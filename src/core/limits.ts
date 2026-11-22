import type { Limits } from './catalogue.js';

// Fixed windows: [windowStartMs, requests, tokens]. Keys are `${providerId}/${modelId}`.
type Window = [number, number, number];
export interface LimitState {
  windows: Record<string, { minute: Window; day: Window }>;
  cooling: Record<string, number>;
  stats: Record<string, { ok: number; fail: number; msAvg: number }>;
  lastModel: Record<string, string>;
  paidDay: [number, number];
}

export function emptyState(): LimitState {
  return { windows: {}, cooling: {}, stats: {}, lastModel: {}, paidDay: [0, 0] };
}

const MIN = 60_000;
const DAY = 86_400_000;

// "1m30s", "2.5s", "500ms", "45" (seconds) -> ms; null when unreadable.
export function parseDuration(v: string | null): number | null {
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(parseFloat(v) * 1000);
  let ms = 0;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = re.exec(v))) {
    any = true;
    ms += parseFloat(m[1]) * { ms: 1, s: 1000, m: MIN, h: 3_600_000 }[m[2] as 'ms' | 's' | 'm' | 'h'];
  }
  return any ? Math.round(ms) : null;
}

export class LimitTracker {
  constructor(readonly state: LimitState, readonly now: () => number = Date.now) {}

  private win(key: string): { minute: Window; day: Window } {
    const t = this.now();
    const m = Math.floor(t / MIN) * MIN;
    const d = Math.floor(t / DAY) * DAY;
    const w = (this.state.windows[key] ??= { minute: [m, 0, 0], day: [d, 0, 0] });
    if (w.minute[0] !== m) w.minute = [m, 0, 0];
    if (w.day[0] !== d) w.day = [d, 0, 0];
    return w;
  }

  allows(key: string, limits: Limits | undefined, tokens: number): boolean {
    if (!limits) return true;
    const { minute, day } = this.win(key);
    if (limits.rpm !== undefined && minute[1] + 1 > limits.rpm) return false;
    if (limits.rpd !== undefined && day[1] + 1 > limits.rpd) return false;
    if (limits.tpm !== undefined && minute[2] + tokens > limits.tpm) return false;
    if (limits.tpd !== undefined && day[2] + tokens > limits.tpd) return false;
    return true;
  }

  record(key: string, tokens: number, ok: boolean, ms: number): void {
    const w = this.win(key);
    w.minute[1]++; w.minute[2] += tokens;
    w.day[1]++; w.day[2] += tokens;
    const s = (this.state.stats[key] ??= { ok: 0, fail: 0, msAvg: 0 });
    const n = s.ok + s.fail;
    s.msAvg = (s.msAvg * n + ms) / (n + 1);
    if (ok) s.ok++; else s.fail++;
  }

  coolDown(key: string, ms: number): void {
    this.state.cooling[key] = Math.max(this.state.cooling[key] ?? 0, this.now() + ms);
  }

  coolingUntil(key: string): number {
    const u = this.state.cooling[key] ?? 0;
    if (u <= this.now()) { delete this.state.cooling[key]; return 0; }
    return u;
  }

  successRate(key: string): number {
    const s = this.state.stats[key];
    return ((s?.ok ?? 0) + 1) / ((s?.ok ?? 0) + (s?.fail ?? 0) + 2);
  }

  speed(key: string): number {
    const s = this.state.stats[key];
    return s && s.ok + s.fail > 0 ? 1 / (1 + s.msAvg / 1000) : 0.5;
  }

  observe(key: string, headers: Headers): void {
    if (headers.get('x-ratelimit-remaining-requests') !== '0') return;
    this.coolDown(key, parseDuration(headers.get('x-ratelimit-reset-requests')) ?? MIN);
  }

  lastModel(conversationId: string): string | undefined { return this.state.lastModel[conversationId]; }
  setLastModel(conversationId: string, key: string): void { this.state.lastModel[conversationId] = key; }

  private paid(): [number, number] {
    const d = Math.floor(this.now() / DAY) * DAY;
    if (this.state.paidDay[0] !== d) this.state.paidDay = [d, 0];
    return this.state.paidDay;
  }
  paidAllowed(cap: number): boolean { return this.paid()[1] < cap; }
  recordPaid(): void { this.paid()[1]++; }
}
