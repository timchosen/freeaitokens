import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidates, type RouteOptions } from '../src/core/orchestrator.ts';
import { LimitTracker, emptyState } from '../src/core/limits.ts';
import { parseCatalogue, type Provider } from '../src/core/catalogue.ts';
import { needsOf, type Needs } from '../src/core/types.ts';

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

// ── route: trying candidates and failing over ──────────────────────────────
import { route, NoCapacityError, type RouteDeps } from '../src/core/orchestrator.ts';

type Reply = Response | Error | (() => Response);
function deps(replies: Record<string, Reply[]>, extra: Partial<RouteDeps> = {}) {
  const c = { t: 1_000_000 };
  const tracker = new LimitTracker(emptyState(), () => c.t);
  const tried: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const host = new URL(url).hostname.split('.')[0];
    const model = JSON.parse(init.body as string).model;
    const k = `${host}/${model}`;
    tried.push(k);
    const r = replies[k]?.shift();
    if (!r) return JSON.parse(init.body as string).stream
      ? new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      : new Response('{"choices":[{"message":{"content":"ok"}}]}', { status: 200 });
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r;
  }) as unknown as typeof fetch;
  const slept: number[] = [];
  const d: RouteDeps = { catalogue: fixture, keys: allKeys, tracker, fetch: f, opts, sleep: async (ms) => { slept.push(ms); c.t += ms; }, ...extra };
  return { d, tried, slept, tracker, c };
}
const req = { messages: [{ role: 'user' as const, content: 'hi' }], tools: [{}] };
const ok = (s = 'ok') => new Response(JSON.stringify({ choices: [{ message: { content: s } }] }));
// Error is raised on the read after the chunks, as a dropped connection would.
const sse = (chunks: string[], fail = false) => () => {
  const q = [...chunks];
  return new Response(new ReadableStream({
    pull(ctl) {
      const ch = q.shift();
      if (ch !== undefined) ctl.enqueue(new TextEncoder().encode(ch));
      else if (fail) ctl.error(new Error('boom'));
      else ctl.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
};

test('fails over on 429 and cools the first candidate for Retry-After', async () => {
  const { d, tried, tracker, c } = deps({ 'free1/small': [new Response('{}', { status: 429, headers: { 'retry-after': '1.5' } })] });
  const r = await route(req, d);
  assert.deepEqual(tried, ['free1/small', 'free1/big']);
  assert.equal(r.candidate.key, 'free1/big');
  assert.equal(tracker.coolingUntil('free1/small'), c.t + 1500);
});

test('fails over on 500', async () => {
  const { d, tried, tracker, c } = deps({ 'free1/small': [new Response('bad', { status: 500 })] });
  await route(req, d);
  assert.deepEqual(tried, ['free1/small', 'free1/big']);
  assert.equal(tracker.coolingUntil('free1/small'), c.t + 30_000);
});

test('fails over on network error', async () => {
  const { d, tried } = deps({ 'free1/small': [new Error('ECONNRESET')] });
  await route(req, d);
  assert.deepEqual(tried, ['free1/small', 'free1/big']);
});

test('fails over on 401 and cools for a day', async () => {
  const { d, tracker, c } = deps({ 'free1/small': [new Response('{}', { status: 401 })] });
  await route(req, d);
  assert.equal(tracker.coolingUntil('free1/small'), c.t + 86_400_000);
});

test('fails over on a 200 that is not a chat completion', async () => {
  const { d, tried } = deps({ 'free1/small': [new Response('{"error":{"message":"quota"}}')] });
  await route(req, d);
  assert.deepEqual(tried, ['free1/small', 'free1/big']);
});

test('fails over on a 404 and cools that model for 10 minutes', async () => {
  const { d, tried, tracker, c } = deps({ 'free1/small': [new Response('{"error":"model not found"}', { status: 404 })] });
  const r = await route(req, d);
  assert.deepEqual(tried, ['free1/small', 'free1/big']);
  assert.equal(r.response.status, 200);
  assert.equal(tracker.coolingUntil('free1/small'), c.t + 600_000);
});

test('fails over on a 400 without cooling the model', async () => {
  const { d, tried, tracker } = deps({ 'free1/small': [new Response('{"error":"schema"}', { status: 400 })] });
  const r = await route(req, d);
  assert.deepEqual(tried, ['free1/small', 'free1/big']);
  assert.equal(r.response.status, 200);
  assert.equal(tracker.coolingUntil('free1/small'), 0);
});

test('returns the 4xx after three providers reject the request', async () => {
  const bad = () => new Response('{"error":"bad"}', { status: 400 });
  const { d, tried } = deps({ 'free1/small': [bad()], 'free1/big': [bad()], 'free2/m': [bad()] });
  const r = await route(req, d);
  assert.equal(r.response.status, 400);
  assert.deepEqual(tried, ['free1/small', 'free1/big', 'free2/m']);
});

const stalled = (chunks: string[] = []) => () => {
  const q = [...chunks];
  return new Response(new ReadableStream({
    pull(ctl) { const ch = q.shift(); if (ch !== undefined) ctl.enqueue(new TextEncoder().encode(ch)); else return new Promise(() => {}); },
  }), { headers: { 'content-type': 'text/event-stream' } });
};

test('streaming: a stream that stalls before the first data line fails over', async () => {
  const { d, tried } = deps({ 'free1/small': [stalled()] }, { idleMs: 30 });
  const r = await route({ ...req, stream: true }, d);
  assert.deepEqual(tried, ['free1/small', 'free1/big']);
  assert.equal(r.candidate.key, 'free1/big');
});

test('streaming: a stream that stalls mid-answer ends with an error line', async () => {
  const { d } = deps({ 'free1/small': [stalled(['data: {"a":1}\n\n'])] }, { idleMs: 30 });
  const r = await route({ ...req, stream: true }, d);
  assert.match((await r.response.text()).trim().split('\n\n').at(-1)!, /"error"/);
});

test('a non-streaming body that stalls fails over', async () => {
  const { d, tried } = deps({ 'free1/small': [stalled()] }, { idleMs: 30 });
  const r = await route(req, d);
  assert.deepEqual(tried, ['free1/small', 'free1/big']);
  assert.equal(r.response.status, 200);
});

test('an image counts as a fixed number of tokens, not its base64 length', () => {
  const img = { messages: [{ role: 'user' as const, content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(700_000) } }, { type: 'text', text: 'what is this' }] }] };
  const n = needsOf(img as any).tokens;
  assert.ok(n >= 1000 && n < 3000, String(n));
});

test('records the attempt and remembers the model for the conversation', async () => {
  const { d, tracker } = deps({});
  const r = await route(req, d);
  assert.equal(tracker.state.stats['free1/small'].ok, 1);
  assert.equal(tracker.lastModel(needsOf(req).conversationId), r.candidate.key);
});

test('streaming: failure before first data line fails over', async () => {
  const { d, tried } = deps({ 'free1/small': [sse([': keepalive\n\n'], true)] });
  const r = await route({ ...req, stream: true }, d);
  assert.deepEqual(tried, ['free1/small', 'free1/big']);
  assert.equal(r.candidate.key, 'free1/big');
});

test('streaming: passes chunks through and keeps the first data line', async () => {
  const { d } = deps({ 'free1/small': [sse(['data: {"a":1}\n\n', 'data: [DONE]\n\n'])] });
  const r = await route({ ...req, stream: true }, d);
  assert.equal(await r.response.text(), 'data: {"a":1}\n\ndata: [DONE]\n\n');
});

test('streaming: upstream ends abruptly after first chunk', async () => {
  const { d } = deps({ 'free1/small': [sse(['data: {"a":1}\n\n'], true)] });
  const r = await route({ ...req, stream: true }, d);
  const text = await r.response.text();
  assert.ok(text.startsWith('data: {"a":1}\n\n'));
  const last = text.trim().split('\n\n').at(-1)!;
  assert.match(last, /^data: .*"error"/);
});

test('streaming: upstream closes without [DONE] gets an error line', async () => {
  const { d } = deps({ 'free1/small': [sse(['data: {"a":1}\n\n'])] });
  const r = await route({ ...req, stream: true }, d);
  assert.match((await r.response.text()).trim().split('\n\n').at(-1)!, /"error"/);
});

const allCool = (tracker: LimitTracker, ms: number) => { for (const k of ['free1/big', 'free1/small', 'free2/m', 'paid/best']) tracker.coolDown(k, ms); };

test('waits when a cooldown ends in 10 s', async () => {
  const { d, tracker, slept } = deps({});
  allCool(tracker, 10_000);
  const r = await route(req, d);
  assert.deepEqual(slept, [10_000]);
  assert.equal(r.response.status, 200);
});

test('throws NoCapacityError with retryAt when it ends in 5 min', async () => {
  const { d, tracker, slept, c } = deps({});
  allCool(tracker, 300_000);
  await assert.rejects(route(req, d), (e: unknown) => e instanceof NoCapacityError && e.reason === 'limits' && e.retryAt === c.t + 300_000);
  assert.deepEqual(slept, []);
});

test('throws too-large when no model has enough context', async () => {
  const { d, tried } = deps({});
  const huge = { messages: [{ role: 'user' as const, content: 'x'.repeat(1_000_000) }] };
  await assert.rejects(route(huge, d), (e: unknown) => e instanceof NoCapacityError && e.reason === 'too-large');
  assert.deepEqual(tried, []);
});

test('calls onPaid and counts the paid request', async () => {
  const paid: string[] = [];
  const { d, tracker } = deps({}, { onPaid: (c) => paid.push(c.key) });
  for (const k of ['free1/big', 'free1/small', 'free2/m']) tracker.coolDown(k, 3_600_000);
  const r = await route(req, d);
  assert.equal(r.candidate.key, 'paid/best');
  assert.deepEqual(paid, ['paid/best']);
  assert.equal(tracker.paidAllowed(1), false);
});
