// The FreeAITokens window: home, playground, tool launcher and providers.
const api = window.freeaitokens;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});
let t = (k) => k, tag;
const num = (n) => n.toLocaleString(tag);

// Strings come from the main process in the chosen language; tagged elements are filled here.
async function applyStrings() {
  const s = await api.strings();
  t = makeTranslator(s.strings, s.lang);
  tag = s.lang;
  document.documentElement.lang = s.lang;
  document.documentElement.dir = s.dir;
  for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
  for (const e of document.querySelectorAll('[data-i18n-html]')) e.innerHTML = t(e.dataset.i18nHtml); // our own packaged strings
  for (const e of document.querySelectorAll('[data-i18n-label]')) e.setAttribute('aria-label', t(e.dataset.i18nLabel));
  for (const e of document.querySelectorAll('[data-i18n-placeholder]')) e.placeholder = t(e.dataset.i18nPlaceholder);
  $('lang').replaceChildren(Object.assign(el('option', '', t('lang_system')), { value: 'system' }), ...s.languages.map((l) => Object.assign(el('option', '', l.name), { value: l.code })));
  $('lang').value = s.chosen;
}

// Tabs, with arrow keys like the site.
const tabs = [...document.querySelectorAll('[role="tab"]')];
function select(t) {
  for (const x of tabs) {
    const on = x === t;
    x.setAttribute('aria-selected', String(on));
    x.tabIndex = on ? 0 : -1;
    $(x.getAttribute('aria-controls')).hidden = !on;
  }
  if (t.id === 't-play') $('prompt').focus();
  if (t.id === 't-use') showUsage();
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => select(t));
  t.addEventListener('keydown', (e) => {
    const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!d) return;
    const n = tabs[(i + d + tabs.length) % tabs.length];
    select(n); n.focus(); e.preventDefault();
  });
});
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { e.preventDefault(); select($(go.dataset.go)); }
});

// Status: endpoint, counts, providers, tools.
let version = '';
async function refresh() {
  const s = await api.status();
  $('running').textContent = t(s.reused ? 'running_reused' : 'running', { port: String(s.port) });
  $('endpoint').textContent = s.endpoint;
  $('endpoint2').textContent = s.endpoint;
  if (!version) $('updText').textContent = t('set_version', { v: s.version });
  version = s.version;
  $('login').checked = s.startAtLogin;
  lists = { chat: s.models, image: s.images };
  fillModels();
  const usable = s.providers.filter((p) => p.status !== 'add');
  $('s-ready').textContent = num(usable.length);
  $('s-left').textContent = num(usable.reduce((n, p) => n + p.left, 0));
  $('s-add').textContent = num(s.providers.length - usable.length);
  $('provList').replaceChildren(...s.providers.map((p) => {
    const row = el('div', 'prov');
    const name = el('div', 'name');
    name.append(el('b', '', p.name), el('small', '', [t('prov_models', { n: p.models }), p.status !== 'add' && p.left ? t('prov_left', { n: p.left }) : '', p.media.length ? t('prov_also', { kinds: new Intl.ListFormat(tag).format(p.media.map((k) => t(`kind_${k}`))) }) : ''].filter(Boolean).join(' · ')));
    row.append(name, el('span', `badge ${p.status}`, t(`status_${p.status}`)));
    if (p.status === 'add') {
      const b = el('button', 'btn quiet', t('add'));
      b.addEventListener('click', () => api.add(p.id));
      row.append(b);
    }
    return row;
  }));
  if (!$('toolGrid').children.length) {
    $('toolGrid').replaceChildren(...s.tools.map((tool) => {
      const card = el('div', 'tool');
      const b = el('button', 'btn', t('open_terminal'));
      b.addEventListener('click', async () => {
        b.disabled = true;
        const r = await api.launch(tool.id);
        b.disabled = false;
        $('toolStatus').className = r.ok ? 'status' : 'status bad';
        $('toolStatus').textContent = r.ok ? t('tool_opening', { name: tool.name }) : t('tool_failed', { name: tool.name, reason: r.reason });
      });
      card.append(el('b', '', tool.name), el('small', '', tool.note), b);
      return card;
    }));
  }
}

for (const b of document.querySelectorAll('[data-copy]')) {
  b.addEventListener('click', async () => {
    await api.copy(b.dataset.copy);
    b.textContent = t('copied');
    setTimeout(() => { b.textContent = t('copy'); }, 1500);
  });
}
$('addTop').addEventListener('click', () => api.add());
$('addProv').addEventListener('click', () => api.add());

// Playground: chats are saved by the main process in the app's state folder.
const OLD_STORE = 'freeaitokens.chats'; // where chats lived before sync; moved once
let chats = [];
async function loadChats() {
  let old = null;
  try { old = localStorage.getItem(OLD_STORE); } catch { /* storage blocked */ }
  if (old) {
    try { chats = await api.chats.migrate(JSON.parse(old)); } catch { chats = await api.chats.list(); }
    try { localStorage.removeItem(OLD_STORE); } catch { /* storage blocked */ }
  } else chats = await api.chats.list();
}
const save = (c) => api.chats.put(c);
let current = null; // the open chat, or null for a new one

function listChats() {
  $('chats').replaceChildren(...chats.map((c) => {
    const li = el('li');
    const b = el('button', c === current ? 'on' : '', c.title);
    b.type = 'button';
    b.title = new Date(c.updated).toLocaleString();
    b.addEventListener('click', () => openChat(c));
    const x = el('button', 'del', '×');
    x.type = 'button';
    x.setAttribute('aria-label', t('delete_chat', { title: c.title }));
    x.addEventListener('click', () => {
      api.dropImages(c.messages.filter((m) => m.image).map((m) => m.image));
      chats = chats.filter((y) => y !== c); api.chats.remove(c.id); if (current === c) openChat(null); else listChats();
    });
    li.append(b, x);
    return li;
  }));
}
function bubble(m) {
  const box = el('div', `msg ${m.role === 'user' ? 'user' : m.error ? 'err' : 'ai'}`);
  if (m.image) box.append(picture(m));
  else if (m.role === 'assistant' && !m.error) {
    box.classList.add('md');
    box.innerHTML = renderMarkdown(m.content); // renderMarkdown escapes everything it does not create itself
    previewSvgs(box);
  } else box.textContent = m.content;
  if (m.meta) {
    const meta = el('div', 'meta');
    meta.append(el('span', 'chip who', m.meta.provider), el('span', 'chip', m.meta.model), el('span', 'chip', t('seconds', { n: (m.meta.ms / 1000).toFixed(1) })));
    if (m.meta.tokens) meta.append(el('span', 'chip', t('tokens', { n: m.meta.tokens })));
    box.append(meta);
  }
  $('empty').hidden = true;
  $('chat').append(box);
  box.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return box;
}
// A made image: shown from the file the main process saved, with Save and Copy.
const srcs = new Map(); // image id → data URL, so a fresh image shows without reading it back
function picture(m) {
  const fig = el('figure', 'pic');
  const img = Object.assign(el('img'), { alt: t('image_alt', { prompt: m.prompt ?? '' }) });
  if (srcs.has(m.image)) img.src = srcs.get(m.image);
  else api.imageData(m.image).then((src) => { if (src) img.src = src; else fig.replaceChildren(el('p', 'status', t('image_gone'))); });
  const save = el('button', 'copy', t('save'));
  save.type = 'button';
  save.addEventListener('click', () => api.saveImage({ image: m.image }));
  const copy = el('button', 'copy', t('copy_image'));
  copy.type = 'button';
  copy.addEventListener('click', async () => { await api.copyImage(asPng(img)); copy.textContent = t('copied'); setTimeout(() => { copy.textContent = t('copy_image'); }, 1500); });
  const bar = el('div', 'actions');
  bar.append(save, copy);
  fig.append(img, bar);
  return fig;
}
// A shown picture redrawn as PNG, for the clipboard and for saving SVG previews.
function asPng(img, width = img.naturalWidth || 1600) {
  const h = Math.round(width * ((img.naturalHeight / img.naturalWidth) || 9 / 16));
  const c = Object.assign(document.createElement('canvas'), { width, height: h });
  c.getContext('2d').drawImage(img, 0, 0, width, h);
  return c.toDataURL('image/png');
}
// SVG code in an answer gets a picture above it, and a button to save it as a PNG.
function previewSvgs(box) {
  for (const pre of box.querySelectorAll('pre')) {
    const src = svgPreview(pre.textContent);
    if (!src) continue;
    const fig = el('figure', 'pic');
    const img = Object.assign(el('img'), { src, alt: t('svg_preview') });
    const save = el('button', 'copy', t('save_png'));
    save.type = 'button';
    save.addEventListener('click', () => api.saveImage({ png: asPng(img, 1600) }));
    const bar = el('div', 'actions');
    bar.append(save);
    fig.append(img, bar);
    pre.before(fig);
  }
}
function openChat(c) {
  current = c;
  $('chat').replaceChildren($('empty'));
  $('empty').hidden = false;
  if (c) { setMode(c.mode ?? 'chat'); for (const m of c.messages) bubble(m); if ([...$('model').options].some((o) => o.value === c.model)) $('model').value = chosen[mode] = c.model; }
  listChats();
  $('prompt').focus();
}
$('chat').addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (a) { e.preventDefault(); api.open(a.href); }
});
async function send() {
  const text = $('prompt').value.trim();
  if (!text || $('send').disabled) return;
  if (!current) { current = { id: crypto.randomUUID(), title: text.slice(0, 60), model: $('model').value, mode, messages: [], updated: Date.now() }; chats.unshift(current); }
  const chat = current;
  const making = mode === 'image';
  chat.messages.push({ id: crypto.randomUUID(), at: Date.now(), role: 'user', content: text, ...(making ? { kind: 'image' } : {}) });
  bubble(chat.messages.at(-1));
  $('prompt').value = '';
  $('send').disabled = busy = true;
  const wait = bubble({ role: 'assistant', content: `_${t(making ? 'creating' : 'thinking')}_` });
  // Image turns are not conversation: chat models only see the chat turns.
  const history = chat.messages.filter((m) => !m.error && !m.image && m.kind !== 'image').map(({ role, content }) => ({ role, content }));
  const r = making ? await api.image(text, $('model').value) : await api.chat(history, $('model').value);
  wait.remove();
  busy = false;
  fillModels();
  if (r.ok && r.image) srcs.set(r.image, r.src);
  const stamp = { id: crypto.randomUUID(), at: Date.now() };
  chat.messages.push(!r.ok ? { ...stamp, role: 'assistant', content: r.reason, error: true }
    : r.image ? { ...stamp, role: 'assistant', content: '', image: r.image, prompt: text, meta: { provider: r.provider, model: r.model, ms: r.ms } }
    : { ...stamp, role: 'assistant', content: r.text, meta: { provider: r.provider, model: r.model, ms: r.ms, tokens: r.tokens } });
  chat.model = $('model').value;
  chat.mode = mode;
  chat.updated = Date.now();
  chats = [chat, ...chats.filter((c) => c !== chat)];
  save(chat);
  if (current === chat) bubble(chat.messages.at(-1));
  listChats();
  refresh();
}
$('ask').addEventListener('submit', (e) => { e.preventDefault(); send(); });
$('prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });
$('newChat').addEventListener('click', () => openChat(null));

// Chat or Image: which models the picker lists, and what the box and button say.
let mode = 'chat', lists = { chat: [], image: [] }, busy = false;
const chosen = { chat: 'free', image: 'free' };
function setMode(m) {
  mode = m;
  for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
  $('prompt').placeholder = t(m === 'image' ? 'image_placeholder' : 'prompt_placeholder');
  $('send').textContent = t(m === 'image' ? 'create' : 'send');
  fillModels();
}
for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => { setMode(b.dataset.mode); $('prompt').focus(); });
$('model').addEventListener('change', () => { chosen[mode] = $('model').value; });
$('addImg').addEventListener('click', () => api.add('cloudflare'));
function fillModels() {
  const sel = $('model');
  const models = lists[mode];
  const keep = chosen[mode];
  $('imgNote').hidden = !(mode === 'image' && !models.length);
  $('send').disabled = busy || (mode === 'image' && !models.length);
  const groups = new Map();
  for (const m of models) { if (!groups.has(m.provider)) groups.set(m.provider, el('optgroup')); groups.get(m.provider).label = m.provider; groups.get(m.provider).append(Object.assign(el('option', '', m.label), { value: m.value })); }
  sel.replaceChildren(Object.assign(el('option', '', t(mode === 'image' ? 'auto_image' : 'auto_model')), { value: 'free' }), ...groups.values());
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : 'free';
}

// Usage
let usageDays = 7;
const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
const compact = (n) => n.toLocaleString(tag, { notation: 'compact', maximumFractionDigits: 1 });
const dayLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(tag, { day: 'numeric', month: 'short', timeZone: 'UTC' });
async function showUsage() {
  const u = await api.usage(usageDays);
  $('u-req').textContent = num(u.totals.requests);
  $('u-rate').textContent = u.totals.successRate == null ? '–' : (u.totals.successRate).toLocaleString(tag, { style: 'percent' });
  $('u-tok').textContent = compact(u.totals.tokens);
  $('u-ms').textContent = u.totals.avgMs ? t('seconds', { n: (u.totals.avgMs / 1000).toFixed(1) }) : '–';
  const W = 760, H = 200, pad = 24, n = u.days.length;
  const max = Math.max(1, ...u.days.map((d) => d.ok + d.fail));
  const bw = (W - pad * 2) / n;
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H + 24}`, role: 'img', 'aria-label': t('chart_label', { n: u.totals.requests }) });
  chart.append(svg('line', { x1: pad, x2: W - pad, y1: H, y2: H, class: 'axis' }), svg('text', { x: 0, y: 12, class: 'tick' }, compact(max)));
  u.days.forEach((d, i) => {
    const x = pad + i * bw + bw * 0.15, w = Math.max(1, bw * 0.7);
    const hOk = (d.ok / max) * (H - 20), hFail = (d.fail / max) * (H - 20);
    const g = svg('g', {});
    g.append(svg('title', {}, t('day_tip', { day: dayLabel(d.date), ok: d.ok, fail: d.fail })));
    if (d.ok) g.append(svg('rect', { x, y: H - hOk, width: w, height: hOk, rx: 2, class: 'ok' }));
    if (d.fail) g.append(svg('rect', { x, y: H - hOk - hFail, width: w, height: hFail, rx: 2, class: 'fail' }));
    if (!d.ok && !d.fail) g.append(svg('rect', { x, y: H - 2, width: w, height: 2, class: 'none' }));
    chart.append(g);
    if (i === 0 || i === n - 1 || (n > 7 && i === Math.floor(n / 2))) chart.append(svg('text', { x: x + w / 2, y: H + 18, class: 'tick', 'text-anchor': n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' }, dayLabel(d.date)));
  });
  const legend = el('div', 'legend');
  legend.append(el('span', 'k ok', t('succeeded')), el('span', 'k fail', t('failed')));
  $('u-chart').replaceChildren(chart, legend);
  $('u-prov').replaceChildren(...(u.providers.length ? u.providers.map((p) => {
    const row = el('div', 'prov');
    const name = el('div', 'name');
    name.append(el('b', '', p.name), el('small', '', t('prov_usage', { ok: p.ok, fail: p.fail, tokens: compact(p.tokens) })));
    const share = el('div', 'bar');
    const fill = el('i');
    fill.style.width = `${Math.round((p.ok + p.fail) / Math.max(1, u.totals.requests) * 100)}%`;
    share.append(fill);
    row.append(name, share);
    return row;
  }) : [el('p', 'lead', t('no_requests'))]));
}
for (const b of document.querySelectorAll('[data-days]')) {
  b.addEventListener('click', () => {
    usageDays = Number(b.dataset.days);
    for (const x of document.querySelectorAll('[data-days]')) x.setAttribute('aria-pressed', String(x === b));
    showUsage();
  });
}

// Settings
$('login').addEventListener('change', async () => { $('login').checked = await api.login($('login').checked); });
$('checkUpd').addEventListener('click', async () => {
  $('checkUpd').disabled = true;
  const r = await api.updates();
  $('checkUpd').disabled = false;
  if (!r.ok) { $('updText').textContent = t('upd_failed', { reason: r.reason }); return; }
  if (!r.newer) { $('updText').textContent = t('upd_latest', { v: version }); return; }
  $('updText').textContent = `${t('upd_out', { v: r.latest })} `;
  const a = el('a', '', t('upd_download'));
  a.href = 'https://freeaitokens.co/download';
  a.addEventListener('click', (e) => { e.preventDefault(); api.open(a.href); });
  $('updText').append(a);
});
$('clearChats').addEventListener('click', () => {
  if (!confirm(t('confirm_delete'))) return;
  for (const c of chats) api.chats.remove(c.id);
  chats = [];
  api.dropImages('all');
  openChat(null);
});
$('lang').addEventListener('change', () => api.lang($('lang').value)); // the main process reloads this window

applyStrings().then(loadChats).then(() => {
  listChats();
  refresh();
  setInterval(() => { if (document.hidden) return; refresh(); if (!$('usage').hidden) showUsage(); }, 15_000);
  window.addEventListener('focus', refresh);
});
