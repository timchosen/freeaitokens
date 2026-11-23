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
