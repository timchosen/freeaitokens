import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { startServer, type ServerHandle } from '../src/node/server.ts';
import { localToken } from '../src/node/state.ts';
import { LimitTracker, emptyState } from '../src/core/limits.ts';
import { parseCatalogue } from '../src/core/catalogue.ts';
import type { RouteDeps } from '../src/core/orchestrator.ts';

const catalogue = parseCatalogue([{ id: 'up', name: 'Up', baseUrl: 'https://up.example/v1', keyless: true, paid: false, terms: 'ok', steps: [], models: [{ id: 'real', context: 100000, tools: true, images: false, quality: 0.5 }] }]);

export let upstream: (body: any) => Response = () => new Response('{}');
export const upstreamBodies: any[] = [];
export function makeDeps(): RouteDeps {
  return {
    catalogue, keys: () => null, tracker: new LimitTracker(emptyState()), opts: { freeOnly: false, paidCap: 200 }, sleep: async () => {},
    fetch: (async (_u: string, init: RequestInit) => { const b = JSON.parse(init.body as string); upstreamBodies.push(b); return upstream(b); }) as unknown as typeof fetch,
  };
}
export const chatJson = (content: string, extra: object = {}) => new Response(JSON.stringify({ id: 'c1', object: 'chat.completion', model: 'real', choices: [{ index: 0, message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
export const chatSse = (lines: object[]) => new Response(lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

let srv: ServerHandle;
let base: string;
let token: string;
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

const post = (path: string, body: object, headers: Record<string, string> = auth()) => fetch(url(path), { method: 'POST', headers, body: JSON.stringify(body) });

test('rejects a request without the local token with 401', async () => {
  const r = await post('/v1/chat/completions', { messages: [] }, { 'content-type': 'application/json' });
  assert.equal(r.status, 401);
  const r2 = await post('/v1/chat/completions', { messages: [] }, { authorization: 'Bearer wrong' });
  assert.equal(r2.status, 401);
});

test('accepts the token as Bearer and as x-api-key', async () => {
  upstream = () => chatJson('hi');
  assert.equal((await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] })).status, 200);
  assert.equal((await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }, { 'x-api-key': token })).status, 200);
});

test('health needs no token and returns the marker', async () => {
  assert.deepEqual(await (await fetch(url('/health'))).json(), { app: 'freetokens' });
});

test('models lists the single virtual model', async () => {
  const j: any = await (await fetch(url('/v1/models'), { headers: auth() })).json();
  assert.deepEqual(j.data.map((m: any) => m.id), ['free']);
});

test('chat completion round-trips and reports model "free"', async () => {
  upstream = () => chatJson('hello');
  const j: any = await (await post('/v1/chat/completions', { model: 'gpt-4', messages: [{ role: 'user', content: 'x' }] })).json();
  assert.equal(j.model, 'free');
  assert.equal(j.choices[0].message.content, 'hello');
  assert.equal(upstreamBodies[0].model, 'real');
});

test('streams SSE chunks through unchanged apart from the model name', async () => {
  upstream = () => chatSse([{ model: 'real', choices: [{ delta: { content: 'he' } }] }, { model: 'real', choices: [{ delta: { content: 'y' } }] }]);
  const r = await post('/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'x' }] });
  assert.match(r.headers.get('content-type')!, /text\/event-stream/);
  const t = await r.text();
  assert.equal(t, 'data: {"model":"free","choices":[{"delta":{"content":"he"}}]}\n\ndata: {"model":"free","choices":[{"delta":{"content":"y"}}]}\n\ndata: [DONE]\n\n');
});

test('no capacity returns 429 with Retry-After', async () => {
  upstream = () => new Response('{}', { status: 429, headers: { 'retry-after': '120' } });
  const r = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 429);
  assert.ok(+r.headers.get('retry-after')! > 0);
  assert.match(((await r.json()) as any).error.message, /limits/);
});

test('too large returns 413', async () => {
  const r = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x'.repeat(1_000_000) }] });
  assert.equal(r.status, 413);
});

test('invalid JSON returns 400', async () => {
  const r = await fetch(url('/v1/chat/completions'), { method: 'POST', headers: auth(), body: '{nope' });
  assert.equal(r.status, 400);
});

test('saves state after a request', async () => {
  upstream = () => chatJson('hi');
  await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] });
  const { loadState } = await import('../src/node/state.ts');
  assert.equal(loadState().stats['up/real'].ok, 1);
});

test('listens on 127.0.0.1 only', async () => {
  assert.equal(srv.address, '127.0.0.1');
});

test('reuses a running instance', async () => {
  const again = await startServer(makeDeps(), srv.port);
  assert.equal(again.reused, true);
  assert.equal(again.port, srv.port);
  await again.close();
  assert.equal((await fetch(url('/health'))).status, 200);
});

test('fails clearly when the port belongs to another program', async () => {
  const other = http.createServer((_q, s) => s.end('not us'));
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  const port = (other.address() as any).port;
  await assert.rejects(startServer(makeDeps(), port), (e: Error) => e.message.includes(String(port)));
  other.close();
});
