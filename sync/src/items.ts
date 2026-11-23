// Vault and items: encrypted bytes with a version each. Writes are compare-and-swap on the version,
// and every version has its own R2 object, so a losing concurrent write can never replace the winner's bytes.
import { json, type LicenseRow } from './auth.ts';
import type { Env } from './index.ts';

const MAX_ITEM = 1024 * 1024;
const MAX_TOTAL = 200 * 1024 * 1024;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// true while under `limit` hits in the current window.
export async function rateOk(env: Env, bucket: string, limit: number, windowMs: number, now: number): Promise<boolean> {
  const w = Math.floor(now / windowMs);
  await env.SYNC_DB.prepare('INSERT INTO rates (bucket, count, window) VALUES (?1, 1, ?2) ON CONFLICT(bucket) DO UPDATE SET count = CASE WHEN window = ?2 THEN count + 1 ELSE 1 END, window = ?2').bind(bucket, w).run();
  return (await env.SYNC_DB.prepare('SELECT count FROM rates WHERE bucket = ?').bind(bucket).first<number>('count'))! <= limit;
}

// The version a write replaces: 0 for "must not exist yet", null when the header is missing or bad.
function expected(req: Request): number | null {
  if (req.headers.get('if-none-match') === '*') return 0;
  const m = /^(\d+)$/.exec(req.headers.get('if-match') ?? '');
  return m ? Number(m[1]) : null;
}

const b64 = (buf: ArrayBuffer) => {
  let s = '';
  const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

async function write(env: Env, lic: LicenseRow, id: string, want: number, bytes: Uint8Array | null, now: number): Promise<Response> {
  const kh = lic.key_hash;
  const cur = await env.SYNC_DB.prepare('SELECT version, size FROM items WHERE key_hash = ? AND id = ?').bind(kh, id).first<{ version: number; size: number }>();
  if ((cur?.version ?? 0) !== want) return json({ version: cur?.version ?? 0 }, 412);
  const size = bytes?.byteLength ?? 0;
  const delta = size - (cur?.size ?? 0);
  if (delta > 0) {
    const used = (await env.SYNC_DB.prepare('SELECT bytes FROM counters WHERE key_hash = ?').bind(kh).first<number>('bytes')) ?? 0;
    if (used + delta > MAX_TOTAL) return json({ error: 'storage full' }, 413);
  }
  const next = want + 1;
  if (bytes) await env.SYNC_BLOBS.put(`${kh}/${id}/${next}`, bytes);
  const seq = '(SELECT seq FROM counters WHERE key_hash = ?1)';
  const swap = want === 0
    ? env.SYNC_DB.prepare(`INSERT INTO items (key_hash, id, version, seq, size, deleted, updated) VALUES (?1, ?2, 1, ${seq}, ?3, 0, ?4) ON CONFLICT DO NOTHING`).bind(kh, id, size, now)
    : env.SYNC_DB.prepare(`UPDATE items SET version = ?5, seq = ${seq}, size = ?3, deleted = ?6, updated = ?4 WHERE key_hash = ?1 AND id = ?2 AND version = ?7`).bind(kh, id, size, now, next, bytes ? 0 : 1, want);
  const res = await env.SYNC_DB.batch([
    env.SYNC_DB.prepare('INSERT INTO counters (key_hash, seq, bytes) VALUES (?, 1, 0) ON CONFLICT(key_hash) DO UPDATE SET seq = seq + 1').bind(kh),
    swap,
    // Counts the bytes only if this request's swap is the one that landed.
    env.SYNC_DB.prepare(`UPDATE counters SET bytes = bytes + ?3 WHERE key_hash = ?1 AND EXISTS (SELECT 1 FROM items WHERE key_hash = ?1 AND id = ?2 AND version = ?4 AND seq = ${seq})`).bind(kh, id, delta, next),
  ]) as { meta: { changes: number } }[];
  if (res[1].meta.changes !== 1) {
    if (bytes) await env.SYNC_BLOBS.delete(`${kh}/${id}/${next}`);
    const now2 = await env.SYNC_DB.prepare('SELECT version FROM items WHERE key_hash = ? AND id = ?').bind(kh, id).first<number>('version');
    return json({ version: now2 ?? 0 }, 412);
  }
  if (want) await env.SYNC_BLOBS.delete(`${kh}/${id}/${want}`);
  return json({ version: next });
}

export async function items(req: Request, env: Env, lic: LicenseRow, path: string, now: number): Promise<Response | null> {
  const kh = lic.key_hash;
  if (path === '/v1/vault') {
    if (req.method === 'GET') {
      const v = await env.SYNC_DB.prepare('SELECT version, body FROM vaults WHERE key_hash = ?').bind(kh).first();
      return v ? json(v) : json({ error: 'no vault' }, 404);
    }
    if (req.method === 'PUT') {
      const want = expected(req);
      const body = (await req.json().catch(() => null) as { body?: unknown } | null)?.body;
      if (want == null) return json({ error: 'if-match or if-none-match required' }, 428);
      if (typeof body !== 'string' || body.length > 4096) return json({ error: 'bad vault' }, 400);
      const r = want === 0
        ? await env.SYNC_DB.prepare('INSERT INTO vaults (key_hash, version, body) VALUES (?, 1, ?) ON CONFLICT DO NOTHING').bind(kh, body).run()
        : await env.SYNC_DB.prepare('UPDATE vaults SET version = version + 1, body = ? WHERE key_hash = ? AND version = ?').bind(body, kh, want).run();
      const version = await env.SYNC_DB.prepare('SELECT version FROM vaults WHERE key_hash = ?').bind(kh).first<number>('version');
      return json({ version }, r.meta.changes ? 200 : 412);
    }
    return null;
  }
  if (path === '/v1/items' && req.method === 'GET') {
    const q = new URL(req.url).searchParams;
    const from = Math.max(0, Number(q.get('since')) || 0);
    const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 200));
    const { results } = await env.SYNC_DB.prepare('SELECT id, version, deleted, size, updated, seq FROM items WHERE key_hash = ? AND seq > ? ORDER BY seq LIMIT ?').bind(kh, from, limit + 1).all<{ id: string; version: number; deleted: number; size: number; updated: number; seq: number }>();
    const out = [];
    let cursor = from, bytes = 0, more = results.length > limit;
    for (const r of results.slice(0, limit)) {
      if (out.length && bytes + r.size > MAX_PAGE_BYTES) { more = true; break; }
      cursor = r.seq;
      const { seq, ...item } = r;
      if (r.deleted) { out.push(item); continue; }
      const obj = await env.SYNC_BLOBS.get(`${kh}/${r.id}/${r.version}`);
      // Replaced since the query: the newer version has a later seq and comes in a later pull.
      if (!obj) continue;
      bytes += r.size;
      out.push({ ...item, blob: b64(await obj.arrayBuffer()) });
    }
    return json({ items: out, cursor, more });
  }
  const m = /^\/v1\/items\/([^/]+)$/.exec(path);
  if (!m || (req.method !== 'PUT' && req.method !== 'DELETE')) return null;
  const id = m[1];
  if (!ID.test(id)) return json({ error: 'bad id' }, 400);
  const want = expected(req);
  if (want == null || (req.method === 'DELETE' && want === 0)) return json({ error: 'if-match or if-none-match required' }, 428);
  if (!(await rateOk(env, `w:${kh}`, 120, 60_000, now))) return json({ error: 'too many writes' }, 429);
  if (req.method === 'DELETE') return write(env, lic, id, want, null, now);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_ITEM) return json({ error: 'item too large' }, 413);
  return write(env, lic, id, want, bytes, now);
}
