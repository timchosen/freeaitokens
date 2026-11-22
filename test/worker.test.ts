import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { buildCatalogue, signPayload, emptyProbeState } from '../worker/src/build.ts';
import { verifyEnvelope } from '../src/node/remote.ts';
import { parseCatalogue, type Provider } from '../src/core/catalogue.ts';

const base = { paid: false, terms: 'ok', steps: [] };
const model = (id: string) => ({ id, context: 100000, tools: true, images: false, quality: 0.5, limits: { rpm: 10 } });
const cat = (): Provider[] => parseCatalogue([
  { ...base, id: 'a', name: 'A', baseUrl: 'https://a.example/v1', keyless: false, models: [model('live'), model('gone'), model('busy')] },
  { ...base, id: 'k', name: 'K', baseUrl: 'https://k.example/v1', keyless: true, discover: ':free$', models: [model('x:free')] },
  { ...base, id: 'nokey', name: 'NoKey', baseUrl: 'https://nokey.example/v1', keyless: false, models: [model('m')] },
]);

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const toolReply = () => json({ choices: [{ message: { tool_calls: [{ function: { name: 'weather', arguments: '{}' } }] } }] });

function fakeFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const host = new URL(url).hostname.split('.')[0];
    const key = init?.body ? `${host}/${JSON.parse(init.body as string).model}` : `${host}${new URL(url).pathname}`;
    calls.push(key);
    return (routes[key] ?? (() => toolReply()))();
  }) as unknown as typeof fetch;
  return { f, calls };
}
const keys = (id: string) => (id === 'a' ? 'key-a' : undefined);

test('keeps models that answer, drops a 404, keeps busy ones', async () => {
  const { f } = fakeFetch({ 'a/gone': () => json({ error: 'nope' }, 404), 'a/busy': () => json({}, 429), 'k/v1/models': () => json({ data: [] }) });
  const out = (await buildCatalogue(cat(), keys, f)).providers;
  assert.deepEqual(out.find((p) => p.id === 'a')!.models.map((m) => m.id), ['live', 'busy']);
});

test('drops a model on a 400 that says it was decommissioned, keeps one on 401 or 500', async () => {
  const c = cat();
  c[0].models.push(model('dead'), model('err'));
  const { f } = fakeFetch({
    'a/gone': () => json({ error: { message: 'The model `gone` has been decommissioned' } }, 400),
    'a/busy': () => json({}, 401), 'a/dead': () => json({ error: { code: 'model_not_found' } }, 400), 'a/err': () => json({}, 500),
    'k/v1/models': () => json({ data: [] }),
  });
  const out = (await buildCatalogue(c, keys, f)).providers;
  assert.deepEqual(out.find((p) => p.id === 'a')!.models.map((m) => m.id), ['live', 'busy', 'err']);
});

test('discovers matching new models that answer, and skips the rest', async () => {
  const { f } = fakeFetch({
    'k/v1/models': () => json({ data: [{ id: 'x:free' }, { id: 'new:free', context_length: 64000 }, { id: 'paid-one' }, { id: 'whisper:free' }, { id: 'broken:free' }] }),
    'k/broken:free': () => json({}, 404),
  });
  const out = (await buildCatalogue(cat(), keys, f)).providers;
  const k = out.find((p) => p.id === 'k')!;
  assert.deepEqual(k.models.map((m) => m.id), ['x:free', 'new:free']);
  assert.equal(k.models[1].context, 64000);
  assert.equal(k.models[1].quality, 0.4);
  assert.deepEqual(k.models[1].limits, { rpm: 10 });
});

test('probes at most 10 new models per run', async () => {
  const data = Array.from({ length: 15 }, (_, i) => ({ id: `n${i}:free` }));
  const { f, calls } = fakeFetch({ 'k/v1/models': () => json({ data }) });
  const out = (await buildCatalogue(cat(), keys, f)).providers;
  assert.equal(calls.filter((c) => /^k\/n\d+:free$/.test(c)).length, 10);
  assert.equal(out.find((p) => p.id === 'k')!.models.length, 11);
});

test('leaves a provider with no key unprobed, and drops a provider left with no models', async () => {
  const c = cat();
  c[0].models = [model('gone')];
  const { f, calls } = fakeFetch({ 'a/gone': () => json({}, 404), 'k/v1/models': () => json({ data: [] }) });
  const out = (await buildCatalogue(c, keys, f)).providers;
  assert.ok(!calls.some((x) => x.startsWith('nokey')));
  assert.deepEqual(out.map((p) => p.id), ['k', 'nokey']);
});

test('a network error keeps the model', async () => {
  const { f } = fakeFetch({ 'a/live': () => { throw new Error('ECONNRESET'); }, 'k/v1/models': () => json({ data: [] }) });
  const out = (await buildCatalogue(cat(), keys, f)).providers;
  assert.ok(out.find((p) => p.id === 'a')!.models.some((m) => m.id === 'live'));
});

test('a signed payload verifies with the matching public key and fails with another', async () => {
  const kp = generateKeyPairSync('ed25519');
  const priv = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const pub = kp.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const env = await signPayload({ issued: '2026-11-22T00:00:00Z', providers: [] }, priv);
  assert.equal(verifyEnvelope(env, pub)?.issued, '2026-11-22T00:00:00Z');
  assert.equal(verifyEnvelope(env, other), null);
  assert.equal(verifyEnvelope({ ...env, payload: env.payload.replace('2026', '2027') }, pub), null);
});

test('with a small budget, tests the models checked longest ago first', async () => {
  const { f, calls } = fakeFetch({ 'k/v1/models': () => json({ data: [] }) });
  const state = emptyProbeState();
  state.probedAt = { 'a/live': 300, 'a/gone': 100, 'a/busy': 200, 'k/x:free': 400 };
  await buildCatalogue(cat(), keys, f, state, 2, 1000);
  assert.deepEqual(calls.slice(0, 2), ['a/gone', 'a/busy']);
});

test('a model found gone stays out until it is tested again and answers', async () => {
  const gone = fakeFetch({ 'a/gone': () => json({}, 404), 'k/v1/models': () => json({ data: [] }) });
  const r1 = await buildCatalogue(cat(), keys, gone.f, emptyProbeState(), 40, 1000);
  // next run has budget only for others: 'a/gone' is not retested, and must stay out
  r1.state.probedAt['a/gone'] = 9999;
  const r2 = await buildCatalogue(cat(), keys, fakeFetch({ 'k/v1/models': () => json({ data: [] }) }).f, r1.state, 2, 2000);
  assert.ok(!r2.providers.find((p) => p.id === 'a')!.models.some((m) => m.id === 'gone'));
  // once retested and answering, it comes back
  r2.state.probedAt['a/gone'] = 0;
  const r3 = await buildCatalogue(cat(), keys, fakeFetch({ 'k/v1/models': () => json({ data: [] }) }).f, r2.state, 40, 3000);
  assert.ok(r3.providers.find((p) => p.id === 'a')!.models.some((m) => m.id === 'gone'));
});

test('discovered models are kept on later runs without being rediscovered', async () => {
  const r1 = await buildCatalogue(cat(), keys, fakeFetch({ 'k/v1/models': () => json({ data: [{ id: 'new:free' }] }) }).f, emptyProbeState(), 40, 1000);
  const { f, calls } = fakeFetch({ 'k/v1/models': () => json({ data: [] }) });
  const r2 = await buildCatalogue(cat(), keys, f, r1.state, 40, 2000);
  assert.ok(r2.providers.find((p) => p.id === 'k')!.models.some((m) => m.id === 'new:free'));
  assert.ok(calls.includes('k/new:free')); // still re-tested in rotation
});
