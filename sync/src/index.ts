// FreeAITokens sync server: stores encrypted blobs it cannot read, sells sync through Stripe.
import { authLicense, json } from './auth.ts';
import { items } from './items.ts';
import { buy, renew, billing, claim, webhook } from './billing.ts';
import { resend } from './resend.ts';
import { cleanup } from './cleanup.ts';

// Minimal shapes of the Cloudflare bindings this Worker uses.
interface Stmt { bind(...a: unknown[]): Stmt; first<T = Record<string, any>>(col?: string): Promise<T | null>; all<T = Record<string, any>>(): Promise<{ results: T[] }>; run(): Promise<{ meta: { changes: number } }> }
export interface D1 { prepare(sql: string): Stmt; batch(s: Stmt[]): Promise<unknown[]> }
export interface R2 { put(k: string, v: ArrayBuffer | Uint8Array | string): Promise<unknown>; get(k: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>; delete(k: string | string[]): Promise<void> }
export interface Env {
  SYNC_DB: D1; SYNC_BLOBS: R2; EMAIL: { send(m: { to: string; from: string; subject: string; text: string }): Promise<unknown> };
  STRIPE_SECRET_KEY: string; STRIPE_WEBHOOK_SECRET: string; LICENSE_SECRET: string; EMAIL_SECRET: string;
  STRIPE_PRICE_YEAR: string; STRIPE_PRICE_LIFE: string; SITE_URL: string;
}

type Ctx = { waitUntil(p: Promise<unknown>): void };

async function route(req: Request, env: Env, now: number, ctx: Ctx): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname === '/buy' && req.method === 'GET') return buy(req, env, now);
  if (pathname === '/stripe/webhook' && req.method === 'POST') return webhook(req, env, now);
  if (pathname === '/resend' && req.method === 'POST') return resend(req, env, now, (p) => ctx.waitUntil(p));
  if (pathname === '/resend' && req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': env.SITE_URL, 'access-control-allow-methods': 'POST', 'access-control-max-age': '86400' } });
  const c = /^\/v1\/claim\/([^/]+)$/.exec(pathname);
  if (c && req.method === 'GET') return claim(env, c[1], now);
  if (!pathname.startsWith('/v1/')) return json({ error: 'not found' }, 404);
  if ((pathname === '/v1/checkout' || pathname === '/v1/billing') && req.method === 'POST') {
    const a = await authLicense(req, env, now, true);
    if (!a.ok) return a.res;
    return pathname === '/v1/checkout' ? renew(req, env, a.lic) : billing(env, a.lic);
  }
  const a = await authLicense(req, env, now);
  if (!a.ok) return a.res;
  if (pathname === '/v1/usage' && req.method === 'GET') {
    const c = await env.SYNC_DB.prepare('SELECT (SELECT COUNT(*) FROM items WHERE key_hash = ?1 AND deleted = 0) AS items, COALESCE((SELECT bytes FROM counters WHERE key_hash = ?1), 0) AS bytes').bind(a.lic.key_hash).first<{ items: number; bytes: number }>();
    return json({ items: c!.items, bytes: c!.bytes, plan: a.lic.plan, paid_until: a.lic.paid_until });
  }
  return (await items(req, env, a.lic, pathname, now)) ?? json({ error: 'not found' }, 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    try { return await route(req, env, Date.now(), ctx); } catch (e) { console.error(e); return json({ error: 'server error' }, 500); }
  },
  async scheduled(_ev: unknown, env: Env): Promise<void> {
    console.log('cleanup', await cleanup(env, Date.now()));
  },
};
