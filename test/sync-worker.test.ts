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
