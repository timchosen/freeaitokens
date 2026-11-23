import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDataKey, wrapDataKey, unwrapDataKey, encryptItem, decryptItem, recoveryCode, fromRecoveryCode, WrongPassphraseError, CorruptItemError } from '../src/node/sync/crypto.ts';

const fast = { N: 2 ** 10, r: 8, p: 1 };

test('the data key wraps under a passphrase and only that passphrase unwraps it', async () => {
  const dk = newDataKey();
  assert.equal(dk.length, 32);
  const body = await wrapDataKey(dk, 'correct horse battery', fast);
  assert.doesNotMatch(body, new RegExp(dk.toString('base64').slice(0, 20)));
  assert.deepEqual(await unwrapDataKey(body, 'correct horse battery'), dk);
  await assert.rejects(unwrapDataKey(body, 'wrong horse battery'), WrongPassphraseError);
  assert.equal(JSON.parse(body).N, 2 ** 10);
});

test('items round-trip, encrypt differently each time, and refuse tampering or a moved id', () => {
  const dk = newDataKey();
  const id = crypto.randomUUID(), other = crypto.randomUUID();
  const value = { type: 'chat', updated: 1, body: { title: 'Trip to Lisbon' } };
  const a = encryptItem(dk, id, value);
  assert.deepEqual(decryptItem(dk, id, a), value);
  assert.notDeepEqual(encryptItem(dk, id, value), a);
  assert.ok(!Buffer.from(a).toString('latin1').includes('Lisbon'));
  assert.throws(() => decryptItem(dk, other, a), CorruptItemError);
  const flipped = Uint8Array.from(a); flipped[20] ^= 1;
  assert.throws(() => decryptItem(dk, id, flipped), CorruptItemError);
  assert.throws(() => decryptItem(newDataKey(), id, a), CorruptItemError);
});

test('recovery code round-trips, ignores spacing and case, and rejects a typo', () => {
  const dk = newDataKey();
  const code = recoveryCode(dk);
  assert.match(code, /^([A-Z2-7]{4}-)+[A-Z2-7]{1,4}$/);
  assert.deepEqual(fromRecoveryCode(code), dk);
  assert.deepEqual(fromRecoveryCode(code.toLowerCase().replace(/-/g, ' ')), dk);
  const typo = (code[0] === 'A' ? 'B' : 'A') + code.slice(1);
  assert.throws(() => fromRecoveryCode(typo));
});
