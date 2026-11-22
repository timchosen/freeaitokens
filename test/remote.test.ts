import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { signPayload } from '../worker/src/build.ts';
import { fetchCatalogue, readCache, writeCache } from '../src/node/remote.ts';

const kp = generateKeyPairSync('ed25519');
const PRIV = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const PUB = kp.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

const prov = (o: object = {}) => ({ id: 'a', name: 'A', baseUrl: 'https://a.example/v1', keyless: false, paid: false, terms: 'ok', steps: [], keyUrl: 'https://a.example/keys', keyPattern: '^a_', models: [{ id: 'm', context: 1000, tools: true, images: false, quality: 0.5 }], ...o });
const URLS = { url: 'https://cat.example/catalogue.json', githubUrl: 'https://raw.example/catalogue.json' };

function serve(envelope: unknown, github: unknown) {
  return (async (u: string) => {
    if (u === URLS.url) return new Response(JSON.stringify(envelope));
    if (u === URLS.githubUrl) return new Response(JSON.stringify(github));
    throw new Error('unexpected ' + u);
  }) as unknown as typeof fetch;
}
const opts = (f: typeof fetch, cachedIssued?: string) => ({ ...URLS, fetch: f, publicKey: PUB, cachedIssued });

beforeEach(() => { process.env.FREEAITOKENS_HOME = mkdtempSync(join(tmpdir(), 'ft-r-')); });

test('accepts a signed list whose providers match GitHub', async () => {
  const env = await signPayload({ issued: '2026-11-22T06:00:00Z', providers: [prov()] }, PRIV);
  const r = await fetchCatalogue(opts(serve(env, [prov({ models: [{ id: 'old', context: 1, tools: false, images: false, quality: 0 }] })])));
  assert.equal(r?.providers[0].models[0].id, 'm');
  assert.equal(r?.issued, '2026-11-22T06:00:00Z');
});

test('rejects a list with a bad signature', async () => {
  const env = await signPayload({ issued: '2026-11-22T06:00:00Z', providers: [prov()] }, PRIV);
  const forged = { ...env, payload: env.payload.replace('a.example/v1', 'evil.example/v1') };
  assert.equal(await fetchCatalogue(opts(serve(forged, [prov()]))), null);
});

test('rejects a signed list that sends a provider somewhere GitHub does not', async () => {
  const env = await signPayload({ issued: '2026-11-22T06:00:00Z', providers: [prov({ baseUrl: 'https://evil.example/v1' })] }, PRIV);
  assert.equal(await fetchCatalogue(opts(serve(env, [prov()]))), null);
});

test('rejects a signed list with a key pattern or key page GitHub does not have', async () => {
  for (const o of [{ keyPattern: '.*' }, { keyUrl: 'https://evil.example/keys' }, { signupUrl: 'https://evil.example/join' }, { keyless: true }]) {
    const env = await signPayload({ issued: '2026-11-22T06:00:00Z', providers: [prov(o)] }, PRIV);
    assert.equal(await fetchCatalogue(opts(serve(env, [prov()]))), null, JSON.stringify(o));
  }
});

test('rejects a signed list with a provider that is not on GitHub', async () => {
  const env = await signPayload({ issued: '2026-11-22T06:00:00Z', providers: [prov(), prov({ id: 'b' })] }, PRIV);
  assert.equal(await fetchCatalogue(opts(serve(env, [prov()]))), null);
});

test('rejects a list older than the cached one', async () => {
  const env = await signPayload({ issued: '2026-11-22T06:00:00Z', providers: [prov()] }, PRIV);
  assert.equal(await fetchCatalogue(opts(serve(env, [prov()]), '2026-11-22T12:00:00Z')), null);
});

test('returns null when the network fails', async () => {
  const f = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  assert.equal(await fetchCatalogue(opts(f)), null);
});

test('the cache round-trips and is checked again on read', async () => {
  const env = await signPayload({ issued: '2026-11-22T06:00:00Z', providers: [prov()] }, PRIV);
  writeCache(env);
  assert.equal(readCache(PUB)?.providers[0].id, 'a');
  writeCache({ ...env, signature: env.signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) });
  assert.equal(readCache(PUB), null);
});

test('rejects a signed list that changes anything about a provider except its models', async () => {
  for (const o of [{ steps: ['Paste your key at https://evil.example'] }, { name: 'A (official)' }, { termsNote: 'all fine' }]) {
    const env = await signPayload({ issued: '2026-11-22T06:00:00Z', providers: [prov(o)] }, PRIV);
    assert.equal(await fetchCatalogue(opts(serve(env, [prov()]))), null, JSON.stringify(o));
  }
});
