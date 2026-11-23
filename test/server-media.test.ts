import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer, type ServerHandle } from '../src/node/server.ts';
import { localToken } from '../src/node/state.ts';
import { LimitTracker, emptyState } from '../src/core/limits.ts';
import { parseCatalogue } from '../src/core/catalogue.ts';

const catalogue = parseCatalogue([{ id: 'up', name: 'Up', baseUrl: 'https://up.example/v1', keyless: true, paid: false, terms: 'ok', steps: [],
  models: [{ id: 'real', context: 1000, tools: false, images: false, quality: 0.5 }],
  media: [
    { id: 'emb', kind: 'embedding', quality: 0.5 }, { id: 'tts', kind: 'speech', quality: 0.5 },
    { id: 'stt', kind: 'transcription', quality: 0.5 }, { id: 'vid', kind: 'video', quality: 0.5 },
  ] }]);

let reply: (url: string, init: RequestInit) => Response = () => new Response('{}');
const seen: { url: string; init: RequestInit }[] = [];
let srv: ServerHandle, token: string;
const url = (p: string) => `http://127.0.0.1:${srv.port}${p}`;
const auth = { authorization: '' };

beforeEach(async () => {
  process.env.FREEAITOKENS_HOME = mkdtempSync(join(tmpdir(), 'ft-'));
  token = localToken();
  auth.authorization = `Bearer ${token}`;
  seen.length = 0;
  srv = await startServer({ catalogue, keys: () => null, tracker: new LimitTracker(emptyState()), opts: { freeOnly: false, paidCap: 200 }, sleep: async () => {},
    fetch: (async (u: string, init: RequestInit) => { seen.push({ url: u, init }); return reply(u, init); }) as unknown as typeof fetch }, 0);
});
afterEach(() => srv.close());

test('embeddings go to a provider embedding model and come back as sent', async () => {
  reply = () => new Response('{"object":"list","data":[{"embedding":[0.1]}]}', { headers: { 'content-type': 'application/json' } });
  const r = await fetch(url('/v1/embeddings'), { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'text-embedding-3-small', input: 'hi' }) });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json() as any).data[0].embedding, [0.1]);
  assert.equal(seen[0].url, 'https://up.example/v1/embeddings');
  assert.equal(JSON.parse(seen[0].init.body as string).model, 'emb');
});

test('media endpoints need the local token', async () => {
  const r = await fetch(url('/v1/embeddings'), { method: 'POST', body: '{}' });
  assert.equal(r.status, 401);
});

test('speech returns the audio bytes with their content type', async () => {
  reply = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
  const r = await fetch(url('/v1/audio/speech'), { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ input: 'hello', voice: 'alloy' }) });
  assert.equal(r.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [1, 2, 3]);
});

test('transcription takes multipart and forwards the file', async () => {
  reply = () => new Response('{"text":"hi"}', { headers: { 'content-type': 'application/json' } });
  const form = new FormData();
  form.set('model', 'whisper-1');
  form.set('file', new Blob([new Uint8Array([9])], { type: 'audio/wav' }), 'a.wav');
  const r = await fetch(url('/v1/audio/transcriptions'), { method: 'POST', headers: auth, body: form });
  assert.equal(((await r.json()) as any).text, 'hi');
  const sent = seen[0].init.body as FormData;
  assert.equal(sent.get('model'), 'stt');
  assert.equal((sent.get('file') as File).name, 'a.wav');
});

test('a kind no provider offers gets a clear 503', async () => {
  const r = await fetch(url('/v1/images/generations'), { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'cat' }) });
  assert.equal(r.status, 503);
  assert.match(((await r.json()) as any).error.message, /No free provider/);
});

test('a video job is polled and downloaded from the provider that made it', async () => {
  reply = (u) => u.endsWith('/videos') ? new Response('{"id":"job1","status":"queued"}') : u.endsWith('/content') ? new Response(new Uint8Array([5]), { headers: { 'content-type': 'video/mp4' } }) : new Response('{"id":"job1","status":"completed"}');
  const made: any = await (await fetch(url('/v1/videos'), { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'a cat' }) })).json();
  assert.equal(made.id, 'job1');
  const polled: any = await (await fetch(url('/v1/videos/job1'), { headers: auth })).json();
  assert.equal(polled.status, 'completed');
  assert.equal(seen[1].url, 'https://up.example/v1/videos/job1');
  const file = await fetch(url('/v1/videos/job1/content'), { headers: auth });
  assert.equal(file.headers.get('content-type'), 'video/mp4');
  assert.equal(seen[2].url, 'https://up.example/v1/videos/job1/content');
  assert.equal((await fetch(url('/v1/videos/unknown'), { headers: auth })).status, 404);
});
