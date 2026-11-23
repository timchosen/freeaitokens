// Checks a translation against English: same string keys and placeholders, every page present,
// and each page keeps the English page's placeholders, links, ids and classes.
// Usage: node site/i18n/check.mjs <code>
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const pagesDir = join(here, '../pages');
const META = /^<!--\s*title:\s*([^|]*?)\s*\|\s*description:\s*([^|]*?)\s*-->\r?\n/;
const all = (re, s) => [...s.matchAll(re)].map((m) => m[1]).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function checkLocale(code) {
  const problems = [];
  const en = JSON.parse(readFileSync(join(here, 'en.json'), 'utf8'));
  const file = join(here, `${code}.json`);
  if (!existsSync(file)) return [`missing i18n/${code}.json`];
  const t = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of Object.keys(en)) {
    if (!(k in t)) { problems.push(`string ${k} missing`); continue; }
    if (!same(all(/(\{\{?\w+\}\}?)/g, en[k]), all(/(\{\{?\w+\}\}?)/g, t[k]))) problems.push(`string ${k} placeholders differ`);
    if (!same(all(/<(\w+)/g, en[k]), all(/<(\w+)/g, t[k]))) problems.push(`string ${k} tags differ`);
  }
  for (const k of Object.keys(t)) if (!(k in en)) problems.push(`string ${k} is not in en.json`);

  for (const f of readdirSync(pagesDir).filter((f) => f.endsWith('.html'))) {
    const p = join(pagesDir, code, f);
    if (!existsSync(p)) { problems.push(`page ${f} missing`); continue; }
    const src = readFileSync(join(pagesDir, f), 'utf8');
    const tr = readFileSync(p, 'utf8');
    if (!META.test(tr)) problems.push(`${f}: first line must be <!-- title: ... | description: ... --> with no | inside`);
    if (!same(all(/(\{\{\w+\}\})/g, src), all(/(\{\{\w+\}\})/g, tr))) problems.push(`${f}: {{placeholders}} differ from English`);
    const own = `/${f.replace(/\.html$/, '').replace(/^index$/, '')}`;
    const enLinks = new Set(all(/href="([^"]*)"/g, src));
    const trLinks = new Set(all(/href="([^"]*)"/g, tr));
    for (const h of enLinks) if (!trLinks.has(h)) problems.push(`${f}: link ${h} missing`);
    for (const h of trLinks) if (!enLinks.has(h) && h !== own) problems.push(`${f}: link ${h} is not in the English page`);
    if (!same(all(/\sid="([^"]*)"/g, src), all(/\sid="([^"]*)"/g, tr))) problems.push(`${f}: ids differ`);
    if (!same(all(/class="([^"]*)"/g, src).filter((c) => c !== 'small muted'), all(/class="([^"]*)"/g, tr).filter((c) => c !== 'small muted'))) problems.push(`${f}: classes differ`);
    if (/freeaitokens(?![\w.\/-])/.test(tr.replace(/<(code|pre)[\s\S]*?<\/\1>|="[^"]*"/g, ''))) problems.push(`${f}: write the name as FreeAITokens`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkLocale(process.argv[2]);
  console.log(problems.length ? problems.join('\n') : 'ok');
  process.exitCode = problems.length ? 1 : 0;
}
