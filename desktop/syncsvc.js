// Sync in the desktop app: buying and picking up a key, setting up with a passphrase, and syncing
// chats and keys in the background. The engine does the syncing; this keeps its state and timers.
import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const KEY_RE = /^FAT-(?:[A-Z2-7]{5}-){4}[A-Z2-7]{5}$/;
// A key bought in the app waits in the keychain (CLAIMED) until a passphrase is chosen.
const LICENSE = 'sync:license', DATAKEY = 'sync:datakey', CLAIMED = 'sync:claimed';
const CLAIM_FOR = 30 * 60_000;
// Pages the app may open in the browser for paying: Stripe's checkout and billing pages.
const PAY_HOSTS = new Set(['checkout.stripe.com', 'billing.stripe.com']);
function payUrl(u) {
  let url;
  try { url = new URL(u); } catch { url = null; }
  if (url?.protocol !== 'https:' || !PAY_HOSTS.has(url.hostname)) throw new Error('The sync server sent a link that is not a payment page.');
  return url.href;
}

export function createSyncService({ base, keys, chats, stateFile, fetch, engine, providers, onStatus = () => {}, onPulled = () => {} }) {
  const read = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return {}; } };
  let saved = read();
  const write = (patch) => {
    saved = { ...saved, ...patch };
    mkdirSync(dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(saved), { mode: 0o600 });
    renameSync(tmp, stateFile);
    onStatus(status());
  };
  const license = () => keys.get(LICENSE);
  const dataKey = () => { const k = keys.get(DATAKEY); return k ? Buffer.from(k, 'base64') : null; };
  const conn = (lic = license()) => ({ base, license: lic, fetch });

  // Chats changed by the person are marked for the next push; changes sync itself writes are not.
  const pending = new Set();
  let quiet = false, nudge = null, started = false;
  chats.onChange((id) => {
    if (quiet) return;
    pending.add(id);
    if (started && license()) { clearTimeout(nudge); nudge = setTimeout(() => void syncNow(), 3000); }
  });

  // What the engine sees. The key snapshot holds keys, so it is kept sealed under the data key.
  const store = () => {
    const dk = dataKey();
    let taken = [];
    return {
      chats: () => chats.all(), // deleted ones too: their stubs carry the delete to other computers
      putChat: (c) => {
        const cur = chats.all().find((x) => x.id === c.id);
        // Edited here during the run: keep both sides and push the result next time.
        const edited = cur && !cur.deleted && cur.updated > c.updated;
        quiet = true; try { chats.put(edited ? engine.mergeChat(cur, c) : c); } finally { quiet = false; }
        if (edited) pending.add(c.id);
      },
      // A key that can't be read right now (keychain locked, access denied) is `undefined`: sync leaves it alone.
      keys: () => Object.fromEntries(providers().map((p) => { try { return [p, (keys.read ?? keys.get)(p)]; } catch { return [p, undefined]; } })),
      // Only provider keys sync; a bundle can never reach other keychain entries such as sync:license.
      setKey: (p, k) => { if (!providers().includes(p)) return; if (k == null) keys.remove(p); else keys.set(p, k); },
      state: () => {
        let snap = { keySnapshot: {}, keyBundle: {} };
        try { if (saved.snap) snap = engine.decryptItem(dk, 'local-snapshot', Buffer.from(saved.snap, 'base64')); } catch { /* start over: every key counts as new */ }
        // Marks leave `pending` only when the run saves its state, so a failed run (offline, expired) keeps them.
        taken = [...pending];
        const dirty = [...new Set([...(saved.dirty ?? []), ...taken])];
        return { cursor: saved.cursor ?? 0, versions: saved.versions ?? {}, dirty, ...snap };
      },
      setState: ({ keySnapshot, keyBundle, keysItemId, ...rest }) => { for (const id of taken) pending.delete(id); write({
        ...rest, snap: Buffer.from(engine.encryptItem(dk, 'local-snapshot', { keySnapshot, keyBundle })).toString('base64'),
      }); },
    };
  };

  function status() {
    const on = !!(license() && dataKey());
    const s = on ? (saved.state ?? 'on') : saved.claim && saved.claim.until > Date.now() ? 'waiting' : 'off';
    const u = saved.usage ?? {};
    return {
      state: s, last: saved.last, reason: saved.reason, detail: saved.detail,
      ...(on ? { items: u.items, bytes: u.bytes, plan: u.plan, paidUntil: u.paid_until } : {}),
      ...(!on && keys.get(CLAIMED) ? { key: keys.get(CLAIMED) } : {}),
    };
  }

  let running = null;
  function syncNow() {
    if (!license() || !dataKey()) return Promise.resolve({ ok: false, reason: 'unauthorized' });
    return (running ??= (async () => {
      try {
        const r = await new engine.SyncEngine({ ...conn(), dataKey: dataKey(), store: store() }).run();
        if (r.reason === 'busy') { // the server's write limit: not an error, carry on in a minute
          write({ state: 'on', reason: undefined, detail: undefined });
          if (started) { clearTimeout(nudge); nudge = setTimeout(() => void syncNow(), 61_000); }
          return r;
        }
        if (!r.ok) {
          write({ state: r.reason === 'expired' || r.reason === 'revoked' ? r.reason : 'error', reason: r.reason, detail: r.detail });
          return r;
        }
        // Only for the numbers on the screen: a failure here doesn't make the sync a failure.
        const u = await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${license()}` } }).then((x) => x.json()).catch(() => null);
        write({ state: 'on', reason: undefined, detail: undefined, last: Date.now(), ...(u && !u.error ? { usage: u } : {}) });
        if (r.pulled) onPulled();
        return r;
      } finally { running = null; }
    })());
  }

  // A new purchase (with a claim the app can pick up), or a renewal/upgrade of this computer's license.
  async function buy(plan) {
    if (plan !== 'year' && plan !== 'life') throw new Error('bad plan');
    if (license()) {
      const r = await fetch(`${base}/v1/checkout`, { method: 'POST', headers: { authorization: `Bearer ${license()}`, 'content-type': 'application/json' }, body: JSON.stringify({ plan }) });
      const j = await r.json().catch(() => ({}));
      if (!j.url) throw new Error(j.error ?? `The sync server answered ${r.status}.`);
      return payUrl(j.url);
    }
    const token = randomBytes(32).toString('hex');
    keys.remove(CLAIMED);
    write({ claim: { token, until: Date.now() + CLAIM_FOR } });
    if (started) pollLoop();
    return `${base}/buy?plan=${plan}&claim=${createHash('sha256').update(token).digest('hex')}`;
  }

  async function pollClaim() {
    const c = saved.claim;
    if (!c || c.until < Date.now()) return null;
    const r = await fetch(`${base}/v1/claim/${c.token}`).catch(() => null);
    if (!r?.ok) return null;
    const { key } = await r.json();
    if (!KEY_RE.test(key ?? '')) return null;
    keys.set(CLAIMED, key);
    write({ claim: undefined });
    return key;
  }
  let polling = null;
  function pollLoop() {
    clearInterval(polling);
    polling = setInterval(async () => {
      if (!saved.claim || saved.claim.until < Date.now() || await pollClaim()) { clearInterval(polling); onStatus(status()); }
    }, 5000);
  }

  const check = (lic, passphrase) => {
    if (!KEY_RE.test(lic ?? '')) throw Object.assign(new Error('That is not a sync key.'), { code: 'bad_key' });
    if (typeof passphrase !== 'string' || passphrase.length < 10 || passphrase.length > 200) throw Object.assign(new Error('The passphrase needs 10 to 200 characters.'), { code: 'bad_passphrase' });
  };
  const keep = (lic, dk) => { keys.set(LICENSE, lic); keys.set(DATAKEY, Buffer.from(dk).toString('base64')); };

  // First computer: makes the data key and returns the recovery code. Later computers: unlock and pull.
  // `confirmed` is false when the passphrase was typed once ("I already have a key"): a brand-new account then
  // answers { confirm: true } so the screen can ask for it again before it becomes the only way in.
  async function setup(lic, passphrase, confirmed = true) {
    lic = String(lic ?? '').trim().toUpperCase();
    check(lic, passphrase);
    const c = conn(lic);
    let out = {}, dk;
    if (await engine.hasVault(c)) dk = await engine.joinExisting({ ...c, passphrase });
    else {
      if (!confirmed) return { confirm: true };
      const n = await engine.setupNew({ ...c, passphrase }); dk = n.dataKey; out = { recovery: n.recovery };
    }
    keep(lic, dk);
    keys.remove(CLAIMED);
    write({ cursor: 0, versions: {}, dirty: chats.list().map((x) => x.id), snap: undefined, claim: undefined, state: 'on', detail: undefined });
    await syncNow();
    return out;
  }

  async function recover(code, passphrase, lic = license() ?? keys.get(CLAIMED)) {
    check(lic, passphrase);
    const dk = await engine.resetWithRecovery({ ...conn(lic), code: String(code ?? ''), passphrase });
    if (!license()) { keep(lic, dk); keys.remove(CLAIMED); write({ cursor: 0, versions: {}, dirty: chats.list().map((x) => x.id), snap: undefined, state: 'on' }); }
    await syncNow();
  }

  async function changePassphrase(passphrase) {
    check(license(), passphrase);
    await engine.changePassphrase({ ...conn(), dataKey: dataKey(), passphrase });
  }

  async function billingUrl() {
    const r = await fetch(`${base}/v1/billing`, { method: 'POST', headers: { authorization: `Bearer ${license()}` } });
    const j = await r.json().catch(() => ({}));
    if (!j.url) throw new Error(j.error ?? `The sync server answered ${r.status}.`);
    return payUrl(j.url);
  }

  // Stops syncing here and forgets the sync key and data key. Chats and provider keys stay.
  function turnOff() {
    keys.remove(LICENSE); keys.remove(DATAKEY); keys.remove(CLAIMED);
    clearTimeout(nudge); clearInterval(polling);
    saved = {};
    rmSync(stateFile, { force: true });
    onStatus(status());
  }

  let ticker = null;
  function start() {
    started = true;
    if (license()) void syncNow();
    ticker = setInterval(() => { if (license()) void syncNow(); }, 60_000);
    if (saved.claim) pollLoop();
  }
  function stop() { started = false; clearInterval(ticker); clearInterval(polling); clearTimeout(nudge); }

  return {
    status, buy, pollClaim, cancelClaim: () => { clearInterval(polling); write({ claim: undefined }); }, setup, syncNow, changePassphrase, recover, billingUrl, turnOff, start, stop,
    recovery: () => (dataKey() ? engine.recoveryCode(dataKey()) : null),
    nudge: () => { if (started && license()) { clearTimeout(nudge); nudge = setTimeout(() => void syncNow(), 3000); } },
  };
}
