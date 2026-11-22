import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { matchKey, validateKey, connectOpenRouter, runList, keySteps } from '../src/node/add.ts';
import { parseCatalogue } from '../src/core/catalogue.ts';
import { LimitTracker, emptyState } from '../src/core/limits.ts';
import type { KeyStore } from '../src/node/keys.ts';

const catalogue = parseCatalogue(JSON.parse((await import('node:fs')).readFileSync(new URL('../src/catalogue.json', import.meta.url), 'utf8')));
const byId = (id: string) => catalogue.find((p) => p.id === id)!;
const groqKey = 'gsk_' + 'a'.repeat(52);

test('matchKey accepts a matching key and trims whitespace', () => {
  assert.equal(matchKey(byId('groq'), `  ${groqKey}\n`), groqKey);
});

test('matchKey rejects ordinary text', () => {
  assert.equal(matchKey(byId('groq'), 'copy this sentence please'), null);
  assert.equal(matchKey(byId('groq'), `my key is ${groqKey}`), null);
});

test('matchKey accepts both Gemini key formats', () => {
  for (const k of ['AIza' + 'a'.repeat(35), 'AQ.' + 'Ab_-1'.repeat(10)]) assert.equal(matchKey(byId('gemini'), k), k);
  assert.equal(matchKey(byId('gemini'), 'AQ.'), null);
});

test("matchKey rejects another provider's key", () => {
  assert.equal(matchKey(byId('cerebras'), groqKey), null);
});

function fakeFetch(status: number, seen: any[] = []) {
  return (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response('{"choices":[]}', { status }); }) as unknown as typeof fetch;
}

test('validateKey ok on 200 and sends one tiny request with the key', async () => {
  const seen: any[] = [];
  assert.deepEqual(await validateKey(byId('groq'), groqKey, fakeFetch(200, seen)), { ok: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(new Headers(seen[0].init.headers).get('authorization'), `Bearer ${groqKey}`);
  assert.equal(JSON.parse(seen[0].init.body).max_tokens, 1);
});

test('validateKey tries the next model when one is too slow, and stops at a rejected key', async () => {
  const prov = byId('nvidia');
  const tried: string[] = [];
  const slowFirst = (async (_u: string, init: RequestInit) => {
    const m = JSON.parse(init.body as string).model; tried.push(m);
    if (m === prov.models[0].id) throw new DOMException('The operation was aborted due to timeout.', 'TimeoutError');
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await validateKey(prov, 'nvapi-x', slowFirst), { ok: true });
  assert.deepEqual(tried, [prov.models[0].id, prov.models[1].id]);
  const seen: any[] = [];
  assert.deepEqual(await validateKey(prov, 'nvapi-x', fakeFetch(403, seen)), { ok: false, reason: 'key rejected' });
  assert.equal(seen.length, 1);
});

test('validateKey treats 429 as a working key', async () => {
  assert.deepEqual(await validateKey(byId('groq'), groqKey, fakeFetch(429)), { ok: true });
});

test('validateKey reports "key rejected" on 401', async () => {
  assert.deepEqual(await validateKey(byId('groq'), groqKey, fakeFetch(401)), { ok: false, reason: 'key rejected' });
});

test('validateKey reports the status on 500', async () => {
  const r = await validateKey(byId('groq'), groqKey, fakeFetch(500));
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /500/);
});

test('validateKey reports a network failure', async () => {
  const f = (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
  const r = await validateKey(byId('groq'), groqKey, f);
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /ENOTFOUND/);
});

test('connectOpenRouter sends an S256 challenge and exchanges the returned code', async () => {
  const exchanged: any[] = [];
  const f = (async (url: string, init: RequestInit) => {
    exchanged.push({ url, body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify({ key: 'sk-or-v1-' + 'b'.repeat(64), user_id: 'u' }));
  }) as unknown as typeof fetch;
  let authUrl!: URL;
  const done = connectOpenRouter(f, (u) => { authUrl = new URL(u); });
  while (!authUrl) await new Promise((r) => setTimeout(r, 5));
  assert.equal(authUrl.origin + authUrl.pathname, 'https://openrouter.ai/auth');
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  const cb = new URL(authUrl.searchParams.get('callback_url')!);
  assert.equal(cb.hostname, 'localhost');
  cb.searchParams.set('code', 'abc');
  cb.searchParams.set('state', authUrl.searchParams.get('state')!);
  // A browser would make this request after the user approves.
  assert.equal((await fetch(cb)).status, 200);
  assert.equal(await done, 'sk-or-v1-' + 'b'.repeat(64));
  assert.equal(exchanged[0].url, 'https://openrouter.ai/api/v1/auth/keys');
  assert.equal(exchanged[0].body.code, 'abc');
  const challenge = createHash('sha256').update(exchanged[0].body.code_verifier).digest('base64url');
  assert.equal(challenge, authUrl.searchParams.get('code_challenge'));
});

test('connectOpenRouter ignores a callback with no code or the wrong state', async () => {
  const f = (async () => new Response(JSON.stringify({ key: 'sk-or-v1-' + 'c'.repeat(64) }))) as unknown as typeof fetch;
  let authUrl!: URL;
  const done = connectOpenRouter(f, (u) => { authUrl = new URL(u); });
  while (!authUrl) await new Promise((r) => setTimeout(r, 5));
  const cb = new URL(authUrl.searchParams.get('callback_url')!);
  assert.equal((await fetch(cb)).status, 400);
  const wrong = new URL(cb); wrong.searchParams.set('code', 'x'); wrong.searchParams.set('state', 'forged');
  assert.equal((await fetch(wrong)).status, 400);
  cb.searchParams.set('code', 'real');
  cb.searchParams.set('state', authUrl.searchParams.get('state')!);
  await fetch(cb);
  assert.equal(await done, 'sk-or-v1-' + 'c'.repeat(64));
});

test('runList shows provider name, key status and remaining daily requests, and never the key', () => {
  const store: KeyStore = { backend: 'file', get: (id) => (id === 'groq' ? groqKey : null), set() {}, remove() {} };
  const t = new LimitTracker(emptyState());
  t.record('groq/openai/gpt-oss-120b', 10, true, 100);
  const out = runList(catalogue, store, t);
  assert.match(out, /Groq.*key added/);
  assert.match(out, /Cerebras.*not added/);
  assert.match(out, /Kilo Gateway.*no key needed/);
  assert.match(out, /999/); // gpt-oss-120b has 1000 a day, one used
  assert.ok(!out.includes(groqKey));
});

test('runList shows the free allowance, not "left today", for a provider with no key', () => {
  const store: KeyStore = { backend: 'file', get: () => null, set() {}, remove() {} };
  const line = runList(catalogue, store, new LimitTracker(emptyState())).split('\n').find((l) => l.startsWith('Groq'))!;
  assert.ok(!line.includes('left today'), line);
  assert.match(line, /up to 1000 free requests a day per model/);
});

test('keySteps shows and opens the sign-up link, labelled, when it is a referral link', () => {
  const plain = keySteps({ ...byId('groq') });
  assert.equal(plain.open, byId('groq').keyUrl);
  assert.ok(!plain.text.includes('referral'));
  const ref = keySteps({ ...byId('groq'), signupUrl: 'https://console.groq.com/?ref=abc', referral: true });
  assert.equal(ref.open, 'https://console.groq.com/?ref=abc');
  assert.match(ref.text, /https:\/\/console\.groq\.com\/\?ref=abc \(referral link\)/);
  assert.ok(ref.text.includes(byId('groq').keyUrl!));
});
