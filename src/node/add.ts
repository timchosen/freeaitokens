import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as p from '@clack/prompts';
import type { Provider } from '../core/catalogue.js';
import type { LimitTracker } from '../core/limits.js';
import type { Fetch } from '../core/upstream.js';
import type { KeyStore } from './keys.js';

export function matchKey(prov: Provider, text: string): string | null {
  const t = text.trim();
  if (!prov.keyPattern || !t) return null;
  return new RegExp(`^(?:${prov.keyPattern.replace(/^\^|\$$/g, '')})$`).test(t) ? t : null;
}

// A bad key is refused at once; a slow or broken model only means: try the next one (at most 3).
export async function validateKey(prov: Provider, key: string, f: Fetch): Promise<{ ok: true } | { ok: false; reason: string }> {
  let reason = '';
  for (const m of prov.models.slice(0, 3)) {
    try {
      const r = await f(`${prov.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: m.id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(20_000),
      });
      if (r.ok || r.status === 429) return { ok: true }; // 429: the key works, it is just busy
      if (r.status === 401 || r.status === 403) return { ok: false, reason: 'key rejected' };
      reason = `${prov.name} answered with status ${r.status}`;
    } catch (e) {
      reason = `could not reach ${prov.name}: ${(e as Error).message}`;
    }
  }
  return { ok: false, reason };
}

const quiet = { stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'], timeout: 1500, encoding: 'utf8' as const };
const CLIPBOARD: [string, string[]][] = [
  ['pbpaste', []],
  ['powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard']],
  ['wl-paste', ['--no-newline']],
  ['xclip', ['-selection', 'clipboard', '-o']],
  ['termux-clipboard-get', []],
];
let clipboardCmd: [string, string[]] | null | undefined;

export function readClipboard(): string | null {
  const tryOne = ([cmd, args]: [string, string[]]) => { try { return execFileSync(cmd, args, quiet); } catch { return null; } };
  if (clipboardCmd) return tryOne(clipboardCmd);
  if (clipboardCmd === null) return null;
  for (const c of CLIPBOARD) {
    const out = tryOne(c);
    if (out !== null) { clipboardCmd = c; return out; }
  }
  clipboardCmd = null;
  return null;
}

export function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.env.TERMUX_VERSION ? ['termux-open-url', [url]]
    : ['xdg-open', [url]];
  try { spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* the URL is printed too */ }
}

const CONNECT_TIMEOUT_MS = 5 * 60_000;

// OpenRouter's official one-click connect (OAuth PKCE, S256) with a local callback.
export async function connectOpenRouter(f: Fetch, open: (url: string) => void = openBrowser): Promise<string> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');
  let resolveCode!: (code: string) => void;
  const code = new Promise<string>((r) => { resolveCode = r; });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const c = u.searchParams.get('code');
    if (!c || u.searchParams.get('state') !== state) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('This link is not from the connection you started. Go back to the terminal.');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('Connected. You can close this tab and go back to the terminal.');
    resolveCode(c);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const auth = new URL('https://openrouter.ai/auth');
  auth.searchParams.set('callback_url', `http://localhost:${port}/callback`);
  auth.searchParams.set('code_challenge', challenge);
  auth.searchParams.set('code_challenge_method', 'S256');
  auth.searchParams.set('state', state);
  auth.searchParams.set('key_label', 'freeaitokens');
  open(auth.toString());
  let timer: NodeJS.Timeout | undefined;
  try {
    const got = await Promise.race([code, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('No answer from OpenRouter within 5 minutes.')), CONNECT_TIMEOUT_MS); })]);
    const r = await f('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: got, code_verifier: verifier, code_challenge_method: 'S256' }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || typeof j.key !== 'string') throw new Error(`OpenRouter did not return a key (status ${r.status}).`);
    return j.key;
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    server.close();
  }
}

function limitText(prov: Provider): string {
  const l = prov.models.find((m) => m.limits)?.limits;
  if (prov.termsNote) return prov.termsNote;
  if (!l) return '';
  return [l.rpm && `${l.rpm}/min`, l.rpd && `${l.rpd}/day`].filter(Boolean).join(', ');
}

async function waitForClipboard(prov: Provider, ms: number): Promise<string | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const k = matchKey(prov, readClipboard() ?? '');
    if (k) return k;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

export async function runAdd(catalogue: Provider[], keys: KeyStore, f: Fetch): Promise<void> {
  p.intro('Add a free provider');
  const choices = catalogue.filter((x) => !x.keyless && !keys.get(x.id));
  if (!choices.length) { p.outro('Every provider in the list already has a key.'); return; }
  const id = await p.select({
    message: 'Which provider?',
    options: choices.map((x) => ({ value: x.id, label: x.name + (x.paid ? ' (paid)' : ''), hint: limitText(x) })),
  });
  if (p.isCancel(id)) { p.cancel('Nothing added.'); return; }
  const prov = catalogue.find((x) => x.id === id)!;
  if (prov.terms === 'caution' && prov.termsNote) p.note(prov.termsNote, 'Before you sign up');

  for (;;) {
    let key: string | null = null;
    if (prov.connect === 'openrouter') {
      p.log.step('Opening OpenRouter in your browser. Sign in and approve the connection.');
      try { key = await connectOpenRouter(f); } catch (e) { p.log.error((e as Error).message); }
    } else {
      const k = keySteps(prov);
      p.note(k.text, `Get a ${prov.name} key`);
      openBrowser(k.open);
      const watch = !!prov.keyPattern && readClipboard() !== null && await p.confirm({ message: 'Watch the clipboard for your key? (it is only read during this step)' });
      if (p.isCancel(watch)) { p.cancel('Nothing added.'); return; }
      if (watch) {
        const s = p.spinner();
        s.start('Waiting for you to copy the key');
        key = await waitForClipboard(prov, CONNECT_TIMEOUT_MS);
        s.stop(key ? 'Key found on the clipboard.' : 'No key seen on the clipboard.');
      }
      if (!key) {
        const typed = await p.password({ message: `Paste your ${prov.name} key` });
        if (p.isCancel(typed)) { p.cancel('Nothing added.'); return; }
        key = typed.trim() || null;
      }
    }
    if (key) {
      const s = p.spinner();
      s.start('Checking the key');
      const v = await validateKey(prov, key, f);
      s.stop(v.ok ? 'Key works.' : `That did not work: ${v.reason}.`);
      if (v.ok) { keys.set(prov.id, key); p.outro(`Added ${prov.name}.`); return; }
    }
    const again = await p.confirm({ message: 'Try again?' });
    if (p.isCancel(again) || !again) { p.cancel('Nothing added.'); return; }
  }
}

// The steps to show and the page to open. A referral sign-up link is opened first and always labelled.
export function keySteps(prov: Provider): { text: string; open: string } {
  const steps = prov.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  if (prov.referral && prov.signupUrl) {
    return { text: `${steps}\n\nSign up: ${prov.signupUrl} (referral link)\nKeys: ${prov.keyUrl}`, open: prov.signupUrl };
  }
  return { text: `${steps}\n\n${prov.keyUrl}`, open: prov.keyUrl! };
}

export function runList(catalogue: Provider[], keys: KeyStore, tracker: LimitTracker): string {
  const lines = catalogue.map((prov) => line(prov) + (prov.media?.length ? `  also: ${[...new Set(prov.media.map((m) => m.kind))].join(', ')}` : ''));
  function line(prov: Provider): string {
    const status = prov.keyless ? 'no key needed' : keys.get(prov.id) ? 'key added' : 'not added';
    // Without a key nothing is "left": show what adding one would give.
    if (status === 'not added') {
      const rpd = Math.max(0, ...prov.models.map((m) => m.limits?.rpd ?? 0));
      return `${prov.name.padEnd(18)} ${status.padEnd(14)} ${rpd ? `up to ${rpd} free requests a day per model` : ''}`.trimEnd();
    }
    const left = prov.models.flatMap((m) => {
      if (!m.limits?.rpd) return [];
      const used = tracker.state.windows[`${prov.id}/${m.id}`];
      const today = used && used.day[0] === Math.floor(tracker.now() / 86_400_000) * 86_400_000 ? used.day[1] : 0;
      return [`${m.id} ${m.limits.rpd - today} left today`];
    });
    return `${prov.name.padEnd(18)} ${status.padEnd(14)} ${left.join(', ')}`.trimEnd();
  }
  return lines.join('\n');
}

export function runRemove(providerId: string, keys: KeyStore): void {
  keys.remove(providerId);
}
