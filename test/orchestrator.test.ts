import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidates, type RouteOptions } from '../src/core/orchestrator.ts';
import { LimitTracker, emptyState } from '../src/core/limits.ts';
import { parseCatalogue, type Provider } from '../src/core/catalogue.ts';
import type { Needs } from '../src/core/types.ts';

const base = { keyless: false, paid: false, terms: 'ok', steps: ['x'], keyUrl: 'https://k', keyPattern: '.+' };
export const fixture: Provider[] = parseCatalogue([
  { ...base, id: 'free1', name: 'Free1', baseUrl: 'https://free1.example/v1', keyless: true, models: [
    { id: 'big', context: 200000, tools: true, images: false, quality: 0.8 },
    { id: 'small', context: 8000, tools: true, images: false, quality: 0.9 },
    { id: 'notools', context: 200000, tools: false, images: true, quality: 0.95 },
  ] },
  { ...base, id: 'free2', name: 'Free2', baseUrl: 'https://free2.example/v1', models: [
    { id: 'm', context: 200000, tools: true, images: false, quality: 0.6 },
  ] },
  { ...base, id: 'paid', name: 'Paid', baseUrl: 'https://paid.example/v1', paid: true, models: [
    { id: 'best', context: 200000, tools: true, images: true, quality: 1 },
  ] },
]);

const allKeys = (id: string) => (id === 'free1' ? null : 'k-' + id);
const opts: RouteOptions = { freeOnly: false, paidCap: 200 };
const needs = (n: Partial<Needs> = {}): Needs => ({ tokens: 1000, tools: false, images: false, conversationId: 'c', ...n });
const ids = (cs: { key: string }[]) => cs.map((c) => c.key);
const tracker = () => new LimitTracker(emptyState(), () => 1_000_000);

test('excludes models without tool support when the request has tools', () => {
  assert.ok(!ids(candidates(needs({ tools: true }), fixture, allKeys, tracker(), opts)).includes('free1/notools'));
  assert.ok(ids(candidates(needs(), fixture, allKeys, tracker(), opts)).includes('free1/notools'));
});

test('excludes models without image support when the request has images', () => {
  assert.deepEqual(ids(candidates(needs({ images: true }), fixture, allKeys, tracker(), opts)), ['free1/notools', 'paid/best']);
});

test('excludes models whose context is too small', () => {
  assert.ok(!ids(candidates(needs({ tokens: 9000 }), fixture, allKeys, tracker(), opts)).includes('free1/small'));
});

test('excludes a keyed provider with no key, includes a keyless one', () => {
  const r = ids(candidates(needs(), fixture, () => null, tracker(), opts));
  assert.ok(r.includes('free1/big'));
  assert.ok(!r.some((k) => k.startsWith('free2/') || k.startsWith('paid/')));
});

test('passes the key through, null for keyless', () => {
  const r = candidates(needs(), fixture, allKeys, tracker(), opts);
  assert.equal(r.find((c) => c.key === 'free2/m')!.apiKey, 'k-free2');
  assert.equal(r.find((c) => c.key === 'free1/big')!.apiKey, null);
});

test('excludes a cooling candidate', () => {
  const t = tracker();
  t.coolDown('free1/big', 60_000);
  assert.ok(!ids(candidates(needs(), fixture, allKeys, t, opts)).includes('free1/big'));
});

test('excludes a candidate over its limits', () => {
  const p = parseCatalogue([{ ...base, id: 'lim', name: 'L', baseUrl: 'https://l.example', keyless: true, models: [{ id: 'm', context: 9000, tools: true, images: false, quality: 0.5, limits: { rpm: 1 } }] }]);
  const t = tracker();
  t.record('lim/m', 10, true, 100);
  assert.deepEqual(candidates(needs(), p, allKeys, t, opts), []);
});

test('free ranks above paid even when paid quality is higher', () => {
  const r = ids(candidates(needs(), fixture, allKeys, tracker(), opts));
  assert.equal(r.at(-1), 'paid/best');
});

test('freeOnly drops paid', () => {
  assert.ok(!ids(candidates(needs(), fixture, allKeys, tracker(), { freeOnly: true, paidCap: 200 })).includes('paid/best'));
});

test('paid dropped when cap reached', () => {
  const t = tracker();
  t.recordPaid();
  assert.ok(!ids(candidates(needs(), fixture, allKeys, t, { freeOnly: false, paidCap: 1 })).includes('paid/best'));
});

test('ranks by quality, success and speed', () => {
  // neutral priors: score = 0.5*q + 0.3*0.5 + 0.2*0.5
  const r = ids(candidates(needs({ tools: true }), fixture, allKeys, tracker(), opts));
  assert.deepEqual(r, ['free1/small', 'free1/big', 'free2/m', 'paid/best']);
});

test('previous model wins a near tie', () => {
  // big: 0.5*0.8+0.25 = 0.65; m with q 0.76: 0.63 -> within 0.05
  const p = parseCatalogue([
    { ...base, id: 'a', name: 'A', baseUrl: 'https://a.example', keyless: true, models: [{ id: 'x', context: 9000, tools: true, images: false, quality: 0.8 }] },
    { ...base, id: 'b', name: 'B', baseUrl: 'https://b.example', keyless: true, models: [{ id: 'y', context: 9000, tools: true, images: false, quality: 0.76 }] },
  ]);
  const t = tracker();
  t.setLastModel('c', 'b/y');
  assert.deepEqual(ids(candidates(needs(), p, allKeys, t, opts)), ['b/y', 'a/x']);
});

test('previous model does not win a clear gap', () => {
  const p = parseCatalogue([
    { ...base, id: 'a', name: 'A', baseUrl: 'https://a.example', keyless: true, models: [{ id: 'x', context: 9000, tools: true, images: false, quality: 0.8 }] },
    { ...base, id: 'b', name: 'B', baseUrl: 'https://b.example', keyless: true, models: [{ id: 'y', context: 9000, tools: true, images: false, quality: 0.4 }] },
  ]);
  const t = tracker();
  t.setLastModel('c', 'b/y');
  assert.deepEqual(ids(candidates(needs(), p, allKeys, t, opts)), ['a/x', 'b/y']);
});
