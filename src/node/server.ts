import http from 'node:http';
import { Readable } from 'node:stream';
import { timingSafeEqual, createHmac, randomBytes } from 'node:crypto';
import { route, NoCapacityError, type RouteDeps } from '../core/orchestrator.js';
import { sseData, mapChatSse } from '../core/sse.js';
import type { ChatRequest } from '../core/types.js';
import { fromAnthropic, toAnthropic, toAnthropicStream, countTokens, anthropicError } from '../core/anthropic.js';
import { localToken, saveState } from './state.js';

export interface ServerHandle { port: number; address: string; reused: boolean; close(): Promise<void> }

export const DEFAULT_PORT = 4949;
const HOST = '127.0.0.1';
const MAX_BODY = 50 * 1024 * 1024;
const MARKER = { app: 'freetokens' };

// A format adapter turns an inbound body into a chat request and a chat response back into its own shape.
export interface Format {
  toChat(body: unknown): ChatRequest;
  fromChat(json: unknown, requestedModel: string): unknown;
  fromChatStream(requestedModel: string): TransformStream<Uint8Array, Uint8Array>;
  error(status: number, message: string): unknown;
  direct?: (body: unknown) => unknown; // answered locally, without a provider
}

const openaiError = (_s: number, message: string) => ({ error: { message, type: 'freetokens_error' } });
const openai: Format = {
  toChat: (b) => b as ChatRequest,
  fromChat: (j: any) => ({ ...j, model: 'free' }),
  fromChatStream: () => {
    const t = mapChatSse((c) => ({ ...c, model: c.model === undefined ? undefined : 'free' }));
    const s = sseData();
    return { writable: s.writable, readable: s.readable.pipeThrough(t) };
  },
  error: openaiError,
};

const anthropic: Format = { toChat: fromAnthropic, fromChat: toAnthropic, fromChatStream: toAnthropicStream, error: anthropicError };
const anthropicCount: Format = { ...anthropic, direct: countTokens };

export const FORMATS: Record<string, Format> = {
  '/v1/chat/completions': openai,
  '/v1/messages': anthropic,
  '/v1/messages/count_tokens': anthropicCount,
};

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function tokenOk(req: http.IncomingMessage, token: string): boolean {
  const h = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? req.headers['x-api-key'];
  const got = Buffer.from(typeof h === 'string' ? h : '');
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large.');
    parts.push(c);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new HttpError(400, 'Request body is not valid JSON.'); }
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
}

export function makeHandler(deps: RouteDeps, token: string, formats: Record<string, Format>) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const [path, query = ''] = (req.url ?? '/').split('?');
    if (req.method === 'GET' && path === '/health') {
      // Proof of the local token, so a launcher never reuses a program that merely copies the marker.
      const nonce = new URLSearchParams(query).get('nonce');
      return send(res, 200, nonce ? { ...MARKER, proof: proofOf(token, nonce) } : MARKER);
    }
    const fmt = formats[path];
    const errOf = fmt ?? openai;
    if (!tokenOk(req, token)) return send(res, 401, errOf.error(401, 'Missing or wrong local token. Run `freetokens` to see it.'));
    if (req.method === 'GET' && path === '/v1/models') {
      return send(res, 200, { object: 'list', data: [{ id: 'free', object: 'model', created: 0, owned_by: 'freetokens' }] });
    }
    if (req.method !== 'POST' || !fmt) return send(res, 404, errOf.error(404, `Unknown endpoint ${req.method} ${path}.`));
    try {
      const body: any = await readJson(req);
      if (fmt.direct) return send(res, 200, fmt.direct(body));
      const chat = fmt.toChat(body);
      const requested = typeof body?.model === 'string' ? body.model : 'free';
      const { response } = await route(chat, deps);
      if (response.status !== 200) {
        const text = await response.text();
        return send(res, response.status, errOf.error(response.status, `Provider rejected the request: ${text.slice(0, 500)}`));
      }
      if (chat.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const out = response.body!.pipeThrough(fmt.fromChatStream(requested));
        Readable.fromWeb(out as any).pipe(res);
        res.on('close', () => out.cancel().catch(() => {}));
      } else {
        send(res, 200, fmt.fromChat(await response.json(), requested));
      }
    } catch (e) {
      if (e instanceof NoCapacityError) {
        const status = e.reason === 'too-large' ? 413 : 429;
        const headers: Record<string, string> = status === 429 ? { 'retry-after': String(Math.max(1, Math.ceil((e.retryAt - deps.tracker.now()) / 1000))) } : {};
        return send(res, status, errOf.error(status, e.message), headers);
      }
      if (e instanceof HttpError) return send(res, e.status, errOf.error(e.status, e.message));
      return send(res, 500, errOf.error(500, `Internal error: ${(e as Error).message}`));
    } finally {
      try { saveState(deps.tracker.state); } catch { /* state is best effort */ }
    }
  };
}

const proofOf = (token: string, nonce: string) => createHmac('sha256', token).update(nonce).digest('hex');

async function isOurs(port: number, token: string): Promise<boolean> {
  try {
    const nonce = randomBytes(16).toString('hex');
    const r = await fetch(`http://${HOST}:${port}/health?nonce=${nonce}`, { signal: AbortSignal.timeout(2000) });
    const j: any = await r.json();
    return j?.app === MARKER.app && j.proof === proofOf(token, nonce);
  } catch {
    return false;
  }
}

export async function startServer(deps: RouteDeps, port = DEFAULT_PORT, extraFormats: Record<string, Format> = {}): Promise<ServerHandle> {
  const token = localToken();
  const server = http.createServer(makeHandler(deps, token, { ...FORMATS, ...extraFormats }));
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, HOST, resolve); });
  } catch (e: any) {
    if (e?.code === 'EADDRINUSE' && (await isOurs(port, token))) return { port, address: HOST, reused: true, close: async () => {} };
    if (e?.code === 'EADDRINUSE') throw new Error(`Port ${port} is already used by another program. Pick another with --port <n>.`);
    throw e;
  }
  const a = server.address() as { port: number; address: string };
  return {
    port: a.port, address: a.address, reused: false,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
