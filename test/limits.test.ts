import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LimitTracker, emptyState } from '../src/core/limits.ts';

const K = 'groq/m';
function clock(start = Date.UTC(2026, 10, 22, 10, 0, 0)) {
  const c = { t: start, now: () => c.t };
  return c;
}

test('blocks the request after rpm is reached', () => {
  const c = clock();
  const t = new LimitTracker(emptyState(), c.now);
  t.record(K, 10, true, 100);
  t.record(K, 10, true, 100);
  assert.equal(t.allows(K, { rpm: 2 }, 10), false);
  c.t += 61_000;
  assert.equal(t.allows(K, { rpm: 2 }, 10), true);
});

test('blocks when tokens would exceed tpm', () => {
  const t = new LimitTracker(emptyState(), clock().now);
  t.record(K, 900, true, 100);
  assert.equal(t.allows(K, { tpm: 1000 }, 200), false);
  assert.equal(t.allows(K, { tpm: 1000 }, 50), true);
});

test('day window resets at UTC midnight', () => {
  const c = clock(Date.UTC(2026, 10, 22, 23, 59, 0));
  const t = new LimitTracker(emptyState(), c.now);
  t.record(K, 10, true, 100);
  assert.equal(t.allows(K, { rpd: 1 }, 10), false);
  c.t = Date.UTC(2026, 10, 23, 0, 0, 1);
  assert.equal(t.allows(K, { rpd: 1 }, 10), true);
});

test('no limits means always allowed', () => {
  const t = new LimitTracker(emptyState(), clock().now);
  for (let i = 0; i < 100; i++) t.record(K, 1000, true, 10);
  assert.equal(t.allows(K, undefined, 1000), true);
});

test('cooldown expires', () => {
  const c = clock();
  const t = new LimitTracker(emptyState(), c.now);
  t.coolDown(K, 30_000);
  assert.ok(t.coolingUntil(K) > 0);
  c.t += 31_000;
  assert.equal(t.coolingUntil(K), 0);
});

test('success rate and speed have neutral priors', () => {
  const t = new LimitTracker(emptyState(), clock().now);
  assert.equal(t.successRate(K), 0.5);
  assert.equal(t.speed(K), 0.5);
  t.record(K, 1, true, 1000);
  assert.equal(t.successRate(K), 2 / 3);
  assert.equal(t.speed(K), 0.5);
  t.record(K, 1, false, 1000);
  assert.equal(t.successRate(K), 0.5);
});

test('observe cools down when the provider reports zero remaining', () => {
  const c = clock();
  const t = new LimitTracker(emptyState(), c.now);
  t.observe(K, new Headers({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1m30s' }));
  assert.equal(t.coolingUntil(K), c.t + 90_000);
  const t2 = new LimitTracker(emptyState(), c.now);
  t2.observe(K, new Headers({ 'x-ratelimit-remaining-requests': '5', 'x-ratelimit-reset-requests': '1m30s' }));
  assert.equal(t2.coolingUntil(K), 0);
});

test('lastModel round-trips per conversation', () => {
  const t = new LimitTracker(emptyState(), clock().now);
  t.setLastModel('conv1', 'groq/m');
  assert.equal(t.lastModel('conv1'), 'groq/m');
  assert.equal(t.lastModel('conv2'), undefined);
});

test('paid cap', () => {
  const c = clock();
  const t = new LimitTracker(emptyState(), c.now);
  for (let i = 0; i < 200; i++) t.recordPaid();
  assert.equal(t.paidAllowed(200), false);
  c.t += 24 * 3600_000;
  assert.equal(t.paidAllowed(200), true);
});

test('usage keeps a daily history per provider, and drops days older than 90', () => {
  let now = Date.UTC(2026, 10, 23, 12);
  const t = new LimitTracker(emptyState(), () => now);
  t.record('groq/m1', 100, true, 400);
  t.record('groq/m1', 50, false, 100);
  t.record('kilo/k', 10, true, 200);
  const day = t.state.usage['2026-11-23'];
  assert.deepEqual({ ok: day.ok, fail: day.fail, tokens: day.tokens, ms: day.ms }, { ok: 2, fail: 1, tokens: 110, ms: 600 });
  assert.deepEqual(day.providers.groq, { ok: 1, fail: 1, tokens: 100 });
  t.state.usage['2026-08-01'] = { ok: 1, fail: 0, tokens: 1, ms: 1, providers: {} };
  now = Date.UTC(2026, 10, 24, 1);
  t.record('kilo/k', 5, true, 10);
  assert.ok(t.state.usage['2026-11-24']);
  assert.ok(!t.state.usage['2026-08-01'], 'old days are dropped');
  assert.ok(t.state.usage['2026-11-23'], 'recent days stay');
});

test('only the newest conversations are remembered', () => {
  const t = new LimitTracker(emptyState());
  for (let i = 0; i < 600; i++) t.setLastModel(`c${i}`, 'p/m');
  t.setLastModel('c100', 'p/m2'); // used again: it becomes the newest
  assert.equal(Object.keys(t.state.lastModel).length, 500);
  assert.equal(t.lastModel('c99'), undefined);
  assert.equal(t.lastModel('c100'), 'p/m2');
  assert.equal(t.lastModel('c599'), 'p/m');
});
