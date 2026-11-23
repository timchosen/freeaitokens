import http from 'node:http';
import { Readable } from 'node:stream';
import { timingSafeEqual, createHmac, randomBytes } from 'node:crypto';
import { route, NoCapacityError, type RouteDeps } from '../core/orchestrator.js';
import { sseData, mapChatSse } from '../core/sse.js';
import { BadRequest, type ChatRequest } from '../core/types.js';
import { fromResponses, toResponses, toResponsesStream, responsesError } from '../core/responses.js';
import { fromAnthropic, toAnthropic, toAnthropicStream, countTokens, anthropicError } from '../core/anthropic.js';
import { fromOllamaChat, fromOllamaGenerate, toOllamaChat, toOllamaGenerate, toOllamaChatStream, toOllamaGenerateStream, ollamaError, ollamaShow, OLLAMA_TAGS } from '../core/ollama.js';
import { fromGemini, toGemini, toGeminiStream, geminiCount, geminiError, GEMINI_MODEL } from '../core/gemini.js';
import { localToken, saveState, loadState } from './state.js';
import { LimitTracker } from '../core/limits.js';
import { routeMedia, NoProviderError, target, type MediaBody, type MediaCandidate } from '../core/media.js';
import type { MediaKind } from '../core/catalogue.js';

export interface ServerHandle { port: number; address: string; reused: boolean; close(): Promise<void> }

export const DEFAULT_PORT = 4949;
const HOST = '127.0.0.1';
const MAX_BODY = 50 * 1024 * 1024;
const MARKER = { app: 'freeaitokens' };

// A format adapter turns an inbound body into a chat request and a chat response back into its own shape.
export interface Format {
  toChat(body: unknown, path: string): ChatRequest;
  fromChat(json: unknown, requestedModel: string, body: unknown): unknown;
  fromChatStream(requestedModel: string, body: unknown): TransformStream<Uint8Array, Uint8Array>;
  error(status: number, message: string): unknown;
  direct?: (body: unknown) => unknown; // answered locally, without a provider
  streamType?: string; // content type of a streamed answer, server-sent events unless set
}

const openaiError = (_s: number, message: string) => ({ error: { message, type: 'freeaitokens_error' } });
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
const responses: Format = { toChat: fromResponses, fromChat: toResponses, fromChatStream: toResponsesStream, error: responsesError };
const ollamaChat: Format = { toChat: fromOllamaChat, fromChat: toOllamaChat, fromChatStream: toOllamaChatStream, error: ollamaError, streamType: 'application/x-ndjson' };
const ollamaGenerate: Format = { ...ollamaChat, toChat: fromOllamaGenerate, fromChat: toOllamaGenerate, fromChatStream: toOllamaGenerateStream };
const gemini: Format = { toChat: fromGemini, fromChat: toGemini, fromChatStream: toGeminiStream, error: geminiError };

export const FORMATS: Record<string, Format> = {
  '/v1/chat/completions': openai,
  '/v1/messages': anthropic,
  '/v1/messages/count_tokens': anthropicCount,
  '/v1/responses': responses,
  '/v1beta/models/*:generateContent': gemini,
  '/v1beta/models/*:streamGenerateContent': gemini,
  '/v1beta/models/*:countTokens': { ...gemini, direct: geminiCount },
  '/api/chat': ollamaChat,
  '/api/generate': ollamaGenerate,
  '/api/show': { ...ollamaChat, direct: ollamaShow },
};

// Answers to GET requests, by path; '*' stands for any model name.
const GETS: Record<string, unknown> = {
  '/v1/models': { object: 'list', data: [{ id: 'free', object: 'model', created: 0, owned_by: 'freeaitokens' }] },
  '/v1beta/models': { models: [GEMINI_MODEL] },
  '/v1beta/models/*': GEMINI_MODEL,
  '/api/tags': OLLAMA_TAGS,
  '/api/version': { version: '0.12.0' },
};
// OpenAI-style endpoints for models that are not chat: the body passes through, only the model changes.
const MEDIA: Record<string, MediaKind> = {
  '/v1/embeddings': 'embedding', '/v1/completions': 'completion', '/v1/images/generations': 'image',
  '/v1/audio/speech': 'speech', '/v1/audio/transcriptions': 'transcription', '/v1/videos': 'video',
};
const MAX_JOBS = 1000;
// Gemini puts the model in the path: /v1beta/models/<model>:<method>.
const pattern = (path: string) => path.replace(/^\/v1beta\/models\/[^/:]+/, '/v1beta/models/*');

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function tokenOk(req: http.IncomingMessage, query: URLSearchParams, token: string): boolean {
  const h = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? req.headers['x-api-key'] ?? req.headers['x-goog-api-key'] ?? query.get('key');
  const got = Buffer.from(typeof h === 'string' ? h : '');
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readRaw(req: http.IncomingMessage): Promise<Buffer> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large.');
    parts.push(c);
  }
  return Buffer.concat(parts);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readRaw(req);
  try { return JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Request body is not valid JSON.'); }
}

async function readMedia(req: http.IncomingMessage): Promise<MediaBody> {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('multipart/form-data')) {
    const json = await readJson(req);
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new HttpError(400, 'Request body must be a JSON object.');
    return { json: json as Record<string, unknown> };
  }
  const raw = await readRaw(req);
  try { return { form: await new Request('http://local/', { method: 'POST', headers: { 'content-type': type }, body: new Uint8Array(raw) }).formData() }; } catch { throw new HttpError(400, 'Request body is not valid multipart form data.'); }
}

// Passes a provider's answer through as it came: JSON, audio, images or video.
function pipe(res: http.ServerResponse, r: Response) {
  res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream' });
  if (!r.body) return void res.end();
  const body = Readable.fromWeb(r.body as any);
  body.pipe(res);
  res.on('close', () => body.destroy());
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
}

export function makeHandler(deps: RouteDeps, token: string, formats: Record<string, Format>) {
  // Which provider made each video job, so polling and download go back to it. In memory: a restart forgets them.
  const jobs = new Map<string, MediaCandidate>();
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const [path, query = ''] = (req.url ?? '/').split('?');
    if (req.method === 'GET' && path === '/health') {
      // Proof of the local token, so a launcher never reuses a program that merely copies the marker.
      const nonce = new URLSearchParams(query).get('nonce');
      return send(res, 200, nonce ? { ...MARKER, proof: proofOf(token, nonce) } : MARKER);
    }
    const key = pattern(path);
    const fmt = formats[key];
    const errOf = fmt ?? (path.startsWith('/v1beta/') ? gemini : path.startsWith('/api/') ? ollamaChat : openai);
    if (!tokenOk(req, new URLSearchParams(query), token)) return send(res, 401, errOf.error(401, 'Missing or wrong local token. Run `freeaitokens` to see it.'));
    if (req.method === 'GET' && key in GETS) return send(res, 200, GETS[key]);
    const kind = req.method === 'POST' ? MEDIA[path] : undefined;
    const video = req.method === 'GET' ? /^\/v1\/videos\/([^/]+)(\/content)?$/.exec(path) : null;
    if (!kind && !video && (req.method !== 'POST' || !fmt)) return send(res, 404, errOf.error(404, `Unknown endpoint ${req.method} ${path}.`));
    try {
      if (video) {
        const c = jobs.get(decodeURIComponent(video[1]));
        if (!c) return send(res, 404, openaiError(404, 'Unknown video job. Jobs are forgotten when freeaitokens restarts.'));
        const { url, auth } = target(c, 'video');
        const r = await deps.fetch(`${url}/${encodeURIComponent(video[1])}${video[2] ?? ''}`, { headers: auth, signal: AbortSignal.timeout(120_000) });
        return pipe(res, r);
      }
      if (kind) {
        const { response, candidate } = await routeMedia(kind, await readMedia(req), deps);
        if (response.status >= 400) return send(res, response.status, openaiError(response.status, `Provider rejected the request: ${(await response.text()).slice(0, 500)}`));
        if (kind !== 'video') return pipe(res, response);
        const j: any = await response.json();
        if (typeof j?.id === 'string') {
          if (jobs.size >= MAX_JOBS) jobs.delete(jobs.keys().next().value!);
          jobs.set(j.id, candidate);
        }
        return send(res, response.status, j);
      }
      if (!fmt) throw new HttpError(404, `Unknown endpoint ${req.method} ${path}.`);
      const body: any = await readJson(req);
      if (fmt.direct) return send(res, 200, fmt.direct(body));
      const chat = fmt.toChat(body, path);
      const requested = typeof body?.model === 'string' ? body.model : 'free';
      const { response, candidate } = await route(chat, deps);
      // Ids only (header-safe); the app's playground shows who answered.
      const servedBy = { 'x-freeaitokens-served-by': `${candidate.provider.id}/${candidate.model.id}`.replace(/[^\x20-\x7e]/g, "") };
      if (response.status !== 200) {
        const text = await response.text();
        return send(res, response.status, errOf.error(response.status, `Provider rejected the request: ${text.slice(0, 500)}`));
      }
      if (chat.stream) {
        res.writeHead(200, { 'content-type': fmt.streamType ?? 'text/event-stream', 'cache-control': 'no-cache', ...servedBy });
        const out = response.body!.pipeThrough(fmt.fromChatStream(requested, body));
        Readable.fromWeb(out as any).pipe(res);
        res.on('close', () => out.cancel().catch(() => {}));
      } else {
        send(res, 200, fmt.fromChat(await response.json(), requested, body), servedBy);
      }
    } catch (e) {
      if (e instanceof NoCapacityError) {
        const status = e.reason === 'too-large' ? 413 : 429;
        const headers: Record<string, string> = status === 429 ? { 'retry-after': String(Math.max(1, Math.ceil((e.retryAt - deps.tracker.now()) / 1000))) } : {};
        return send(res, status, errOf.error(status, e.message), headers);
      }
      if (e instanceof NoProviderError) return send(res, e.status, errOf.error(e.status, e.message));
      if (e instanceof HttpError || e instanceof BadRequest) return send(res, e.status, errOf.error(e.status, e.message));
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

// For a launcher that reused another launcher's endpoint: if that one stops, take the port over.
export function keepServing(deps: RouteDeps, port: number, everyMs = 2000): { owns: () => boolean; stop: () => Promise<void> } {
  let own: ServerHandle | null = null, busy = false;
  const timer = setInterval(async () => {
    if (own || busy) return;
    busy = true;
    try {
      const s = await startServer(deps, port);
      if (!s.reused) { deps.tracker = new LimitTracker(loadState()); own = s; clearInterval(timer); }
    } catch { /* another program took the port: keep trying */ } finally { busy = false; }
  }, everyMs);
  timer.unref?.();
  return { owns: () => own !== null, stop: async () => { clearInterval(timer); await own?.close(); } };
}
