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
