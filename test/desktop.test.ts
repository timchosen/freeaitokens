import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS module
import { allowedUrl, choices, menuLine, menuTemplate, providerRows, cleanMessages, launchFile } from '../desktop/logic.js';

const cat = [
  { id: 'kilo', name: 'Kilo', keyless: true },
  { id: 'groq', name: 'Groq', keyless: false, keyUrl: 'https://console.groq.com/keys', signupUrl: 'https://console.groq.com', termsNote: 'n' },
  { id: 'or', name: 'OpenRouter', keyless: false, connect: 'openrouter', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'has', name: 'Has', keyless: false, keyUrl: 'https://has.example' },
  { id: 'cf', name: 'CF', keyless: false, keyUrl: 'https://cf.example', baseUrl: 'https://cf.example/accounts/{account}/ai/v1' },
];

test('allowedUrl accepts only pages the provider list names', () => {
  assert.ok(allowedUrl(cat, 'https://console.groq.com/keys'));
  assert.ok(allowedUrl(cat, 'https://console.groq.com'));
  assert.ok(!allowedUrl(cat, 'https://evil.example'));
  assert.ok(!allowedUrl(cat, 'file:///etc/passwd'));
  assert.ok(!allowedUrl(cat, undefined));
});

test('choices lists keyed providers without a key, with steps, and OpenRouter as a connect flow', () => {
  const keys = { get: (id: string) => (id === 'has' ? 'k' : null) };
  const c = choices(cat, keys, (p: any) => ({ text: `steps for ${p.id}`, open: p.keyUrl }));
  assert.deepEqual(c.map((x: any) => x.id), ['groq', 'or', 'cf']);
  assert.equal(c[0].account, false);
  assert.equal(c[2].account, true); // asks for the account ID as well as the token
  assert.equal(c[0].steps, 'steps for groq');
  assert.equal(c[0].open, 'https://console.groq.com/keys');
  assert.equal(c[1].connect, 'openrouter');
  assert.equal(c[1].open, null);
});

test('menu opens the window first, shows the endpoint, and has no grayed-out provider lines', () => {
  assert.equal(menuLine('Groq               key added      x 9 left today'), 'Groq · key added · x 9 left today');
  const open = () => {};
  const t = menuTemplate({ port: 4949, reused: false, startAtLogin: true }, { open });
  assert.equal(t[0].label, 'Open FreeAITokens');
  assert.equal(t[0].click, open);
  assert.ok(t.some((i: any) => /127\.0\.0\.1:4949/.test(i.label ?? '')));
  assert.ok(!t.some((i: any) => i.submenu), 'no submenu of disabled lines');
  assert.equal(t.find((i: any) => i.label === 'Start at login').checked, true);
});

test('providerRows says which providers are ready and how much is left today', () => {
  const day = Math.floor(Date.UTC(2026, 10, 23, 12) / 86_400_000) * 86_400_000;
  const tracker = { now: () => day + 3_600_000, state: { windows: { 'groq/m1': { day: [day, 40] } } } };
  const c = [
    { id: 'kilo', name: 'Kilo', keyless: true, models: [{ id: 'k', limits: {} }] },
    { id: 'groq', name: 'Groq', keyless: false, models: [{ id: 'm1', limits: { rpd: 100 } }, { id: 'm2', limits: { rpd: 50 } }] },
    { id: 'cf', name: 'CF', keyless: false, models: [{ id: 'x', limits: { rpd: 10 } }] },
  ];
  const rows = providerRows(c, { get: (id: string) => (id === 'groq' ? 'k' : null) }, tracker);
  assert.deepEqual(rows.map((r: any) => [r.id, r.status]), [['kilo', 'keyless'], ['groq', 'ready'], ['cf', 'add']]);
  assert.equal(rows[1].left, 110);
  assert.equal(rows[1].models, 2);
});

test('cleanMessages keeps only plain user and assistant text, and refuses anything else', () => {
  assert.deepEqual(cleanMessages([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]), [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]);
  assert.equal(cleanMessages([{ role: 'system', content: 'x' }]), null);
  assert.equal(cleanMessages([{ role: 'user', content: 5 }]), null);
  assert.equal(cleanMessages('nope'), null);
  assert.equal(cleanMessages([]), null);
  assert.equal(cleanMessages(Array(201).fill({ role: 'user', content: 'a' })), null);
  assert.equal(cleanMessages([{ role: 'user', content: 'a'.repeat(100_001) }]), null);
});

test('launchFile opens a tool in a terminal with its settings, quoting every value', () => {
  const spec = { cmd: 'codex', args: ['-c', 'model="free"', "it's"], env: { FREEAITOKENS_TOKEN: 't0k', EMPTY: '' } };
  const mac = launchFile('codex', 'Codex', spec, 'darwin');
  assert.equal(mac.ext, '.command');
  assert.match(mac.text, /^#!\/bin\/sh\n/);
  assert.match(mac.text, /export FREEAITOKENS_TOKEN='t0k'/);
  assert.match(mac.text, /exec 'codex' '-c' 'model="free"' 'it'\\''s'/);
  assert.match(mac.text, /command -v 'codex'/);
  assert.match(mac.text, /npm install -g @openai\/codex/);
  const win = launchFile('codex', 'Codex', spec, 'win32');
  assert.equal(win.ext, '.cmd');
  assert.match(win.text, /set "FREEAITOKENS_TOKEN=t0k"/);
  assert.match(win.text, /codex "-c" "model=\\"free\\"" "it's"/);
  assert.match(win.text, /\r\n/);
  assert.throws(() => launchFile('codex', 'Codex', { ...spec, env: { 'BAD NAME': 'x' } }, 'darwin'));
  assert.throws(() => launchFile('codex', 'Codex', { ...spec, args: ['a&b'] }, 'win32'), /character/);
});

test('desktop build names every release file without a version', async () => {
  const { readFileSync } = await import('node:fs');
  const b = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8')).build;
  assert.deepEqual(b.mac.target, [{ target: 'dmg', arch: ['universal'] }, { target: 'zip', arch: ['universal'] }]);
  // The universal app carries the keychain module for both chips, which CI installs on the Mac runner.
  assert.equal(b.mac.x64ArchFiles, '**/keyring.darwin-*.node');
  const wf = readFileSync(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8');
  // Signing variables are only set on the Mac job and only when the certificate exists: an empty CSC_LINK breaks the build.
  assert.doesNotMatch(wf, /^\s+CSC_LINK:/m);
  assert.match(wf, /if: runner\.os == 'macOS' && env\.MAC_CERT != ''/);
  assert.match(wf, /notarize:true/);
  assert.match(readFileSync(new URL('../site/static/install', import.meta.url), 'utf8'), /xattr -dr com\.apple\.quarantine/);
  assert.match(readFileSync(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8'), /keyring-darwin-x64@[\d.]+ @napi-rs\/keyring-darwin-arm64@/);
  assert.equal(b.mac.artifactName, 'FreeAITokens-mac.${ext}');
  assert.equal(b.mac.identity, '-'); // ad-hoc signed, so a downloaded copy gets Open Anyway instead of "damaged"
  assert.equal(b.mac.hardenedRuntime, false);
  assert.equal(b.win.artifactName, 'FreeAITokens-windows.${ext}');
  assert.equal(b.appImage.artifactName, 'FreeAITokens-linux-${arch}.${ext}');
  assert.equal(b.deb.artifactName, 'FreeAITokens-linux-${arch}.${ext}');
  assert.deepEqual(b.linux.target, [{ target: 'AppImage', arch: ['x64', 'arm64'] }, { target: 'deb', arch: ['x64', 'arm64'] }]);
});
