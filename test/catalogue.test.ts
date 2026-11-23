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

test('endpoint fills {account} from an "account:token" key, and leaves other providers alone', async () => {
  const { endpoint } = await import('../src/core/catalogue.ts');
  assert.deepEqual(endpoint('https://a.example/accounts/{account}/ai/v1', 'abc:tok'), { base: 'https://a.example/accounts/abc/ai/v1', key: 'tok' });
  assert.deepEqual(endpoint('https://a.example/v1', 'k:with:colons'), { base: 'https://a.example/v1', key: 'k:with:colons' });
  assert.deepEqual(endpoint('https://a.example/v1', null), { base: 'https://a.example/v1', key: null });
  // An account that is not a plain id never changes the host or path.
  assert.equal(endpoint('https://a.example/accounts/{account}/ai', '../../evil:tok').base, 'https://a.example/accounts/..%2F..%2Fevil/ai');
});

test('joinAccount makes the stored "account:token" key and refuses an account that is not a plain id', async () => {
  const { joinAccount, needsAccount } = await import('../src/core/catalogue.ts');
  assert.equal(joinAccount(' 0123abcd ', ' tok '), '0123abcd:tok');
  assert.equal(joinAccount('a/b', 'tok'), null);
  assert.equal(joinAccount('', 'tok'), null);
  assert.equal(joinAccount('abc', ''), null);
  assert.equal(needsAccount({ baseUrl: 'https://x/accounts/{account}/ai/v1' } as any), true);
  assert.equal(needsAccount({ baseUrl: 'https://x/v1' } as any), false);
});
