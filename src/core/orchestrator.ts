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
