// Buying sync: checkout, Stripe webhooks, the app's one-time key pickup, and the billing portal.
import { json, type LicenseRow } from './auth.ts';
import { licenseKey, sha256hex, hmacHex } from './license.ts';
import { stripe, verifyWebhook } from './stripe.ts';
import type { Env } from './index.ts';

const HEX64 = /^[0-9a-f]{64}$/;
const DAY = 86_400_000;

async function checkout(env: Env, plan: string, claim: string | null, license: string | null): Promise<string> {
  const form: Record<string, string> = {
    mode: plan === 'year' ? 'subscription' : 'payment',
    'line_items[0][price]': plan === 'year' ? env.STRIPE_PRICE_YEAR : env.STRIPE_PRICE_LIFE,
    'line_items[0][quantity]': '1',
    'managed_payments[enabled]': 'true',
    success_url: `${env.SITE_URL}/sync-thanks`,
    cancel_url: `${env.SITE_URL}/sync`,
  };
  if (claim) form.client_reference_id = claim;
  if (license) form['metadata[license]'] = license;
  return (await stripe(env, 'POST', '/v1/checkout/sessions', form)).url;
}

// GET /buy?plan=year|life&claim=<sha256 of the app's token>: a new purchase, from the site or the app.
export async function buy(req: Request, env: Env): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const plan = q.get('plan'), claim = q.get('claim');
  if ((plan !== 'year' && plan !== 'life') || (claim && !HEX64.test(claim))) return json({ error: 'bad request' }, 400);
  return new Response(null, { status: 303, headers: { location: await checkout(env, plan, claim, null), 'cache-control': 'no-store' } });
}

// POST /v1/checkout {plan} with the license as bearer: renew after a lapse, or upgrade to lifetime.
export async function renew(req: Request, env: Env, lic: LicenseRow): Promise<Response> {
  const plan = (await req.json().catch(() => ({})) as { plan?: string }).plan;
  if (plan !== 'year' && plan !== 'life') return json({ error: 'bad plan' }, 400);
  return json({ url: await checkout(env, plan, null, lic.key_hash) });
}

// POST /v1/billing: Stripe's page for changing or cancelling the yearly plan.
export async function billing(env: Env, lic: LicenseRow): Promise<Response> {
  if (!lic.stripe_customer) return json({ error: 'no billing account' }, 409);
  const p = await stripe(env, 'POST', '/v1/billing_portal/sessions', { customer: lic.stripe_customer, return_url: `${env.SITE_URL}/sync` });
  return json({ url: p.url });
}

// GET /v1/claim/<token>: the app picks up its new key once. The key is recomputed, never stored.
export async function claim(env: Env, token: string, now: number): Promise<Response> {
  if (!HEX64.test(token)) return json({ error: 'not found' }, 404);
  const h = await sha256hex(token);
  const row = await env.SYNC_DB.prepare('SELECT session, expires FROM claims WHERE claim_hash = ?').bind(h).first<{ session: string; expires: number }>();
  if (!row || row.expires < now) return json({ error: 'not found' }, 404);
  const del = await env.SYNC_DB.prepare('DELETE FROM claims WHERE claim_hash = ?').bind(h).run();
  if (!del.meta.changes) return json({ error: 'not found' }, 404);
  return json({ key: await licenseKey(env.LICENSE_SECRET, row.session) });
}

const periodEnd = (sub: any) => (sub?.items?.data?.[0]?.current_period_end ?? sub?.current_period_end) * 1000;

async function completed(env: Env, s: any, now: number): Promise<void> {
  if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') return; // async payments finish later
  const plan = s.mode === 'subscription' ? 'year' : 'life';
  const ref = s.subscription ?? s.payment_intent ?? null;
  const email = s.customer_details?.email;
  const emailHash = email ? await hmacHex(env.EMAIL_SECRET, String(email).trim().toLowerCase()) : null;
  // Until the invoice arrives, a year from now; invoice.paid sets the exact date.
  const until = plan === 'life' ? null : now + 366 * DAY;
  const upgrade = s.metadata?.license as string | undefined;
  if (upgrade) {
    const lic = await env.SYNC_DB.prepare('SELECT * FROM licenses WHERE key_hash = ?').bind(upgrade).first<LicenseRow>();
    if (!lic) throw new Error(`checkout for unknown license ${upgrade.slice(0, 8)}`);
    if (lic.stripe_ref === ref) return;
    await env.SYNC_DB.prepare('UPDATE licenses SET plan = ?, stripe_ref = ?, stripe_customer = COALESCE(?, stripe_customer), email_hash = COALESCE(?, email_hash), paid_until = ? WHERE key_hash = ?')
      .bind(plan, ref, s.customer ?? null, emailHash, until, upgrade).run();
    if (plan === 'life' && lic.plan === 'year' && lic.stripe_ref?.startsWith('sub_') && (lic.paid_until ?? 0) > now) {
      await stripe(env, 'DELETE', `/v1/subscriptions/${lic.stripe_ref}`);
    }
    return;
  }
  const keyHash = await sha256hex(await licenseKey(env.LICENSE_SECRET, s.id));
  const res = await env.SYNC_DB.batch([
    env.SYNC_DB.prepare('INSERT INTO licenses (key_hash, plan, stripe_customer, stripe_ref, first_session, email_hash, paid_until, revoked, created) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT DO NOTHING')
      .bind(keyHash, plan, s.customer ?? null, ref, s.id, emailHash, until, now),
    ...(s.client_reference_id && HEX64.test(s.client_reference_id)
      ? [env.SYNC_DB.prepare('INSERT INTO claims (claim_hash, session, expires) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(s.client_reference_id, s.id, now + DAY)]
      : []),
  ]) as { meta: { changes: number } }[];
  // Another checkout took this claim first; the buyer still gets the key by email ("send me my key").
  if (res[1] && res[1].meta.changes === 0) console.warn('claim already taken for session', s.id);
}

// A charge maps to a lifetime license by payment intent, or to a yearly one by customer. Every charge that
// revokes is recorded; a won dispute removes only its own dispute record, never a refund, and the license
// comes back only when no record is left.
const MATCH = "(stripe_ref = ?1 OR (plan = 'year' AND stripe_customer = ?2))";
async function revoke(env: Env, charge: any, at: number, refund: boolean): Promise<void> {
  const ids = [charge.payment_intent ?? null, charge.customer ?? null];
  await env.SYNC_DB.batch([
    env.SYNC_DB.prepare(`INSERT INTO revocations (key_hash, charge, refund) SELECT key_hash, ?3, ?4 FROM licenses WHERE ${MATCH} ON CONFLICT(key_hash, charge) DO UPDATE SET refund = MAX(refund, excluded.refund)`).bind(...ids, charge.id ?? '?', refund ? 1 : 0),
    env.SYNC_DB.prepare(`UPDATE licenses SET revoked = COALESCE(revoked, ?3) WHERE ${MATCH}`).bind(...ids, at),
  ]);
}
async function disputeWon(env: Env, charge: any): Promise<void> {
  const ids = [charge.payment_intent ?? null, charge.customer ?? null, charge.id ?? '?'];
  const mine = 'r.charge = ?3 AND r.refund = 0';
  await env.SYNC_DB.batch([
    // Only a license this dispute revoked, and only when nothing else revoked it too.
    env.SYNC_DB.prepare(`UPDATE licenses SET revoked = NULL WHERE ${MATCH} AND EXISTS (SELECT 1 FROM revocations r WHERE r.key_hash = licenses.key_hash AND ${mine}) AND NOT EXISTS (SELECT 1 FROM revocations r WHERE r.key_hash = licenses.key_hash AND NOT (${mine}))`).bind(...ids),
    env.SYNC_DB.prepare(`DELETE FROM revocations AS r WHERE ${mine} AND key_hash IN (SELECT key_hash FROM licenses WHERE ${MATCH})`).bind(...ids),
  ]);
}

async function handle(env: Env, type: string, o: any, now: number): Promise<void> {
  switch (type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return completed(env, o, now);
    case 'invoice.paid': {
      const sub = o.parent?.subscription_details?.subscription ?? o.subscription;
      const end = Math.max(...(o.lines?.data ?? []).map((l: any) => l.period?.end ?? 0)) * 1000;
      if (!sub || !end) return;
      const lic = await env.SYNC_DB.prepare('SELECT plan FROM licenses WHERE stripe_ref = ?').bind(sub).first<{ plan: string }>();
      if (!lic) throw new Error('invoice for a license not created yet'); // 500: Stripe retries after checkout lands
      if (lic.plan === 'year') await env.SYNC_DB.prepare('UPDATE licenses SET paid_until = ? WHERE stripe_ref = ?').bind(end, sub).run();
      return;
    }
    // Only a paid invoice extends a plan; a subscription change (past_due, cancel) can only shorten it.
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const end = periodEnd(o);
      if (end) await env.SYNC_DB.prepare("UPDATE licenses SET paid_until = MIN(paid_until, ?) WHERE stripe_ref = ? AND plan = 'year'").bind(end, o.id).run();
      return;
    }
    case 'charge.refunded':
      if (o.refunded) await revoke(env, o, now, true);
      return;
    case 'charge.dispute.created':
      return revoke(env, await stripe(env, 'GET', `/v1/charges/${o.charge}`), now, false);
    case 'charge.dispute.closed':
      if (o.status === 'won') await disputeWon(env, await stripe(env, 'GET', `/v1/charges/${o.charge}`));
      return;
  }
}

// POST /stripe/webhook
export async function webhook(req: Request, env: Env, now: number): Promise<Response> {
  const payload = await req.text();
  if (!(await verifyWebhook(payload, req.headers.get('stripe-signature') ?? '', env.STRIPE_WEBHOOK_SECRET, now))) return json({ error: 'bad signature' }, 400);
  const ev = JSON.parse(payload);
  if (await env.SYNC_DB.prepare('SELECT 1 AS x FROM events WHERE id = ?').bind(ev.id).first()) return json({ ok: true });
  await handle(env, ev.type, ev.data?.object ?? {}, now);
  await env.SYNC_DB.prepare('INSERT INTO events (id, seen) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(ev.id, now).run();
  return json({ ok: true });
}
