import type { Provider, Model } from './catalogue.js';
import type { LimitTracker } from './limits.js';
import type { Needs } from './types.js';

export interface Candidate { provider: Provider; model: Model; apiKey: string | null; key: string }
export interface RouteOptions { freeOnly: boolean; paidCap: number }
export type KeyLookup = (providerId: string) => string | null;

const STICKY_MARGIN = 0.05;

export function candidates(needs: Needs, catalogue: Provider[], keys: KeyLookup, tracker: LimitTracker, opts: RouteOptions): Candidate[] {
  const paidOk = !opts.freeOnly && tracker.paidAllowed(opts.paidCap);
  const scored: { c: Candidate; score: number }[] = [];
  for (const provider of catalogue) {
    if (provider.paid && !paidOk) continue;
    const apiKey = provider.keyless ? null : keys(provider.id);
    if (!provider.keyless && !apiKey) continue;
    for (const model of provider.models) {
      const key = `${provider.id}/${model.id}`;
      if (model.context < needs.tokens) continue;
      if (needs.tools && !model.tools) continue;
      if (needs.images && !model.images) continue;
      if (tracker.coolingUntil(key)) continue;
      if (!tracker.allows(key, model.limits, needs.tokens)) continue;
      const score = 0.5 * model.quality + 0.3 * tracker.successRate(key) + 0.2 * tracker.speed(key);
      scored.push({ c: { provider, model, apiKey, key }, score });
    }
  }
  const last = tracker.lastModel(needs.conversationId);
  const tier = (paid: boolean) => {
    const t = scored.filter((s) => s.c.provider.paid === paid).sort((a, b) => b.score - a.score);
    const i = t.findIndex((s) => s.c.key === last);
    if (i > 0 && t[0].score - t[i].score <= STICKY_MARGIN) t.unshift(...t.splice(i, 1));
    return t.map((s) => s.c);
  };
  return [...tier(false), ...tier(true)];
}

// ── route: try candidates in order, fail over on provider trouble ─────────────

import { parseDuration } from './limits.js';
import { needsOf, type ChatRequest } from './types.js';
import { callUpstream, type Fetch } from './upstream.js';

export class NoCapacityError extends Error {
  constructor(readonly reason: 'limits' | 'too-large', readonly retryAt: number) {
    super(reason === 'too-large'
      ? 'This conversation is too long for every available free model.'
      : `All free models are at their limits. Capacity returns at ${new Date(retryAt).toISOString()}.`);
  }
}

export interface RouteDeps {
  catalogue: import('./catalogue.js').Provider[];
  keys: KeyLookup;
  tracker: LimitTracker;
  fetch: Fetch;
  opts: RouteOptions;
  sleep: (ms: number) => Promise<void>;
  onPaid?: (c: Candidate) => void;
  idleMs?: number; // longest silence from a provider before it counts as stalled
}

const MAX_WAIT_MS = 30_000;
const COOL = { rateLimit: 60_000, error: 30_000, auth: 86_400_000, gone: 600_000 };
const IDLE_MS = 60_000;
const MAX_REJECTS = 3; // a request three providers reject is probably the client's to fix

// Rejects if p takes longer than ms.
function timed<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error('provider stalled')), ms); })]).finally(() => clearTimeout(t));
}
const enc = new TextEncoder();
const dec = new TextDecoder();
const ERROR_LINE = enc.encode('data: {"error":{"message":"upstream ended before the answer was complete"}}\n\n');

function retryAfterMs(h: Headers, now: number): number {
  const v = h.get('retry-after');
  const d = parseDuration(v);
  if (d !== null) return d;
  const at = v ? Date.parse(v) : NaN;
  return Number.isNaN(at) ? COOL.rateLimit : Math.max(0, at - now);
}

// Read until the first `data:` line. Returns the buffered chunks and the live reader, or null on failure.
async function peek(body: ReadableStream<Uint8Array>, idleMs: number): Promise<{ head: Uint8Array[]; reader: ReadableStreamDefaultReader<Uint8Array> } | null> {
  const reader = body.getReader();
  const head: Uint8Array[] = [];
  let text = '';
  try {
    while (!/(^|\n)data:/.test(text)) {
      const { done, value } = await timed(reader.read(), idleMs);
      if (done) return null;
      head.push(value);
      text += dec.decode(value, { stream: true });
    }
    return { head, reader };
  } catch {
    reader.cancel().catch(() => {});
    return null;
  }
}

// Replays the peeked chunks, then the rest; appends an error line if the source fails or never sends [DONE].
function guarded(head: Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>, idleMs: number): ReadableStream<Uint8Array> {
  let tail = '';
  const see = (c: Uint8Array) => { tail = (tail + dec.decode(c, { stream: true })).slice(-32); return c; };
  head.forEach(see);
  return new ReadableStream({
    start(ctl) { for (const c of head) ctl.enqueue(c); },
    async pull(ctl) {
      try {
        const { done, value } = await timed(reader.read(), idleMs);
        if (!done) { ctl.enqueue(see(value)); return; }
        if (!tail.includes('[DONE]')) ctl.enqueue(ERROR_LINE);
      } catch {
        ctl.enqueue(ERROR_LINE);
        reader.cancel().catch(() => {});
      }
      ctl.close();
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

export async function route(req: ChatRequest, deps: RouteDeps, waited = false): Promise<{ response: Response; candidate: Candidate }> {
  const { tracker } = deps;
  const needs = needsOf(req);
  if (!deps.catalogue.some((p) => p.models.some((m) => m.context >= needs.tokens))) {
    throw new NoCapacityError('too-large', tracker.now());
  }
  const idleMs = deps.idleMs ?? IDLE_MS;
  let rejected: { response: Response; candidate: Candidate } | null = null, rejects = 0;
  for (const c of candidates(needs, deps.catalogue, deps.keys, tracker, deps.opts)) {
    const start = tracker.now();
    const fail = (coolMs: number) => { tracker.record(c.key, needs.tokens, false, tracker.now() - start); tracker.coolDown(c.key, coolMs); };
    let res: Response;
    try {
      res = await callUpstream(c, req, deps.fetch);
    } catch {
      fail(COOL.error);
      continue;
    }
    tracker.observe(c.key, res.headers);
    if (res.status === 429) { fail(retryAfterMs(res.headers, tracker.now())); continue; }
    if (res.status === 401 || res.status === 403) { fail(COOL.auth); continue; }
    if (res.status >= 500) { fail(COOL.error); continue; }
    if (res.status >= 400) {
      // Usually provider-specific (stale model id, schema dialect, context size): try the next one.
      if (res.status === 404) fail(COOL.gone);
      else tracker.record(c.key, needs.tokens, false, tracker.now() - start);
      rejected = { response: new Response(await timed(res.text(), idleMs).catch(() => ''), { status: res.status, headers: res.headers }), candidate: c };
      if (++rejects >= MAX_REJECTS) return rejected;
      continue;
    }

    let response: Response;
    if (req.stream) {
      const p = res.body ? await peek(res.body, idleMs) : null;
      if (!p) { fail(COOL.error); continue; }
      response = new Response(guarded(p.head, p.reader, idleMs), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    } else {
      const text = await timed(res.text(), idleMs).catch(() => { res.body?.cancel().catch(() => {}); return ''; });
      let json: any;
      try { json = JSON.parse(text); } catch { /* handled below */ }
      if (!Array.isArray(json?.choices)) { fail(COOL.error); continue; }
      response = new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    tracker.record(c.key, needs.tokens, true, tracker.now() - start);
    tracker.setLastModel(needs.conversationId, c.key);
    if (c.provider.paid) { tracker.recordPaid(); deps.onPaid?.(c); }
    return { response, candidate: c };
  }

  if (rejected) return rejected;
  const cooling = Object.values(tracker.state.cooling).filter((u) => u > tracker.now());
  const retryAt = cooling.length ? Math.min(...cooling) : tracker.now() + COOL.rateLimit;
  if (!waited && retryAt - tracker.now() <= MAX_WAIT_MS) {
    await deps.sleep(retryAt - tracker.now());
    return route(req, deps, true);
  }
  throw new NoCapacityError('limits', retryAt);
}
