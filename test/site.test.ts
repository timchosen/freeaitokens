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
