import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore plain JS module
import { render, stats, build } from '../site/build.mjs';

const catalogue = JSON.parse(readFileSync(new URL('../src/catalogue.json', import.meta.url), 'utf8'));

test('stats on the real catalogue: 27 providers, about 7.5 billion tokens a month', () => {
  const s = stats(catalogue);
  assert.equal(s.providers, catalogue.length);
  assert.ok(Math.abs(s.monthlyTokens - 7.52e9) / 7.52e9 < 0.01, String(s.monthlyTokens));
});

test('stats counts tpd, else 2000 tokens per request, over 30 days', () => {
  const s = stats([{ id: 'a', keyless: true, models: [{ id: 'x', limits: { tpd: 1000 } }, { id: 'y' }], limits: { rpd: 10 } }]);
  assert.equal(s.monthlyTokens, (1000 + 20000) * 30);
  assert.equal(s.keyless, 1);
});

test('render puts the title in <title> and marks the current page in the menu', () => {
  const html = render('<p>hi</p>', { title: 'Setup', description: 'd', path: '/setup' });
  assert.match(html, /<title>Setup · FreeAITokens<\/title>/);
  assert.match(html, /<a href="\/setup" aria-current="page">/);
  assert.match(html, /<p>hi<\/p>/);
});

test('build writes every page with nothing left unfilled', () => {
  const out = mkdtempSync(join(tmpdir(), 'site-'));
  build(out);
  const pages = readdirSync(out).filter((f) => f.endsWith('.html'));
  assert.ok(pages.includes('index.html'));
  for (const p of pages) assert.doesNotMatch(readFileSync(join(out, p), 'utf8'), /\{\{/, p);
});

// @ts-ignore plain JS module
import { detectOS, downloadFor, starsLabel } from '../site/static/site.js';

test('detectOS knows Mac, Windows and Linux, and says null for phones and tablets', () => {
  assert.equal(detectOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15', 'MacIntel'), 'mac');
  assert.equal(detectOS('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', 'Win32'), 'windows');
  assert.equal(detectOS('Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', 'Linux x86_64'), 'linux');
  assert.equal(detectOS('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 'iPhone'), null);
  assert.equal(detectOS('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36', 'Linux armv8l'), null);
  assert.equal(detectOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15', 'MacIntel:touch'), null);
});

test('downloadFor gives the file and names the other systems', () => {
  assert.deepEqual(downloadFor('mac'), { label: 'Download for Mac', file: 'FreeAITokens-mac.dmg', others: ['windows', 'linux'] });
  assert.equal(downloadFor('windows').file, 'FreeAITokens-windows.exe');
  assert.equal(downloadFor('linux').file, 'FreeAITokens-linux-x86_64.AppImage');
  assert.deepEqual(downloadFor(null), { label: 'Download for your computer', file: null, others: ['mac', 'windows', 'linux'] });
});

test('starsLabel hides small or unknown counts', () => {
  assert.equal(starsLabel(null), '');
  assert.equal(starsLabel(9), '');
  assert.equal(starsLabel(128), '★ 128');
  assert.equal(starsLabel(1234), '★ 1.2k');
});

import { spawnSync } from 'node:child_process';
const SCRIPT = new URL('../site/static/install', import.meta.url).pathname;
function dry(os: string, arch: string, home = '/home/u') {
  return spawnSync('sh', [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, FREEAITOKENS_DRY_RUN: '1', FREEAITOKENS_OS: os, FREEAITOKENS_ARCH: arch } });
}

test('install script picks the right file and place for each system', () => {
  for (const arch of ['arm64', 'x86_64']) {
    const r = dry('Darwin', arch);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /releases\/latest\/download\/FreeAITokens-mac\.zip/);
    assert.match(r.stdout, /Applications/);
  }
  const l = dry('Linux', 'x86_64');
  assert.match(l.stdout, /FreeAITokens-linux-x86_64\.AppImage/);
  assert.match(l.stdout, /\/home\/u\/\.local\/bin\/freeaitokens-app/);
  assert.match(dry('Linux', 'aarch64').stdout, /FreeAITokens-linux-arm64\.AppImage/);
});

test('install script refuses an unsupported system and changes nothing', () => {
  const r = dry('FreeBSD', 'amd64');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not supported/);
  assert.equal(spawnSync('sh', ['-n', SCRIPT]).status, 0);
});

test('every page has a title and description, links only to pages that exist, and writes the name FreeAITokens', async () => {
  const out = mkdtempSync(join(tmpdir(), 'site-'));
  build(out);
  const pages = readdirSync(out).filter((f) => f.endsWith('.html'));
  for (const name of ['index', 'download', 'setup', 'ask-your-ai', 'docs', 'about', 'disclaimer', 'privacy', 'support', 'install-script', '404']) assert.ok(pages.includes(`${name}.html`), name);
  for (const p of pages) {
    const html = readFileSync(join(out, p), 'utf8');
    assert.match(html, /<meta name="description" content="[^"]{20,}">/, p);
    for (const [, href] of html.matchAll(/href="(\/[^"#]*)/g)) {
      const path = href === '/' ? 'index.html' : href.slice(1);
      assert.ok(existsSync(join(out, path)) || existsSync(join(out, `${path}.html`)), `${p} links to missing ${href}`);
    }
    const prose = html.replace(/<(code|pre|script|title)[\s\S]*?<\/\1>/g, '').replace(/="[^"]*"/g, '').replace(/freeaitokens\.co|timchosen\/freeaitokens|freeaitokens-app/g, '');
    assert.doesNotMatch(prose, /freeaitokens/, `${p} writes the name in lowercase outside code`);
  }
  assert.ok(existsSync(join(out, 'setup.md')) && existsSync(join(out, 'install')) && existsSync(join(out, 'install.ps1')));
});

test('review fixes: release deploy blocks placeholders, Windows download is quiet, ARM Linux gets the ARM file', () => {
  const pkg = JSON.parse(readFileSync(new URL('../site/package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.deploy, /SITE_RELEASE=1 node build\.mjs/);
  assert.match(readFileSync(new URL('../site/static/install.ps1', import.meta.url), 'utf8'), /\$ProgressPreference = 'SilentlyContinue'/);
  assert.match(readFileSync(new URL('../site/static/install', import.meta.url), 'utf8'), /quit app id "\{\{appId\}\}"/);
  assert.equal(downloadFor('linux', true).file, 'FreeAITokens-linux-arm64.AppImage');
  const out = mkdtempSync(join(tmpdir(), 'site-'));
  process.env.SITE_RELEASE = '1';
  try { build(out); } finally { delete process.env.SITE_RELEASE; }
});

test('owner links live only in site.config.json, so a fork changes one file', async () => {
  const { readdirSync: ls, statSync } = await import('node:fs');
  const root = new URL('../site/', import.meta.url).pathname;
  const walk = (d: string): string[] => ls(d).flatMap((f) => {
    const p = join(d, f);
    if (['dist', '.wrangler', 'node_modules', 'site.config.json', 'wrangler.jsonc'].includes(f)) return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  for (const f of walk(root)) assert.doesNotMatch(readFileSync(f, 'utf8'), /timchosen|buymeacoffee\.com|freeaitokens\.co\b/, f);
  const cfg = JSON.parse(readFileSync(join(root, 'site.config.json'), 'utf8'));
  const out = mkdtempSync(join(tmpdir(), 'site-'));
  build(out);
  for (const f of ['index.html', 'install', 'install.ps1', 'setup.md', 'site.js']) {
    const t = readFileSync(join(out, f), 'utf8');
    assert.doesNotMatch(t, /\{\{\w+\}\}/, f);
  }
  const home = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(home.includes(cfg.coffee) && home.includes(`github.com/${cfg.repo}`));
  assert.match(readFileSync(join(out, 'install'), 'utf8'), new RegExp(`github\\.com/${cfg.repo}/releases/latest/download`));
});

test('the footer links to Terms, Privacy and Disclaimer, and the disclaimer lists every provider', () => {
  const out = mkdtempSync(join(tmpdir(), 'site-'));
  build(out);
  const home = readFileSync(join(out, 'index.html'), 'utf8');
  for (const href of ['/terms', '/privacy', '/disclaimer', '/providers', '/models']) assert.ok(home.includes(`href="${href}"`), href);
  const disc = readFileSync(join(out, 'disclaimer.html'), 'utf8');
  for (const p of catalogue) assert.ok(disc.includes(p.name.replace(/&/g, '&amp;')), p.name);
});

// @ts-ignore plain JS module
import { slug, modelRows } from '../site/build.mjs';
// @ts-ignore plain JS module
import { filterModels } from '../site/static/site.js';

test('every provider gets a page with sign-up and key links, and every model gets its own page', () => {
  const out = mkdtempSync(join(tmpdir(), 'site-'));
  build(out);
  const list = readFileSync(join(out, 'providers.html'), 'utf8');
  for (const p of catalogue) {
    assert.ok(list.includes(`href="/providers/${p.id}"`), p.id);
    const page = readFileSync(join(out, 'providers', `${p.id}.html`), 'utf8');
    if (p.keyUrl) assert.ok(page.includes(p.keyUrl.replace(/&/g, '&amp;')), `${p.id} key link`);
    for (const m of modelRows(catalogue).filter((r: any) => r.provider === p.id)) {
      const href = `/models/${p.id}/${m.slug}`;
      assert.ok(page.includes(`href="${href}"`), href);
      assert.match(readFileSync(join(out, `${href.slice(1)}.html`), 'utf8'), new RegExp(`/providers/${p.id}`));
    }
  }
  const models = readFileSync(join(out, 'models.html'), 'utf8');
  assert.equal((models.match(/data-model /g) ?? []).length, modelRows(catalogue).length);
});

test('model slugs are safe and unique within a provider', () => {
  assert.equal(slug('meta-llama/Llama-3.3-70B:free'), 'meta-llama-llama-3-3-70b-free');
  assert.equal(slug('@cf/zai-org/glm-4.7-flash'), 'cf-zai-org-glm-4-7-flash');
  for (const p of catalogue) {
    const s = modelRows(catalogue).filter((r: any) => r.provider === p.id).map((r: any) => r.slug);
    assert.equal(new Set(s).size, s.length, p.id);
  }
});

test('filterModels matches search, provider, kind, features and context', () => {
  const rows = [
    { provider: 'groq', kind: 'chat', name: 'gpt-oss-120b', tools: true, images: false, keyless: false, context: 131072 },
    { provider: 'kilo', kind: 'chat', name: 'nemotron', tools: false, images: true, keyless: true, context: 32000 },
    { provider: 'groq', kind: 'speech', name: 'playai-tts', tools: false, images: false, keyless: false, context: 0 },
  ];
  const f = (q: object) => filterModels(rows, { q: '', provider: '', kind: '', tools: false, images: false, keyless: false, minContext: 0, ...q }).map((r: any) => r.name);
  assert.deepEqual(f({}), ['gpt-oss-120b', 'nemotron', 'playai-tts']);
  assert.deepEqual(f({ q: 'NEMO' }), ['nemotron']);
  assert.deepEqual(f({ provider: 'groq', kind: 'chat' }), ['gpt-oss-120b']);
  assert.deepEqual(f({ tools: true }), ['gpt-oss-120b']);
  assert.deepEqual(f({ images: true, keyless: true }), ['nemotron']);
  assert.deepEqual(f({ minContext: 100000 }), ['gpt-oss-120b']);
});

import { generated } from '../site/build.mjs';

test('generated pages refuse a provider id that is not a plain slug', () => {
  const p = { id: '../evil', name: 'Evil', keyless: true, models: [] };
  assert.throws(() => generated([p]), /provider id/);
});

// @ts-ignore plain JS module
import { checkLocale } from '../site/i18n/check.mjs';
const locales = JSON.parse(readFileSync(new URL('../site/i18n/locales.json', import.meta.url), 'utf8'));
const en = JSON.parse(readFileSync(new URL('../site/i18n/en.json', import.meta.url), 'utf8'));

test('the header has a mobile menu button that controls the main nav', () => {
  const out = mkdtempSync(join(tmpdir(), 'site-'));
  build(out);
  const home = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(home, /<button class="menu-btn" type="button" aria-expanded="false" aria-controls="menu">/);
  assert.match(home, /<nav id="menu" aria-label="Main">/);
});

test('every translation is complete and keeps the English structure', () => {
  for (const l of locales.filter((x: any) => x.code !== 'en')) assert.deepEqual(checkLocale(l.code), [], l.code);
});

test('each language gets every page, its own links, a switcher, and the right direction', () => {
  const out = mkdtempSync(join(tmpdir(), 'site-'));
  build(out);
  const english = readdirSync(out).filter((f) => f.endsWith('.html'));
  for (const l of locales) {
    const dir = l.code === 'en' ? out : join(out, l.code);
    for (const f of english) assert.ok(existsSync(join(dir, f)), `${l.code}/${f}`);
    const home = readFileSync(join(dir, 'index.html'), 'utf8');
    assert.match(home, new RegExp(`<html lang="${l.lang}" dir="${l.dir}">`), l.code);
    for (const o of locales) assert.ok(home.includes(`hreflang="${o.lang}" lang="${o.lang}"`), `${l.code} switcher lists ${o.code}`);
    if (l.code !== 'en') {
      assert.ok(home.includes(`href="/${l.code}/download"`), `${l.code} links stay in ${l.code}`);
      assert.ok(home.includes('href="/logo.svg"') || home.includes('src="/logo.svg"'));
      const t = JSON.parse(readFileSync(new URL(`../site/i18n/${l.code}.json`, import.meta.url), 'utf8'));
      const provs = readFileSync(join(dir, 'providers.html'), 'utf8');
      assert.ok(provs.includes(`<h1>${t.providers_title}</h1>`), `${l.code} providers page is translated`);
      assert.ok(existsSync(join(dir, 'providers', 'groq.html')) && existsSync(join(dir, 'models', 'groq')), l.code);
    }
    for (const f of english) for (const [, href] of readFileSync(join(dir, f), 'utf8').matchAll(/href="(\/[^"#]*)/g)) {
      const path = href.endsWith('/') ? `${href.slice(1)}index.html` : href.slice(1);
      assert.ok(existsSync(join(out, path)) || existsSync(join(out, `${path}.html`)), `${l.code}/${f} links to missing ${href}`);
    }
    for (const f of [join(dir, 'index.html'), join(dir, 'models.html')]) assert.doesNotMatch(readFileSync(f, 'utf8'), /\{\{|\[\[/, f);
  }
});

test('model tables stack into labelled cards on phones', () => {
  const out = mkdtempSync(join(tmpdir(), 'site-'));
  build(out);
  const models = readFileSync(join(out, 'models.html'), 'utf8');
  assert.match(models, /<div class="table stack">/);
  assert.match(models, /<td data-label="Provider">/);
});

test('the in-page script strings match en.json', () => {
  for (const k of Object.keys(en).filter((k) => k.startsWith('js_'))) assert.ok(readFileSync(new URL('../site/static/site.js', import.meta.url), 'utf8').includes(JSON.stringify(en[k])), k);
  assert.equal(downloadFor('mac').label, 'Download for Mac');
  assert.equal(downloadFor('mac', false, { js_download_os: 'Descargar para {os}' }).label, 'Descargar para Mac');
});

