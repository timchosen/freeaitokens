// Builds site/dist: each page body in pages/ wrapped in layout.html, plus everything in static/.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const layout = readFileSync(join(here, 'layout.html'), 'utf8');
const catalogue = JSON.parse(readFileSync(join(here, '../src/catalogue.json'), 'utf8'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Same count as the README: published tokens a day, else 2,000 tokens a request, over 30 days.
export function stats(cat) {
  let daily = 0;
  for (const p of cat) for (const m of p.models) {
    const l = m.limits ?? p.limits ?? {};
    daily += l.tpd ?? (l.rpd ?? 0) * 2000;
  }
  return {
    providers: cat.length,
    models: cat.reduce((n, p) => n + p.models.length, 0),
    keyless: cat.filter((p) => p.keyless).length,
    monthlyTokens: daily * 30,
  };
}

export function render(body, { title, description, path }) {
  const nav = layout.replace(/<a href="([^"]+)"( class="[^"]*")?>/g, (m, href, cls) => (href === path ? `<a href="${href}"${cls ?? ''} aria-current="page">` : m));
  return nav
    .replace('{{title}}', esc(path === '/' ? 'FreeAITokens · Free AI, without the bill' : `${title} · FreeAITokens`))
    .replace('{{description}}', esc(description))
    .replace('{{body}}', () => body);
}

function limitText(p) {
  const all = p.models.map((m) => m.limits ?? p.limits ?? {});
  const tpd = Math.max(0, ...all.map((l) => l.tpd ?? 0));
  const rpd = Math.max(0, ...all.map((l) => l.rpd ?? 0));
  const rpm = Math.max(0, ...all.map((l) => l.rpm ?? 0));
  if (tpd) return `up to ${tpd.toLocaleString('en')} tokens a day per model`;
  if (rpd) return `up to ${rpd.toLocaleString('en')} requests a day per model`;
  if (rpm) return `${rpm} requests a minute`;
  return 'not published';
}

function providerTable(cat) {
  const rows = cat.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.keyless ? 'No' : 'Free key'}</td><td>${esc(limitText(p))}</td><td>${esc(p.termsNote ?? '')}</td></tr>`);
  return `<div class="table"><table><thead><tr><th>Provider</th><th>Key needed</th><th>Free limit</th><th>Good to know</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

const billions = (n) => `about ${(n / 1e9).toFixed(1).replace(/\.0$/, '')} billion`;

export function build(outDir = join(here, 'dist')) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(join(here, 'static'), outDir, { recursive: true });
  const s = stats(catalogue);
  const fill = { providers: String(s.providers), models: String(s.models), keyless: String(s.keyless), monthly: billions(s.monthlyTokens), providerTable: providerTable(catalogue), installScript: esc(readFileSync(join(here, 'static/install'), 'utf8')), installPs1: esc(readFileSync(join(here, 'static/install.ps1'), 'utf8')) };
  for (const f of readdirSync(join(here, 'pages')).filter((f) => f.endsWith('.html'))) {
    const src = readFileSync(join(here, 'pages', f), 'utf8');
    const meta = /^<!--\s*title:\s*(.*?)\s*\|\s*description:\s*(.*?)\s*-->\n?/.exec(src);
    if (!meta) throw new Error(`site: ${f} has no title/description comment`);
    const put = (t) => t.replace(/\{\{(\w+)\}\}/g, (m, k) => {
      if (!(k in fill)) throw new Error(`site: ${f} uses unknown {{${k}}}`);
      return fill[k];
    });
    const body = put(src.slice(meta[0].length));
    const name = f.replace(/\.html$/, '');
    if (process.env.SITE_RELEASE === '1' && body.includes('REPLACE_ME')) throw new Error(`site: ${f} still has a REPLACE_ME link`);
    writeFileSync(join(outDir, f), render(body, { title: meta[1], description: put(meta[2]), path: name === 'index' ? '/' : `/${name}` }));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) build();
