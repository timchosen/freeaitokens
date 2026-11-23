// A sync Worker environment for tests: D1 backed by node:sqlite with the real schema,
// R2 and the email sender backed by plain objects.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { sha256hex } from '../../sync/src/license.ts';
import type { Env } from '../../sync/src/index.ts';

function fakeD1(db: DatabaseSync) {
  const stmt = (sql: string, args: any[] = []): any => ({
    bind: (...a: any[]) => stmt(sql, a),
    first: async (col?: string) => {
      const r: any = db.prepare(sql).get(...args);
      return r == null ? null : col ? r[col] : { ...r };
    },
    all: async () => ({ results: db.prepare(sql).all(...args).map((r: any) => ({ ...r })) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    exec: () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: any[]) => {
      db.exec('BEGIN');
      try { const out = list.map((s) => s.exec()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

function fakeR2(blobs: Map<string, Uint8Array>) {
  return {
    put: async (k: string, v: ArrayBuffer | Uint8Array | string) => { blobs.set(k, typeof v === 'string' ? new TextEncoder().encode(v) : new Uint8Array(v as ArrayBuffer)); },
    get: async (k: string) => {
      const v = blobs.get(k);
      return v ? { arrayBuffer: async () => v.slice().buffer, size: v.byteLength } : null;
    },
    delete: async (k: string | string[]) => { for (const x of [k].flat()) blobs.delete(x); },
  };
}

export function makeEnv(over: Partial<Env> = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../sync/schema.sql', import.meta.url), 'utf8'));
  const blobs = new Map<string, Uint8Array>();
  const mail: any[] = [];
  const env = {
    SYNC_DB: fakeD1(db), SYNC_BLOBS: fakeR2(blobs), EMAIL: { send: async (m: any) => { mail.push(m); } },
    STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', LICENSE_SECRET: 'lic-secret', EMAIL_SECRET: 'mail-secret',
    STRIPE_PRICE_YEAR: 'price_year', STRIPE_PRICE_LIFE: 'price_life', SITE_URL: 'https://freeaitokens.co',
    ...over,
  } as unknown as Env;
  return { env, db, blobs, mail };
}

export async function addLicense(db: DatabaseSync, key: string, o: { plan?: string; paid_until?: number | null; revoked?: number | null; session?: string; email_hash?: string } = {}) {
  db.prepare('INSERT INTO licenses (key_hash, plan, first_session, email_hash, paid_until, revoked, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(await sha256hex(key), o.plan ?? 'year', o.session ?? `cs_${key}`, o.email_hash ?? null, o.paid_until === undefined ? Date.now() + 86_400_000 : o.paid_until, o.revoked ?? null, Date.now());
}
