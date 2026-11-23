import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
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
  const { existsSync } = await import('node:fs');
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
