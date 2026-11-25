import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCatalogue } from '../src/core/catalogue.ts';
import { LimitTracker, emptyState } from '../src/core/limits.ts';
import { routeMedia, mediaCandidates } from '../src/core/media.ts';
import { NoCapacityError, type RouteDeps } from '../src/core/orchestrator.ts';

const base = { keyless: false, paid: false, terms: 'ok', steps: [], models: [{ id: 'chat', context: 1000, tools: false, images: false, quality: 0.5 }] };
const cat = parseCatalogue([
  { ...base, id: 'a', name: 'A', baseUrl: 'https://a.example/v1', media: [
    { id: 'emb-a', kind: 'embedding', quality: 0.9 },
    { id: 'img-a', kind: 'image', quality: 0.5, limits: { rpd: 1 } },
  ] },
  { ...base, id: 'b', name: 'B', baseUrl: 'https://b.example/v1', keyless: true, media: [
    { id: 'emb-b', kind: 'embedding', quality: 0.4 },
    { id: 'tts-b', kind: 'speech', quality: 0.5, baseUrl: 'https://tts.b.example/v2', path: '/speak' },
  ] },
  { ...base, id: 'nokey', name: 'NoKey', baseUrl: 'https://n.example/v1', media: [{ id: 'emb-n', kind: 'embedding', quality: 1 }] },
]);

function deps(reply: (url: string, init: RequestInit) => Response, seen: { url: string; init: RequestInit }[] = []): RouteDeps {
  return {
    catalogue: cat, keys: (id) => (id === 'a' ? 'key-a' : null), tracker: new LimitTracker(emptyState(), () => 1_000_000),
    opts: { freeOnly: false, paidCap: 200 }, sleep: async () => {},
    fetch: (async (url: string, init: RequestInit) => { seen.push({ url, init }); return reply(url, init); }) as unknown as typeof fetch,
  };
}

test('catalogue accepts media models and rejects an unknown kind', () => {
  assert.equal(cat[0].media!.length, 2);
  assert.throws(() => parseCatalogue([{ ...base, id: 'x', name: 'X', baseUrl: 'https://x.example', media: [{ id: 'm', kind: 'telepathy', quality: 0.5 }] }]), /kind/);
  assert.throws(() => parseCatalogue([{ ...base, id: 'x', name: 'X', baseUrl: 'https://x.example', media: [{ id: 'm', kind: 'image', quality: 0.5, path: '@evil.example/x' }] }]), /path/);
});

test('media candidates are only that kind, need a key unless keyless, best first', () => {
  const c = mediaCandidates('embedding', cat, (id) => (id === 'a' ? 'key-a' : null), new LimitTracker(emptyState()), { freeOnly: false, paidCap: 200 });
  assert.deepEqual(c.map((x) => x.key), ['a/emb-a', 'b/emb-b']);
});

test('routeMedia sends JSON with the chosen model to the kind path and the key', async () => {
  const seen: any[] = [];
  const { response } = await routeMedia('embedding', { json: { model: 'whatever', input: 'hi' } }, deps(() => new Response('{"data":[]}'), seen));
  assert.equal(response.status, 200);
  assert.equal(seen[0].url, 'https://a.example/v1/embeddings');
  assert.equal(JSON.parse(seen[0].init.body).model, 'emb-a');
  assert.equal(new Headers(seen[0].init.headers).get('authorization'), 'Bearer key-a');
});

test('routeMedia fails over on 429 and 5xx, and uses a model base URL and path override', async () => {
  const seen: any[] = [];
  const d = deps((url) => (url.includes('a.example') ? new Response('{}', { status: 503 }) : new Response('ok')), seen);
  const r = await routeMedia('embedding', { json: { input: 'x' } }, d);
  assert.equal(r.candidate.key, 'b/emb-b');
  const s = await routeMedia('speech', { json: { input: 'hello', voice: 'x' } }, deps(() => new Response(new Uint8Array([1, 2]))));
  assert.equal(s.candidate.key, 'b/tts-b');
  const seen2: any[] = [];
  await routeMedia('speech', { json: { input: 'hi' } }, deps(() => new Response('x'), seen2));
  assert.equal(seen2[0].url, 'https://tts.b.example/v2/speak');
});

test('routeMedia sends multipart with the model replaced and the file kept', async () => {
  const form = new FormData();
  form.set('model', 'whisper-1');
  form.set('file', new Blob([new Uint8Array([7, 7])], { type: 'audio/wav' }), 'a.wav');
  const cat2 = parseCatalogue([{ ...base, id: 'a', name: 'A', baseUrl: 'https://a.example/v1', media: [{ id: 'stt', kind: 'transcription', quality: 0.5 }] }]);
  let got: FormData | undefined, url = '';
  const d = { ...deps(() => new Response('{"text":"hi"}')), catalogue: cat2 };
  d.fetch = (async (u: string, init: RequestInit) => { url = u; got = init.body as FormData; return new Response('{"text":"hi"}'); }) as any;
  await routeMedia('transcription', { form }, d);
  assert.equal(url, 'https://a.example/v1/audio/transcriptions');
  assert.equal(got!.get('model'), 'stt');
  assert.equal((got!.get('file') as File).name, 'a.wav');
});

test('routeMedia counts each request against the model limits', async () => {
  const d = deps(() => new Response('{"data":[]}'));
  await routeMedia('image', { json: { prompt: 'cat' } }, d);
  await assert.rejects(routeMedia('image', { json: { prompt: 'dog' } }, d), NoCapacityError);
});

test('routeMedia with no provider for the kind says so', async () => {
  await assert.rejects(routeMedia('video', { json: { prompt: 'x' } }, deps(() => new Response('{}'))), /No free provider/);
});

test('naming a catalogue media model pins the request to it (embeddings from different models do not mix)', async () => {
  const seen: any[] = [];
  const r = await routeMedia('embedding', { json: { model: 'emb-b', input: 'x' } }, deps(() => new Response('{}'), seen));
  assert.equal(r.candidate.key, 'b/emb-b');
  const r2 = await routeMedia('embedding', { json: { model: 'a/emb-a', input: 'x' } }, deps(() => new Response('{}')));
  assert.equal(r2.candidate.key, 'a/emb-a');
  // A pinned model that is busy does not fall over to another one.
  await assert.rejects(routeMedia('embedding', { json: { model: 'emb-b', input: 'x' } }, deps(() => new Response('{}', { status: 503 }))), NoCapacityError);
});

// Cloudflare: the account goes into the address, and image, speech and transcription use its own /run format.
const cfCat = parseCatalogue([{ ...base, id: 'cf', name: 'CF', baseUrl: 'https://cf.example/accounts/{account}/ai/v1', media: [
  { id: '@cf/emb', kind: 'embedding', quality: 0.5 },
  { id: '@cf/flux', kind: 'image', quality: 0.5, api: 'workers-ai' },
  { id: '@cf/aura', kind: 'speech', quality: 0.5, api: 'workers-ai' },
  { id: '@cf/whisper', kind: 'transcription', quality: 0.5, api: 'workers-ai' },
] }]);
function cfDeps(reply: (url: string, init: RequestInit) => Response, seen: { url: string; init: RequestInit }[]): RouteDeps {
  return { ...deps(reply, seen), catalogue: cfCat, keys: (id) => (id === 'cf' ? 'acct1:tok' : null) };
}

test('Cloudflare embeddings use the OpenAI path with the account in the address', async () => {
  const seen: any[] = [];
  await routeMedia('embedding', { json: { input: 'x' } }, cfDeps(() => new Response('{}'), seen));
  assert.equal(seen[0].url, 'https://cf.example/accounts/acct1/ai/v1/embeddings');
  assert.equal(new Headers(seen[0].init.headers).get('authorization'), 'Bearer tok');
});

test('Cloudflare images: OpenAI request in, /run request out, base64 image back as data[].b64_json', async () => {
  const seen: any[] = [];
  const { response } = await routeMedia('image', { json: { prompt: 'a cat', n: 1, size: '1024x1024' } },
    cfDeps(() => new Response(JSON.stringify({ result: { image: 'QUJD' }, success: true })), seen));
  assert.equal(seen[0].url, 'https://cf.example/accounts/acct1/ai/run/@cf/flux');
  assert.deepEqual(JSON.parse(seen[0].init.body), { prompt: 'a cat' });
  const j: any = await response.json();
  assert.equal(j.data[0].b64_json, 'QUJD');
  assert.equal(typeof j.created, 'number');
});

test('Cloudflare speech: input becomes text, a known voice becomes the speaker, audio passes through', async () => {
  const seen: any[] = [];
  const { response } = await routeMedia('speech', { json: { input: 'hello', voice: 'luna' } },
    cfDeps(() => new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/mpeg' } }), seen));
  assert.deepEqual(JSON.parse(seen[0].init.body), { text: 'hello', speaker: 'luna' });
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2]);
  await routeMedia('speech', { json: { input: 'hi', voice: 'alloy' } }, cfDeps(() => new Response('x'), seen));
  assert.deepEqual(JSON.parse(seen[1].init.body), { text: 'hi' }); // an OpenAI voice name is left out
});

test('Cloudflare transcription: the uploaded file goes as base64, the text comes back OpenAI-shaped', async () => {
  const seen: any[] = [];
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array([104, 105])]), 'a.wav');
  form.set('language', 'en');
  form.set('prompt', 'names');
  const { response } = await routeMedia('transcription', { form },
    cfDeps(() => new Response(JSON.stringify({ result: { text: 'hi there', vtt: 'WEBVTT' }, success: true })), seen));
  assert.deepEqual(JSON.parse(seen[0].init.body), { audio: 'aGk=', language: 'en', initial_prompt: 'names' });
  assert.deepEqual(await response.json(), { text: 'hi there' });
  const form2 = new FormData();
  form2.set('file', new Blob([new Uint8Array([1])]), 'a.wav');
  form2.set('response_format', 'text');
  const r2 = await routeMedia('transcription', { form: form2 }, cfDeps(() => new Response(JSON.stringify({ result: { text: 'plain' } })), seen));
  assert.equal(await r2.response.text(), 'plain');
});

test('catalogue rejects an unknown media api', () => {
  assert.throws(() => parseCatalogue([{ ...base, id: 'x', name: 'X', baseUrl: 'https://x.example', media: [{ id: 'm', kind: 'image', quality: 0.5, api: 'other' }] }]), /api/);
});

test('routeMedia waits as long as the provider asks after a 429', async () => {
  const d = deps(() => new Response('{}', { status: 429, headers: { 'retry-after': '3600' } }));
  await assert.rejects(routeMedia('image', { json: { prompt: 'cat' } }, d), NoCapacityError);
  const until = Math.max(...Object.values(d.tracker.state.cooling));
  assert.ok(until - d.tracker.now() > 3_000_000, 'cooling for about an hour, not a minute');
});
