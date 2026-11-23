// Stripe over plain fetch: form-encoded calls and webhook signature checks.
import { hmacHex } from './license.ts';
import type { Env } from './index.ts';

export async function stripe(env: Env, method: string, path: string, form?: Record<string, string>): Promise<any> {
  const r = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'stripe-version': '2025-03-31.basil', ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`stripe ${method} ${path}: ${j?.error?.message ?? r.status}`);
  return j;
}

// Stripe-Signature: t=<seconds>,v1=<hex>[,v1=<hex>…]
export async function verifyWebhook(payload: string, header: string, secret: string, now: number, tolerance = 300): Promise<boolean> {
  const t = /(?:^|,)t=(\d+)/.exec(header)?.[1];
  const sigs = [...header.matchAll(/(?:^|,)v1=([0-9a-f]+)/g)].map((m) => m[1]);
  if (!t || !sigs.length || Math.abs(now / 1000 - Number(t)) > tolerance) return false;
  const want = await hmacHex(secret, `${t}.${payload}`);
  // Constant-time compare.
  return sigs.some((s) => s.length === want.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ want.charCodeAt(i)), 0) === 0);
}
