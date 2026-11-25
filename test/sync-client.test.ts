import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDataKey, wrapDataKey, unwrapDataKey, encryptItem, decryptItem, recoveryCode, fromRecoveryCode, WrongPassphraseError, CorruptItemError } from '../src/node/sync/crypto.ts';

const fast = { N: 2 ** 14, r: 8, p: 1 };

test('the data key wraps under a passphrase and only that passphrase unwraps it', async () => {
  const dk = newDataKey();
  assert.equal(dk.length, 32);
  const body = await wrapDataKey(dk, 'correct horse battery', fast);
  assert.ok(!body.includes(dk.toString('base64').slice(0, 20)));
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
  const b = chat({ title: 'new', model: 'groq/x', mode: 'image', updated: 9, messages: [msg('m1', 1), msg('m3', 3), msg('m0', 0)] });
  const m = mergeChat(a, b);
  assert.deepEqual(m.messages.map((x) => x.id), ['m0', 'm1', 'm2', 'm3']);
  assert.equal(m.title, 'new');
  assert.equal(m.model, 'groq/x');
  assert.equal(m.updated, 9);
  assert.equal(m.mode, 'image', "the newer side's mode is kept");
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

test('mergeChat: a delete only removes the version it saw; an edit it never saw wins, even if made before the delete', () => {
  // The tombstone keeps the deleted copy's `updated` (5); it was deleted at 11.
  const tomb = chat({ updated: 5, deleted: 11 });
  const unseen = chat({ updated: 10, messages: [msg('m10', 10)] });
  for (const m of [mergeChat(tomb, unseen), mergeChat(unseen, tomb)]) {
    assert.equal(m.deleted, undefined);
    assert.deepEqual(m.messages.map((x) => x.id), ['m10']);
  }
  assert.equal(mergeChat(tomb, chat({ updated: 5, messages: [msg('m5', 5)] })).deleted, 11, 'the copy it deleted stays deleted');
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

// Task 7: the engine against the real Worker
import worker from '../sync/src/index.ts';
import { makeEnv, addLicense } from './helpers/sync-env.ts';
import { SyncEngine, setupNew, joinExisting, hasVault, changePassphrase, resetWithRecovery, type LocalStore, type SyncState } from '../src/node/sync/engine.ts';
import { randomUUID } from 'node:crypto';

const LIC = 'FAT-AAAAA-AAAAA-AAAAA-AAAAA-AAAAB';
const wctx = { waitUntil() {}, passThroughOnException() {} } as any;
function server() {
  const s = makeEnv();
  const f = (async (u: any, init?: any) => worker.fetch(new Request(u, init), s.env, wctx)) as typeof fetch;
  return { ...s, f };
}
function memStore(): LocalStore & { removeChat(id: string): void; data: { chats: Map<string, Chat>; keys: Record<string, string | null>; st: SyncState } } {
  const data = { chats: new Map<string, Chat>(), keys: {} as Record<string, string | null>, st: { cursor: 0, versions: {}, keySnapshot: {}, dirty: [] } as SyncState };
  return {
    data,
    chats: () => [...data.chats.values()].map((c) => structuredClone(c)),
    putChat: (c) => { data.chats.set(c.id, structuredClone(c)); },
    removeChat: (id) => { const c = data.chats.get(id); if (c && !c.deleted) data.chats.set(id, { id, title: '', model: '', updated: c.updated, deleted: Date.now(), messages: [] }); },
    keys: () => ({ ...data.keys }),
    setKey: (p, k) => { if (k == null) delete data.keys[p]; else data.keys[p] = k; },
    state: () => structuredClone(data.st),
    setState: (s) => { data.st = structuredClone(s); },
  };
}
const live = (st: { chats(): Chat[] }) => st.chats().filter((c) => !c.deleted);
const edit = (st: ReturnType<typeof memStore>, c: Chat) => { st.putChat(c); st.data.st.dirty.push(c.id); };
const opts = (f: typeof fetch) => ({ base: 'https://sync.test', license: LIC, fetch: f });

async function pair() {
  const s = server();
  await addLicense(s.db, LIC);
  const { dataKey } = await setupNew({ ...opts(s.f), passphrase: 'pass one two' });
  const A = memStore(), B = memStore();
  const ea = new SyncEngine({ ...opts(s.f), dataKey, store: A });
  const eb = new SyncEngine({ ...opts(s.f), dataKey: await joinExisting({ ...opts(s.f), passphrase: 'pass one two' }), store: B });
  return { s, A, B, ea, eb, dataKey };
}

test('engine: two devices on one license converge on chats and keys', async () => {
  const { A, B, ea, eb } = await pair();
  const id = randomUUID();
  edit(A, chat({ id, title: 'hello', updated: 1, messages: [msg('m1', 1)] }));
  A.setKey('groq', 'gsk_a');
  assert.deepEqual(await ea.run(), { ok: true, pulled: 0, pushed: 2 });
  assert.equal((await eb.run()).ok, true);
  assert.deepEqual(B.chats(), A.chats());
  assert.deepEqual(B.keys(), { groq: 'gsk_a' });
  B.setKey('groq', null);
  await eb.run(); await ea.run();
  assert.deepEqual(A.keys(), {}, 'a removal travels too');
});

test('engine: both editing one chat before syncing keeps both messages', async () => {
  const { s, A, B, ea, eb, dataKey } = await pair();
  const id = randomUUID();
  edit(A, chat({ id, updated: 1, messages: [msg('m1', 1)] }));
  await ea.run(); await eb.run();
  edit(A, chat({ id, updated: 2, messages: [msg('m1', 1), msg('a2', 2)] }));
  edit(B, chat({ id, updated: 3, messages: [msg('m1', 1), msg('b3', 3)] }));
  // A pushes after B pulled and before B pushes, so B's push meets a newer version: 412, re-pull, merge, retry.
  let raced = false;
  const racing = (async (u: any, i?: any) => { if (i?.method === 'PUT' && !raced) { raced = true; await ea.run(); } return s.f(u, i); }) as typeof fetch;
  const eb2 = new SyncEngine({ ...opts(racing), dataKey, store: B });
  assert.equal((await eb2.run()).ok, true);
  assert.ok(raced);
  await ea.run();
  for (const st of [A, B]) assert.deepEqual(st.chats()[0].messages.map((m) => m.id), ['m1', 'a2', 'b3']);
  void eb;
});

test('engine: a chat deleted on one device disappears on the other', async () => {
  const { A, B, ea, eb } = await pair();
  const id = randomUUID();
  edit(A, chat({ id, updated: 1, messages: [msg('m1', 1)] }));
  await ea.run(); await eb.run();
  A.removeChat(id); A.data.st.dirty.push(id);
  await ea.run(); await eb.run();
  assert.deepEqual(live(B), []);
});

test('engine: deleting a chat on one device does not wipe an edit the other device made earlier but had not synced', async () => {
  const { A, B, ea, eb } = await pair();
  const id = randomUUID();
  edit(A, chat({ id, updated: 1, messages: [msg('m1', 1)] }));
  await ea.run(); await eb.run();
  edit(B, chat({ id, updated: 2, messages: [msg('m1', 1), msg('b2', 2)] })); // B offline: not synced yet
  A.removeChat(id); A.data.st.dirty.push(id); // A deletes later, never having seen b2
  await ea.run(); await eb.run(); await ea.run();
  for (const st of [A, B]) assert.deepEqual(live(st).map((c) => c.messages.map((m) => m.id)), [['m1', 'b2']]);
});

test('engine: an undecryptable item is reported and never applied, the rest still syncs, and the next run is not stuck on it', async () => {
  const { s, A, B, ea, eb } = await pair();
  const bad = randomUUID(), fine = randomUUID();
  edit(A, chat({ id: bad, title: 'v1', updated: 1, messages: [msg('m1', 1)] }));
  await ea.run(); await eb.run();
  edit(A, chat({ id: bad, title: 'v2', updated: 2, messages: [msg('m1', 1), msg('m2', 2)] }));
  edit(A, chat({ id: fine, title: 'fine', updated: 3, messages: [msg('f1', 3)] }));
  await ea.run();
  const row = s.db.prepare('SELECT obj FROM items WHERE id = ?').get(bad) as any;
  s.blobs.set(row.obj, s.blobs.get(row.obj)!.map((x: number, i: number) => (i === 20 ? x ^ 1 : x)));
  assert.deepEqual(await eb.run(), { ok: false, reason: 'corrupt', detail: 'A synced item could not be decrypted.' });
  assert.deepEqual(live(B).find((c) => c.id === bad)!.title, 'v1', 'the damaged copy changed nothing here');
  assert.ok(live(B).some((c) => c.id === fine), 'everything else came in');
  assert.equal((await eb.run()).ok, true, 'not stuck');
  await ea.run(); await eb.run();
  for (const st of [A, B]) assert.deepEqual(live(st).find((c) => c.id === bad)!.messages.map((m) => m.id), ['m1', 'm2'], 'the good copies repair the damaged one');
});

test('engine: an undecryptable item on a first pull, an expired license or no network change nothing locally', async () => {
  const { s, A, B, ea, eb } = await pair();
  edit(A, chat({ id: randomUUID(), updated: 1, messages: [msg('m1', 1)] }));
  await ea.run();
  const good = new Map(s.blobs);
  for (const [k, v] of s.blobs) s.blobs.set(k, v.map((x, i) => (i === 20 ? x ^ 1 : x)));
  assert.equal((await eb.run() as any).reason, 'corrupt');
  assert.deepEqual(live(B), []);
  for (const [k, v] of good) s.blobs.set(k, v);

  const C = memStore();
  edit(C, chat({ id: randomUUID(), updated: 5, messages: [msg('c1', 5)] }));
  let calls = 0;
  const expiring = (async (u: any, i?: any) => { if (++calls === 2) s.db.prepare('UPDATE licenses SET paid_until = 1').run(); return s.f(u, i); }) as typeof fetch;
  const ec = new SyncEngine({ ...opts(expiring), dataKey: (ea as any).o.dataKey, store: C });
  const cBefore = structuredClone(C.data);
  assert.deepEqual(await ec.run(), { ok: false, reason: 'expired' });
  assert.deepEqual(C.data, cBefore);

  const off = new SyncEngine({ ...opts((async () => { throw new TypeError('fetch failed'); }) as typeof fetch), dataKey: Buffer.alloc(32), store: memStore() });
  assert.deepEqual(await off.run(), { ok: false, reason: 'offline', detail: 'fetch failed' });
});

test('engine setup: wrong passphrase, second setup, passphrase change and recovery reset', async () => {
  const s = server();
  await addLicense(s.db, LIC);
  const { dataKey, recovery } = await setupNew({ ...opts(s.f), passphrase: 'first pass' });
  await assert.rejects(setupNew({ ...opts(s.f), passphrase: 'again' }), /already/);
  await assert.rejects(joinExisting({ ...opts(s.f), passphrase: 'nope' }), WrongPassphraseError);
  await changePassphrase({ ...opts(s.f), dataKey, passphrase: 'second pass' });
  assert.deepEqual(await joinExisting({ ...opts(s.f), passphrase: 'second pass' }), dataKey);
  assert.deepEqual(await resetWithRecovery({ ...opts(s.f), code: recovery, passphrase: 'third pass' }), dataKey);
  assert.deepEqual(await joinExisting({ ...opts(s.f), passphrase: 'third pass' }), dataKey);
  await assert.rejects(resetWithRecovery({ ...opts(s.f), code: recoveryCode(Buffer.alloc(32, 7)), passphrase: 'x' }), /recovery code/);
});

test('engine: a server-side delete marker (not an encrypted tombstone) removes nothing and the chat is pushed again', async () => {
  const { s, A, B, ea, eb } = await pair();
  const id = randomUUID();
  edit(A, chat({ id, updated: 1, messages: [msg('m1', 1)] }));
  await ea.run(); await eb.run();
  s.db.prepare("UPDATE items SET deleted = 1, obj = NULL, version = version + 1, seq = seq + 100 WHERE id = ?").run(id);
  await eb.run();
  assert.deepEqual(B.chats().map((c) => c.id), [id]);
  const row = s.db.prepare('SELECT deleted FROM items WHERE id = ?').get(id) as any;
  assert.equal(row.deleted, 0, 'B wrote its copy back');
});

test('engine: renewing after the 90-day cleanup re-uploads this computer\'s data, and a new computer joins the same account', async () => {
  const { cleanup } = await import('../sync/src/cleanup.ts');
  const { s, A, ea } = await pair();
  const id = randomUUID();
  edit(A, chat({ id, title: 'kept', updated: 1, messages: [msg('m1', 1)] }));
  A.setKey('groq', 'gsk_a');
  await ea.run();
  const DAY = 86_400_000;
  s.db.prepare('UPDATE licenses SET paid_until = ?').run(Date.now() - 91 * DAY);
  await cleanup(s.env, Date.now());
  s.db.prepare('UPDATE licenses SET paid_until = ?').run(Date.now() + 365 * DAY); // renewed
  assert.equal((await ea.run()).ok, true);
  assert.ok(await hasVault(opts(s.f)), 'the wrapped data key survives, so the passphrase still opens the account');
  const C = memStore();
  const ec = new SyncEngine({ ...opts(s.f), dataKey: await joinExisting({ ...opts(s.f), passphrase: 'pass one two' }), store: C });
  assert.equal((await ec.run()).ok, true);
  assert.deepEqual(live(C).map((c) => c.title), ['kept']);
  assert.deepEqual(C.keys(), { groq: 'gsk_a' });
});

test('engine: a run that never gets past a conflict says so instead of reporting success, and changes nothing', async () => {
  const { s, A, dataKey } = await pair();
  edit(A, chat({ id: randomUUID(), updated: 1, messages: [msg('m1', 1)] }));
  const stuck = (async (u: any, i?: any) => (i?.method === 'PUT' ? new Response(JSON.stringify({ version: 99 }), { status: 412 }) : s.f(u, i))) as typeof fetch;
  const before = structuredClone(A.data.st);
  const r = await new SyncEngine({ ...opts(stuck), dataKey, store: A }).run();
  assert.equal(r.ok, false);
  assert.deepEqual(A.data.st, before, 'dirty marks kept for the next run');
});

test('engine: the server saying "too many writes" is reported as busy, not as an error', async () => {
  const { s, A, dataKey } = await pair();
  edit(A, chat({ id: randomUUID(), updated: 1, messages: [msg('m1', 1)] }));
  const limited = (async (u: any, i?: any) => (i?.method === 'PUT' ? new Response('{"error":"too many writes"}', { status: 429 }) : s.f(u, i))) as typeof fetch;
  assert.deepEqual(await new SyncEngine({ ...opts(limited), dataKey, store: A }).run(), { ok: false, reason: 'busy' });
});

test('a chat too large for the server stays here and everything else still syncs', async () => {
  const { A, B, ea, eb } = await pair();
  const big = randomUUID(), small = randomUUID();
  edit(A, chat({ id: big, title: 'Huge', updated: 5, messages: [msg(randomUUID(), 1, 'x'.repeat(1_100_000))] }));
  edit(A, chat({ id: small, title: 'Small', updated: 6, messages: [msg(randomUUID(), 2)] }));
  const r = await ea.run() as any;
  assert.equal(r.reason, 'toolarge');
  assert.match(r.detail, /"Huge"/);
  assert.deepEqual(A.data.st.dirty, [big], 'the large chat is still waiting; the small one went');
  await eb.run();
  assert.deepEqual(live(B).map((c) => c.title), ['Small']);
});

test('an answer read aloud keeps its audio when the copy without it is merged in, either way round', () => {
  const msg = { id: '00000000-0000-4000-8000-000000000001', at: 1, role: 'assistant', content: 'Hi', meta: { provider: 'Groq', model: 'm', ms: 1 } } as any;
  const plain: Chat = { id: 'c1', title: 't', model: 'free', updated: 1, messages: [msg] } as any;
  const spoken: Chat = { ...plain, updated: 2, messages: [{ ...msg, audio: '00000000-0000-4000-8000-000000000002.wav' }] } as any;
  assert.equal((mergeChat(plain, spoken).messages[0] as any).audio, '00000000-0000-4000-8000-000000000002.wav');
  assert.equal((mergeChat(spoken, plain).messages[0] as any).audio, '00000000-0000-4000-8000-000000000002.wav');
});
