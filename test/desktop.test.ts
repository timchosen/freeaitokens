import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS module
import { allowedUrl, choices, menuLine, menuTemplate, providerRows, cleanMessages, launchFile, modelOptions, narrowTo, newerVersion, usageSummary, pickLang } from '../desktop/logic.js';
import { readFileSync as readText } from 'node:fs';
import vm from 'node:vm';

// The translator in desktop/t.js is a plain script shared by the windows and the main process.
function loadT() { const ctx: any = { Intl }; vm.runInNewContext(readText(new URL('../desktop/t.js', import.meta.url), 'utf8'), ctx); return ctx.makeTranslator; }
const desktopEn = JSON.parse(readText(new URL('../desktop/i18n/en.json', import.meta.url), 'utf8'));

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
  const t = menuTemplate({ port: 4949, reused: false, startAtLogin: true }, { open }, loadT()(desktopEn, 'en'));
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
  assert.match(wf, /if: runner\.os == 'macOS' && env\.HAS_MAC_CERT == 'true'/);
  assert.doesNotMatch(wf, /^ {6}MAC_CERT: \$\{\{ secrets/m, 'the certificate is not in job-level env');
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

test('modelOptions lists only chat models you can use now, and narrowTo keeps just the chosen one', () => {
  const c = [
    { id: 'kilo', name: 'Kilo', keyless: true, models: [{ id: 'k1' }] },
    { id: 'groq', name: 'Groq', keyless: false, models: [{ id: 'g1' }, { id: 'g2' }] },
    { id: 'cf', name: 'CF', keyless: false, models: [{ id: 'c1' }] },
  ];
  const keys = { get: (id: string) => (id === 'groq' ? 'k' : null) };
  assert.deepEqual(modelOptions(c, keys).map((o: any) => o.value), ['kilo/k1', 'groq/g1', 'groq/g2']);
  assert.equal(modelOptions(c, keys)[1].provider, 'Groq');
  assert.equal(narrowTo(c, 'free'), c);
  assert.deepEqual(narrowTo(c, 'groq/g2').map((p: any) => [p.id, p.models.map((m: any) => m.id)]), [['groq', ['g2']]]);
  assert.equal(narrowTo(c, 'groq/nope'), null);
  assert.equal(narrowTo(c, 'cf/c1').length, 1, 'narrowing does not check keys; modelOptions does');
});

test('newerVersion compares release tags', () => {
  assert.equal(newerVersion('0.3.2', 'v0.3.3'), true);
  assert.equal(newerVersion('0.3.2', 'v0.3.2'), false);
  assert.equal(newerVersion('0.10.0', 'v0.9.9'), false);
  assert.equal(newerVersion('0.3.2', 'garbage'), false);
});

test('markdown renders headings, bold, lists and code, and escapes everything else', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const ctx: any = {};
  vm.runInNewContext(readFileSync(new URL('../desktop/md.js', import.meta.url), 'utf8'), ctx);
  const html = ctx.renderMarkdown('### Hi\n\n**bold** and `x<y`\n\n1. one\n2. two\n\n* a\n* b\n\n```js\nlet a = "<b>";\n```\n\n[site](https://example.com) [bad](javascript:alert(1)) <img src=x onerror=1>');
  assert.match(html, /<h3>Hi<\/h3>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>x&lt;y<\/code>/);
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(html, /<pre><code>let a = &quot;&lt;b&gt;&quot;;<\/code><\/pre>/);
  assert.match(html, /<a href="https:\/\/example\.com">site<\/a>/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.doesNotMatch(html, /<img/);
});

test('usageSummary fills every day in the range and totals it, busiest provider first', () => {
  const usage = {
    '2026-11-21': { ok: 3, fail: 1, tokens: 300, ms: 1500, providers: { groq: { ok: 3, fail: 1, tokens: 300 } } },
    '2026-11-23': { ok: 1, fail: 0, tokens: 50, ms: 500, providers: { kilo: { ok: 1, fail: 0, tokens: 50 } } },
    '2026-10-01': { ok: 9, fail: 9, tokens: 9, ms: 9, providers: {} },
  };
  const cat = [{ id: 'groq', name: 'Groq' }];
  const s = usageSummary(usage, 7, cat, Date.UTC(2026, 10, 23, 9));
  assert.equal(s.days.length, 7);
  assert.deepEqual(s.days.at(-1), { date: '2026-11-23', ok: 1, fail: 0, tokens: 50 });
  assert.deepEqual(s.days.at(-2), { date: '2026-11-22', ok: 0, fail: 0, tokens: 0 });
  assert.deepEqual(s.totals, { requests: 5, ok: 4, fail: 1, tokens: 350, avgMs: 500, successRate: 0.8 });
  assert.deepEqual(s.providers.map((p: any) => [p.name, p.ok, p.fail]), [['Groq', 3, 1], ['kilo', 1, 0]]);
  assert.equal(usageSummary({}, 7, cat, Date.UTC(2026, 10, 23)).totals.successRate, null);
});

test('pickLang uses the saved choice, else the first system language there is a translation for, else English', () => {
  const codes = ['en', 'pt', 'zh', 'ar'];
  assert.equal(pickLang('ar', ['pt-BR'], codes), 'ar');
  assert.equal(pickLang('system', ['de-DE', 'pt-BR', 'en-US'], codes), 'pt');
  assert.equal(pickLang(undefined, ['zh-Hans-CN'], codes), 'zh');
  assert.equal(pickLang('xx', ['de'], codes), 'en');
  assert.equal(pickLang(null, undefined, codes), 'en');
});

test('translator fills placeholders, formats numbers and picks plural forms', () => {
  const make = loadT();
  const en = make({ hi: 'Hi {name}', n_one: '{n} model', n_other: '{n} models' }, 'en');
  assert.equal(en('hi', { name: 'Ana' }), 'Hi Ana');
  assert.equal(en('n', { n: 1 }), '1 model');
  assert.equal(en('n', { n: 1200 }), '1,200 models');
  assert.equal(en('missing'), 'missing');
  const ar = make({ n_one: 'one', n_two: 'two', n_other: 'other' }, 'ar');
  assert.equal(ar('n', { n: 2 }), 'two');
  assert.equal(ar('n', { n: 5 }), 'other', 'a missing plural form falls back to _other');
});

test('every desktop string the windows and tray use is in en.json', () => {
  const src = ['app.html', 'add.html', 'app.js', 'main.js'].map((f) => readText(new URL(`../desktop/${f}`, import.meta.url), 'utf8')).join('\n');
  const used = new Set([...src.matchAll(/data-i18n(?:-[a-z]+)?="(\w+)"/g), ...src.matchAll(/\bt\('(\w+)'/g)].map((m) => m[1]));
  assert.ok(used.size > 50, `found only ${used.size} strings`);
  for (const k of used) assert.ok(k in desktopEn || `${k}_other` in desktopEn, `${k} is not in desktop/i18n/en.json`);
});

test('the desktop app has every site language, and each translation matches English', async () => {
  // @ts-ignore plain JS module
  const { checkDesktopLocale } = await import('../desktop/i18n/check.mjs');
  const site = readText(new URL('../site/i18n/locales.json', import.meta.url), 'utf8');
  assert.equal(readText(new URL('../desktop/i18n/locales.json', import.meta.url), 'utf8'), site);
  for (const { code } of JSON.parse(site)) assert.deepEqual(checkDesktopLocale(code), [], code);
  const files = JSON.parse(readText(new URL('../desktop/package.json', import.meta.url), 'utf8')).build.files;
  assert.ok(files.includes('i18n/*.json') && files.includes('t.js'));
});
