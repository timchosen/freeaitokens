import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
// @ts-ignore plain JS module
import { allowedUrl, choices, menuLine, menuTemplate, providerRows, cleanMessages, launchFile, modelOptions, narrowTo, newerVersion, usageSummary, pickLang, imageOptions, imageFrom, imageType, privateAddress, guessKind, sortedKind, audioType, mediaOptions, pcmToWav, pickRelease, docMessage, joinUsers, voiceSetup } from '../desktop/logic.js';
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

test('imageOptions lists image models the person can use', () => {
  const c = [
    { id: 'kilo', name: 'Kilo', keyless: true, models: [], media: [{ id: 'k-img', kind: 'image' }] },
    { id: 'cf', name: 'Cloudflare', keyless: false, models: [], media: [{ id: '@cf/flux', kind: 'image' }, { id: 'whisper', kind: 'transcription' }] },
    { id: 'or', name: 'OpenRouter', keyless: false, models: [], media: [{ id: 'recraft', kind: 'image' }] },
  ];
  const keys = new Map([['cf', 'x']]);
  assert.deepEqual(imageOptions(c, keys), [
    { value: 'kilo/k-img', label: 'k-img', provider: 'Kilo' },
    { value: 'cf/@cf/flux', label: '@cf/flux', provider: 'Cloudflare' },
  ]);
});

test('imageFrom takes base64 or a web address from an images answer, nothing else', () => {
  assert.deepEqual(imageFrom({ data: [{ b64_json: 'iVBOR' }] }), { b64: 'iVBOR' });
  assert.deepEqual(imageFrom({ data: [{ url: 'https://cdn.example/a.png' }] }), { url: 'https://cdn.example/a.png' });
  assert.equal(imageFrom({ data: [{ url: 'file:///etc/passwd' }] }), null);
  assert.equal(imageFrom({ data: [] }), null);
  assert.equal(imageFrom(null), null);
});

test('imageType knows PNG, JPEG and WebP by their first bytes', () => {
  assert.equal(imageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'png');
  assert.equal(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
  assert.equal(imageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(imageType(new TextEncoder().encode('<svg onload=alert(1)>')), null);
});

test('SVG code blocks get a safe picture preview; other code does not', () => {
  const ctx: any = {};
  vm.runInNewContext(readText(new URL('../desktop/md.js', import.meta.url), 'utf8'), ctx);
  const src = ctx.svgPreview('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n');
  assert.match(src, /^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
  assert.equal(ctx.svgPreview('let a = "<svg>";'), null);
  assert.equal(ctx.svgPreview('<svg><rect/>'), null, 'needs a closing tag');
});

test('the window may show data: images and nothing from the web', () => {
  const html = readText(new URL('../desktop/app.html', import.meta.url), 'utf8');
  assert.match(html, /img-src 'self' data:;/);
  assert.doesNotMatch(html, /img-src[^;]*https?:/);
});

test('privateAddress spots loopback, private, link-local and other local addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:192.168.0.5', '198.18.0.1', '192.0.0.1', 'fec0::1', '2002:7f00:1::', '64:ff9b::7f00:1', '64:ff9b:1::1', '::7f00:1']) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '104.18.2.3', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(privateAddress(ip), false, ip);
});

test('guessKind reads what a message asks for: a picture, speech, or chat', () => {
  assert.equal(guessKind('draw a fox in the snow'), 'image');
  assert.equal(guessKind('Make me a logo for a bakery'), 'image');
  assert.equal(guessKind('a picture of a red car'), 'image');
  assert.equal(guessKind('please say good morning'), 'speech');
  assert.equal(guessKind('Read aloud: the quick brown fox'), 'speech');
  assert.equal(guessKind('what is a fox'), 'chat');
  assert.equal(guessKind('how do I draw conclusions from data'), 'chat');
  assert.equal(guessKind('dibuja un zorro'), 'image');
  assert.equal(guessKind('dessine un chat'), 'image');
  assert.equal(guessKind('zeichne eine Katze'), 'image');
  assert.equal(guessKind('di mana rumahmu?'), 'chat');
});

test('sortedKind takes the first word of the sorting answer, or nothing', () => {
  assert.equal(sortedKind('Image.'), 'image');
  assert.equal(sortedKind(' SPEECH\n'), 'speech');
  assert.equal(sortedKind('chat'), 'chat');
  assert.equal(sortedKind('I think chat'), null);
  assert.equal(sortedKind('Image - they want a picture'), 'image');
  assert.equal(sortedKind(''), null);
  assert.equal(sortedKind(undefined), null);
});

test('audioType knows audio files by their first bytes', () => {
  const u = (...b) => new Uint8Array([...b, ...new Array(16).fill(0)]);
  assert.equal(audioType(u(0x49, 0x44, 0x33)), 'mp3');
  assert.equal(audioType(u(0xff, 0xfb, 0x90)), 'mp3');
  assert.equal(audioType(u(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45)), 'wav');
  assert.equal(audioType(u(0x4f, 0x67, 0x67, 0x53)), 'ogg');
  assert.equal(audioType(u(0x66, 0x4c, 0x61, 0x43)), 'flac');
  assert.equal(audioType(u(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70)), 'm4a');
  assert.equal(audioType(u(0x1a, 0x45, 0xdf, 0xa3)), 'webm');
  assert.equal(audioType(u(0x89, 0x50, 0x4e, 0x47)), null);
  assert.equal(audioType(u(0xff, 0xfe, 0x68, 0x00)), null); // UTF-16 text, not an MP3 frame
  assert.equal(audioType(new Uint8Array([0x49, 0x44])), null);
});

test('mediaOptions lists only models of one kind that you can use now', () => {
  const c = [
    { id: 'a', name: 'A', keyless: true, media: [{ id: 'voice', kind: 'speech' }, { id: 'pic', kind: 'image' }] },
    { id: 'b', name: 'B', keyless: false, media: [{ id: 'voice2', kind: 'speech' }] },
    { id: 'c', name: 'C', keyless: false, media: [{ id: 'voice3', kind: 'speech' }] },
  ];
  const keys = { get: (id) => (id === 'b' ? 'k' : undefined) };
  assert.deepEqual(mediaOptions(c, keys, 'speech').map((o) => o.value), ['a/voice', 'b/voice2']);
  assert.deepEqual(imageOptions(c, keys).map((o) => o.value), ['a/pic']);
});

test('pcmToWav gives raw PCM speech a WAV header from its content type, and leaves other audio alone', () => {
  const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
  const wav = pcmToWav(pcm, 'audio/pcm;rate=44100;channels=1');
  assert.equal(audioType(wav), 'wav');
  assert.equal(wav.length, 44 + 8);
  const v = new DataView(wav.buffer, wav.byteOffset);
  assert.equal(v.getUint32(24, true), 44100);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getUint32(40, true), 8);
  assert.equal(pcmToWav(pcm, 'audio/mpeg'), pcm);
  assert.equal(pcmToWav(pcm, null), pcm);
});

// Task 8: chats kept in the app's state folder
// @ts-ignore plain JS module
import { migrateChats, openChatStore, cleanChat } from '../desktop/chats.js';
import { mkdtempSync, statSync, readFileSync as readF, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('migrateChats gives every chat and message an id and a time, keeping order and content', () => {
  const old = [
    { id: 1700000000000, title: 'b', model: 'free', mode: 'chat', updated: 2000, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo', meta: { provider: 'Groq', model: 'x', ms: 3 } }] },
    { title: 'a', model: 'free', updated: 1000, messages: [{ role: 'user', content: 'pic', kind: 'image' }, { role: 'assistant', content: '', image: '0b5c7a3e-1f2d-4c5b-9a8e-7d6c5b4a3f21.png', prompt: 'pic' }] },
  ];
  const out = migrateChats(old);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c: any) => c.title), ['b', 'a']);
  for (const c of out) {
    assert.match(c.id, UUID);
    for (const m of c.messages) assert.match(m.id, UUID);
    const at = c.messages.map((m: any) => m.at);
    assert.deepEqual([...at].sort((x, y) => x - y), at, 'times keep message order');
    assert.ok(at.at(-1) <= c.updated);
  }
  assert.equal(out[0].messages[1].content, 'yo');
  assert.deepEqual(out[0].messages[1].meta, { provider: 'Groq', model: 'x', ms: 3 });
  assert.equal(out[1].messages[1].image, '0b5c7a3e-1f2d-4c5b-9a8e-7d6c5b4a3f21.png');
  assert.equal(out[0].mode, 'chat');
  assert.deepEqual(migrateChats('junk'), []);
  assert.deepEqual(migrateChats([null, 5, { title: 'x' }]), []);
});

test('cleanChat refuses oversized or malformed chats', () => {
  const ok = migrateChats([{ title: 't', model: 'free', updated: 1, messages: [{ role: 'user', content: 'hi' }] }])[0];
  assert.ok(cleanChat(ok));
  assert.equal(cleanChat({ ...ok, id: 'not-a-uuid' }), null);
  assert.equal(cleanChat({ ...ok, messages: [{ ...ok.messages[0], role: 'system' }] }), null);
  assert.equal(cleanChat({ ...ok, messages: [{ ...ok.messages[0], content: 'x'.repeat(100_001) }] }), null);
  assert.equal(cleanChat({ ...ok, messages: [{ ...ok.messages[0], image: '../../etc/passwd' }] }), null);
});

test('chat store round-trips through its file, owner-only, and remove leaves a hidden tombstone', () => {
  const file = pjoin(mkdtempSync(pjoin(tmpdir(), 'fat-chats-')), 'chats.json');
  const s = openChatStore(file);
  const [a, b] = migrateChats([{ title: 'a', model: 'free', updated: 1, messages: [] }, { title: 'b', model: 'free', updated: 2, messages: [] }]);
  const seen: string[] = [];
  s.onChange((id: string) => seen.push(id));
  s.put(a); s.put(b);
  assert.deepEqual(openChatStore(file).list().map((c: any) => c.title), ['b', 'a'], 'newest first, from disk');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  s.remove(a.id);
  assert.deepEqual(s.list().map((c: any) => c.title), ['b']);
  const raw = JSON.parse(readF(file, 'utf8'));
  const stub = raw.chats.find((c: any) => c.id === a.id);
  assert.ok(stub.deleted && stub.messages.length === 0);
  assert.equal(stub.updated, 1, 'the stub keeps the removed copy\'s time, so edits it never saw still win');
  assert.deepEqual(seen, [a.id, b.id, a.id]);
});

// Task 9: the desktop sync service against the real Worker
// @ts-ignore plain JS module
import { createSyncService } from '../desktop/syncsvc.js';
import worker from '../sync/src/index.ts';
import { licenseKey } from '../sync/src/license.ts';
import { makeEnv, addLicense } from './helpers/sync-env.ts';

function fakeKeys() {
  const m = new Map<string, string>();
  return { backend: 'keychain', get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => { m.set(k, v); }, remove: (k: string) => { m.delete(k); } };
}

test('sync service: buy and claim a key, set up, a second computer pulls chats and keys, turning off forgets only sync', async () => {
  const { env, db } = makeEnv();
  const wctx = { waitUntil() {}, passThroughOnException() {} } as any;
  const f = (async (u: any, i?: any) => worker.fetch(new Request(u, i), env, wctx)) as typeof fetch;
  const engine = await import('../src/node/sync/engine.ts');
  const mk = () => {
    const dir = mkdtempSync(pjoin(tmpdir(), 'fat-sync-'));
    const keys = fakeKeys();
    const chats = openChatStore(pjoin(dir, 'chats.json'));
    const svc = createSyncService({ base: 'https://sync.test', keys, chats, stateFile: pjoin(dir, 'sync.json'), fetch: f, engine, providers: () => ['groq', 'cf'] });
    return { keys, chats, svc };
  };
  const A = mk();
  A.keys.set('groq', 'gsk_1');
  const [c] = migrateChats([{ title: 'hi', model: 'free', updated: 5, messages: [{ role: 'user', content: 'yo' }] }]);
  A.chats.put(c);
  assert.equal(A.svc.status().state, 'off');
  assert.equal(A.svc.key(), null, 'no key to copy before sync is set up');

  const url = await A.svc.buy('year');
  assert.match(url, /^https:\/\/sync\.test\/buy\?plan=year&claim=[0-9a-f]{64}$/);
  assert.equal(A.svc.status().state, 'waiting');
  assert.equal(await A.svc.pollClaim(), null, 'nothing paid yet');
  const key = await licenseKey('lic-secret', 'cs_t1');
  await addLicense(db, key, { session: 'cs_t1' });
  db.prepare('INSERT INTO claims (claim_hash, session, expires) VALUES (?, ?, ?)').run(url.split('claim=')[1], 'cs_t1', Date.now() + 60_000);
  assert.equal(await A.svc.pollClaim(), key);
  assert.equal(A.svc.status().key, key, 'the key is shown until a passphrase is set');

  await assert.rejects(A.svc.setup('FAT-nope', 'a long passphrase'), /key/);
  await assert.rejects(A.svc.setup(key, 'short'), /passphrase/);
  const { recovery } = await A.svc.setup(key, 'a long passphrase');
  assert.match(recovery, /^[A-Z2-7]{4}-/);
  assert.equal(A.svc.recovery(), recovery);
  assert.equal(A.svc.status().state, 'on');
  assert.equal(A.svc.status().plan, 'year');
  assert.equal(A.keys.get('sync:license'), key);
  assert.equal(A.svc.key(), key, 'the sync key can be copied again once sync is on');

  const B = mk();
  B.keys.set('cf', 'acct:cf_2');
  await assert.rejects(B.svc.setup(key, 'the wrong passphrase'), engine.WrongPassphraseError);
  assert.deepEqual(await B.svc.setup(key, 'a long passphrase'), {});
  assert.deepEqual(B.chats.list().map((x: any) => x.title), ['hi']);
  assert.equal(B.keys.get('groq'), 'gsk_1');

  // A change on B reaches A.
  B.chats.put({ ...B.chats.list()[0], title: 'renamed', updated: 10 });
  assert.equal((await B.svc.syncNow()).ok, true);
  assert.equal((await A.svc.syncNow()).ok, true);
  assert.deepEqual(A.chats.list().map((x: any) => x.title), ['renamed']);
  assert.equal(A.keys.get('cf'), 'acct:cf_2');

  B.svc.turnOff();
  assert.equal(B.keys.get('sync:license'), null);
  assert.equal(B.keys.get('sync:datakey'), null);
  assert.equal(B.keys.get('groq'), 'gsk_1');
  assert.equal(B.chats.list().length, 1);
  assert.equal(B.svc.status().state, 'off');
});

test('sync service: synced keys touch only known providers, and only sync or Stripe pages are opened', async () => {
  const engine = await import('../src/node/sync/engine.ts');
  const keys = fakeKeys();
  keys.set('sync:license', 'FAT-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA');
  keys.set('sync:datakey', Buffer.alloc(32, 1).toString('base64'));
  const dir = mkdtempSync(pjoin(tmpdir(), 'fat-sync-'));
  let reply: any = {};
  const f = (async () => new Response(JSON.stringify(reply), { status: 200 })) as unknown as typeof fetch;
  // An engine that brings back a bundle naming a sync secret and an unknown provider.
  const fakeEngine = { ...engine, SyncEngine: class { o: any; constructor(o: any) { this.o = o; } async run() {
    for (const [p, k] of [['sync:license', 'FAT-EVILX-EVILX-EVILX-EVILX-EVILX'], ['nope', 'x'], ['groq', 'gsk_ok']]) this.o.store.setKey(p, k);
    return { ok: true, pulled: 1, pushed: 0 };
  } } };
  const svc = createSyncService({ base: 'https://sync.test', keys, chats: openChatStore(pjoin(dir, 'c.json')), stateFile: pjoin(dir, 's.json'), fetch: f, engine: fakeEngine, providers: () => ['groq'] });
  await svc.syncNow();
  assert.equal(keys.get('sync:license'), 'FAT-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA');
  assert.equal(keys.get('nope'), null);
  assert.equal(keys.get('groq'), 'gsk_ok');
  for (const url of ['file:///etc/passwd', 'http://checkout.stripe.com/x', 'https://evil.example/pay', 'javascript:alert(1)']) {
    reply = { url };
    await assert.rejects(svc.buy('year'), /not a payment page/, url);
    await assert.rejects(svc.billingUrl(), /not a payment page/, url);
  }
  reply = { url: 'https://checkout.stripe.com/c/pay/cs_1' };
  assert.equal(await svc.buy('life'), 'https://checkout.stripe.com/c/pay/cs_1');
  reply = { url: 'https://billing.stripe.com/p/session/x' };
  assert.equal(await svc.billingUrl(), 'https://billing.stripe.com/p/session/x');
});

// Two computers on one sync key, with a switch that takes the network away.
async function twoComputers(opts: { aKeys?: Record<string, string>; bKeys?: Record<string, string> } = {}) {
  const { env, db } = makeEnv();
  const wctx = { waitUntil() {}, passThroughOnException() {} } as any;
  const net: { down: boolean; hook?: (url: string, init?: any) => Response | Error | undefined } = { down: false };
  const f = (async (u: any, i?: any) => {
    if (net.down) throw new TypeError('fetch failed');
    const hit = net.hook?.(String(u), i);
    if (hit instanceof Error) throw hit;
    return hit ?? worker.fetch(new Request(u, i), env, wctx);
  }) as typeof fetch;
  const engine = await import('../src/node/sync/engine.ts');
  const key = await licenseKey('lic-secret', 'cs_two');
  await addLicense(db, key, { session: 'cs_two' });
  const mk = (preset: Record<string, string> = {}) => {
    const dir = mkdtempSync(pjoin(tmpdir(), 'fat-sync-'));
    const keys = fakeKeys();
    for (const [p, k] of Object.entries(preset)) keys.set(p, k);
    const chats = openChatStore(pjoin(dir, 'chats.json'));
    const svc = createSyncService({ base: 'https://sync.test', keys, chats, stateFile: pjoin(dir, 'sync.json'), fetch: f, engine, providers: () => ['groq', 'cf'] });
    svc.start(); svc.stop(); // started, so edits are marked for the next push, but no timers left running
    return { keys, chats, svc };
  };
  const A = mk(opts.aKeys);
  await A.svc.setup(key, 'a long passphrase');
  const B = mk(opts.bKeys);
  await B.svc.setup(key, 'a long passphrase');
  return { A, B, net, key, db, env };
}

test('sync service: a chat edited while offline is pushed once the network is back', async () => {
  const { A, B, net } = await twoComputers();
  const [c] = migrateChats([{ title: 'plane', model: 'free', updated: 5, messages: [{ role: 'user', content: 'yo' }] }]);
  net.down = true;
  B.chats.put(c);
  assert.equal((await B.svc.syncNow()).ok, false, 'offline');
  net.down = false;
  assert.equal((await B.svc.syncNow()).ok, true);
  await A.svc.syncNow();
  assert.deepEqual(A.chats.list().map((x: any) => x.title), ['plane']);
});

test('sync service: joining with an old copy of a key keeps the account\'s current key, and adds keys only the new computer has', async () => {
  const { A, B } = await twoComputers({ aKeys: { groq: 'gsk_current' }, bKeys: { groq: 'gsk_old', cf: 'acct:cf_b' } });
  assert.equal(B.keys.get('groq'), 'gsk_current');
  await A.svc.syncNow();
  assert.equal(A.keys.get('groq'), 'gsk_current');
  assert.equal(A.keys.get('cf'), 'acct:cf_b');
});

test('sync service: a keychain item that cannot be read is left alone, never synced as a removal', async () => {
  const { A, B } = await twoComputers({ aKeys: { groq: 'gsk_1' } });
  assert.equal(B.keys.get('groq'), 'gsk_1');
  // As after an app update when the person clicks Deny: the plain read says "no key", the strict one throws.
  const plainGet = B.keys.get;
  (B.keys as any).get = (k: string) => (k === 'groq' ? null : plainGet(k));
  (B.keys as any).read = (k: string) => { if (k === 'groq') throw new Error('User interaction is not allowed.'); return null; };
  assert.equal((await B.svc.syncNow()).ok, true);
  await A.svc.syncNow();
  assert.equal(A.keys.get('groq'), 'gsk_1');
});

test('chat store: saving an old copy of a chat (the window held it while sync pulled) keeps the messages sync brought in', async () => {
  const { mergeChat } = await import('../src/node/sync/engine.ts');
  const s = openChatStore(pjoin(mkdtempSync(pjoin(tmpdir(), 'fat-chats-')), 'chats.json'), mergeChat);
  const [c] = migrateChats([{ title: 'a', model: 'free', updated: 5, messages: [{ role: 'user', content: 'one' }] }]);
  s.put(c);
  const pulled = { ...c, updated: 6, messages: [...c.messages, { id: randomUUID(), at: 6, role: 'assistant', content: 'from the laptop' }] };
  s.put(pulled); // what sync wrote
  s.save({ ...c, updated: 7, messages: [...c.messages, { id: randomUUID(), at: 7, role: 'user', content: 'two' }] }); // the window's stale copy
  assert.deepEqual(s.list()[0].messages.map((m: any) => m.content), ['one', 'from the laptop', 'two']);
});

test('sync service: a pulled chat older than this computer\'s copy is merged into it, not skipped', async () => {
  const engine = await import('../src/node/sync/engine.ts');
  const keys = fakeKeys();
  keys.set('sync:license', 'FAT-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA');
  keys.set('sync:datakey', Buffer.alloc(32, 1).toString('base64'));
  const dir = mkdtempSync(pjoin(tmpdir(), 'fat-sync-'));
  const chats = openChatStore(pjoin(dir, 'c.json'), engine.mergeChat);
  const [c] = migrateChats([{ title: 'a', model: 'free', updated: 10, messages: [{ role: 'user', content: 'here' }] }]);
  chats.put(c);
  const f = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  const fakeEngine = { ...engine, SyncEngine: class { o: any; constructor(o: any) { this.o = o; } async run() {
    this.o.store.putChat({ ...c, updated: 5, messages: [{ id: randomUUID(), at: 4, role: 'assistant', content: 'there' }] });
    return { ok: true, pulled: 1, pushed: 0 };
  } } };
  const svc = createSyncService({ base: 'https://sync.test', keys, chats, stateFile: pjoin(dir, 's.json'), fetch: f, engine: fakeEngine, providers: () => [] });
  await svc.syncNow();
  assert.deepEqual(chats.list()[0].messages.map((m: any) => m.content).sort(), ['here', 'there']);
});

test('sync service: a picked-up key waits in the keychain, not in the state file', async () => {
  const { env, db } = makeEnv();
  const wctx = { waitUntil() {}, passThroughOnException() {} } as any;
  const f = (async (u: any, i?: any) => worker.fetch(new Request(u, i), env, wctx)) as typeof fetch;
  const dir = mkdtempSync(pjoin(tmpdir(), 'fat-sync-'));
  const keys = fakeKeys();
  const svc = createSyncService({ base: 'https://sync.test', keys, chats: openChatStore(pjoin(dir, 'c.json')), stateFile: pjoin(dir, 's.json'), fetch: f, engine: await import('../src/node/sync/engine.ts'), providers: () => [] });
  const url = await svc.buy('life');
  const key = await licenseKey('lic-secret', 'cs_claimed');
  await addLicense(db, key, { session: 'cs_claimed' });
  db.prepare('INSERT INTO claims (claim_hash, session, expires) VALUES (?, ?, ?)').run(url.split('claim=')[1], 'cs_claimed', Date.now() + 60_000);
  assert.equal(await svc.pollClaim(), key);
  assert.equal(svc.status().key, key);
  assert.ok(!readF(pjoin(dir, 's.json'), 'utf8').includes(key), 'not on disk in plain text');
  await svc.setup(key, 'a long passphrase');
  assert.equal(keys.get('sync:claimed'), null, 'gone once set up');
});

test('sync service: a key with no account yet asks for the new passphrase twice, even through "I already have a key"', async () => {
  const { env, db } = makeEnv();
  const wctx = { waitUntil() {}, passThroughOnException() {} } as any;
  const f = (async (u: any, i?: any) => worker.fetch(new Request(u, i), env, wctx)) as typeof fetch;
  const key = await licenseKey('lic-secret', 'cs_site');
  await addLicense(db, key, { session: 'cs_site' });
  const dir = mkdtempSync(pjoin(tmpdir(), 'fat-sync-'));
  const keys = fakeKeys();
  const svc = createSyncService({ base: 'https://sync.test', keys, chats: openChatStore(pjoin(dir, 'c.json')), stateFile: pjoin(dir, 's.json'), fetch: f, engine: await import('../src/node/sync/engine.ts'), providers: () => [] });
  assert.deepEqual(await svc.setup(key, 'a long passphrase', false), { confirm: true });
  assert.equal(svc.status().state, 'off', 'nothing set up yet');
  assert.match((await svc.setup(key, 'a long passphrase', true)).recovery, /^[A-Z2-7]{4}-/);
});

test('sync service: "too many writes" keeps sync on, and a failed usage check does not fail a good run', async () => {
  const { A, net } = await twoComputers();
  const [c] = migrateChats([{ title: 'x', model: 'free', updated: 5, messages: [{ role: 'user', content: 'yo' }] }]);
  A.chats.put(c);
  net.hook = (_u, i) => (i?.method === 'PUT' ? new Response('{"error":"too many writes"}', { status: 429 }) : undefined);
  assert.equal((await A.svc.syncNow() as any).reason, 'busy');
  assert.equal(A.svc.status().state, 'on', 'not shown as an error; it carries on next time');
  net.hook = (u) => (u.endsWith('/v1/usage') ? new TypeError('fetch failed') : undefined);
  assert.equal((await A.svc.syncNow()).ok, true);
  assert.equal(A.svc.status().state, 'on');
});

test('chat store drops removed-chat stubs older than 90 days when it opens', () => {
  const file = pjoin(mkdtempSync(pjoin(tmpdir(), 'fat-chats-')), 'chats.json');
  const day = 86_400_000, now = Date.now();
  const stub = (deleted: number) => ({ id: randomUUID(), title: '', model: '', updated: 1, deleted, messages: [] });
  const [old, fresh] = [stub(now - 91 * day), stub(now - 10 * day)];
  writeFileSync(file, JSON.stringify({ chats: [old, fresh] }));
  assert.deepEqual(openChatStore(file).all().map((c: any) => c.id), [fresh.id]);
});

test('cleanChat keeps spoken answers, transcribed files and Auto mode', () => {
  const [c] = migrateChats([{ title: 't', model: 'free', mode: 'auto', updated: 5000, messages: [
    { role: 'user', content: 'Transcribe: a.mp3', kind: 'file' },
    { role: 'assistant', kind: 'speech', content: '', audio: '0b5c7a3e-1f2d-4c5b-9a8e-7d6c5b4a3f21.mp3', meta: { provider: 'Groq', model: 'x', ms: 3, auto: 'speech' } },
  ] }]);
  assert.equal(c.mode, 'auto');
  assert.deepEqual(c.messages.map((m: any) => [m.kind, m.audio]), [['file', undefined], ['speech', '0b5c7a3e-1f2d-4c5b-9a8e-7d6c5b4a3f21.mp3']]);
  assert.equal(cleanChat({ ...c, messages: [{ ...c.messages[1], audio: '../x.mp3' }] }), null);
});

test('pickRelease offers pre-releases only to early access, never drafts, only newer versions', () => {
  const list = [
    { tag_name: 'v0.4.0', prerelease: true, draft: false, html_url: 'https://github.com/x/releases/tag/v0.4.0' },
    { tag_name: 'v0.5.0', prerelease: false, draft: true, html_url: 'https://github.com/x/releases/tag/v0.5.0' },
    { tag_name: 'v0.3.11', prerelease: false, draft: false, html_url: 'https://github.com/x/releases/tag/v0.3.11' },
  ];
  assert.deepEqual(pickRelease(list, '0.3.10', true), { tag: 'v0.4.0', url: 'https://github.com/x/releases/tag/v0.4.0', early: true });
  assert.deepEqual(pickRelease(list, '0.3.10', false), { tag: 'v0.3.11', url: 'https://github.com/x/releases/tag/v0.3.11', early: false });
  assert.equal(pickRelease(list, '0.4.0', true), null);
  assert.equal(pickRelease('junk', '0.1.0', true), null);
});

// Attaching documents: text-like files and Word documents become text for the chat.
// @ts-ignore plain JS module
import { docText, DOC_CHARS } from '../desktop/docs.js';
import { deflateRawSync } from 'node:zlib';

// A minimal zip (one deflated entry per file), enough to stand in for a .docx.
function zip(files: Record<string, string>) {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text)), n = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(Buffer.byteLength(text), 22); local.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(Buffer.byteLength(text), 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    parts.push(local, n, data); central.push(c, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

test('docText reads text, data and code files, Word documents, and refuses other binary files', async () => {
  assert.deepEqual(await docText(Buffer.from('name,count\nfox,3\n'), 'a.csv'), { text: 'name,count\nfox,3\n', cut: false });
  assert.equal((await docText(Buffer.from('\uFEFF# Notes'), 'n.md')).text, '# Notes', 'byte-order mark dropped');
  const docx = zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> &amp; bye</w:t></w:r></w:p><w:p><w:r><w:t>Line 2</w:t></w:r></w:p></w:body></w:document>' });
  assert.deepEqual(await docText(docx, 'r.docx'), { text: 'Hello & bye\nLine 2', cut: false });
  assert.equal(await docText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]), 'x.png'), null);
  assert.equal(await docText(zip({ 'other.xml': '<a/>' }), 'x.docx'), null);
  const big = await docText(Buffer.from('x'.repeat(DOC_CHARS + 10)), 'big.txt');
  assert.equal(big.text.length, DOC_CHARS); assert.equal(big.cut, true);
});

test('docMessage keeps the file name on its first line and joinUsers merges a document with the question after it', () => {
  assert.equal(docMessage('a.csv', 'x,y'), 'File: a.csv\n\n```\nx,y\n```');
  assert.deepEqual(joinUsers([{ role: 'user', content: 'File: a.csv' }, { role: 'user', content: 'sum it' }, { role: 'assistant', content: '3' }]),
    [{ role: 'user', content: 'File: a.csv\n\nsum it' }, { role: 'assistant', content: '3' }]);
});

// A one-page PDF with real text, written by hand (pdf.js rebuilds the cross-reference table itself).
function pdf(text: string) {
  const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : '';
  return Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${stream.length} >> stream
${stream}
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF`);
}

test('docText reads the text of a PDF, and a PDF with no text (a scan) says it is empty', async () => {
  assert.deepEqual(await docText(pdf('Hello from a PDF'), 'a.pdf'), { text: 'Hello from a PDF', cut: false });
  assert.deepEqual(await docText(pdf(''), 'scan.pdf'), { text: '', cut: false, empty: true });
  assert.equal(await docText(Buffer.from('%PDF-1.4 broken'), 'b.pdf'), null);
});

test('voiceSetup names who does dictation and spoken answers now, and the free provider to add for each', () => {
  const c = [
    { id: 'ovh', name: 'OVH', keyless: true, media: [{ id: 'w', kind: 'transcription' }] },
    { id: 'paidco', name: 'Paid', keyless: false, paid: true, media: [{ id: 'p', kind: 'speech' }] },
    { id: 'groq', name: 'Groq', keyless: false, media: [{ id: 'w2', kind: 'transcription' }, { id: 's', kind: 'transcription' }, { id: 'v', kind: 'speech' }] },
    { id: 'cf', name: 'Cloudflare', keyless: false, media: [{ id: 'v2', kind: 'speech' }] },
  ];
  const none = { get: () => undefined };
  assert.deepEqual(voiceSetup(c, none), {
    transcription: { using: ['OVH'], add: { id: 'groq', name: 'Groq' } },
    speech: { using: [], add: { id: 'groq', name: 'Groq' } }, // never a paid provider
  });
  const withGroq = { get: (id) => (id === 'groq' ? 'k' : undefined) };
  assert.deepEqual(voiceSetup(c, withGroq), {
    transcription: { using: ['OVH', 'Groq'], add: null },
    speech: { using: ['Groq'], add: { id: 'cf', name: 'Cloudflare' } },
  });
});
