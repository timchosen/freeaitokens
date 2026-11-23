// The license key is the bearer token. Only its hash is stored.
import { sha256hex, KEY_RE } from './license.ts';
import type { Env } from './index.ts';

export type LicenseRow = {
  key_hash: string; plan: 'year' | 'life'; stripe_customer: string | null; stripe_ref: string | null;
  first_session: string; email_hash: string | null; paid_until: number | null; revoked: number | null; created: number;
};

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

// allowExpired: renewing and the billing page must work after a yearly plan has lapsed.
export async function authLicense(req: Request, env: Env, now: number, allowExpired = false): Promise<{ ok: true; lic: LicenseRow } | { ok: false; res: Response }> {
  const key = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!key || !KEY_RE.test(key)) return { ok: false, res: json({ error: 'unauthorized' }, 401) };
  const lic = await env.SYNC_DB.prepare('SELECT * FROM licenses WHERE key_hash = ?').bind(await sha256hex(key)).first<LicenseRow>();
  if (!lic) return { ok: false, res: json({ error: 'unauthorized' }, 401) };
  if (lic.revoked != null) return { ok: false, res: json({ error: 'revoked' }, 402) };
  if (!allowExpired && lic.paid_until != null && lic.paid_until < now) return { ok: false, res: json({ error: 'expired' }, 402) };
  return { ok: true, lic };
}
