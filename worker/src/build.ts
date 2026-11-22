import type { Model, Provider } from '../../src/core/catalogue.js';

type Fetch = typeof fetch;
export interface Envelope { payload: string; signature: string }

const PROBE_TIMEOUT_MS = 20_000;
const MAX_NEW_PER_RUN = 10;
const NOT_CHAT = /whisper|tts|speech|embed|guard|moderation|rerank|image|audio|orpheus|transcri/i;
const GONE = /not[ _-]?found|does not exist|decommission|deprecated|no longer (available|supported)|unknown model|invalid model/i;

// One small tool-call request: is the model alive, and does it call tools?
async function probe(p: Provider, modelId: string, key: string | undefined, f: Fetch): Promise<'ok' | 'gone' | 'unsure' | { tools: boolean }> {
  let res: Response;
  try {
    res = await f(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: modelId, max_tokens: 200,
        messages: [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
        tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return 'unsure';
  }
  const text = await res.text().catch(() => '');
  if (res.status === 404) return 'gone';
  if (res.status === 400 && GONE.test(text)) return 'gone';
  if (res.status !== 200) return 'unsure';
  try {
    const j = JSON.parse(text);
    if (!Array.isArray(j?.choices)) return 'unsure';
    return { tools: Array.isArray(j.choices[0]?.message?.tool_calls) && j.choices[0].message.tool_calls.length > 0 };
  } catch {
    return 'unsure';
  }
}

async function listModels(p: Provider, key: string | undefined, f: Fetch): Promise<{ id: string; context?: number }[]> {
  try {
    const r = await f(`${p.baseUrl}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const j: any = await r.json();
    return (Array.isArray(j?.data) ? j.data : []).filter((m: any) => typeof m?.id === 'string')
      .map((m: any) => ({ id: m.id, context: Number(m.context_length ?? m.context_window) || undefined }));
  } catch {
    return [];
  }
}

// What the service remembers between runs, so each run can test only part of the list.
export interface ProbeState { probedAt: Record<string, number>; gone: Record<string, number>; found: Record<string, Model[]> }
export const emptyProbeState = (): ProbeState => ({ probedAt: {}, gone: {}, found: {} });

// Refreshes the repo's catalogue against the providers themselves. Providers come only from `base`.
// `budget` caps outbound calls (Workers free plan: 50 per run); models checked longest ago go first.
export async function buildCatalogue(base: Provider[], keyFor: (id: string) => string | undefined, f: Fetch,
  state: ProbeState = emptyProbeState(), budget = 40, now = Date.now()): Promise<{ providers: Provider[]; state: ProbeState }> {
  const usable = base.filter((p) => p.keyless || keyFor(p.id));
  const modelsOf = (p: Provider) => {
    const seen = new Set(p.models.map((m) => m.id));
    return [...p.models, ...(state.found[p.id] ?? []).filter((m) => !seen.has(m.id))];
  };
  const tasks = usable.flatMap((p) => modelsOf(p).map((m) => ({ p, m, key: `${p.id}/${m.id}` })))
    .sort((a, b) => (state.probedAt[a.key] ?? 0) - (state.probedAt[b.key] ?? 0));
  for (const t of tasks) {
    if (budget <= 0) break;
    budget--;
    const r = await probe(t.p, t.m.id, keyFor(t.p.id), f);
    state.probedAt[t.key] = now;
    if (r === 'gone') state.gone[t.key] = now; else delete state.gone[t.key];
  }
  let fresh = MAX_NEW_PER_RUN;
  for (const p of usable) {
    if (!p.discover || budget <= 1 || fresh <= 0) continue;
    budget--;
    const want = new RegExp(p.discover);
    const known = new Set(modelsOf(p).map((m) => m.id));
    for (const c of await listModels(p, keyFor(p.id), f)) {
      if (budget <= 0 || fresh <= 0) break;
      if (known.has(c.id) || state.gone[`${p.id}/${c.id}`] || !want.test(c.id) || NOT_CHAT.test(c.id)) continue;
      budget--; fresh--;
      const r = await probe(p, c.id, keyFor(p.id), f);
      state.probedAt[`${p.id}/${c.id}`] = now;
      if (r === 'gone') { state.gone[`${p.id}/${c.id}`] = now; continue; }
      if (typeof r !== 'object') continue;
      (state.found[p.id] ??= []).push({ id: c.id, context: c.context ?? 32768, tools: r.tools, images: false, quality: 0.4, ...(p.models[0]?.limits ? { limits: p.models[0].limits } : {}) });
    }
  }
  for (const id of Object.keys(state.found)) state.found[id] = state.found[id].filter((m) => !state.gone[`${id}/${m.id}`]);
  const providers: Provider[] = [];
  for (const p of base) {
    if (!usable.includes(p)) { providers.push(p); continue; } // nothing to test with: publish as the repo has it
    const models = modelsOf(p).filter((m) => !state.gone[`${p.id}/${m.id}`]);
    if (models.length) providers.push({ ...p, models });
  }
  return { providers, state };
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Signs the exact payload bytes with Ed25519. privateKey: base64 PKCS#8 DER.
export async function signPayload(body: { issued: string; providers: Provider[] }, privateKey: string): Promise<Envelope> {
  const payload = JSON.stringify(body);
  const key = await crypto.subtle.importKey('pkcs8', unb64(privateKey), { name: 'Ed25519' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(payload)));
  return { payload, signature: b64(sig) };
}
