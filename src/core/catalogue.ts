export interface Limits { rpm?: number; rpd?: number; tpm?: number; tpd?: number }
export interface Model { id: string; context: number; tools: boolean; images: boolean; quality: number; limits?: Limits }
export const MEDIA_KINDS = ['embedding', 'completion', 'image', 'speech', 'transcription', 'video'] as const;
export type MediaKind = typeof MEDIA_KINDS[number];
// Non-chat models live apart from `models` so older clients, which treat every model as chat, never pick one.
// api 'workers-ai': Cloudflare's own /run/<model> format instead of the OpenAI one.
export interface MediaModel { id: string; kind: MediaKind; quality: number; limits?: Limits; baseUrl?: string; path?: string; context?: number; api?: 'workers-ai' }
export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  keyless: boolean;
  paid: boolean;
  terms: 'ok' | 'caution';
  termsNote?: string;
  signupUrl?: string;
  keyUrl?: string;
  steps: string[];
  keyPattern?: string;
  connect?: 'openrouter';
  referral?: boolean; // signupUrl carries a referral code; always labelled where shown
  discover?: string; // regex of model ids the catalogue service may add automatically
  limits?: Limits;
  models: Model[];
  media?: MediaModel[];
}

// A provider whose address holds the account ({account}) is given its key as "account:token".
export function endpoint(base: string, key: string | null): { base: string; key: string | null } {
  if (!base.includes('{account}') || !key) return { base, key };
  const i = key.indexOf(':');
  return { base: base.replace('{account}', encodeURIComponent(key.slice(0, i))), key: key.slice(i + 1) };
}

export const needsAccount = (p: Pick<Provider, 'baseUrl'>) => p.baseUrl.includes('{account}');
// The stored key for such a provider; null when either part is missing or the account is not a plain id.
export function joinAccount(account: string, token: string): string | null {
  const a = account.trim(), t = token.trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(a) && t ? `${a}:${t}` : null;
}

function fail(where: string, field: string): never {
  throw new Error(`catalogue: ${where} has an invalid or missing "${field}"`);
}

export function parseCatalogue(json: unknown): Provider[] {
  if (!Array.isArray(json)) throw new Error('catalogue: expected a list of providers');
  return json.map((p: any, i): Provider => {
    const where = typeof p?.id === 'string' ? p.id : `provider #${i}`;
    for (const f of ['id', 'name', 'baseUrl'] as const) if (typeof p?.[f] !== 'string' || !p[f]) fail(where, f);
    if (!p.baseUrl.startsWith('https://')) fail(where, 'baseUrl');
    for (const f of ['keyless', 'paid'] as const) if (typeof p[f] !== 'boolean') fail(where, f);
    if (p.terms !== 'ok' && p.terms !== 'caution') fail(where, 'terms');
    if (!Array.isArray(p.steps)) fail(where, 'steps');
    if (!Array.isArray(p.models) || p.models.length === 0) fail(where, 'models');
    for (const m of p.models) {
      const mw = `${where}/${m?.id ?? '?'}`;
      if (typeof m?.id !== 'string') fail(where, 'models.id');
      if (!Number.isInteger(m.context) || m.context <= 0) fail(mw, 'context');
      if (typeof m.tools !== 'boolean') fail(mw, 'tools');
      if (typeof m.images !== 'boolean') fail(mw, 'images');
      if (typeof m.quality !== 'number' || m.quality < 0 || m.quality > 1) fail(mw, 'quality');
    }
    for (const m of p.media ?? []) {
      const mw = `${where}/${m?.id ?? '?'}`;
      if (typeof m?.id !== 'string') fail(where, 'media.id');
      if (!MEDIA_KINDS.includes(m.kind)) fail(mw, 'kind');
      if (typeof m.quality !== 'number' || m.quality < 0 || m.quality > 1) fail(mw, 'quality');
      if (m.baseUrl !== undefined && !String(m.baseUrl).startsWith('https://')) fail(mw, 'baseUrl');
      if (m.api !== undefined && m.api !== 'workers-ai') fail(mw, 'api');
      if (m.path !== undefined && !/^\/[\w\-./]*$/.test(m.path)) fail(mw, 'path'); // a path, never a new host
    }
    if (p.keyPattern !== undefined) new RegExp(p.keyPattern); // throws on a bad pattern
    if (p.discover !== undefined) new RegExp(p.discover);
    return p as Provider;
  });
}
