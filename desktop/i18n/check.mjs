// Checks a desktop translation against English: same keys, same {placeholders}, same HTML tags.
// Extra plural forms (_zero, _two, _few, _many) are allowed where English has the _other form.
// Usage: node desktop/i18n/check.mjs <code>
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const all = (re, s) => [...s.matchAll(re)].map((m) => m[1]).sort().join();

export function checkDesktopLocale(code) {
  const en = JSON.parse(readFileSync(join(here, 'en.json'), 'utf8'));
  const file = join(here, `${code}.json`);
  if (!existsSync(file)) return [`missing desktop/i18n/${code}.json`];
  const t = JSON.parse(readFileSync(file, 'utf8'));
  const problems = [];
  const base = (k) => k.replace(/_(zero|one|two|few|many|other)$/, '_other');
  for (const k of Object.keys(en)) if (!(k in t)) problems.push(`${k} missing`);
  for (const [k, v] of Object.entries(t)) {
    const src = en[k] ?? en[base(k)];
    if (src == null) { problems.push(`${k} is not in en.json`); continue; }
    if (typeof v !== 'string' || !v.trim()) { problems.push(`${k} is empty`); continue; }
    if (all(/\{(\w+)\}/g, src) !== all(/\{(\w+)\}/g, v)) problems.push(`${k} placeholders differ`);
    if (all(/<(\/?\w+[^>]*)>/g, src) !== all(/<(\/?\w+[^>]*)>/g, v)) problems.push(`${k} HTML tags differ`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const p = checkDesktopLocale(process.argv[2]);
  console.log(p.length ? p.join('\n') : 'ok');
  process.exit(p.length ? 1 : 0);
}
