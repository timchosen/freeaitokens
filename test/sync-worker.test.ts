import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../sync/src/index.ts';
import { licenseKey } from '../sync/src/license.ts';
import { makeEnv, addLicense } from './helpers/sync-env.ts';

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); }, passThroughOnException() {} } as any;
const settle = () => Promise.all(pending.splice(0));
export const call = (env: any, path: string, init: RequestInit & { key?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.key) headers.set('authorization', `Bearer ${init.key}`);
  return worker.fetch(new Request(`https://sync.test${path}`, { ...init, headers }), env, ctx);
};
const K = (n: number) => `FAT-AAAAA-AAAAA-AAAAA-AAAAA-AAAA${'BCDEFG'[n]}`;

test('licenseKey is FAT- plus five groups of five base32 chars and is stable', async () => {
  const k = await licenseKey('s3cret', 'cs_test_1');
  assert.match(k, /^FAT-([A-Z2-7]{5}-){4}[A-Z2-7]{5}$/);
  assert.equal(k, await licenseKey('s3cret', 'cs_test_1'));
  assert.notEqual(k, await licenseKey('s3cret', 'cs_test_2'));
  assert.notEqual(k, await licenseKey('other', 'cs_test_1'));
});

test('API refuses a missing, unknown, expired or revoked license', async () => {
  const { env, db } = makeEnv();
  await addLicense(db, K(0));
  await addLicense(db, K(1), { paid_until: Date.now() - 1000 });
  await addLicense(db, K(2), { revoked: Date.now() - 1000 });
  await addLicense(db, K(3), { plan: 'life', paid_until: null });
  assert.equal((await call(env, '/v1/usage')).status, 401);
  assert.equal((await call(env, '/v1/usage', { key: K(5) })).status, 401);
  const expired = await call(env, '/v1/usage', { key: K(1) });
  assert.equal(expired.status, 402);
  assert.deepEqual(await expired.json(), { error: 'expired' });
  const revoked = await call(env, '/v1/usage', { key: K(2) });
  assert.equal(revoked.status, 402);
  assert.deepEqual(await revoked.json(), { error: 'revoked' });
  assert.equal((await call(env, '/v1/usage', { key: K(0) })).status, 200);
  assert.equal((await call(env, '/v1/usage', { key: K(3) })).status, 200);
});

test('unknown paths are 404 and API responses are never cached', async () => {
  const { env, db } = makeEnv();
  await addLicense(db, K(0));
  assert.equal((await call(env, '/nope')).status, 404);
  const r = await call(env, '/v1/usage', { key: K(0) });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await r.json(), { items: 0, bytes: 0, plan: 'year', paid_until: (db.prepare('SELECT paid_until FROM licenses').get() as any).paid_until });
});

// Task 2: vault and items
const put = (env: any, id: string, bytes: Uint8Array | string, key: string, h: Record<string, string>) =>
  call(env, `/v1/items/${id}`, { method: 'PUT', key, body: bytes, headers: h });
const since = async (env: any, key: string, s = 0) => (await call(env, `/v1/items?since=${s}`, { key })).json() as Promise<any>;

test('items: create, read back, stale write refused, delete leaves a tombstone', async () => {
  const { env, db, blobs } = makeEnv();
  await addLicense(db, K(0));
  const id = crypto.randomUUID();
  const r1 = await put(env, id, 'secret-bytes-1', K(0), { 'if-none-match': '*' });
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { version: 1 });
  assert.equal((await put(env, id, 'x', K(0), { 'if-none-match': '*' })).status, 412, 'create twice');
  let page = await since(env, K(0));
  assert.equal(page.items.length, 1);
  assert.equal(Buffer.from(page.items[0].blob, 'base64').toString(), 'secret-bytes-1');
  assert.equal(page.more, false);
  const cursor = page.cursor;

  assert.equal((await put(env, id, 'v2', K(0), { 'if-match': '1' })).status, 200);
  const stale = await put(env, id, 'loser', K(0), { 'if-match': '1' });
  assert.equal(stale.status, 412);
  assert.deepEqual(await stale.json(), { version: 2 });
  page = await since(env, K(0), cursor);
  assert.equal(page.items.length, 1, 'only the later change');
  assert.equal(Buffer.from(page.items[0].blob, 'base64').toString(), 'v2', 'the losing write did not replace the bytes');
  assert.equal(blobs.size, 1, 'old and losing versions removed');

  assert.equal((await put(env, id, 'x', K(0), {})).status, 428, 'a write must say which version it replaces');
  const del = await call(env, `/v1/items/${id}`, { method: 'DELETE', key: K(0), headers: { 'if-match': '2' } });
  assert.deepEqual(await del.json(), { version: 3 });
  page = await since(env, K(0), page.cursor);
  assert.equal(page.items[0].deleted, 1);
  assert.equal(page.items[0].blob, undefined);
  assert.equal(blobs.size, 0);
  assert.deepEqual(await (await call(env, '/v1/usage', { key: K(0) })).json(), { items: 0, bytes: 0, plan: 'year', paid_until: (db.prepare('SELECT paid_until FROM licenses').get() as any).paid_until });
});

test('items: bad ids, size, quota and write-rate limits; licenses see only their own items', async () => {
  const { env, db } = makeEnv();
  await addLicense(db, K(0));
  await addLicense(db, K(1));
  assert.equal((await put(env, 'not-a-uuid', 'x', K(0), { 'if-none-match': '*' })).status, 400);
  assert.equal((await put(env, crypto.randomUUID(), new Uint8Array(1024 * 1024 + 1), K(0), { 'if-none-match': '*' })).status, 413);
  await put(env, crypto.randomUUID(), 'mine', K(0), { 'if-none-match': '*' });
  assert.equal((await since(env, K(1))).items.length, 0);
  db.prepare('UPDATE counters SET bytes = ?').run(200 * 1024 * 1024 - 2);
  assert.equal((await put(env, crypto.randomUUID(), 'abc', K(0), { 'if-none-match': '*' })).status, 413, 'over 200 MB');
  for (let i = 0; i < 120; i++) await put(env, crypto.randomUUID(), '', K(1), { 'if-none-match': '*' });
  assert.equal((await put(env, crypto.randomUUID(), '', K(1), { 'if-none-match': '*' })).status, 429, '121st write in a minute');
});

test('vault: create once, update with the right version only', async () => {
  const { env, db } = makeEnv();
  await addLicense(db, K(0));
  assert.equal((await call(env, '/v1/vault', { key: K(0) })).status, 404);
  const body = JSON.stringify({ body: '{"v":1}' });
  assert.deepEqual(await (await call(env, '/v1/vault', { method: 'PUT', key: K(0), body, headers: { 'if-none-match': '*' } })).json(), { version: 1 });
  assert.equal((await call(env, '/v1/vault', { method: 'PUT', key: K(0), body, headers: { 'if-none-match': '*' } })).status, 412);
  assert.equal((await call(env, '/v1/vault', { method: 'PUT', key: K(0), body, headers: { 'if-match': '7' } })).status, 412);
  assert.equal((await call(env, '/v1/vault', { method: 'PUT', key: K(0), body: JSON.stringify({ body: '{"v":2}' }), headers: { 'if-match': '1' } })).status, 200);
  assert.deepEqual(await (await call(env, '/v1/vault', { key: K(0) })).json(), { version: 2, body: '{"v":2}' });
});

// Task 3: Stripe
import { hmacHex, sha256hex } from '../sync/src/license.ts';

const stripeCalls: { url: string; method: string; body: string }[] = [];
let stripeReply: (url: string, method: string) => any = () => ({});
const realFetch = globalThis.fetch;
function stubStripe() {
  stripeCalls.length = 0;
  globalThis.fetch = (async (u: any, init: any = {}) => {
    const url = String(u);
    if (!url.startsWith('https://api.stripe.com/')) return realFetch(u, init);
    stripeCalls.push({ url, method: init.method ?? 'GET', body: String(init.body ?? '') });
    const { __status = 200, ...reply } = stripeReply(url, init.method ?? 'GET') ?? {};
    return new Response(JSON.stringify(reply), { status: __status });
  }) as any;
}
async function hook(env: any, type: string, object: any, id = `evt_${Math.random()}`) {
  const payload = JSON.stringify({ id, type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${await hmacHex(env.STRIPE_WEBHOOK_SECRET, `${t}.${payload}`)}`;
  return call(env, '/stripe/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': sig } });
}
const token = 'ab'.repeat(32);
const completed = (o: any = {}) => ({ id: 'cs_life_1', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_1', customer: 'cus_1', customer_details: { email: 'Ana@Example.com ' }, client_reference_id: null, metadata: {}, ...o });

test('/buy creates a Managed Payments checkout with the claim and redirects to it', async () => {
  stubStripe();
  stripeReply = () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/c/x' });
  const { env } = makeEnv();
  const claim = await sha256hex(token);
  const r = await call(env, `/buy?plan=life&claim=${claim}`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), 'https://checkout.stripe.com/c/x');
  const body = new URLSearchParams(stripeCalls[0].body);
  assert.equal(body.get('managed_payments[enabled]'), 'true');
  assert.equal(body.get('mode'), 'payment');
  assert.equal(body.get('line_items[0][price]'), 'price_life');
  assert.equal(body.get('client_reference_id'), claim);
  assert.equal((await call(env, '/buy?plan=forever')).status, 400);
  globalThis.fetch = realFetch;
});

test('webhook: bad signature is refused; a paid lifetime checkout makes one license that the app can claim once', async () => {
  stubStripe();
  const { env, db } = makeEnv();
  const bad = await call(env, '/stripe/webhook', { method: 'POST', body: '{}', headers: { 'stripe-signature': 't=1,v1=00' } });
  assert.equal(bad.status, 400);
  const obj = completed({ client_reference_id: await sha256hex(token) });
  assert.equal((await hook(env, 'checkout.session.completed', obj, 'evt_a')).status, 200);
  assert.equal((await hook(env, 'checkout.session.completed', obj, 'evt_a')).status, 200, 'replayed');
  assert.equal((await hook(env, 'checkout.session.completed', obj, 'evt_b')).status, 200, 'same session, new event id');
  const rows = db.prepare('SELECT * FROM licenses').all() as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].paid_until, null);
  assert.equal(rows[0].plan, 'life');
  assert.equal(rows[0].email_hash, await hmacHex('mail-secret', 'ana@example.com'));
  const got = await call(env, `/v1/claim/${token}`);
  const { key } = await got.json() as any;
  assert.match(key, /^FAT-/);
  assert.equal((await call(env, '/v1/usage', { key })).status, 200);
  assert.equal((await call(env, `/v1/claim/${token}`)).status, 404, 'only once');
  globalThis.fetch = realFetch;
});

test('webhook: yearly plan gets paid_until from the invoice, even when the invoice comes first', async () => {
  stubStripe();
  const { env, db } = makeEnv();
  const end = Math.floor(Date.now() / 1000) + 365 * 86400;
  const invoice = { id: 'in_1', billing_reason: 'subscription_create', parent: { subscription_details: { subscription: 'sub_1' } }, lines: { data: [{ period: { end } }] } };
  assert.equal((await hook(env, 'invoice.paid', invoice, 'evt_inv')).status, 500, 'license not there yet: Stripe retries');
  await hook(env, 'checkout.session.completed', completed({ id: 'cs_year_1', mode: 'subscription', subscription: 'sub_1', payment_intent: null }));
  assert.equal((await hook(env, 'invoice.paid', invoice, 'evt_inv')).status, 200);
  assert.equal((db.prepare('SELECT paid_until FROM licenses').get() as any).paid_until, end * 1000);
  await hook(env, 'customer.subscription.deleted', { id: 'sub_1', items: { data: [{ current_period_end: end - 100 }] } });
  assert.equal((db.prepare('SELECT paid_until FROM licenses').get() as any).paid_until, (end - 100) * 1000);
  globalThis.fetch = realFetch;
});

test('webhook: upgrading a yearly license to lifetime keeps the key and cancels the subscription', async () => {
  stubStripe();
  const { env, db } = makeEnv();
  await hook(env, 'checkout.session.completed', completed({ id: 'cs_year_1', mode: 'subscription', subscription: 'sub_1', payment_intent: null }));
  const kh = (db.prepare('SELECT key_hash FROM licenses').get() as any).key_hash;
  await hook(env, 'checkout.session.completed', completed({ id: 'cs_up', metadata: { license: kh }, payment_intent: 'pi_up' }));
  const rows = db.prepare('SELECT * FROM licenses').all() as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].plan, 'life');
  assert.equal(rows[0].paid_until, null);
  assert.ok(stripeCalls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v1/subscriptions/sub_1')));
  globalThis.fetch = realFetch;
});

test('webhook: a refund or dispute revokes; a won dispute restores', async () => {
  stubStripe();
  stripeReply = (url) => url.includes('/v1/charges/') ? { id: 'ch_1', payment_intent: 'pi_1', customer: 'cus_1' } : {};
  const { env, db } = makeEnv();
  await hook(env, 'checkout.session.completed', completed());
  const key = await (await import('../sync/src/license.ts')).licenseKey('lic-secret', 'cs_life_1');
  await hook(env, 'charge.refunded', { id: 'ch_1', refunded: false, payment_intent: 'pi_1', customer: 'cus_1' });
  assert.equal((await call(env, '/v1/usage', { key })).status, 200, 'partial refund changes nothing');
  await hook(env, 'charge.dispute.created', { id: 'dp_1', charge: 'ch_1' });
  assert.deepEqual(await (await call(env, '/v1/usage', { key })).json(), { error: 'revoked' });
  await hook(env, 'charge.dispute.closed', { id: 'dp_1', charge: 'ch_1', status: 'won' });
  assert.equal((await call(env, '/v1/usage', { key })).status, 200);
  await hook(env, 'charge.refunded', { id: 'ch_1', refunded: true, payment_intent: 'pi_1', customer: 'cus_1' });
  assert.equal((await call(env, '/v1/usage', { key })).status, 402);
  globalThis.fetch = realFetch;
});

test('webhook: a dispute that beats its checkout is retried until the license exists; an old unknown charge is not', async () => {
  stubStripe();
  const created = Math.floor(Date.now() / 1000);
  stripeReply = (url) => url.includes('/v1/charges/ch_old') ? { id: 'ch_old', payment_intent: 'pi_x', customer: 'cus_x', created: created - 2 * 86400 }
    : url.includes('/v1/charges/') ? { id: 'ch_1', payment_intent: 'pi_1', customer: 'cus_1', created } : {};
  const { env } = makeEnv();
  assert.equal((await hook(env, 'charge.dispute.created', { id: 'dp_1', charge: 'ch_1' }, 'evt_d')).status, 500, 'no license yet: Stripe retries');
  await hook(env, 'charge.refunded', { id: 'ch_1', refunded: true, payment_intent: 'pi_1', customer: 'cus_1', created }, 'evt_r');
  await hook(env, 'checkout.session.completed', completed());
  const key = await (await import('../sync/src/license.ts')).licenseKey('lic-secret', 'cs_life_1');
  assert.equal((await hook(env, 'charge.dispute.created', { id: 'dp_1', charge: 'ch_1' }, 'evt_d')).status, 200);
  assert.deepEqual(await (await call(env, '/v1/usage', { key })).json(), { error: 'revoked' });
  assert.equal((await hook(env, 'charge.dispute.created', { id: 'dp_9', charge: 'ch_old' })).status, 200, 'an old charge no license uses is not retried');
  globalThis.fetch = realFetch;
});

test('/v1/checkout renews or upgrades the bearer license; /v1/billing opens the portal', async () => {
  stubStripe();
  stripeReply = (url) => url.includes('billing_portal') ? { url: 'https://billing.stripe.com/p/x' } : { id: 'cs_2', url: 'https://checkout.stripe.com/c/y' };
  const { env, db } = makeEnv();
  await addLicense(db, K(0), { paid_until: Date.now() - 1000 });
  db.prepare('UPDATE licenses SET stripe_customer = ?').run('cus_9');
  const r = await call(env, '/v1/checkout', { method: 'POST', key: K(0), body: JSON.stringify({ plan: 'year' }) });
  assert.deepEqual(await r.json(), { url: 'https://checkout.stripe.com/c/y' }, 'an expired license may renew');
  assert.equal(new URLSearchParams(stripeCalls[0].body).get('metadata[license]'), await sha256hex(K(0)));
  const p = await call(env, '/v1/billing', { method: 'POST', key: K(0) });
  assert.deepEqual(await p.json(), { url: 'https://billing.stripe.com/p/x' });
  globalThis.fetch = realFetch;
});

test('items: two writers racing on the same version leave the winner\'s bytes intact and the quota exact', async () => {
  const { env, db, blobs } = makeEnv();
  await addLicense(db, K(0));
  const id = crypto.randomUUID();
  await put(env, id, 'v1', K(0), { 'if-none-match': '*' });
  const [a, b] = await Promise.all([put(env, id, 'from-a', K(0), { 'if-match': '1' }), put(env, id, 'from-bb', K(0), { 'if-match': '1' })]);
  const winner = a.status === 200 ? 'from-a' : 'from-bb';
  assert.deepEqual([a.status, b.status].sort(), [200, 412]);
  const page = await since(env, K(0));
  assert.equal(Buffer.from(page.items[0].blob, 'base64').toString(), winner);
  assert.equal(blobs.size, 1);
  assert.equal((db.prepare('SELECT bytes FROM counters').get() as any).bytes, winner.length);
});

test('items: concurrent writes cannot push a license over its storage cap', async () => {
  const { env, db } = makeEnv();
  await addLicense(db, K(0));
  await put(env, crypto.randomUUID(), 'x', K(0), { 'if-none-match': '*' });
  db.prepare('UPDATE counters SET bytes = ?').run(200 * 1024 * 1024 - 10);
  const rs = await Promise.all([1, 2, 3].map(() => put(env, crypto.randomUUID(), '12345678', K(0), { 'if-none-match': '*' })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 413, 413]);
  assert.ok((db.prepare('SELECT bytes FROM counters').get() as any).bytes <= 200 * 1024 * 1024);
});

// Task 4: key resend and cleanup
import { cleanup } from '../sync/src/cleanup.ts';

const resend = (env: any, email: string, ip = '1.2.3.4') =>
  call(env, '/resend', { method: 'POST', body: new URLSearchParams({ email }), headers: { 'cf-connecting-ip': ip, accept: 'application/json' } });

test('resend: same answer for known and unknown addresses, one mail per license, rate-limited, no address stored', async () => {
  const { env, db, mail } = makeEnv();
  const eh = await hmacHex('mail-secret', 'ana@example.com');
  await addLicense(db, K(0), { session: 'cs_a', email_hash: eh });
  await addLicense(db, K(1), { session: 'cs_b', email_hash: eh });
  const unknown = await resend(env, 'nobody@example.com');
  const known = await resend(env, '  Ana@Example.com ', '5.6.7.8');
  await settle();
  assert.equal(unknown.status, known.status);
  assert.equal(await unknown.text(), await known.text());
  assert.equal(known.headers.get('access-control-allow-origin'), 'https://freeaitokens.co');
  assert.equal(mail.length, 2);
  const { licenseKey } = await import('../sync/src/license.ts');
  assert.ok(mail.every((m) => m.to === 'ana@example.com'));
  assert.ok(mail.every((m) => m.from?.name === 'FreeAITokens' && m.from?.email === 'sync@freeaitokens.co'), 'the email shows FreeAITokens as the sender');
  const keys = await Promise.all([licenseKey('lic-secret', 'cs_a'), licenseKey('lic-secret', 'cs_b')]);
  for (const k of keys) assert.ok(mail.some((m) => m.text.includes(k)), 'each license key is mailed');
  for (let i = 0; i < 3; i++) await resend(env, 'ana@example.com', `9.9.9.${i}`);
  await settle();
  assert.equal(mail.length, 2 + 2 * 2, 'the fourth request of the day for one address sends nothing');
  for (let i = 0; i < 5; i++) await resend(env, `x${i}@example.com`, '7.7.7.7');
  assert.deepEqual(await (await resend(env, 'ana@example.com', '7.7.7.7')).json(), { ok: true }, 'still the same answer when limited');
  const dump = JSON.stringify(['licenses', 'rates', 'events', 'claims'].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
  assert.ok(!/example\.com/i.test(dump), 'no email text anywhere');
});

test('cleanup deletes data 90 days after a plan ends or is revoked, old tombstones and expired claims', async () => {
  const { env, db, blobs } = makeEnv();
  const now = Date.now(), DAY = 86_400_000;
  await addLicense(db, K(0), { paid_until: now - 89 * DAY });
  await addLicense(db, K(1), { paid_until: now - 91 * DAY });
  await addLicense(db, K(2), { plan: 'life', paid_until: null, revoked: now - 91 * DAY });
  await addLicense(db, K(3), { plan: 'life', paid_until: null });
  // Give each license an item (written directly; their plans have ended so the API would refuse).
  for (const i of [0, 1, 2, 3]) {
    const kh = (db.prepare('SELECT key_hash FROM licenses WHERE first_session = ?').get(`cs_${K(i)}`) as any).key_hash;
    db.prepare('INSERT INTO items (key_hash, id, version, seq, size, deleted, updated, obj) VALUES (?, ?, 1, 1, 3, 0, ?, ?)').run(kh, `id${i}`, now, `${kh}/id${i}/o`);
    db.prepare('INSERT INTO counters (key_hash, seq, bytes) VALUES (?, 1, 3)').run(kh);
    blobs.set(`${kh}/id${i}/o`, new Uint8Array(3));
  }
  const kh3 = (db.prepare('SELECT key_hash FROM licenses WHERE first_session = ?').get(`cs_${K(3)}`) as any).key_hash;
  db.prepare('INSERT INTO items (key_hash, id, version, seq, size, deleted, updated, obj) VALUES (?, ?, 2, 2, 0, 1, ?, NULL)').run(kh3, 'old-tomb', now - 91 * DAY);
  db.prepare('INSERT INTO items (key_hash, id, version, seq, size, deleted, updated, obj) VALUES (?, ?, 2, 3, 0, 1, ?, NULL)').run(kh3, 'new-tomb', now - 10 * DAY);
  db.prepare('INSERT INTO claims (claim_hash, session, expires) VALUES (?, ?, ?), (?, ?, ?)').run('a', 's', now - 1, 'b', 's', now + DAY);
  const r = await cleanup(env, now);
  assert.deepEqual(r, { licenses: 2, tombstones: 1, claims: 1 });
  assert.equal(blobs.size, 2, 'K0 (89 days) and K3 (lifetime) keep their data');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM licenses').get() as any).n, 4, 'license rows stay so a renewal finds them');
  assert.deepEqual((db.prepare("SELECT id FROM items WHERE deleted = 1").all() as any[]).map((x) => x.id), ['new-tomb']);
});

test('webhook: a subscription change never extends a plan; only a paid invoice does', async () => {
  stubStripe();
  const { env, db } = makeEnv();
  await hook(env, 'checkout.session.completed', completed({ id: 'cs_y', mode: 'subscription', subscription: 'sub_1', payment_intent: null }));
  const before = (db.prepare('SELECT paid_until FROM licenses').get() as any).paid_until;
  const far = Math.floor(before / 1000) + 400 * 86400;
  await hook(env, 'customer.subscription.updated', { id: 'sub_1', status: 'past_due', items: { data: [{ current_period_end: far }] } });
  assert.equal((db.prepare('SELECT paid_until FROM licenses').get() as any).paid_until, before, 'failed renewal does not extend');
  globalThis.fetch = realFetch;
});

test('webhook: winning a dispute does not undo a revocation caused by a refund of another charge', async () => {
  stubStripe();
  stripeReply = (url) => url.includes('/v1/charges/ch_2') ? { id: 'ch_2', payment_intent: 'pi_1', customer: 'cus_1' } : {};
  const { env } = makeEnv();
  await hook(env, 'checkout.session.completed', completed());
  const key = await (await import('../sync/src/license.ts')).licenseKey('lic-secret', 'cs_life_1');
  await hook(env, 'charge.refunded', { id: 'ch_1', refunded: true, payment_intent: 'pi_1', customer: 'cus_1' });
  await hook(env, 'charge.dispute.closed', { id: 'dp_2', charge: 'ch_2', status: 'won' });
  assert.deepEqual(await (await call(env, '/v1/usage', { key })).json(), { error: 'revoked' });
  globalThis.fetch = realFetch;
});

test('webhook: a won dispute never lifts a revocation that a refund (of any charge) also caused', async () => {
  stubStripe();
  stripeReply = (url) => url.includes('/v1/charges/ch_1') ? { id: 'ch_1', payment_intent: 'pi_1', customer: 'cus_1' } : {};
  const { env } = makeEnv();
  await hook(env, 'checkout.session.completed', completed());
  const key = await (await import('../sync/src/license.ts')).licenseKey('lic-secret', 'cs_life_1');
  await hook(env, 'charge.dispute.created', { id: 'dp_1', charge: 'ch_1' }, 'evt_d1');
  await hook(env, 'charge.refunded', { id: 'ch_2', refunded: true, payment_intent: 'pi_1', customer: 'cus_1' }, 'evt_r2');
  await hook(env, 'charge.dispute.closed', { id: 'dp_1', charge: 'ch_1', status: 'won' }, 'evt_w1');
  assert.deepEqual(await (await call(env, '/v1/usage', { key })).json(), { error: 'revoked' }, 'refund of ch_2 still stands');
  globalThis.fetch = realFetch;
});

test('webhook: a won dispute does not lift a revocation that has no record of that dispute', async () => {
  stubStripe();
  stripeReply = () => ({ id: 'ch_9', payment_intent: 'pi_1', customer: 'cus_1' });
  const { env, db } = makeEnv();
  await hook(env, 'checkout.session.completed', completed());
  db.prepare('UPDATE licenses SET revoked = 1').run(); // revoked by hand, no revocations row
  const key = await (await import('../sync/src/license.ts')).licenseKey('lic-secret', 'cs_life_1');
  await hook(env, 'charge.dispute.closed', { id: 'dp_9', charge: 'ch_9', status: 'won' });
  assert.deepEqual(await (await call(env, '/v1/usage', { key })).json(), { error: 'revoked' });
  globalThis.fetch = realFetch;
});

test('webhook: renewing a lapsed yearly plan cancels the old subscription first, so a late retry of it cannot charge twice', async () => {
  stubStripe();
  stripeReply = () => ({});
  const { env, db } = makeEnv();
  await hook(env, 'checkout.session.completed', completed({ id: 'cs_year_1', mode: 'subscription', subscription: 'sub_1', payment_intent: null }));
  const kh = (db.prepare('SELECT key_hash FROM licenses').get() as any).key_hash;
  db.prepare('UPDATE licenses SET paid_until = ?').run(Date.now() - 86_400_000); // card failed: past_due, looks expired
  // The cancel fails once (Stripe down): the event fails too, and Stripe's retry cancels.
  stripeReply = (url, method) => (method === 'DELETE' ? { __status: 500, error: { message: 'try later' } } : {});
  const renew = completed({ id: 'cs_year_2', mode: 'subscription', subscription: 'sub_2', payment_intent: null, metadata: { license: kh } });
  assert.equal((await hook(env, 'checkout.session.completed', renew, 'evt_renew')).status, 500);
  stripeReply = () => ({});
  assert.equal((await hook(env, 'checkout.session.completed', renew, 'evt_renew')).status, 200);
  assert.ok(stripeCalls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v1/subscriptions/sub_1') ), 'old subscription cancelled');
  assert.equal((db.prepare('SELECT stripe_ref FROM licenses').get() as any).stripe_ref, 'sub_2');
  // An invoice still arriving for the old subscription is acknowledged, not retried for days.
  const old = { id: 'in_old', billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_1' } }, lines: { data: [{ period: { end: 2e9 } }] } };
  assert.equal((await hook(env, 'invoice.paid', old)).status, 200);
  assert.equal((db.prepare('SELECT stripe_ref FROM licenses').get() as any).stripe_ref, 'sub_2');
  // A subscription Stripe already cancelled counts as cancelled.
  stripeReply = (url, method) => (method === 'DELETE' ? { __status: 404, error: { message: 'No such subscription: sub_2' } } : {});
  const again = completed({ id: 'cs_year_3', mode: 'subscription', subscription: 'sub_3', payment_intent: null, metadata: { license: kh } });
  assert.equal((await hook(env, 'checkout.session.completed', again)).status, 200);
  globalThis.fetch = realFetch;
});

test('resend: a plain form post (no JavaScript) goes back to the page in its language, showing the sent message', async () => {
  const { env } = makeEnv();
  const post = (body: Record<string, string>) => call(env, '/resend', { method: 'POST', body: new URLSearchParams(body), headers: { 'cf-connecting-ip': '3.3.3.3' } });
  const en = await post({ email: 'a@example.com' });
  assert.equal(en.status, 303);
  assert.equal(en.headers.get('location'), 'https://freeaitokens.co/sync#resend-done');
  assert.equal((await post({ email: 'a@example.com', lang: 'de' })).headers.get('location'), 'https://freeaitokens.co/de/sync#resend-done');
  assert.equal((await post({ email: 'a@example.com', lang: '//evil.example' })).headers.get('location'), 'https://freeaitokens.co/sync#resend-done');
});

test('/v1/checkout refuses to sell a yearly plan to a lifetime license', async () => {
  stubStripe();
  stripeReply = () => ({ id: 'cs_2', url: 'https://checkout.stripe.com/c/y' });
  const { env, db } = makeEnv();
  await addLicense(db, K(0), { plan: 'life', paid_until: null });
  assert.equal((await call(env, '/v1/checkout', { method: 'POST', key: K(0), body: JSON.stringify({ plan: 'year' }) })).status, 409);
  assert.equal((await call(env, '/v1/checkout', { method: 'POST', key: K(0), body: JSON.stringify({ plan: 'life' }) })).status, 409);
  assert.equal(stripeCalls.length, 0);
  globalThis.fetch = realFetch;
});

test('/buy is rate-limited per address, so crawlers cannot create checkout sessions without end', async () => {
  stubStripe();
  stripeReply = () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/c/x' });
  const { env } = makeEnv();
  const get = (ip: string) => call(env, '/buy?plan=year', { headers: { 'cf-connecting-ip': ip } });
  for (let i = 0; i < 20; i++) assert.equal((await get('4.4.4.4')).status, 303);
  assert.equal((await get('4.4.4.4')).status, 429);
  assert.equal((await get('5.5.5.5')).status, 303, 'other people still buy');
  globalThis.fetch = realFetch;
});

test('webhook: refunding a yearly charge from before a renewal still revokes, though the renewal made a new Stripe customer', async () => {
  stubStripe();
  stripeReply = () => ({});
  const { env, db } = makeEnv();
  await hook(env, 'checkout.session.completed', completed({ id: 'cs_year_1', mode: 'subscription', subscription: 'sub_1', payment_intent: null, customer: 'cus_old' }));
  const kh = (db.prepare('SELECT key_hash FROM licenses').get() as any).key_hash;
  await hook(env, 'checkout.session.completed', completed({ id: 'cs_year_2', mode: 'subscription', subscription: 'sub_2', payment_intent: null, customer: 'cus_new', metadata: { license: kh } }));
  await hook(env, 'charge.refunded', { id: 'ch_old', refunded: true, payment_intent: 'pi_old', customer: 'cus_old' });
  assert.ok((db.prepare('SELECT revoked FROM licenses').get() as any).revoked);
  globalThis.fetch = realFetch;
});

test('a purchase can be picked up by the app for an hour, not longer', async () => {
  stubStripe();
  const { env, db } = makeEnv();
  await hook(env, 'checkout.session.completed', completed({ client_reference_id: await sha256hex(token) }), 'evt_hour');
  const { expires } = db.prepare('SELECT expires FROM claims').get() as any;
  assert.ok(expires <= Date.now() + 3_600_000 && expires > Date.now() + 3_500_000, `expires in ${(expires - Date.now()) / 60_000} min`);
  globalThis.fetch = realFetch;
});
