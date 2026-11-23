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
  for (const e of document.querySelectorAll('[data-i18n-title]')) e.title = t(e.dataset.i18nTitle);
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
  lists = { auto: s.models, chat: s.models, image: s.images };
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

// Playground: chats are saved in this window's storage, on this computer only.
const STORE = 'freeaitokens.chats';
const load = () => { try { return JSON.parse(localStorage.getItem(STORE)) ?? []; } catch { return []; } };
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(chats.slice(0, 100))); } catch { /* storage full or blocked */ } };
let chats = load();
let current = null; // the open chat, or null for a new one

// A small drawn icon (16×16, stroked with the text colour).
function icon(d) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}
function listChats() {
  $('chats').replaceChildren(...chats.map((c) => {
    const li = el('li');
    const b = el('button', c === current ? 'on' : '', c.title);
    b.type = 'button';
    b.title = new Date(c.updated).toLocaleString();
    b.addEventListener('click', () => openChat(c));
    const x = el('button', 'del');
    x.type = 'button';
    x.append(icon('M4 4l8 8M12 4l-8 8'));
    x.setAttribute('aria-label', t('delete_chat', { title: c.title }));
    x.addEventListener('click', () => {
      api.dropImages(c.messages.flatMap((m) => [m.image, m.audio]).filter(Boolean));
      chats = chats.filter((y) => y !== c); save(); if (current === c) openChat(null); else listChats();
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
  if (m.audio) box.append(player(m));
  if (m.meta) {
    const meta = el('div', 'meta');
    if (m.meta.auto) meta.append(el('span', 'chip auto', t('auto_kind', { kind: t(`kind_${m.meta.auto}`) })));
    meta.append(el('span', 'chip who', m.meta.provider), el('span', 'chip', m.meta.model), el('span', 'chip', t('seconds', { n: (m.meta.ms / 1000).toFixed(1) })));
    if (m.meta.tokens) meta.append(el('span', 'chip', t('tokens', { n: m.meta.tokens })));
    if (m.content && !m.audio && !m.image) meta.append(speakButton(m, box));
    box.append(meta);
  }
  $('empty').hidden = true;
  const chat = $('chat');
  chat.append(box);
  chat.scrollTo({ top: chat.scrollHeight, behavior: 'smooth' });
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
// Speech: an audio player from the file the main process saved, with Save.
const audioSrcs = new Map();
function player(m) {
  const fig = el('figure', 'sound');
  const audio = Object.assign(el('audio'), { controls: true, preload: 'metadata' });
  if (audioSrcs.has(m.audio)) audio.src = audioSrcs.get(m.audio);
  else api.audioData(m.audio).then((src) => { if (src) audio.src = src; else fig.replaceChildren(el('p', 'status', t('image_gone'))); });
  const save = el('button', 'copy', t('save'));
  save.type = 'button';
  save.addEventListener('click', () => api.saveAudio(m.audio));
  fig.append(audio, save);
  return fig;
}
// The speaker button under an answer reads it aloud; the sound is kept with that answer.
function speakButton(m, box) {
  const b = el('button', 'icon-btn speak');
  b.type = 'button';
  b.title = t('read_aloud');
  b.setAttribute('aria-label', t('read_aloud'));
  b.append(icon('M2.5 6v4h2.5l3.5 3V3L5 6zM11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.5a6 6 0 0 1 0 9'));
  b.addEventListener('click', async () => {
    if (b.disabled) return;
    b.disabled = true;
    b.title = t('speaking');
    const r = await api.speech(m.content.replace(/[*_`#>|]/g, '').slice(0, 4000));
    b.disabled = false;
    b.title = t('read_aloud');
    if (!r.ok) { box.append(el('p', 'status err-line', r.reason)); return; }
    audioSrcs.set(r.audio, r.src);
    m.audio = r.audio;
    save();
    b.remove();
    box.querySelector('.meta').before(player(m));
    box.querySelector('audio').play().catch(() => {});
  });
  return b;
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
  if (c) { setMode(c.mode ?? 'auto'); for (const m of c.messages) bubble(m); if ([...$('model').options].some((o) => o.value === c.model)) $('model').value = chosen[mode] = c.model; }
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
  if (!current) { current = { id: Date.now(), title: text.slice(0, 60), model: $('model').value, mode, messages: [], updated: Date.now() }; chats.unshift(current); }
  const chat = current;
  const asked = { role: 'user', content: text };
  chat.messages.push(asked);
  bubble(asked);
  $('prompt').value = '';
  $('send').disabled = busy = true;
  const wait = bubble({ role: 'assistant', content: `_${t(mode === 'image' ? 'creating' : 'thinking')}_` });
  // Auto: a free model (or the word rules) decides between chat, a picture and speech.
  const auto = mode === 'auto' ? (await api.sort(text)).kind : null;
  const kind = auto ?? mode;
  if (kind !== 'chat') { asked.kind = kind; wait.innerHTML = renderMarkdown(`_${t(kind === 'image' ? 'creating' : 'speaking')}_`); }
  // Picture and speech turns are not conversation: chat models only see the chat turns.
  const history = chat.messages.filter((m) => !m.error && !m.image && !m.audio && m.kind !== 'image' && m.kind !== 'speech').map(({ role, content }) => ({ role, content }));
  const model = $('model').value;
  const r = kind === 'image' ? await api.image(text, mode === 'image' ? model : 'free')
    : kind === 'speech' ? await api.speech(text, true)
    : await api.chat(history, model);
  wait.remove();
  busy = false;
  fillModels();
  if (r.ok && r.image) srcs.set(r.image, r.src);
  if (r.ok && r.audio) audioSrcs.set(r.audio, r.src);
  const meta = r.ok ? { provider: r.provider, model: r.model, ms: r.ms, ...(r.tokens ? { tokens: r.tokens } : {}), ...(auto && auto !== 'chat' ? { auto } : {}) } : null;
  chat.messages.push(!r.ok ? { role: 'assistant', content: r.reason, error: true }
    : r.image ? { role: 'assistant', content: '', image: r.image, prompt: text, meta }
    : r.audio ? { role: 'assistant', content: r.text ?? '', audio: r.audio, meta }
    : { role: 'assistant', content: r.text, meta });
  chat.model = $('model').value;
  chat.mode = mode;
  chat.updated = Date.now();
  chats = [chat, ...chats.filter((c) => c !== chat)];
  save();
  if (current === chat) bubble(chat.messages.at(-1));
  listChats();
  refresh();
}
$('ask').addEventListener('submit', (e) => { e.preventDefault(); send(); });
$('prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });
$('newChat').addEventListener('click', () => openChat(null));
// Attach: the person picks an audio file in the system dialog; its transcript joins the chat.
$('attach').addEventListener('click', async () => {
  if (busy) return;
  $('send').disabled = $('attach').disabled = busy = true;
  const r = await api.transcribe();
  $('attach').disabled = busy = false;
  fillModels();
  if (r.canceled) return;
  if (!current) { current = { id: Date.now(), title: t('transcribe_file', { name: r.name ?? '' }).slice(0, 60), model: $('model').value, mode, messages: [], updated: Date.now() }; chats.unshift(current); }
  const chat = current;
  chat.messages.push({ role: 'user', content: t('transcribe_file', { name: r.name ?? '' }), kind: 'file' },
    r.ok ? { role: 'assistant', content: r.text, meta: { provider: r.provider, model: r.model, ms: r.ms } } : { role: 'assistant', content: r.reason, error: true });
  chat.updated = Date.now();
  chats = [chat, ...chats.filter((c) => c !== chat)];
  save();
  if (current === chat) { bubble(chat.messages.at(-2)); bubble(chat.messages.at(-1)); }
  listChats();
  refresh();
});

// Chat or Image: which models the picker lists, and what the box and button say.
let mode = 'auto', lists = { auto: [], chat: [], image: [] }, busy = false;
const chosen = { auto: 'free', chat: 'free', image: 'free' };
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
  chats = [];
  api.dropImages('all');
  save();
  openChat(null);
});
$('lang').addEventListener('change', () => api.lang($('lang').value)); // the main process reloads this window

applyStrings().then(() => {
  listChats();
  refresh();
  setInterval(() => { if (document.hidden) return; refresh(); if (!$('usage').hidden) showUsage(); }, 15_000);
  window.addEventListener('focus', refresh);
});
