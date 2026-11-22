import { beforeEach, afterEach } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer, type ServerHandle } from '../src/node/server.ts';
import { localToken } from '../src/node/state.ts';
import { LimitTracker, emptyState } from '../src/core/limits.ts';
import { parseCatalogue } from '../src/core/catalogue.ts';
import type { RouteDeps } from '../src/core/orchestrator.ts';

const catalogue = parseCatalogue([{ id: 'up', name: 'Up', baseUrl: 'https://up.example/v1', keyless: true, paid: false, terms: 'ok', steps: [], models: [{ id: 'real', context: 100000, tools: true, images: false, quality: 0.5 }] }]);

let upstream: (body: any) => Response = () => new Response('{}');
export const setUpstream = (f: (body: any) => Response) => { upstream = f; };
export const upstreamBodies: any[] = [];
export function makeDeps(): RouteDeps {
  return {
    catalogue, keys: () => null, tracker: new LimitTracker(emptyState()), opts: { freeOnly: false, paidCap: 200 }, sleep: async () => {},
    fetch: (async (_u: string, init: RequestInit) => { const b = JSON.parse(init.body as string); upstreamBodies.push(b); return upstream(b); }) as unknown as typeof fetch,
  };
}
export const chatJson = (content: string, extra: object = {}) => new Response(JSON.stringify({ id: 'c1', object: 'chat.completion', model: 'real', choices: [{ index: 0, message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
export const chatSse = (lines: object[]) => new Response(lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

export let srv: ServerHandle;
let base: string;
export let token: string;
export const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
export const url = (p: string) => base + p;

beforeEach(async () => {
  process.env.FREETOKENS_HOME = mkdtempSync(join(tmpdir(), 'ft-'));
  token = localToken();
  upstreamBodies.length = 0;
  srv = await startServer(makeDeps(), 0);
  base = `http://127.0.0.1:${srv.port}`;
});
afterEach(() => srv.close());

export const post = (path: string, body: object, headers: Record<string, string> = auth()) => fetch(url(path), { method: 'POST', headers, body: JSON.stringify(body) });
