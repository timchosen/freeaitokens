import { createPublicKey, verify } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseCatalogue, type Provider } from '../core/catalogue.js';
import { stateDir } from './state.js';

export interface Envelope { payload: string; signature: string }
export interface Signed { issued: string; providers: Provider[] }

const TIMEOUT_MS = 5000;
// A signed list may change a provider's models (or drop the provider). Everything else - where keys go,
// which pages open, the steps users follow - must match the public repo, so the Cloudflare account
// alone cannot redirect anyone.
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as any)[k])])) : v);
const withoutModels = ({ models: _m, ...rest }: Provider) => JSON.stringify(canon(rest));

export function verifyEnvelope(env: unknown, publicKey: string): Signed | null {
  try {
    const e = env as Envelope;
    if (typeof e?.payload !== 'string' || typeof e.signature !== 'string') return null;
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    if (!verify(null, Buffer.from(e.payload), key, Buffer.from(e.signature, 'base64'))) return null;
    const body = JSON.parse(e.payload);
    if (typeof body?.issued !== 'string' || Number.isNaN(Date.parse(body.issued))) return null;
    return { issued: body.issued, providers: parseCatalogue(body.providers) };
  } catch {
    return null;
  }
}

// Every provider must exist in `repo` with the same fields; `allowNew` lets through providers `repo` lacks.
function matchesRepo(providers: Provider[], repo: Provider[], allowNew = false): boolean {
  const byId = new Map(repo.map((p) => [p.id, p]));
  return providers.every((p) => {
    const r = byId.get(p.id);
    return r ? withoutModels(p) === withoutModels(r) : allowNew;
  });
}

export interface FetchOptions { url: string; githubUrl: string; fetch: typeof fetch; publicKey: string; cachedIssued?: string }

// The latest signed list, or null if anything about it is wrong. Never throws.
export async function fetchCatalogue(o: FetchOptions): Promise<(Signed & { envelope: Envelope }) | null> {
  try {
    const get = (u: string) => o.fetch(u, { signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
    const [envelope, repo] = await Promise.all([get(o.url), get(o.githubUrl)]);
    const s = verifyEnvelope(envelope, o.publicKey);
    if (!s) return null;
    if (o.cachedIssued && Date.parse(s.issued) <= Date.parse(o.cachedIssued)) return null; // no rollback
    if (!matchesRepo(s.providers, parseCatalogue(repo))) return null;
    return { ...s, envelope: envelope as Envelope };
  } catch {
    return null;
  }
}

const cacheFile = () => join(stateDir(), 'catalogue.json');

export function readCache(publicKey: string): Signed | null {
  try { return verifyEnvelope(JSON.parse(readFileSync(cacheFile(), 'utf8')), publicKey); } catch { return null; }
}

export function writeCache(env: Envelope): void {
  const f = cacheFile();
  writeFileSync(f + '.tmp', JSON.stringify(env), { mode: 0o600 });
  renameSync(f + '.tmp', f);
}

// Set when the catalogue service is deployed; while empty, the bundled list is always used.
export const CATALOGUE_URL = 'https://freeaitokens-catalogue.cmon-ground-ai.workers.dev/catalogue.json';
export const PUBLIC_KEY = 'MCowBQYDK2VwAyEAQnMYussPFgif+/u6z16moBG07CWjrXpmnPbfeATWvH0=';
export const GITHUB_URL = 'https://raw.githubusercontent.com/timchosen/freeaitokens/main/src/catalogue.json';
const CHECK_EVERY_MS = 6 * 3_600_000;
const CACHE_MAX_AGE_MS = 7 * 86_400_000;

// The cached list, unless it is too old or disagrees with this release about a provider both have
// (a release that moves a provider must win over an older signed list).
export function cachedCatalogue(bundled: Provider[], publicKey: string, now = Date.now()): Provider[] | null {
  const c = readCache(publicKey);
  if (!c || now - Date.parse(c.issued) > CACHE_MAX_AGE_MS) return null;
  return matchesRepo(c.providers, bundled, true) ? c.providers : null;
}

const updatesOff = () => !CATALOGUE_URL || !PUBLIC_KEY || process.env.FREEAITOKENS_CATALOGUE === 'bundled';

// The best list available right now without the network.
export function currentCatalogue(bundled: Provider[]): Provider[] {
  return (updatesOff() ? null : cachedCatalogue(bundled, PUBLIC_KEY)) ?? bundled;
}

// A newer verified list, if one is due and available; caches it. Resolves null otherwise, never throws.
export async function updateCatalogue(f: typeof fetch = fetch): Promise<Provider[] | null> {
  if (updatesOff()) return null;
  try { if (Date.now() - statSync(cacheFile()).mtimeMs < CHECK_EVERY_MS) return null; } catch { /* no cache yet */ }
  const r = await fetchCatalogue({ url: CATALOGUE_URL, githubUrl: GITHUB_URL, fetch: f, publicKey: PUBLIC_KEY, cachedIssued: readCache(PUBLIC_KEY)?.issued });
  if (!r) return null;
  try { writeCache(r.envelope); } catch { /* cache is best effort */ }
  return r.providers;
}
