// Daily: delete data 90 days after a plan ends or is revoked, old tombstones, expired claims, old events and counters.
import type { Env } from './index.ts';

const DAY = 86_400_000;

export async function cleanup(env: Env, now: number): Promise<{ licenses: number; tombstones: number; claims: number }> {
  const db = env.SYNC_DB;
  const cut = now - 90 * DAY;
  // Only licenses that still have data; the license row stays so a later renewal finds it.
  const { results } = await db.prepare('SELECT key_hash FROM licenses WHERE ((paid_until IS NOT NULL AND paid_until < ?1) OR (revoked IS NOT NULL AND revoked < ?1)) AND key_hash IN (SELECT key_hash FROM counters UNION SELECT key_hash FROM vaults)').bind(cut).all<{ key_hash: string }>();
  for (const { key_hash } of results) {
    const objs = (await db.prepare('SELECT obj FROM items WHERE key_hash = ? AND obj IS NOT NULL').bind(key_hash).all<{ obj: string }>()).results.map((r) => r.obj);
    for (let i = 0; i < objs.length; i += 1000) await env.SYNC_BLOBS.delete(objs.slice(i, i + 1000));
    await db.batch(['items', 'vaults', 'counters'].map((t) => db.prepare(`DELETE FROM ${t} WHERE key_hash = ?`).bind(key_hash)));
  }
  const tomb = await db.prepare('DELETE FROM items WHERE deleted = 1 AND updated < ?').bind(cut).run();
  const claims = await db.prepare('DELETE FROM claims WHERE expires < ?').bind(now).run();
  await db.prepare('DELETE FROM events WHERE seen < ?').bind(now - 30 * DAY).run();
  // Rate windows are minutes, hours or days since 1970; anything older than two days is spent.
  await db.prepare("DELETE FROM rates WHERE (bucket LIKE 'w:%' AND window < ?1) OR (bucket LIKE 'ip:%' AND window < ?2) OR (bucket LIKE 'e:%' AND window < ?3)")
    .bind(Math.floor(now / 60_000) - 2880, Math.floor(now / 3_600_000) - 48, Math.floor(now / DAY) - 2).run();
  return { licenses: results.length, tombstones: tomb.meta.changes, claims: claims.meta.changes };
}
