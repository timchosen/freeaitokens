// Sync: pull what changed, merge it with this computer's chats and keys, push what is new here.
// Nothing local changes until the whole run succeeds, so a failure halfway leaves this computer as it was.
import { createHmac } from 'node:crypto';
import { newDataKey, wrapDataKey, unwrapDataKey, encryptItem, decryptItem, recoveryCode, fromRecoveryCode, CorruptItemError } from './crypto.js';
import { mergeChat, mergeKeys, localKeyChanges, type Chat, type KeyBundle } from './merge.js';

export type SyncState = { cursor: number; versions: Record<string, number>; keySnapshot: Record<string, string>; keysItemId?: string; keyBundle?: KeyBundle; dirty: string[] };
export interface LocalStore {
  chats(): Chat[]; putChat(c: Chat): void; removeChat(id: string): void;
  keys(): Record<string, string | null>; setKey(provider: string, key: string | null): void;
  state(): SyncState; setState(s: SyncState): void;
}
type Reason = 'expired' | 'revoked' | 'offline' | 'corrupt' | 'unauthorized' | 'full';
export type SyncResult = { ok: true; pulled: number; pushed: number } | { ok: false; reason: Reason; detail?: string };
type Conn = { base: string; license: string; fetch: typeof fetch };

class SyncFail extends Error { constructor(readonly reason: Reason, readonly detail?: string) { super(detail ?? reason); } }

async function api(c: Conn, method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Response> {
  let r: Response;
  try {
    r = await c.fetch(`${c.base}${path}`, { method, body: init.body, headers: { authorization: `Bearer ${c.license}`, ...init.headers } });
  } catch (e) { throw new SyncFail('offline', (e as Error).message); }
  if (r.status === 401) throw new SyncFail('unauthorized');
  if (r.status === 402) throw new SyncFail(((await r.json().catch(() => ({}))) as any).error === 'revoked' ? 'revoked' : 'expired');
  if (r.status === 413 && path.startsWith('/v1/items/')) throw new SyncFail('full', 'Sync storage is full.');
  if (r.status >= 500) throw new SyncFail('offline', `The sync server answered ${r.status}.`);
  return r;
}

// Key order does not matter when comparing two copies.
const canon = (v: any): string => Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v);
const same = (a: unknown, b: unknown) => canon(a) === canon(b);

// Every device derives the same id for the keys item, so two devices never create two of them.
export function keysItemId(dataKey: Buffer): string {
  const h = createHmac('sha256', dataKey).update('freeaitokens keys item').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export class SyncEngine {
  constructor(readonly o: Conn & { dataKey: Buffer; store: LocalStore; now?: () => number }) {}

  async run(): Promise<SyncResult> {
    try { return await this.sync(); } catch (e) {
      if (e instanceof SyncFail) return e.detail ? { ok: false, reason: e.reason, detail: e.detail } : { ok: false, reason: e.reason };
      if (e instanceof CorruptItemError) return { ok: false, reason: 'corrupt', detail: e.message };
      throw e;
    }
  }

  private async sync(): Promise<SyncResult> {
    const { store, dataKey } = this.o;
    const now = (this.o.now ?? Date.now)();
    const st = store.state();
    const keysId = keysItemId(dataKey);
    const versions = { ...st.versions };
    const original = new Map(store.chats().map((c) => [c.id, c]));
    const work = new Map(original);
    const dirty = new Set(st.dirty);
    // A dirty chat that is gone locally was deleted here: push a tombstone.
    for (const id of dirty) if (!work.has(id)) work.set(id, { id, title: '', model: '', updated: now, deleted: now, messages: [] });
    const keysNow = store.keys();
    const changes = localKeyChanges(st.keySnapshot, keysNow, now);
    let bundle = mergeKeys(st.keyBundle ?? {}, changes);
    let keysDirty = Object.keys(changes).length > 0;
    let cursor = st.cursor, pulled = 0, pushed = 0;

    const pull = async () => {
      for (let more = true; more;) {
        const page = await (await api(this.o, 'GET', `/v1/items?since=${cursor}`)).json() as { items: { id: string; version: number; deleted: number; blob?: string }[]; cursor: number; more: boolean };
        for (const it of page.items) {
          if ((versions[it.id] ?? 0) >= it.version) continue; // our own write, already in `work`
          versions[it.id] = it.version;
          pulled++;
          if (it.deleted || !it.blob) { if (it.id !== keysId) { work.delete(it.id); dirty.delete(it.id); } continue; }
          const v = decryptItem(dataKey, it.id, Buffer.from(it.blob, 'base64'));
          if (it.id === keysId && v.type === 'keys') {
            bundle = mergeKeys(bundle, v.keys);
            keysDirty = !same(bundle, v.keys);
          } else if (v.type === 'chat') {
            const local = work.get(it.id);
            const merged = local ? mergeChat(local, v.chat) : v.chat;
            work.set(it.id, merged);
            if (same(merged, v.chat)) dirty.delete(it.id); else dirty.add(it.id);
          }
        }
        cursor = page.cursor;
        more = page.more;
      }
    };

    const put = async (id: string, value: object): Promise<boolean> => {
      const v = versions[id];
      const r = await api(this.o, 'PUT', `/v1/items/${id}`, {
        body: Buffer.from(encryptItem(dataKey, id, value)),
        headers: { 'content-type': 'application/octet-stream', ...(v ? { 'if-match': String(v) } : { 'if-none-match': '*' }) },
      });
      if (r.status === 412) return false;
      if (!r.ok) throw new SyncFail('offline', `The sync server answered ${r.status}.`);
      versions[id] = ((await r.json()) as { version: number }).version;
      pushed++;
      return true;
    };

    await pull();
    for (let attempt = 0; attempt < 4; attempt++) {
      let conflict = false;
      for (const id of [...dirty]) {
        if (await put(id, { type: 'chat', chat: work.get(id) })) dirty.delete(id); else conflict = true;
      }
      if (keysDirty) { if (await put(keysId, { type: 'keys', keys: bundle })) keysDirty = false; else conflict = true; }
      if (!conflict) break;
      await pull(); // someone wrote first: take theirs in, merge, try again
    }

    // Everything worked: now change this computer.
    for (const [id, c] of work) {
      if (c.deleted) { if (original.has(id)) store.removeChat(id); }
      else if (!original.has(id) || !same(original.get(id), c)) store.putChat(c);
    }
    for (const id of original.keys()) if (!work.has(id)) store.removeChat(id);
    for (const [p, { key }] of Object.entries(bundle)) if ((keysNow[p] ?? null) !== key) store.setKey(p, key);
    const keySnapshot = Object.fromEntries(Object.entries(bundle).filter(([, v]) => v.key != null).map(([p, v]) => [p, v.key!]));
    store.setState({ cursor, versions, keySnapshot, keysItemId: keysId, keyBundle: bundle, dirty: [...dirty] });
    return { ok: true, pulled, pushed };
  }
}

// The vault body holds the wrapped data key plus a small sealed check, so a recovery code can be tested.
const vaultBody = async (dataKey: Buffer, passphrase: string) =>
  JSON.stringify({ ...JSON.parse(await wrapDataKey(dataKey, passphrase)), check: Buffer.from(encryptItem(dataKey, 'vault-check', { ok: 1 })).toString('base64') });

async function getVault(c: Conn): Promise<{ version: number; body: string } | null> {
  const r = await api(c, 'GET', '/v1/vault');
  if (r.status === 404) return null;
  if (!r.ok) throw new SyncFail('offline', `The sync server answered ${r.status}.`);
  return r.json() as Promise<{ version: number; body: string }>;
}
async function putVault(c: Conn, body: string, version: number | null): Promise<void> {
  const r = await api(c, 'PUT', '/v1/vault', { body: JSON.stringify({ body }), headers: { 'content-type': 'application/json', ...(version ? { 'if-match': String(version) } : { 'if-none-match': '*' }) } });
  if (r.status === 412) throw new Error('This sync account changed on another computer. Try again.');
  if (!r.ok) throw new SyncFail('offline', `The sync server answered ${r.status}.`);
}

export async function setupNew(o: Conn & { passphrase: string }): Promise<{ dataKey: Buffer; recovery: string }> {
  if (await getVault(o)) throw new Error('This sync key is already set up. Choose "I already have a key" and enter its passphrase.');
  const dataKey = newDataKey();
  await putVault(o, await vaultBody(dataKey, o.passphrase), null);
  return { dataKey, recovery: recoveryCode(dataKey) };
}

export async function joinExisting(o: Conn & { passphrase: string }): Promise<Buffer> {
  const v = await getVault(o);
  if (!v) throw new Error('This sync key has not been set up yet. Choose "Set up sync" first.');
  return unwrapDataKey(v.body, o.passphrase);
}

export async function changePassphrase(o: Conn & { dataKey: Buffer; passphrase: string }): Promise<void> {
  const v = await getVault(o);
  if (!v) throw new Error('This sync key has not been set up yet.');
  await putVault(o, await vaultBody(o.dataKey, o.passphrase), v.version);
}

export async function resetWithRecovery(o: Conn & { code: string; passphrase: string }): Promise<Buffer> {
  const dataKey = fromRecoveryCode(o.code);
  const v = await getVault(o);
  if (!v) throw new Error('This sync key has not been set up yet.');
  try { decryptItem(dataKey, 'vault-check', Buffer.from(JSON.parse(v.body).check, 'base64')); }
  catch { throw new Error('That recovery code does not open this sync account.'); }
  await putVault(o, await vaultBody(dataKey, o.passphrase), v.version);
  return dataKey;
}
