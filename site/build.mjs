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

// Everything that names the owner (GitHub repo, donation link, domain) comes from here, so a fork edits one file.
const config = JSON.parse(readFileSync(join(here, 'site.config.json'), 'utf8'));
const TEXT_FILES = /^(install|install\.ps1|.*\.(md|js|txt))$/;

function providerTerms(cat) {
  const rows = cat.map((p) => {
    const site = p.signupUrl ?? p.keyUrl;
    const name = site ? `<a href="${esc(site)}">${esc(p.name)}</a>` : esc(p.name);
    return `<tr><td>${name}</td><td>${esc(p.termsNote ?? 'Standard free tier; see the provider\'s terms.')}</td></tr>`;
  });
  return `<div class="table"><table><thead><tr><th>Provider</th><th>What to know before you use it</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

export const slug = (id) => id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const ctx = (n) => (n ? (n >= 1e6 ? `${+(n / 1048576).toFixed(1)}M` : `${Math.round(n / 1024)}K`) : '—');
const KIND = { chat: 'Chat', embedding: 'Embeddings', completion: 'Completions', image: 'Images', speech: 'Text to speech', transcription: 'Transcription', video: 'Video' };

function modelLimit(l) {
  if (!l) return 'not published';
  const parts = [l.tpd && `${l.tpd.toLocaleString('en')} tokens a day`, l.rpd && `${l.rpd.toLocaleString('en')} requests a day`, l.rpm && `${l.rpm} a minute`].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'not published';
}

export function modelRows(cat) {
  return cat.flatMap((p) => [...p.models.map((m) => ({ ...m, kind: 'chat' })), ...(p.media ?? [])].map((m) => ({
    provider: p.id, providerName: p.name, id: m.id, kind: m.kind,
    // the same model can be both chat and completions; the second page gets the kind in its name
    slug: m.kind !== 'chat' && p.models.some((c) => c.id === m.id) ? `${slug(m.id)}-${m.kind}` : slug(m.id), context: m.context ?? 0,
    tools: !!m.tools, images: !!m.images, quality: m.quality, limits: m.limits ?? p.limits, keyless: p.keyless, paid: p.paid,
  })));
}

const yes = (b) => (b ? 'Yes' : '—');
const access = (p) => (p.paid ? 'Paid key' : p.keyless ? 'No key needed' : 'Free key');

function keyBlock(p) {
  if (p.keyless) return `<p>No account or key needed: FreeAITokens uses ${esc(p.name)} straight away.</p>`;
  const steps = p.steps?.length ? `<ol>${p.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : '';
  const connect = p.connect === 'openrouter' ? '<p>Easiest: in the FreeAITokens app choose <b>Add a provider…</b> → OpenRouter and approve the connection in your browser. No copying needed.</p>' : '';
  const buttons = [p.signupUrl && `<a class="btn quiet small-btn" href="${esc(p.signupUrl)}">Sign up or log in</a>`, p.keyUrl && `<a class="btn small-btn" href="${esc(p.keyUrl)}">Get your API key</a>`].filter(Boolean).join(' ');
  return `${connect}${steps}<p class="foot-buttons">${buttons}</p><p class="small muted">Then paste the key into FreeAITokens: <b>Add a provider…</b> in the app, or <code>npx freeaitokens add</code>.</p>`;
}

export function generated(cat) {
  // Provider ids become file paths and URLs.
  for (const p of cat) if (!/^[a-z0-9-]+$/.test(p.id)) throw new Error(`site: bad provider id ${JSON.stringify(p.id)}`);
  const rows = modelRows(cat);
  const pages = [];
  const cards = cat.map((p) => {
    const all = [...p.models, ...(p.media ?? [])];
    const kinds = [...new Set((p.media ?? []).map((m) => KIND[m.kind]))];
    const links = [p.signupUrl && !p.keyless && `<a href="${esc(p.signupUrl)}">Sign up</a>`, p.keyUrl && !p.keyless && `<a href="${esc(p.keyUrl)}">Get API key</a>`].filter(Boolean).join(' · ');
    return `<article class="card prov"><h2><a href="/providers/${p.id}">${esc(p.name)}</a></h2><p class="badges"><span class="badge">${access(p)}</span><span class="badge">${all.length} model${all.length === 1 ? '' : 's'}</span>${kinds.map((k) => `<span class="badge">${k}</span>`).join('')}</p><p class="small">Free limit: ${esc(limitText(p))}</p>${p.termsNote ? `<p class="small muted">${esc(p.termsNote)}</p>` : ''}<p class="small"><a href="/providers/${p.id}">Details and models</a>${links ? ` · ${links}` : ''}</p></article>`;
  });
  pages.push({ file: 'providers.html', path: '/providers', title: 'Providers', description: `All ${cat.length} free AI providers FreeAITokens works with, their free limits, and how to get a free key for each.`,
    body: `<div class="page wide"><h1>Providers</h1><p class="lead">FreeAITokens works with ${cat.length} AI providers. ${cat.filter((p) => p.keyless).length} need no account; for the rest, a free key takes a minute. Each one adds to your free total.</p><p><a href="/models">Browse all ${rows.length} models</a></p><div class="cards">${cards.join('')}</div><p class="small muted">Read each provider's notes before you sign up: <a href="/disclaimer#providers">provider terms</a>.</p></div>` });

  for (const p of cat) {
    const mine = rows.filter((r) => r.provider === p.id);
    const table = `<div class="table"><table><thead><tr><th>Model</th><th>Type</th><th>Context</th><th>Tools</th><th>Images</th><th>Free limit</th></tr></thead><tbody>${mine.map((r) => `<tr><td><a href="/models/${p.id}/${r.slug}">${esc(r.id)}</a></td><td>${KIND[r.kind]}</td><td>${ctx(r.context)}</td><td>${yes(r.tools)}</td><td>${yes(r.images)}</td><td>${esc(modelLimit(r.limits))}</td></tr>`).join('')}</tbody></table></div>`;
    pages.push({ file: `providers/${p.id}.html`, path: '/providers', title: p.name, description: `${p.name} on FreeAITokens: ${mine.length} models, its free limits, and how to get a free API key.`,
      body: `<div class="page wide"><p class="small"><a href="/providers">Providers</a> /</p><h1>${esc(p.name)}</h1><p class="badges"><span class="badge">${access(p)}</span><span class="badge">${mine.length} models</span></p><p class="lead">Free limit: ${esc(limitText(p))}.</p>${p.termsNote ? `<div class="card"><h3>Good to know</h3><p>${esc(p.termsNote)}</p></div>` : ''}<h2>${p.keyless ? 'No key needed' : 'Get a free key'}</h2>${keyBlock(p)}<h2>Models</h2>${table}</div>` });
    for (const r of mine) {
      const facts = [['Provider', `<a href="/providers/${p.id}">${esc(p.name)}</a>`], ['Type', KIND[r.kind]], ['Context', r.kind === 'chat' || r.context ? `${ctx(r.context)} tokens` : '—'], ['Tool calling', yes(r.tools)], ['Reads images', yes(r.images)], ['Free limit', esc(modelLimit(r.limits))], ['Access', access(p)], ['Ranking score', `${Math.round(r.quality * 10)}/10`]];
      const use = r.kind === 'chat'
        ? '<p>You don\'t pick chat models: FreeAITokens chooses the best free model that fits each request and moves to another when one runs out. This one is used when it fits and has free capacity.</p>'
        : `<p>Send <code>${esc(p.id)}/${esc(r.id)}</code> as the model to always use this one; otherwise FreeAITokens picks a free ${KIND[r.kind].toLowerCase()} model for you. See <a href="/docs#media">Not only chat</a>.</p>`;
      pages.push({ file: `models/${p.id}/${r.slug}.html`, path: '/models', title: `${r.id} (${p.name})`, description: `${r.id} from ${p.name}: context, features and free limits on FreeAITokens.`,
        body: `<div class="page"><p class="small"><a href="/models">Models</a> / <a href="/providers/${p.id}">${esc(p.name)}</a> /</p><h1 class="model-title">${esc(r.id)}</h1><div class="table"><table><tbody>${facts.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</tbody></table></div><h2>How FreeAITokens uses it</h2>${use}<h2>${p.keyless ? 'No key needed' : `Get a free ${esc(p.name)} key`}</h2>${keyBlock(p)}</div>` });
    }
  }

  const provOpts = cat.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const kinds = [...new Set(rows.map((r) => r.kind))];
  const kindOpts = kinds.map((k) => `<option value="${k}">${KIND[k]}</option>`).join('');
  const trs = rows.map((r) => `<tr data-model data-provider="${r.provider}" data-kind="${r.kind}" data-name="${esc(`${r.id} ${r.providerName}`.toLowerCase())}" data-tools="${r.tools}" data-images="${r.images}" data-keyless="${r.keyless}" data-context="${r.context}"><td><a href="/models/${r.provider}/${r.slug}">${esc(r.id)}</a></td><td><a href="/providers/${r.provider}">${esc(r.providerName)}</a></td><td>${KIND[r.kind]}</td><td>${ctx(r.context)}</td><td>${yes(r.tools)}</td><td>${yes(r.images)}</td><td>${esc(modelLimit(r.limits))}</td></tr>`).join('');
  pages.push({ file: 'models.html', path: '/models', title: 'Models', description: `All ${rows.length} free AI models FreeAITokens can use, with filters for provider, type, tool calling, images and context size.`,
    body: `<div class="page wide"><h1>Models</h1><p class="lead">Every free model FreeAITokens can use. You don't have to choose: it picks the best one for each request. This list is for the curious.</p>
<form class="filters" role="search" aria-label="Filter models">
<label>Search <input type="search" name="q" placeholder="Model or provider"></label>
<label>Provider <select name="provider"><option value="">All</option>${provOpts}</select></label>
<label>Type <select name="kind"><option value="">All</option>${kindOpts}</select></label>
<label>Context <select name="minContext"><option value="0">Any</option><option value="32000">32K+</option><option value="128000">128K+</option><option value="1000000">1M+</option></select></label>
<label class="check"><input type="checkbox" name="tools"> Tool calling</label>
<label class="check"><input type="checkbox" name="images"> Reads images</label>
<label class="check"><input type="checkbox" name="keyless"> No key needed</label>
</form>
<p class="small muted" aria-live="polite" data-count>${rows.length} models</p>
<div class="table"><table><thead><tr><th>Model</th><th>Provider</th><th>Type</th><th>Context</th><th>Tools</th><th>Images</th><th>Free limit</th></tr></thead><tbody>${trs}</tbody></table></div></div>` });
  return pages;
}

export function build(outDir = join(here, 'dist')) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(join(here, 'static'), outDir, { recursive: true });
  const s = stats(catalogue);
  const fill = {
    ...config,
    repoUrl: `https://github.com/${config.repo}`,
    year: String(new Date().getUTCFullYear()),
    providers: String(s.providers), models: String(s.models), keyless: String(s.keyless), monthly: billions(s.monthlyTokens),
    providerTable: providerTable(catalogue), providerTerms: providerTerms(catalogue),
  };
  const put = (t, where) => t.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in fill)) throw new Error(`site: ${where} uses unknown {{${k}}}`);
    return fill[k];
  });
  for (const f of readdirSync(outDir).filter((f) => TEXT_FILES.test(f))) {
    writeFileSync(join(outDir, f), put(readFileSync(join(outDir, f), 'utf8'), f));
  }
  fill.installScript = esc(readFileSync(join(outDir, 'install'), 'utf8'));
  fill.installPs1 = esc(readFileSync(join(outDir, 'install.ps1'), 'utf8'));
  for (const f of readdirSync(join(here, 'pages')).filter((f) => f.endsWith('.html'))) {
    const src = readFileSync(join(here, 'pages', f), 'utf8');
    const meta = /^<!--\s*title:\s*(.*?)\s*\|\s*description:\s*(.*?)\s*-->\n?/.exec(src);
    if (!meta) throw new Error(`site: ${f} has no title/description comment`);
    const name = f.replace(/\.html$/, '');
    const page = render(src.slice(meta[0].length), { title: meta[1], description: put(meta[2], f), path: name === 'index' ? '/' : `/${name}` });
    writeFileSync(join(outDir, f), put(page, f));
  }
  for (const g of generated(catalogue)) {
    mkdirSync(join(outDir, g.file, '..'), { recursive: true });
    writeFileSync(join(outDir, g.file), put(render(g.body, g), g.file));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) build();
