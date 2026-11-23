// Routing for non-chat requests (embeddings, completions, images, speech, transcription, video).
// The body passes through as the provider expects it; only the model is replaced.
import type { MediaKind, MediaModel, Provider } from './catalogue.js';
import type { LimitTracker } from './limits.js';
import { NoCapacityError, type RouteDeps, type RouteOptions, type KeyLookup } from './orchestrator.js';

export const KIND_PATH: Record<MediaKind, string> = {
  embedding: '/embeddings', completion: '/completions', image: '/images/generations',
  speech: '/audio/speech', transcription: '/audio/transcriptions', video: '/videos',
};

export interface MediaCandidate { provider: Provider; model: MediaModel; apiKey: string | null; key: string }
export type MediaBody = { json: Record<string, unknown> } | { form: FormData };

export class NoProviderError extends Error {
  readonly status = 503;
  constructor(kind: MediaKind) { super(`No free provider for ${kind} requests is set up. Run \`freeaitokens list\` to see which providers offer it.`); }
}

const COOL = { rateLimit: 60_000, error: 30_000, auth: 86_400_000, gone: 600_000 };
const MAX_REJECTS = 3;
const MAX_WAIT_MS = 30_000;

// The model a request names, when it is one of ours ("id" or "provider/id"); any other name means "pick one".
export function pinned(kind: MediaKind, catalogue: Provider[], body: MediaBody): string | null {
  const want = 'json' in body ? body.json.model : body.form.get('model');
  if (typeof want !== 'string') return null;
  for (const p of catalogue) for (const m of p.media ?? []) if (m.kind === kind && (want === m.id || want === `${p.id}/${m.id}`)) return want;
  return null;
}

export function mediaCandidates(kind: MediaKind, catalogue: Provider[], keys: KeyLookup, tracker: LimitTracker, opts: RouteOptions, tokens = 0, pin: string | null = null): MediaCandidate[] {
  const paidOk = !opts.freeOnly && tracker.paidAllowed(opts.paidCap);
  const out: { c: MediaCandidate; score: number }[] = [];
  for (const provider of catalogue) {
    if (provider.paid && !paidOk) continue;
    const apiKey = provider.keyless ? null : keys(provider.id);
    if (!provider.keyless && !apiKey) continue;
    for (const model of provider.media ?? []) {
      if (model.kind !== kind) continue;
      const key = `${provider.id}/${model.id}`;
      if (pin && pin !== model.id && pin !== key) continue;
      if (tracker.coolingUntil(key) || !tracker.allows(key, model.limits, tokens)) continue;
      out.push({ c: { provider, model, apiKey, key }, score: (provider.paid ? -1 : 0) + 0.5 * model.quality + 0.3 * tracker.successRate(key) + 0.2 * tracker.speed(key) });
    }
  }
  return out.sort((a, b) => b.score - a.score).map((x) => x.c);
}

// Rough input size, so token limits (tpm/tpd) apply to embeddings and completions.
function tokensOf(body: MediaBody): number {
  if (!('json' in body)) return 0;
  const j = body.json;
  return Math.ceil(JSON.stringify(j.input ?? j.prompt ?? '').length / 4);
}

function requestFor(c: MediaCandidate, body: MediaBody, signal: AbortSignal): RequestInit {
  const auth: Record<string, string> = c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {};
  if ('form' in body) {
    const form = new FormData();
    for (const [k, v] of body.form) if (k !== 'model') form.append(k, v);
    form.set('model', c.model.id);
    return { method: 'POST', headers: auth, body: form, signal };
  }
  return { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ ...body.json, model: c.model.id }), signal };
}

export async function routeMedia(kind: MediaKind, body: MediaBody, deps: RouteDeps, waited = false): Promise<{ response: Response; candidate: MediaCandidate }> {
  const { tracker } = deps;
  if (!deps.catalogue.some((p) => (p.media ?? []).some((m) => m.kind === kind))) throw new NoProviderError(kind);
  const tokens = tokensOf(body);
  let rejected: { response: Response; candidate: MediaCandidate } | null = null, rejects = 0;
  // Embeddings from different models cannot be compared, so a named model is never swapped for another.
  const list = mediaCandidates(kind, deps.catalogue, deps.keys, tracker, deps.opts, tokens, pinned(kind, deps.catalogue, body));
  if (!list.length && !deps.catalogue.some((p) => (p.keyless || deps.keys(p.id)) && (p.media ?? []).some((m) => m.kind === kind))) throw new NoProviderError(kind);
  for (const c of list) {
    const start = tracker.now();
    const fail = (ms: number) => { tracker.record(c.key, tokens, false, tracker.now() - start); tracker.coolDown(c.key, ms); };
    let res: Response;
    try {
      // Generation can be slow (images, speech): allow two minutes for the headers.
      res = await deps.fetch(`${c.model.baseUrl ?? c.provider.baseUrl}${c.model.path ?? KIND_PATH[kind]}`, requestFor(c, body, AbortSignal.timeout(120_000)));
    } catch {
      fail(COOL.error);
      continue;
    }
    tracker.observe(c.key, res.headers);
    if (res.status === 429) { fail(COOL.rateLimit); continue; }
    if (res.status === 401 || res.status === 403) { fail(COOL.auth); continue; }
    if (res.status >= 500) { fail(COOL.error); continue; }
    if (res.status >= 400) {
      if (res.status === 404) fail(COOL.gone); else tracker.record(c.key, tokens, false, tracker.now() - start);
      rejected = { response: new Response(await res.text().catch(() => ''), { status: res.status, headers: res.headers }), candidate: c };
      if (++rejects >= MAX_REJECTS) return rejected;
      continue;
    }
    tracker.record(c.key, tokens, true, tracker.now() - start);
    if (c.provider.paid) tracker.recordPaid();
    return { response: res, candidate: c };
  }
  if (rejected) return rejected;
  const cooling = Object.values(tracker.state.cooling).filter((u) => u > tracker.now());
  const retryAt = cooling.length ? Math.min(...cooling) : tracker.now() + COOL.rateLimit;
  if (!waited && retryAt - tracker.now() <= MAX_WAIT_MS) {
    await deps.sleep(retryAt - tracker.now());
    return routeMedia(kind, body, deps, true);
  }
  throw new NoCapacityError('limits', retryAt);
}
