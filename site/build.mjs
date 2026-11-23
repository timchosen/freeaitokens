// Builds site/dist: each page body in pages/ wrapped in layout.html, plus everything in static/.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const layout = readFileSync(join(here, 'layout.html'), 'utf8');
const catalogue = JSON.parse(readFileSync(join(here, '../src/catalogue.json'), 'utf8'));

const pagesDir = join(here, 'pages');
const EN = JSON.parse(readFileSync(join(here, 'i18n/en.json'), 'utf8'));
export const locales = JSON.parse(readFileSync(join(here, 'i18n/locales.json'), 'utf8'));
const strings = (code) => (code === 'en' ? EN : { ...EN, ...JSON.parse(readFileSync(join(here, `i18n/${code}.json`), 'utf8')) });
const fmt = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
const PAGE_NAMES = new Set([...readdirSync(pagesDir).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)), 'providers', 'models']);
const pageUrl = (code, url) => (code === 'en' ? url : `/${code}${url === '/' ? '/' : url}`);

// Links to pages stay in the reader's language; files (/install, /logo.svg) and hreflang links don't.
function localize(html, code) {
  if (code === 'en') return html;
  return html.replace(/<a\b[^>]*>/g, (tag) => (/hreflang=/.test(tag) ? tag : tag.replace(/href="\/([^"]*)"/, (m, rest) => {
    const seg = rest.split(/[/#?]/)[0];
    return seg === '' || PAGE_NAMES.has(seg) ? `href="/${code}/${rest}"` : m;
  })));
}

function langMenu(code, url, t) {
  const here = locales.find((l) => l.code === code);
  const items = locales.map((l) => `<li><a href="${pageUrl(l.code, url)}" hreflang="${l.lang}" lang="${l.lang}"${l.code === code ? ' aria-current="true"' : ''}>${esc(l.name)}</a></li>`).join('');
  return `<details class="lang"><summary aria-label="${esc(t.language)}: ${esc(here.name)}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg><span>${esc(here.name)}</span></summary><ul>${items}</ul></details>`;
}

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
    models: cat.reduce((n, p) => n + p.models.length + (p.media?.length ?? 0), 0),
    keyless: cat.filter((p) => p.keyless).length,
    monthlyTokens: daily * 30,
  };
}

// Model families people recognise, counted across every provider (chat and media models).
const FAMILIES = [
  ['Qwen', /qwen/i], ['DeepSeek', /deepseek/i], ['GPT-OSS', /gpt-oss/i], ['Gemma', /gemma/i], ['Gemini', /gemini/i],
  ['Llama', /llama/i], ['Mistral', /mistral|codestral|leanstral|cydonia/i], ['Nemotron', /nemotron/i], ['GLM', /glm/i],
  ['Kimi', /kimi/i], ['MiniMax', /minimax/i], ['Whisper', /whisper/i], ['FLUX', /flux/i], ['BGE', /bge/i],
];
export function kindCounts(cat) {
  const n = {};
  for (const p of cat) for (const m of [...p.models, ...(p.media ?? [])]) n[m.kind ?? 'chat'] = (n[m.kind ?? 'chat'] ?? 0) + 1;
  return n;
}
export function families(cat) {
  const all = cat.flatMap((p) => [...p.models, ...(p.media ?? [])].map((m) => ({ id: m.id, kind: m.kind ?? 'chat' })));
  return FAMILIES.map(([name, re]) => {
    const mine = all.filter((m) => re.test(m.id));
    return { name, count: mine.length, kinds: [...new Set(mine.map((m) => m.kind))] };
  }).filter((f) => f.count).sort((a, b) => b.count - a.count);
}
const KIND_ORDER = ['chat', 'transcription', 'speech', 'image', 'video', 'embedding']; // completion models are chat models too
function heroStats(cat, s, t, lang) {
  const big = new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 });
  const counts = kindCounts(cat);
  const kinds = KIND_ORDER.filter((k) => counts[k]).map((k) => `<li>${esc(t[`kind_${k}`])} <b>${counts[k].toLocaleString(lang)}</b></li>`).join('');
  return `<div class="hero-stats">
  <div class="hs-big"><b>${big.format(s.monthlyTokens)}</b><span>${esc(t.hero_tokens)}</span></div>
  <div><b>${s.models.toLocaleString(lang)}</b><span>${esc(t.hero_models)}</span></div>
  <div><b>${s.providers.toLocaleString(lang)}</b><span>${esc(t.hero_providers)}</span></div>
</div>
<ul class="kinds" aria-label="${esc(t.hero_models)}">${kinds}</ul>`;
}
function modelsSection(cat, t, lang, code) {
  // Filled in after render(), so links get the language prefix here.
  const href = `${code === 'en' ? '' : `/${code}`}/models`;
  const boxes = families(cat).map((f) => `<li><a class="tool fam" href="${href}"><b>${f.count.toLocaleString(lang)}</b><span>${esc(f.name)}</span><small>${esc(f.kinds.map((k) => t[`kind_${k}`]).join(' · '))}</small></a></li>`).join('\n    ');
  return `<section class="section center" id="models">
  <h2>${esc(t.models_title)}</h2>
  <p class="muted">${esc(t.models_lead)}</p>
  <ul class="tools">
    ${boxes}
  </ul>
  <p class="small"><a href="${href}">${esc(t.models_all)}</a></p>
</section>`;
}

// Coming-soon phone apps: three phone mockups drawn in HTML/CSS, every word from the language file.
function phone(label, screen) {
  return `<figure class="phone" role="img" aria-label="${esc(label)}"><div class="notch"></div><div class="screen">${screen}</div><figcaption>${esc(label)}</figcaption></figure>`;
}
function mobileSection(t, repoUrl) {
  const chat = `<div class="ph-top"><b>${esc(t.mob_chat)}</b><span class="ph-chip">Llama 3.3 · Groq</span></div>
    <p class="ph-u">${esc(t.mob_m_q)}</p><p class="ph-a">${esc(t.mob_m_a)}</p><p class="ph-u short">${esc(t.mob_m_q2)}</p><div class="ph-typing"><i></i><i></i><i></i></div>
    <div class="ph-input">${esc(t.mob_m_ask)}</div>`;
  const image = `<div class="ph-top"><b>${esc(t.mob_images)}</b><span class="ph-chip">FLUX</span></div>
    <p class="ph-u">${esc(t.mob_m_img)}</p><div class="ph-art"><span class="sun"></span><span class="sea"></span><span class="sea two"></span></div>
    <div class="ph-input">${esc(t.mob_m_ask)}</div>`;
  const voice = `<div class="ph-top"><b>${esc(t.mob_voice)}</b><span class="ph-chip">Whisper</span></div>
    <div class="ph-mic"><span></span></div><div class="ph-wave">${'<i></i>'.repeat(14)}</div><p class="ph-rec">${esc(t.mob_m_rec)}</p>
    <p class="ph-a">${esc(t.mob_m_tr)}</p>`;
  return `<section class="section center mobile" id="mobile">
  <p class="eyebrow">${esc(t.mob_eyebrow)}</p>
  <h2>${esc(t.mob_title)}</h2>
  <p class="muted narrow">${esc(t.mob_lead)}</p>
  <div class="phones">${phone(t.mob_chat, chat)}${phone(t.mob_images, image)}${phone(t.mob_voice, voice)}</div>
  <p class="small">${esc(t.mob_watch)} <a href="${repoUrl}">GitHub</a></p>
</section>`;
}
function mobileSoon(t, code) {
  return `<li id="mobile"><span><b>${esc(t.mob_platforms)}</b> · ${esc(t.mob_eyebrow)}</span><span><a href="${code === 'en' ? '' : `/${code}`}/#mobile">${esc(t.mob_see)}</a></span></li>`;
}

export function render(body, { title, description, path, url = path, code = 'en' }) {
  const t = strings(code);
  const l = locales.find((x) => x.code === code);
  const fullTitle = path === '/' ? `FreeAITokens · ${t.home_title}` : `${title} · FreeAITokens`;
  const vars = {
    lang: l.lang, dir: l.dir, langMenu: langMenu(code, url, t),
    // Link previews (Open Graph, X): one shared card image for every page.
    social: [
      `<link rel="canonical" href="https://{{domain}}${pageUrl(code, url)}">`,
      '<meta property="og:type" content="website">',
      '<meta property="og:site_name" content="FreeAITokens">',
      `<meta property="og:title" content="${esc(fullTitle)}">`,
      `<meta property="og:description" content="${esc(description)}">`,
      `<meta property="og:url" content="https://{{domain}}${pageUrl(code, url)}">`,
      `<meta property="og:locale" content="${l.lang.replace('-', '_')}">`,
      '<meta property="og:image" content="https://{{domain}}/og.png">',
      '<meta property="og:image:width" content="1200">',
      '<meta property="og:image:height" content="630">',
      `<meta property="og:image:alt" content="${esc(t.og_alt)}">`,
      '<meta name="twitter:card" content="summary_large_image">',
      `<meta name="twitter:title" content="${esc(fullTitle)}">`,
      `<meta name="twitter:description" content="${esc(description)}">`,
      '<meta name="twitter:image" content="https://{{domain}}/og.png">',
      `<meta name="twitter:image:alt" content="${esc(t.og_alt)}">`,
    ].join('\n'),
    alternates: locales.map((x) => `<link rel="alternate" hreflang="${x.lang}" href="https://{{domain}}${pageUrl(x.code, url)}">`).join('\n') + `\n<link rel="alternate" hreflang="x-default" href="https://{{domain}}${url}">`,
  };
  const nav = layout.replace(/<a href="([^"]+)"( class="[^"]*")?>/g, (m, href, cls) => (href === path ? `<a href="${href}"${cls ?? ''} aria-current="page">` : m));
  const html = nav
    .replace(/\[\[(\w+)\]\]/g, (m, k) => {
      if (k in vars) return vars[k];
      if (!(k in t)) throw new Error(`site: layout uses unknown [[${k}]]`);
      return esc(t[k]);
    })
    .replace('{{title}}', esc(fullTitle))
    .replace('{{description}}', esc(description))
    .replace('{{body}}', () => body);
  return localize(html, code);
}

function limitText(p, t = EN, lang = 'en') {
  const all = p.models.map((m) => m.limits ?? p.limits ?? {});
  const tpd = Math.max(0, ...all.map((l) => l.tpd ?? 0));
  const rpd = Math.max(0, ...all.map((l) => l.rpd ?? 0));
  const rpm = Math.max(0, ...all.map((l) => l.rpm ?? 0));
  if (tpd) return fmt(t.limit_tpd_max, { n: tpd.toLocaleString(lang) });
  if (rpd) return fmt(t.limit_rpd_max, { n: rpd.toLocaleString(lang) });
  if (rpm) return fmt(t.limit_rpm, { n: rpm.toLocaleString(lang) });
  return t.not_published;
}

// A table whose cells carry their column name, so phones can show each row as a labelled card.
function stackTable(heads, rows, attrs = []) {
  const tr = rows.map((cells, i) => `<tr${attrs[i] ?? ''}>${cells.map((c, j) => `<td data-label="${esc(heads[j])}">${c}</td>`).join('')}</tr>`).join('');
  return `<div class="table stack"><table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

function providerTable(cat, t = EN, lang = 'en') {
  return stackTable([t.th_provider, t.th_key_needed, t.th_free_limit, t.th_good_to_know],
    cat.map((p) => [esc(p.name), p.keyless ? t.no : t.access_free, esc(limitText(p, t, lang)), esc(p.termsNote ?? '')]));
}

const approx = (n, t, lang) => fmt(t.about_n, { n: new Intl.NumberFormat(lang, { notation: 'compact', compactDisplay: 'long', maximumFractionDigits: 1 }).format(n) });

// Everything that names the owner (GitHub repo, donation link, domain) comes from here, so a fork edits one file.
const config = JSON.parse(readFileSync(join(here, 'site.config.json'), 'utf8'));
const TEXT_FILES = /^(install|install\.ps1|_headers|.*\.(md|js|txt))$/;

function providerTerms(cat, t = EN) {
  return stackTable([t.th_provider, t.th_what_to_know], cat.map((p) => {
    const site = p.signupUrl ?? p.keyUrl;
    return [site ? `<a href="${esc(site)}">${esc(p.name)}</a>` : esc(p.name), esc(p.termsNote ?? t.standard_terms)];
  }));
}

export const slug = (id) => id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const ctx = (n) => (n ? (n >= 1e6 ? `${+(n / 1048576).toFixed(1)}M` : `${Math.round(n / 1024)}K`) : '—');
function modelLimit(l, t, lang) {
  if (!l) return t.not_published;
  const n = (x) => ({ n: x.toLocaleString(lang) });
  const parts = [l.tpd && fmt(t.m_tpd, n(l.tpd)), l.rpd && fmt(t.m_rpd, n(l.rpd)), l.rpm && fmt(t.m_rpm, n(l.rpm))].filter(Boolean);
  return parts.length ? parts.join(' · ') : t.not_published;
}

export function modelRows(cat) {
  return cat.flatMap((p) => [...p.models.map((m) => ({ ...m, kind: 'chat' })), ...(p.media ?? [])].map((m) => ({
    provider: p.id, providerName: p.name, id: m.id, kind: m.kind,
    // the same model can be both chat and completions; the second page gets the kind in its name
    slug: m.kind !== 'chat' && p.models.some((c) => c.id === m.id) ? `${slug(m.id)}-${m.kind}` : slug(m.id), context: m.context ?? 0,
    tools: !!m.tools, images: !!m.images, quality: m.quality, limits: m.limits ?? p.limits, keyless: p.keyless, paid: p.paid,
  })));
}

function keyBlock(p, t) {
  if (p.keyless) return `<p>${fmt(t.keyless_text, { name: esc(p.name) })}</p>`;
  const steps = p.steps?.length ? `<ol>${p.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : '';
  const connect = p.connect === 'openrouter' ? `<p>${t.openrouter_connect}</p>` : '';
  const buttons = [p.signupUrl && `<a class="btn quiet small-btn" href="${esc(p.signupUrl)}">${esc(t.signup)}</a>`, p.keyUrl && `<a class="btn small-btn" href="${esc(p.keyUrl)}">${esc(t.get_key)}</a>`].filter(Boolean).join(' ');
  return `${connect}${steps}<p class="foot-buttons">${buttons}</p><p class="small muted">${t.paste_key}</p>`;
}

// Provider and model pages, in one language. Catalogue text (names, steps, notes) stays as the catalogue writes it.
export function generated(cat, t = EN, lang = 'en') {
  // Provider ids become file paths and URLs.
  for (const p of cat) if (!/^[a-z0-9-]+$/.test(p.id)) throw new Error(`site: bad provider id ${JSON.stringify(p.id)}`);
  const kind = (k) => t[`kind_${k}`];
  const yes = (b) => (b ? t.yes : '—');
  const access = (p) => (p.paid ? t.access_paid : p.keyless ? t.access_keyless : t.access_free);
  const count = (n) => fmt(n === 1 ? t.model_count_one : t.model_count, { n });
  const rows = modelRows(cat);
  const pages = [];
  const cards = cat.map((p) => {
    const all = [...p.models, ...(p.media ?? [])];
    const kinds = [...new Set((p.media ?? []).map((m) => kind(m.kind)))];
    const links = [p.signupUrl && !p.keyless && `<a href="${esc(p.signupUrl)}">${esc(t.signup_short)}</a>`, p.keyUrl && !p.keyless && `<a href="${esc(p.keyUrl)}">${esc(t.get_key_short)}</a>`].filter(Boolean).join(' · ');
    return `<article class="card prov"><h2><a href="/providers/${p.id}">${esc(p.name)}</a></h2><p class="badges"><span class="badge">${access(p)}</span><span class="badge">${count(all.length)}</span>${kinds.map((k) => `<span class="badge">${k}</span>`).join('')}</p><p class="small">${esc(fmt(t.free_limit, { limit: limitText(p, t, lang) }))}</p>${p.termsNote ? `<p class="small muted">${esc(p.termsNote)}</p>` : ''}<p class="small"><a href="/providers/${p.id}">${esc(t.details)}</a>${links ? ` · ${links}` : ''}</p></article>`;
  });
  pages.push({ file: 'providers.html', path: '/providers', title: t.providers_title, description: fmt(t.providers_desc, { n: cat.length }),
    body: `<div class="page wide"><h1>${esc(t.providers_title)}</h1><p class="lead">${esc(fmt(t.providers_lead, { n: cat.length, k: cat.filter((p) => p.keyless).length }))}</p><p><a href="/models">${esc(fmt(t.browse_models, { n: rows.length }))}</a></p><div class="cards">${cards.join('')}</div><p class="small muted">${esc(t.read_notes)} <a href="/disclaimer#providers">${esc(t.provider_terms_link)}</a>.</p></div>` });

  for (const p of cat) {
    const mine = rows.filter((r) => r.provider === p.id);
    const table = stackTable([t.th_model, t.th_type, t.th_context, t.th_tools, t.th_images, t.th_free_limit],
      mine.map((r) => [`<a href="/models/${p.id}/${r.slug}">${esc(r.id)}</a>`, kind(r.kind), ctx(r.context), yes(r.tools), yes(r.images), esc(modelLimit(r.limits, t, lang))]));
    pages.push({ file: `providers/${p.id}.html`, path: '/providers', title: p.name, description: fmt(t.provider_desc, { name: p.name, n: mine.length }),
      body: `<div class="page wide"><p class="small"><a href="/providers">${esc(t.providers_title)}</a> /</p><h1>${esc(p.name)}</h1><p class="badges"><span class="badge">${access(p)}</span><span class="badge">${count(mine.length)}</span></p><p class="lead">${esc(fmt(t.free_limit, { limit: limitText(p, t, lang) }))}</p>${p.termsNote ? `<div class="card"><h3>${esc(t.th_good_to_know)}</h3><p>${esc(p.termsNote)}</p></div>` : ''}<h2>${esc(p.keyless ? t.access_keyless : t.get_free_key)}</h2>${keyBlock(p, t)}<h2>${esc(t.models_h)}</h2>${table}</div>` });
    for (const r of mine) {
      const facts = [[t.th_provider, `<a href="/providers/${p.id}">${esc(p.name)}</a>`], [t.th_type, kind(r.kind)], [t.th_context, r.kind === 'chat' || r.context ? fmt(t.tokens, { n: ctx(r.context) }) : '—'], [t.f_tools, yes(r.tools)], [t.f_images, yes(r.images)], [t.th_free_limit, esc(modelLimit(r.limits, t, lang))], [t.f_access, access(p)], [t.f_score, `${Math.round(r.quality * 10)}/10`]];
      const use = r.kind === 'chat' ? `<p>${esc(t.use_chat)}</p>` : `<p>${fmt(t.use_media, { model: `${esc(p.id)}/${esc(r.id)}` })}</p>`;
      pages.push({ file: `models/${p.id}/${r.slug}.html`, path: '/models', title: `${r.id} (${p.name})`, description: fmt(t.model_desc, { id: r.id, name: p.name }),
        body: `<div class="page"><p class="small"><a href="/models">${esc(t.models_title)}</a> / <a href="/providers/${p.id}">${esc(p.name)}</a> /</p><h1 class="model-title">${esc(r.id)}</h1><div class="table"><table><tbody>${facts.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('')}</tbody></table></div><h2>${esc(t.how_used)}</h2>${use}<h2>${esc(p.keyless ? t.access_keyless : fmt(t.get_named_key, { name: p.name }))}</h2>${keyBlock(p, t)}</div>` });
    }
  }

  const provOpts = cat.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const kindOpts = [...new Set(rows.map((r) => r.kind))].map((k) => `<option value="${k}">${kind(k)}</option>`).join('');
  const table = stackTable([t.th_model, t.th_provider, t.th_type, t.th_context, t.th_tools, t.th_images, t.th_free_limit],
    rows.map((r) => [`<a href="/models/${r.provider}/${r.slug}">${esc(r.id)}</a>`, `<a href="/providers/${r.provider}">${esc(r.providerName)}</a>`, kind(r.kind), ctx(r.context), yes(r.tools), yes(r.images), esc(modelLimit(r.limits, t, lang))]),
    rows.map((r) => ` data-model data-provider="${r.provider}" data-kind="${r.kind}" data-name="${esc(`${r.id} ${r.providerName}`.toLowerCase())}" data-tools="${r.tools}" data-images="${r.images}" data-keyless="${r.keyless}" data-context="${r.context}"`));
  pages.push({ file: 'models.html', path: '/models', title: t.models_title, description: fmt(t.models_desc, { n: rows.length }),
    body: `<div class="page wide"><h1>${esc(t.models_title)}</h1><p class="lead">${esc(t.models_lead)}</p>
<form class="filters" role="search" aria-label="${esc(t.filter_label)}">
<label class="grow">${esc(t.search)} <input type="search" name="q" placeholder="${esc(t.search_ph)}"></label>
<label>${esc(t.th_provider)} <select name="provider"><option value="">${esc(t.all)}</option>${provOpts}</select></label>
<label>${esc(t.th_type)} <select name="kind"><option value="">${esc(t.all)}</option>${kindOpts}</select></label>
<label>${esc(t.th_context)} <select name="minContext"><option value="0">${esc(t.any)}</option><option value="32000">32K+</option><option value="128000">128K+</option><option value="1000000">1M+</option></select></label>
<label class="check"><input type="checkbox" name="tools"> ${esc(t.f_tools)}</label>
<label class="check"><input type="checkbox" name="images"> ${esc(t.f_images)}</label>
<label class="check"><input type="checkbox" name="keyless"> ${esc(t.access_keyless)}</label>
</form>
<p class="small muted" aria-live="polite" data-count>${esc(fmt(t.model_count, { n: rows.length }))}</p>
${table}</div>` });
  return pages;
}

export function build(outDir = join(here, 'dist')) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(join(here, 'static'), outDir, { recursive: true });
  const s = stats(catalogue);
  const base = {
    ...config,
    repoUrl: `https://github.com/${config.repo}`,
    year: String(new Date().getUTCFullYear()),
    providers: String(s.providers), models: String(s.models), keyless: String(s.keyless),
  };
  const put = (text, fill, where) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in fill)) throw new Error(`site: ${where} uses unknown {{${k}}}`);
    return fill[k];
  });
  const en = { ...base, monthly: approx(s.monthlyTokens, EN, 'en') };
  for (const f of readdirSync(outDir).filter((f) => TEXT_FILES.test(f))) {
    writeFileSync(join(outDir, f), put(readFileSync(join(outDir, f), 'utf8'), en, f));
  }
  // The script's own strings, for every language but English (which it carries itself).
  const js = Object.fromEntries(locales.filter((l) => l.code !== 'en').map((l) => [l.lang, Object.fromEntries(Object.entries(strings(l.code)).filter(([k]) => k.startsWith('js_')))]));
  const script = join(outDir, 'site.js');
  writeFileSync(script, readFileSync(script, 'utf8').replace('const I18N = {};', () => `const I18N = ${JSON.stringify(js)};`));
  base.installScript = esc(readFileSync(join(outDir, 'install'), 'utf8'));
  base.installPs1 = esc(readFileSync(join(outDir, 'install.ps1'), 'utf8'));

  const files = readdirSync(pagesDir).filter((f) => f.endsWith('.html'));
  for (const l of locales) {
    const t = strings(l.code);
    const fill = { ...base, monthly: approx(s.monthlyTokens, t, l.lang), heroStats: heroStats(catalogue, s, t, l.lang), mobileSection: mobileSection(t, base.repoUrl), mobileSoon: mobileSoon(t, l.code), modelsSection: modelsSection(catalogue, t, l.lang, l.code), providerTable: providerTable(catalogue, t, l.lang), providerTerms: providerTerms(catalogue, t) };
    const out = l.code === 'en' ? outDir : join(outDir, l.code);
    mkdirSync(out, { recursive: true });
    for (const f of files) {
      const from = l.code === 'en' ? join(pagesDir, f) : join(pagesDir, l.code, f);
      if (!existsSync(from)) throw new Error(`site: pages/${l.code}/${f} is missing (node site/i18n/check.mjs ${l.code})`);
      const src = readFileSync(from, 'utf8');
      const meta = /^<!--\s*title:\s*(.*?)\s*\|\s*description:\s*(.*?)\s*-->\n?/.exec(src);
      if (!meta) throw new Error(`site: ${from} has no title/description comment`);
      const name = f.replace(/\.html$/, '');
      const path = name === 'index' ? '/' : `/${name}`;
      const page = render(src.slice(meta[0].length), { title: meta[1], description: put(meta[2], fill, f), path, code: l.code });
      writeFileSync(join(out, f), put(page, fill, f));
    }
    for (const g of generated(catalogue, t, l.lang)) {
      mkdirSync(join(out, g.file, '..'), { recursive: true });
      writeFileSync(join(out, g.file), put(render(g.body, { ...g, url: `/${g.file.replace(/\.html$/, '')}`, code: l.code }), fill, g.file));
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) build();
