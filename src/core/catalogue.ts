export interface Limits { rpm?: number; rpd?: number; tpm?: number; tpd?: number }
export interface Model { id: string; context: number; tools: boolean; images: boolean; quality: number; limits?: Limits }
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
    if (p.keyPattern !== undefined) new RegExp(p.keyPattern); // throws on a bad pattern
    if (p.discover !== undefined) new RegExp(p.discover);
    return p as Provider;
  });
}
