import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS module
import { allowedUrl, choices, menuLine, menuTemplate } from '../desktop/logic.js';

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

test('menu shows the endpoint, one line per provider and a checked login item', () => {
  assert.equal(menuLine('Groq               key added      x 9 left today'), 'Groq · key added · x 9 left today');
  const t = menuTemplate({ port: 4949, reused: false, lines: ['A  b'], startAtLogin: true }, {});
  assert.match(t[0].label, /127\.0\.0\.1:4949/);
  assert.equal(t.find((i: any) => i.label === 'Providers').submenu[0].label, 'A · b');
  assert.equal(t.find((i: any) => i.label === 'Start at login').checked, true);
});

test('desktop build names every release file without a version', async () => {
  const { readFileSync } = await import('node:fs');
  const b = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8')).build;
  assert.deepEqual(b.mac.target, [{ target: 'dmg', arch: ['universal'] }, { target: 'zip', arch: ['universal'] }]);
  assert.equal(b.mac.artifactName, 'FreeAITokens-mac.${ext}');
  assert.equal(b.mac.identity, '-'); // ad-hoc signed, so a downloaded copy gets Open Anyway instead of "damaged"
  assert.equal(b.mac.hardenedRuntime, false);
  assert.equal(b.win.artifactName, 'FreeAITokens-windows.${ext}');
  assert.equal(b.appImage.artifactName, 'FreeAITokens-linux-${arch}.${ext}');
  assert.equal(b.deb.artifactName, 'FreeAITokens-linux-${arch}.${ext}');
  assert.deepEqual(b.linux.target, [{ target: 'AppImage', arch: ['x64', 'arm64'] }, { target: 'deb', arch: ['x64', 'arm64'] }]);
});
