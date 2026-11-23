import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../sync/src/index.ts';
import { licenseKey } from '../sync/src/license.ts';
import { makeEnv, addLicense } from './helpers/sync-env.ts';

const ctx = { waitUntil() {}, passThroughOnException() {} } as any;
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
