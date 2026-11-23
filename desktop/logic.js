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

export function menuTemplate({ port, reused, startAtLogin }, on) {
  return [
    { label: 'Open FreeAITokens', click: on.open },
    { type: 'separator' },
    { label: reused ? `Using the endpoint already running on port ${port}` : `Running on http://127.0.0.1:${port}/v1`, enabled: false },
    { label: 'Copy endpoint', click: on.copyEndpoint },
    { label: 'Copy local token', click: on.copyToken },
    { label: 'Add a provider…', click: on.add },
    { type: 'separator' },
    { label: 'Start at login', type: 'checkbox', checked: startAtLogin, click: on.toggleLogin },
    { label: 'Quit freeaitokens', click: on.quit },
  ];
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
