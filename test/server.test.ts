import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, keepServing } from '../src/node/server.ts';
import { parseCatalogue } from '../src/core/catalogue.ts';
import { makeDeps, setUpstream, chatJson, chatSse, auth, url, post, srv, token, upstreamBodies } from './helpers.ts';


test('rejects a request without the local token with 401', async () => {
  const r = await post('/v1/chat/completions', { messages: [] }, { 'content-type': 'application/json' });
  assert.equal(r.status, 401);
  const r2 = await post('/v1/chat/completions', { messages: [] }, { authorization: 'Bearer wrong' });
  assert.equal(r2.status, 401);
});

test('accepts the token as Bearer and as x-api-key', async () => {
  setUpstream(() => chatJson('hi'));
  assert.equal((await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] })).status, 200);
  assert.equal((await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }, { 'x-api-key': token })).status, 200);
});

test('health needs no token and returns the marker', async () => {
  assert.deepEqual(await (await fetch(url('/health'))).json(), { app: 'freeaitokens' });
});

test('models lists the single virtual model', async () => {
  const j: any = await (await fetch(url('/v1/models'), { headers: auth() })).json();
  assert.deepEqual(j.data.map((m: any) => m.id), ['free']);
});

test('chat completion round-trips and reports model "free"', async () => {
  setUpstream(() => chatJson('hello'));
  const j: any = await (await post('/v1/chat/completions', { model: 'gpt-4', messages: [{ role: 'user', content: 'x' }] })).json();
  assert.equal(j.model, 'free');
  assert.equal(j.choices[0].message.content, 'hello');
  assert.equal(upstreamBodies[0].model, 'real');
});

test('streams SSE chunks through unchanged apart from the model name', async () => {
  setUpstream(() => chatSse([{ model: 'real', choices: [{ delta: { content: 'he' } }] }, { model: 'real', choices: [{ delta: { content: 'y' } }] }]));
  const r = await post('/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'x' }] });
  assert.match(r.headers.get('content-type')!, /text\/event-stream/);
  const t = await r.text();
  assert.equal(t, 'data: {"model":"free","choices":[{"delta":{"content":"he"}}]}\n\ndata: {"model":"free","choices":[{"delta":{"content":"y"}}]}\n\ndata: [DONE]\n\n');
});

test('no capacity returns 429 with Retry-After', async () => {
  setUpstream(() => new Response('{}', { status: 429, headers: { 'retry-after': '120' } }));
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
  setUpstream(() => chatJson('hi'));
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

test('a reusing launcher takes over when the first server stops', async () => {
  const port = srv.port;
  const f = keepServing(makeDeps(), port, 20);
  await srv.close();
  for (let i = 0; i < 100 && !f.owns(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.owns(), true);
  assert.equal((await fetch(url('/health'))).status, 200);
  await f.stop();
});

test('fails clearly when the port belongs to another program', async (t) => {
  const other = http.createServer((_q, s) => s.end('not us'));
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  t.after(() => { other.closeAllConnections(); other.close(); });
  const port = (other.address() as any).port;
  await assert.rejects(startServer(makeDeps(), port), (e: Error) => e.message.includes(String(port)));
});

test('does not reuse a program that only fakes the health marker', async (t) => {
  const fake = http.createServer((_q, s) => s.end('{"app":"freeaitokens"}'));
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  t.after(() => { fake.closeAllConnections(); fake.close(); });
  const port = (fake.address() as any).port;
  await assert.rejects(startServer(makeDeps(), port), (e: Error) => e.message.includes(String(port)));
});

test('a chat answer says which provider and model served it', async () => {
  setUpstream(() => chatJson('hello'));
  const r = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] });
  assert.match(r.headers.get('x-freeaitokens-served-by') ?? '', /^[a-z0-9-]+\/.+/);
  setUpstream(() => chatSse([{ model: 'real', choices: [{ delta: { content: 'hi' } }] }]));
  const s = await post('/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'x' }] });
  assert.match(s.headers.get('x-freeaitokens-served-by') ?? '', /^[a-z0-9-]+\/.+/);
  await s.text();
});

test('a client that leaves mid-stream stops the provider', async () => {
  let cancelled = false;
  const enc = new TextEncoder();
  setUpstream(() => new Response(new ReadableStream({
    async pull(c) { await new Promise((r) => setTimeout(r, 20)); c.enqueue(enc.encode('data: {"model":"real","choices":[{"delta":{"content":"x"}}]}\n\n')); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const ac = new AbortController();
  const r = await fetch(url('/v1/chat/completions'), { method: 'POST', headers: auth(), body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'x' }] }), signal: ac.signal });
  await r.body!.getReader().read();
  ac.abort();
  for (let i = 0; i < 50 && !cancelled; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(cancelled, 'the provider stream was cancelled');
});

test('a chunk the converter cannot read ends that answer, not the server', async () => {
  setUpstream(() => new Response('data: null\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  await post('/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'x' }] }).then((r) => r.text()).catch(() => ''); // that answer is cut short
  setUpstream(() => chatJson('still here'));
  const j: any = await (await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] })).json();
  assert.equal(j.choices[0].message.content, 'still here');
});

test('a model name that names a provider keeps the request on that provider; other names route freely', async () => {
  setUpstream(() => chatJson('hi'));
  const model = (id: string, quality: number) => ({ id, context: 100000, tools: true, images: false, quality });
  const prov = (id: string, models: object[]) => ({ id, name: id, baseUrl: `https://${id}.example/v1`, keyless: true, paid: false, terms: 'ok', steps: [], models });
  const deps = { ...makeDeps(), catalogue: parseCatalogue([prov('best', [model('top', 0.9)]), prov('low', [model('a', 0.2), model('b', 0.1)])]) };
  const s2 = await startServer(deps, 0);
  try {
    const ask = (m: string) => fetch(`http://127.0.0.1:${s2.port}/v1/chat/completions`, { method: 'POST', headers: auth(), body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'x' }] }) });
    const served = async (m: string) => (await ask(m)).headers.get('x-freeaitokens-served-by');
    assert.equal(await served('free'), 'best/top', 'free routing prefers the better model');
    assert.equal(await served('FreeAITokens'), 'best/top', 'a label that names no provider routes as before');
    for (let i = 0; i < 3; i++) assert.match((await served('low'))!, /^low\//, 'stays on the named provider');
    assert.equal(await served('low/b'), 'low/b', 'provider/model picks that model');
    assert.match((await served('low/no-such-model'))!, /^low\//, 'an unknown model keeps the provider');
  } finally { await s2.close(); }
});
