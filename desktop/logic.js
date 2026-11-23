import { BlockList, isIP } from 'node:net';
// Pure helpers for the tray app, kept out of main.js so they can be tested without Electron.

// The add window may only open pages the provider list names, never a URL a page hands it.
export function allowedUrl(catalogue, url) {
  return typeof url === "string" && catalogue.some((p) => p.signupUrl === url || p.keyUrl === url);
}

// Providers the add window offers: the ones that take a key and have none yet.
export function choices(catalogue, keys, stepsOf) {
  return catalogue.filter((p) => !p.keyless && !keys.get(p.id)).map((p) => {
    const s = p.connect === 'openrouter' ? null : stepsOf(p);
    // account: the address holds the account, so the window asks for the account ID too.
    return { id: p.id, name: p.name, note: p.termsNote ?? '', connect: p.connect ?? null, account: String(p.baseUrl ?? '').includes('{account}'), steps: s?.text ?? '', open: s?.open ?? null };
  });
}

// runList pads columns for a terminal; a menu wants one readable line.
export const menuLine = (line) => line.trim().replace(/\s{2,}/g, ' · ');

export function menuTemplate({ port, reused, startAtLogin }, on, t) {
  return [
    { label: t('menu_open'), click: on.open },
    { type: 'separator' },
    { label: reused ? t('menu_reused', { port: String(port) }) : t('menu_running', { url: `http://127.0.0.1:${port}/v1` }), enabled: false },
    { label: t('menu_copy_endpoint'), click: on.copyEndpoint },
    { label: t('menu_copy_token'), click: on.copyToken },
    { label: t('menu_add'), click: on.add },
    { type: 'separator' },
    { label: t('set_login'), type: 'checkbox', checked: startAtLogin, click: on.toggleLogin },
    { label: t('menu_quit'), click: on.quit },
  ];
}

// The app's language: the saved choice, else the first system language with a translation, else English.
export function pickLang(saved, preferred, codes) {
  if (codes.includes(saved)) return saved;
  for (const l of preferred ?? []) {
    const base = String(l).toLowerCase().split(/[-_]/)[0];
    if (codes.includes(base)) return base;
  }
  return 'en';
}

// One row per provider for the window: ready (key added), keyless, or add (no key yet), and requests left today.
export function providerRows(catalogue, keys, tracker) {
  const today = Math.floor(tracker.now() / 86_400_000) * 86_400_000;
  return catalogue.map((p) => {
    const status = p.keyless ? 'keyless' : keys.get(p.id) ? 'ready' : 'add';
    let left = 0;
    for (const m of p.models) {
      const rpd = m.limits?.rpd ?? p.limits?.rpd;
      if (!rpd) continue;
      const w = tracker.state.windows[`${p.id}/${m.id}`];
      left += Math.max(0, rpd - (w && w.day[0] === today ? w.day[1] : 0));
    }
    return { id: p.id, name: p.name, status, left: status === 'add' ? 0 : left, models: p.models.length + (p.media?.length ?? 0), note: p.termsNote ?? '', media: [...new Set((p.media ?? []).map((m) => m.kind))] };
  });
}

// The playground's messages come from a web page: plain user/assistant text only, with sane sizes.
export function cleanMessages(list) {
  if (!Array.isArray(list) || !list.length || list.length > 200) return null;
  const out = [];
  for (const m of list) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || m.content.length > 100_000) return null;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

const INSTALL = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  gemini: 'npm install -g @google/gemini-cli',
  qwen: 'npm install -g @qwen-code/qwen-code',
};

// A script that opens the tool in a terminal with FreeAITokens' settings (.command on Mac, .cmd on Windows, .sh on Linux).
export function launchFile(tool, name, spec, platform) {
  for (const k of Object.keys(spec.env)) if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`bad variable name ${k}`);
  const hint = INSTALL[tool] ? `Install it with: ${INSTALL[tool]}` : `Install ${name} from its website, then try again.`;
  if (platform === 'win32') {
    const bad = /[&|<>^%!\r\n]/;
    for (const v of [spec.cmd, ...spec.args, ...Object.values(spec.env)]) if (bad.test(v)) throw new Error(`unsupported character in ${JSON.stringify(v)}`);
    const q = (v) => `"${v.replace(/"/g, '\\"')}"`;
    const lines = ['@echo off', `title ${name} with FreeAITokens`, ...Object.entries(spec.env).map(([k, v]) => `set "${k}=${v}"`),
      `where ${spec.cmd} >nul 2>nul || (echo ${name} is not installed. ${hint} & pause & exit /b 1)`,
      [spec.cmd, ...spec.args.map(q)].join(' ')];
    return { ext: '.cmd', text: lines.join('\r\n') + '\r\n' };
  }
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const lines = ['#!/bin/sh', `# Opens ${name} using FreeAITokens. Made by the FreeAITokens app.`, 'cd "$HOME"',
    ...Object.entries(spec.env).map(([k, v]) => `export ${k}=${q(v)}`),
    `if ! command -v ${q(spec.cmd)} >/dev/null 2>&1; then echo ${q(`${name} is not installed. ${hint}`)}; exit 1; fi`,
    `exec ${[spec.cmd, ...spec.args].map(q).join(' ')}`];
  return { ext: platform === 'darwin' ? '.command' : '.sh', text: lines.join('\n') + '\n' };
}

// Chat models the playground can pick from: keyless providers and ones with a key saved.
export function modelOptions(catalogue, keys) {
  return catalogue.filter((p) => p.keyless || keys.get(p.id))
    .flatMap((p) => p.models.map((m) => ({ value: `${p.id}/${m.id}`, label: m.id, provider: p.name })));
}

// The catalogue with only the chosen model in it ('free' keeps everything); null if it does not exist.
export function narrowTo(catalogue, choice) {
  if (choice === 'free') return catalogue;
  const i = typeof choice === 'string' ? choice.indexOf('/') : -1;
  if (i < 1) return null;
  const pid = choice.slice(0, i), mid = choice.slice(i + 1);
  const p = catalogue.find((x) => x.id === pid);
  const m = p?.models.find((x) => x.id === mid);
  return m ? [{ ...p, models: [m] }] : null;
}

// True when a release tag like 'v0.3.3' is newer than this app's version.
export function newerVersion(current, tag) {
  const parse = (v) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
  const a = parse(current), b = parse(tag);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] > a[i];
  return false;
}

// The Usage page: the last `days` days (empty days included), totals, and providers by requests.
export function usageSummary(usage, days, catalogue, now = Date.now()) {
  const list = [];
  const totals = { requests: 0, ok: 0, fail: 0, tokens: 0, avgMs: 0, successRate: null };
  const prov = new Map();
  let ms = 0;
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    const d = usage?.[date];
    list.push({ date, ok: d?.ok ?? 0, fail: d?.fail ?? 0, tokens: d?.tokens ?? 0 });
    if (!d) continue;
    totals.ok += d.ok; totals.fail += d.fail; totals.tokens += d.tokens; ms += d.ms;
    for (const [id, p] of Object.entries(d.providers ?? {})) {
      const t = prov.get(id) ?? { id, name: catalogue.find((c) => c.id === id)?.name ?? id, ok: 0, fail: 0, tokens: 0 };
      t.ok += p.ok; t.fail += p.fail; t.tokens += p.tokens;
      prov.set(id, t);
    }
  }
  totals.requests = totals.ok + totals.fail;
  totals.avgMs = totals.ok ? Math.round(ms / totals.ok) : 0;
  totals.successRate = totals.requests ? totals.ok / totals.requests : null;
  return { days: list, totals, providers: [...prov.values()].sort((a, b) => b.ok + b.fail - (a.ok + a.fail)) };
}

// Image models the playground can use: keyless providers and ones with a key saved.
export function imageOptions(catalogue, keys) {
  return catalogue.filter((p) => p.keyless || keys.get(p.id))
    .flatMap((p) => (p.media ?? []).filter((m) => m.kind === 'image').map((m) => ({ value: `${p.id}/${m.id}`, label: m.id, provider: p.name })));
}

// The picture in an OpenAI-style images answer: base64, or a web address to fetch.
export function imageFrom(body) {
  const d = body?.data?.[0];
  if (typeof d?.b64_json === 'string' && d.b64_json) return { b64: d.b64_json };
  if (typeof d?.url === 'string' && /^https:\/\//.test(d.url)) return { url: d.url };
  return null;
}

// The file type from the first bytes, never from what the provider says it sent.
export function imageType(u8) {
  const at = (i, ...b) => b.every((x, j) => u8[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpg';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
  return null;
}

// True for addresses on this computer or a private network: image downloads must never reach them.
// IPv4-mapped addresses are checked as the IPv4 inside; other IPv6 forms that carry an IPv4 address
// (NAT64, 6to4, IPv4-compatible) are blocked whole.
const V4 = new BlockList(), V6 = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) V4.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16], ['fc00::', 7], ['fe80::', 10],
  ['fec0::', 10], ['ff00::', 8]]) V6.addSubnet(net, bits, 'ipv6');
export function privateAddress(ip) {
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(ip);
  if (mapped) {
    const v4 = mapped[1] ?? [parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255, parseInt(mapped[3], 16) >> 8, parseInt(mapped[3], 16) & 255].join('.');
    return privateAddress(v4);
  }
  const type = isIP(ip);
  if (type === 4) return V4.check(ip, 'ipv4');
  if (type === 6) return /^::ffff:/i.test(ip) || V6.check(ip, 'ipv6');
  return true;
}
