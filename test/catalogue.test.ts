import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCatalogue } from '../src/core/catalogue.ts';
import { needsOf } from '../src/core/types.ts';

const raw = JSON.parse(readFileSync(new URL('../src/catalogue.json', import.meta.url), 'utf8'));

test('parses the bundled catalogue', () => {
  const ps = parseCatalogue(raw);
  assert.ok(ps.length > 0);
  assert.equal(new Set(ps.map((p) => p.id)).size, ps.length);
  for (const p of ps) {
    assert.match(p.baseUrl, /^https:\/\//, p.id);
    assert.ok(p.models.length >= 1, p.id);
    for (const m of p.models) assert.ok(m.quality >= 0 && m.quality <= 1, `${p.id}/${m.id}`);
  }
  assert.ok(!ps.some((p) => p.id === 'cohere'));
});

test('keyed providers have onboarding data', () => {
  for (const p of parseCatalogue(raw).filter((p) => !p.keyless)) {
    assert.ok(p.keyUrl, p.id);
    assert.ok(p.steps.length > 0, p.id);
  }
});

test('rejects a model with no context', () => {
  const bad = [{ id: 'acme', name: 'Acme', baseUrl: 'https://a.example', keyless: true, paid: false, terms: 'ok', steps: [], models: [{ id: 'm', tools: true, images: false, quality: 0.5 }] }];
  assert.throws(() => parseCatalogue(bad), (e: Error) => e.message.includes('acme') && e.message.includes('context'));
});

test('needsOf detects tools and images', () => {
  assert.equal(needsOf({ messages: [{ role: 'user', content: 'hi' }], tools: [{}] }).tools, true);
  assert.equal(needsOf({ messages: [{ role: 'user', content: 'hi' }] }).tools, false);
  const img = needsOf({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] }] });
  assert.equal(img.images, true);
});

test('needsOf gives the same conversation id across turns of one chat', () => {
  const first = needsOf({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'fix the bug' }] });
  const later = needsOf({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'fix the bug' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'thanks' }] });
  const other = needsOf({ messages: [{ role: 'user', content: 'something else' }] });
  assert.equal(first.conversationId, later.conversationId);
  assert.notEqual(first.conversationId, other.conversationId);
  assert.ok(later.tokens > first.tokens);
});
