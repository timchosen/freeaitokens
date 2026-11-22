import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callUpstream } from '../src/core/upstream.ts';
import { parseCatalogue } from '../src/core/catalogue.ts';
import type { Candidate } from '../src/core/orchestrator.ts';

const [p] = parseCatalogue([{ id: 'x', name: 'X', baseUrl: 'https://x.example/v1', keyless: false, paid: false, terms: 'ok', steps: [], models: [{ id: 'real-model', context: 1000, tools: true, images: false, quality: 0.5 }] }]);
const cand = (apiKey: string | null): Candidate => ({ provider: p, model: p.models[0], apiKey, key: 'x/real-model' });

function spy() {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}'); }) as unknown as typeof fetch;
  return { calls, f };
}

test('omits Authorization for a keyless provider', async () => {
  const s = spy();
  await callUpstream(cand(null), { messages: [] }, s.f);
  assert.equal(new Headers(s.calls[0].init.headers).get('authorization'), null);
});

test('sends Bearer key otherwise', async () => {
  const s = spy();
  await callUpstream(cand('sk-1'), { messages: [] }, s.f);
  assert.equal(new Headers(s.calls[0].init.headers).get('authorization'), 'Bearer sk-1');
  assert.equal(s.calls[0].url, 'https://x.example/v1/chat/completions');
});

test('overrides model id', async () => {
  const s = spy();
  await callUpstream(cand('k'), { messages: [], model: 'free' }, s.f);
  assert.equal(JSON.parse(s.calls[0].init.body as string).model, 'real-model');
});
