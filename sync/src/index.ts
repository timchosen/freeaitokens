// FreeAITokens sync server: stores encrypted blobs it cannot read, sells sync through Stripe.
import { authLicense, json } from './auth.ts';
import { items } from './items.ts';

// Minimal shapes of the Cloudflare bindings this Worker uses.
interface Stmt { bind(...a: unknown[]): Stmt; first<T = Record<string, any>>(col?: string): Promise<T | null>; all<T = Record<string, any>>(): Promise<{ results: T[] }>; run(): Promise<{ meta: { changes: number } }> }
export interface D1 { prepare(sql: string): Stmt; batch(s: Stmt[]): Promise<unknown[]> }
export interface R2 { put(k: string, v: ArrayBuffer | Uint8Array | string): Promise<unknown>; get(k: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>; delete(k: string | string[]): Promise<void> }
export interface Env {
  SYNC_DB: D1; SYNC_BLOBS: R2; EMAIL: { send(m: { to: string; from: string; subject: string; text: string }): Promise<unknown> };
  STRIPE_SECRET_KEY: string; STRIPE_WEBHOOK_SECRET: string; LICENSE_SECRET: string; EMAIL_SECRET: string;
  STRIPE_PRICE_YEAR: string; STRIPE_PRICE_LIFE: string; SITE_URL: string;
}

async function route(req: Request, env: Env, now: number): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (!pathname.startsWith('/v1/')) return json({ error: 'not found' }, 404);
  const a = await authLicense(req, env, now);
  if (!a.ok) return a.res;
  if (pathname === '/v1/usage' && req.method === 'GET') {
    const c = await env.SYNC_DB.prepare('SELECT (SELECT COUNT(*) FROM items WHERE key_hash = ?1 AND deleted = 0) AS items, COALESCE((SELECT bytes FROM counters WHERE key_hash = ?1), 0) AS bytes').bind(a.lic.key_hash).first<{ items: number; bytes: number }>();
    return json({ items: c!.items, bytes: c!.bytes, plan: a.lic.plan, paid_until: a.lic.paid_until });
  }
  return (await items(req, env, a.lic, pathname, now)) ?? json({ error: 'not found' }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try { return await route(req, env, Date.now()); } catch (e) { console.error(e); return json({ error: 'server error' }, 500); }
  },
};
