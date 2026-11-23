// "Send me my key": emails every license bought with an address. Only a keyed hash of the address is stored.
import { json } from './auth.ts';
import { hmacHex, licenseKey } from './license.ts';
import { rateOk } from './items.ts';
import type { Env } from './index.ts';

const HOUR = 3_600_000;

export async function resend(req: Request, env: Env, now: number, later: (p: Promise<unknown>) => void): Promise<Response> {
  const cors = { 'access-control-allow-origin': env.SITE_URL, vary: 'origin' };
  // One answer whatever happens, so the form cannot be used to learn who bought sync.
  const done = json({ ok: true }, 200, cors);
  const email = String((await req.formData().catch(() => null))?.get('email') ?? '').trim().toLowerCase();
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email)) return done;
  if (!(await rateOk(env, `ip:${req.headers.get('cf-connecting-ip') ?? '?'}`, 5, HOUR, now))) return done;
  const eh = await hmacHex(env.EMAIL_SECRET, email);
  if (!(await rateOk(env, `e:${eh}`, 3, 24 * HOUR, now))) return done;
  const { results } = await env.SYNC_DB.prepare('SELECT first_session FROM licenses WHERE email_hash = ?').bind(eh).all<{ first_session: string }>();
  // Sent after answering, so the response time does not tell a buyer's address from a stranger's.
  later(Promise.all(results.map(async (r) => env.EMAIL.send({
    to: email,
    from: 'sync@freeaitokens.co',
    subject: 'Your FreeAITokens sync key',
    text: `Here is your FreeAITokens sync key:\n\n${await licenseKey(env.LICENSE_SECRET, r.first_session)}\n\nIn FreeAITokens, open Settings › Sync, choose "I already have a key", and enter it with your sync passphrase.\n\nIf you did not ask for this, you can ignore this email.`,
  }))).catch((e) => console.error('resend failed', e)));
  return done;
}
