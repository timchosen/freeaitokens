import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDataKey, wrapDataKey, unwrapDataKey, encryptItem, decryptItem, recoveryCode, fromRecoveryCode, WrongPassphraseError, CorruptItemError } from '../src/node/sync/crypto.ts';

const fast = { N: 2 ** 14, r: 8, p: 1 };

test('the data key wraps under a passphrase and only that passphrase unwraps it', async () => {
  const dk = newDataKey();
  assert.equal(dk.length, 32);
  const body = await wrapDataKey(dk, 'correct horse battery', fast);
  assert.doesNotMatch(body, new RegExp(dk.toString('base64').slice(0, 20)));
  assert.deepEqual(await unwrapDataKey(body, 'correct horse battery'), dk);
  await assert.rejects(unwrapDataKey(body, 'wrong horse battery'), WrongPassphraseError);
  assert.equal(JSON.parse(body).N, 2 ** 14);
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

// Task 6: merges
import { mergeChat, mergeKeys, localKeyChanges, type Chat } from '../src/node/sync/merge.ts';

const msg = (id: string, at: number, content = id) => ({ id, at, role: 'user' as const, content });
const chat = (o: Partial<Chat>): Chat => ({ id: 'c1', title: 'T', model: 'free', updated: 1, messages: [], ...o });

test('mergeChat keeps every message from both sides, in time order, and is the same either way round', () => {
  const a = chat({ title: 'old', updated: 5, messages: [msg('m1', 1), msg('m2', 2)] });
  const b = chat({ title: 'new', model: 'groq/x', updated: 9, messages: [msg('m1', 1), msg('m3', 3), msg('m0', 0)] });
  const m = mergeChat(a, b);
  assert.deepEqual(m.messages.map((x) => x.id), ['m0', 'm1', 'm2', 'm3']);
  assert.equal(m.title, 'new');
  assert.equal(m.model, 'groq/x');
  assert.equal(m.updated, 9);
  assert.deepEqual(mergeChat(b, a), m);
});

test('mergeChat: an edit made after a delete wins; a delete after the last edit stays deleted', () => {
  const deleted = chat({ updated: 5, deleted: 5, messages: [] });
  const edited = chat({ updated: 7, messages: [msg('m9', 7)] });
  assert.equal(mergeChat(deleted, edited).deleted, undefined);
  assert.equal(mergeChat(edited, deleted).deleted, undefined);
  const later = chat({ updated: 8, deleted: 8 });
  assert.equal(mergeChat(edited, later).deleted, 8);
});

test('mergeKeys: newer per provider wins, removals included; CLI changes show up as edits', () => {
  const a = { groq: { key: 'g1', updated: 1 }, cf: { key: 'c1', updated: 5 } };
  const b = { groq: { key: 'g2', updated: 3 }, cf: { key: null, updated: 4 }, or: { key: 'o1', updated: 2 } };
  assert.deepEqual(mergeKeys(a, b), { groq: { key: 'g2', updated: 3 }, cf: { key: 'c1', updated: 5 }, or: { key: 'o1', updated: 2 } });
  assert.deepEqual(mergeKeys({ groq: { key: 'g1', updated: 1 } }, { groq: { key: null, updated: 3 } }), { groq: { key: null, updated: 3 } }, 'a newer removal stays removed');
  assert.deepEqual(localKeyChanges({ groq: 'g1' }, {}, 7), { groq: { key: null, updated: 7 } }, 'removed outside the app');
  assert.deepEqual(localKeyChanges({ groq: 'g1', cf: 'c1' }, { groq: 'g1', cf: null, or: 'new' }, 99), { cf: { key: null, updated: 99 }, or: { key: 'new', updated: 99 } });
});

test('unwrapDataKey refuses scrypt settings outside the known range before deriving', async () => {
  const { unwrapDataKey: unwrap } = await import('../src/node/sync/crypto.ts');
  const bad = (o: object) => JSON.stringify({ v: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', N: 2 ** 17, r: 8, p: 1, box: 'AA==', ...o });
  for (const o of [{ N: 2 ** 30 }, { N: 3 }, { r: 64 }, { p: 100 }, { v: 2 }]) {
    await assert.rejects(unwrap(bad(o), 'x'), /settings/, JSON.stringify(o));
  }
});
