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
  $('theme').value = s.theme ?? 'system';
  lists = { auto: s.models, chat: s.models, image: s.images };
  const v = voice = s.voice, list = (names) => (names.length ? new Intl.ListFormat(tag).format(names) : t('voice_none'));
  $('voiceText').textContent = `${t('voice_dictation', { list: list(v.transcription.using) })} · ${t('voice_speech', { list: list(v.speech.using) })}`;
  const adds = [v.transcription.add, v.speech.add].filter((p, i, a) => p && a.findIndex((q) => q?.id === p.id) === i);
  $('voiceAdd').replaceChildren(...adds.map(addButton));
  fillModels();
  const usable = s.providers.filter((p) => p.status !== 'add');
  $('s-ready').textContent = num(usable.length);
  $('s-left').textContent = num(usable.reduce((n, p) => n + p.left, 0));
  $('s-add').textContent = num(s.providers.length - usable.length);
  provs = s.providers;
  catalogue = s.catalogue;
  $('endpoint3').textContent = s.endpoint;
  const trouble = provs.filter((p) => p.trouble).length;
  $('kSummary').textContent = [t('keys_count', { n: usable.length, total: provs.length }), trouble ? t('keys_trouble_n', { n: trouble }) : ''].filter(Boolean).join(' · ');
  showKeys();
  showModels();
  if (!$('toolGrid').children.length) {
    $('toolGrid').replaceChildren(...s.tools.map((tool) => {
      const card = el('div', 'tool');
      const b = el('button', 'btn quiet', t('open_terminal'));
      b.addEventListener('click', async () => {
        b.disabled = true;
        const r = await api.launch(tool.id);
        b.disabled = false;
        $('toolStatus').className = r.ok ? 'status' : 'status bad';
        $('toolStatus').textContent = r.ok ? t('tool_opening', { name: tool.name }) : t('tool_failed', { name: tool.name, reason: r.reason });
      });
      const cmd = `npx freeaitokens ${tool.id}`, line = el('div', 'cmd');
      const copy = el('button', 'copy', t('copy'));
      copy.addEventListener('click', () => copied(copy, cmd));
      line.append(el('code', '', cmd), copy);
      const title = el('div', 'with-logo');
      title.append(brands.agent(tool.id, tool.name, 28), el('b', '', tool.name));
      card.append(title, el('small', '', tool.note), line, b);
      return card;
    }));
  }
}

// a provider's logo from its name, as the answers and usage rows carry only the name
const provLogo = (name, size) => brands.provider(provs.find((p) => p.name === name)?.id, name, size);

// Keys page: every provider, filtered by whether it is added and what it does.
let provs = [], keyShow = 'all', keyDoes = '';
function showKeys() {
  const rows = provs.filter((p) => (keyShow === 'all' || (keyShow === 'added' ? p.status !== 'add' : keyShow === 'add' ? p.status === 'add' : p.trouble)) && (!keyDoes || p.does.includes(keyDoes)));
  $('kEmpty').hidden = rows.length > 0;
  $('provList').replaceChildren(...rows.map((p) => {
    const row = el('div', 'prov');
    const state = p.status === 'add' ? 'add' : p.trouble ? 'trouble' : 'ready';
    row.append(el('span', `dot ${state}`));
    const name = el('div', 'name');
    const does = el('span', 'does');
    does.append(...p.does.map((d) => el('span', 'chip', t(`does_${d}`))));
    const head = el('div', 'line');
    head.append(brands.provider(p.id, p.name), el('b', '', p.name), does);
    const facts = p.status === 'add' ? [t('prov_models', { n: p.models }), t('keys_free')]
      : [p.trouble ? t('keys_cooling') : p.left ? t('prov_left', { n: p.left }) : '', t('prov_models', { n: p.models })];
    name.append(head, el('small', '', facts.filter(Boolean).join(' · ')));
    row.append(name);
    const say = el('small', 'say');
    say.setAttribute('role', 'status');
    if (p.status === 'add') {
      const b = el('button', 'btn quiet', t('add'));
      b.addEventListener('click', () => api.add(p.id));
      row.append(b);
    } else if (p.status === 'keyless') {
      row.append(el('span', 'badge keyless', t('status_keyless')));
    } else {
      const test = el('button', 'btn quiet', t('keys_test'));
      test.addEventListener('click', async () => {
        test.disabled = true; say.className = 'say'; say.textContent = t('keys_testing');
        const r = await api.testKey(p.id);
        test.disabled = false;
        say.className = r.ok ? 'say ok' : 'say bad';
        say.textContent = r.ok ? t('keys_works') : r.reason;
      });
      const rm = el('button', 'btn quiet danger', t('keys_remove'));
      let armed = 0;
      rm.addEventListener('click', async () => {
        if (!armed) { rm.textContent = t('keys_remove_sure'); armed = setTimeout(() => { armed = 0; rm.textContent = t('keys_remove'); }, 4000); return; }
        clearTimeout(armed);
        await api.removeKey(p.id);
        refresh();
      });
      row.append(say, test, rm);
    }
    return row;
  }));
}
const pressOne = (group, b) => { for (const x of group.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b)); };
$('kShow').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; keyShow = b.dataset.show; pressOne($('kShow'), b); showKeys(); });
$('kDoes').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; keyDoes = b.dataset.does; pressOne($('kDoes'), b); showKeys(); });

// Models page: every model, by kind, with limits, readiness and how it has done on this computer.
let catalogue = [], modelKind = 'chat';
const KINDS = ['chat', 'image', 'speech', 'transcription', 'embedding', 'video', 'completion'];
const contextSize = (n) => (n >= 1_000_000 ? `${+(n / 1_048_576).toFixed(1)}M` : `${Math.round(n / 1024)}K`);
function showModels() {
  const kinds = KINDS.filter((k) => catalogue.some((m) => m.kind === k));
  if (!kinds.includes(modelKind)) modelKind = kinds[0] ?? 'chat';
  $('mKinds').replaceChildren(...kinds.map((k) => {
    const b = el('button', '', `${t(`mkind_${k}`)} ${num(catalogue.filter((m) => m.kind === k && (!$('mReady').checked || m.ready)).length)}`);
    b.type = 'button'; b.dataset.kind = k; b.setAttribute('aria-pressed', String(k === modelKind));
    return b;
  }));
  const q = $('mSearch').value.trim().toLowerCase();
  const rows = catalogue.filter((m) => m.kind === modelKind && (!$('mReady').checked || m.ready) && (!$('mTools').checked || m.tools) && (!$('mVision').checked || m.vision)
    && (!q || m.id.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q)))
    .sort((a, b) => b.ready - a.ready || b.quality - a.quality);
  $('mCount').textContent = t('models_count', { n: rows.length });
  $('mEmpty').hidden = rows.length > 0;
  $('mEmpty').textContent = $('mReady').checked ? t('models_none_ready') : t('models_none');
  $('mList').replaceChildren(...rows.slice(0, 300).map((m) => {
    const row = el('div', 'prov model');
    const state = !m.ready ? 'add' : m.cooling ? 'trouble' : 'ready';
    row.append(el('span', `dot ${state}`));
    const name = el('div', 'name');
    const head = el('div', 'line');
    const caps = el('span', 'does');
    if (m.context) caps.append(el('span', 'chip', contextSize(m.context)));
    if (m.tools) caps.append(el('span', 'chip', t('cap_tools')));
    if (m.vision) caps.append(el('span', 'chip', t('cap_vision')));
    head.append(brands.model(m.id), el('b', 'mono', m.id), caps);
    const limits = [m.rpd && t('models_per_day', { n: m.rpd }), m.rpm && t('models_per_min', { n: m.rpm })].filter(Boolean).join(' · ');
    const record = m.ok + m.fail ? t('models_record', { pct: (m.ok / (m.ok + m.fail)).toLocaleString(tag, { style: 'percent' }), s: (m.ms / 1000).toLocaleString(tag, { maximumFractionDigits: 1 }) }) : '';
    const status = !m.ready ? t('models_needs_key') : m.cooling ? t('models_cooling', { time: new Date(m.cooling).toLocaleTimeString(tag, { hour: 'numeric', minute: '2-digit' }) }) : '';
    name.append(head, el('small', '', [brands.maker(m.id)?.name, t('models_via', { name: m.provider }), limits, record, status].filter(Boolean).join(' · ')));
    row.append(name);
    if (!m.ready) {
      const b = el('button', 'btn quiet', t('add'));
      b.addEventListener('click', () => api.add(m.providerId));
      row.append(b);
    } else if (m.kind === 'chat' || m.kind === 'image') {
      const b = el('button', 'btn quiet', t('models_try'));
      b.addEventListener('click', () => tryModel(m));
      row.append(b);
    }
    return row;
  }));
}
function tryModel(m) {
  select($('t-play'));
  setMode(m.kind === 'image' ? 'image' : 'chat');
  if ([...$('model').options].some((o) => o.value === m.value)) $('model').value = chosen[mode] = m.value;
  $('prompt').focus();
}
$('mKinds').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; modelKind = b.dataset.kind; showModels(); });
for (const id of ['mReady', 'mTools', 'mVision']) $(id).addEventListener('change', showModels);
$('mSearch').addEventListener('input', showModels);

async function copied(b, text) {
  await api.copyText(text);
  b.textContent = t('copied');
  setTimeout(() => { b.textContent = t('copy'); }, 1500);
}
for (const b of document.querySelectorAll('[data-copy-text]')) b.addEventListener('click', () => copied(b, b.dataset.copyText));

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
    try {
      chats = await api.chats.migrate(JSON.parse(old));
      try { localStorage.removeItem(OLD_STORE); } catch { /* storage blocked */ }
    } catch { chats = await api.chats.list(); } // kept in window storage, so the next start tries again
  } else chats = await api.chats.list();
}
const save = (c) => api.chats.put(c);
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
      chats = chats.filter((y) => y !== c); api.chats.remove(c.id); if (current === c) openChat(null); else listChats();
    });
    li.append(b, x);
    return li;
  }));
}
function bubble(m) {
  const box = el('div', `msg ${m.role === 'user' ? 'user' : m.error ? 'err' : 'ai'}`);
  if (m.image) box.append(picture(m));
  else if (m.kind === 'file' && m.content.includes('\n')) box.append(attached(m.content)); // a document: its name, text folded away
  else if (m.role === 'assistant' && !m.error) {
    box.classList.add('md');
    box.innerHTML = renderMarkdown(m.content); // renderMarkdown escapes everything it does not create itself
    previewSvgs(box);
  } else box.textContent = m.content;
  if (m.error && (m.add || [t('no_speech_providers'), t('no_transcription_providers')].includes(m.content))) box.append(' ', addButton(m.add));
  if (m.audio) box.append(player(m));
  if (m.meta?.sources?.length) {
    const src = el('div', 'sources');
    src.append(el('span', '', t('sources')));
    for (const p of m.meta.sources) { if (!/^https?:\/\//.test(p?.u)) continue; const a = el('a', 'chip', String(p.t)); a.href = p.u; a.title = p.u; src.append(a); } // synced chats come from other computers: web links only
    box.append(src);
  }
  if (m.meta) {
    const meta = el('div', 'meta');
    if (m.meta.auto) meta.append(el('span', 'chip auto', t('auto_kind', { kind: t(`kind_${m.meta.auto}`) })));
    const who = el('span', 'chip who'), what = el('span', 'chip');
    who.append(provLogo(m.meta.provider, 14), m.meta.provider); what.append(brands.model(m.meta.model, 14), m.meta.model);
    meta.append(who, what, el('span', 'chip', t('seconds', { n: (m.meta.ms / 1000).toFixed(1) })));
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
// An attached document (see docMessage in logic.js): the "File: name" line, with the text folded underneath.
function attached(content) {
  const d = el('details', 'doc');
  const [head, ...rest] = content.split('\n');
  d.append(el('summary', '', head), el('pre', '', rest.join('\n').replace(/^\n*```\n/, '').replace(/\n```$/, '')));
  return d;
}
// The fix for a voice problem: add the named free provider (or pick one, for errors saved before names were).
function addButton(p) {
  const b = el('button', 'copy', p ? t('add_free', { name: p.name }) : t('btn_add'));
  b.type = 'button';
  b.addEventListener('click', () => api.add(p?.id));
  return b;
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
// Turn an answer into speech and keep the sound with it.
async function speakIt(m) {
  const r = await api.speech(m.content.replace(/[*_`#>|]/g, '').slice(0, 4000));
  if (!r.ok) return r;
  audioSrcs.set(r.audio, r.src);
  m.audio = r.audio;
  const live = current?.messages.find((x) => x.id === m.id); // sync may have swapped in a fresh copy of the chat
  if (live) live.audio = r.audio;
  if (current) { current.updated = Date.now(); save(current); }
  return r;
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
    const r = await speakIt(m);
    b.disabled = false;
    b.title = t('read_aloud');
    if (!r.ok) { const line = el('p', 'status err-line', r.reason); if (r.add) line.append(' ', addButton(r.add)); box.append(line); return; }
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
  if (!text || $('send').disabled) return null;
  if (!current) { current = { id: crypto.randomUUID(), title: text.slice(0, 60), model: $('model').value, mode, messages: [], updated: Date.now() }; chats.unshift(current); }
  const chat = current, asking = mode, model = $('model').value; // read before waiting: the person may switch chats
  const asked = { id: crypto.randomUUID(), at: Date.now(), role: 'user', content: text };
  chat.messages.push(asked);
  bubble(asked);
  $('prompt').value = '';
  $('send').disabled = busy = true;
  const wait = bubble({ role: 'assistant', content: `_${t(asking === 'image' ? 'creating' : 'thinking')}_` });
  // Auto: a free model (or the word rules) decides between chat, a picture and speech.
  const auto = asking === 'auto' ? (await api.sort(text)).kind : null;
  const kind = auto ?? asking;
  if (kind !== 'chat') { asked.kind = kind; wait.innerHTML = renderMarkdown(`_${t(kind === 'image' ? 'creating' : 'speaking')}_`); }
  // Picture and speech turns are not conversation: chat models only see the chat turns.
  const history = chat.messages.filter((m) => !m.error && !m.image && m.kind !== 'image' && m.kind !== 'speech').map(({ role, content }) => ({ role, content }));
  const r = kind === 'image' ? await api.image(text, asking === 'image' ? model : 'free')
    : kind === 'speech' ? await api.speech(text.slice(0, 4000), true)
    : await api.chat(history, model, web);
  wait.remove();
  busy = false;
  fillModels();
  if (r.ok && r.image) srcs.set(r.image, r.src);
  if (r.ok && r.audio) audioSrcs.set(r.audio, r.src);
  const meta = r.ok ? { provider: r.provider, model: r.model, ms: r.ms, ...(r.tokens ? { tokens: r.tokens } : {}), ...(r.sources?.length ? { sources: r.sources } : {}), ...(auto && auto !== 'chat' ? { auto } : {}) } : null;
  const stamp = { id: crypto.randomUUID(), at: Date.now() };
  chat.messages.push(!r.ok ? { ...stamp, role: 'assistant', content: r.reason, error: true, ...(r.add ? { add: r.add } : {}) }
    : r.image ? { ...stamp, role: 'assistant', content: '', image: r.image, prompt: text, meta }
    : r.audio ? { ...stamp, role: 'assistant', kind: 'speech', content: r.text ?? '', audio: r.audio, meta }
    : { ...stamp, role: 'assistant', content: r.text, meta });
  chat.model = model;
  chat.mode = asking;
  chat.updated = Date.now();
  chats = [chat, ...chats.filter((c) => c.id !== chat.id)]; // by id: sync may have swapped in a fresh copy meanwhile
  const saved = await save(chat);
  if (current === chat) bubble(chat.messages.at(-1));
  if (!saved && current === chat) bubble({ role: 'assistant', content: t('chat_too_long'), error: true }); // shown, not stored
  else if (current?.id === chat.id) {
    // Sync refreshed this chat while we waited: show the stored copy, which now holds both sides.
    chats = await api.chats.list();
    current = chats.find((c) => c.id === chat.id) ?? null;
    if (current) openChat(current);
  }
  listChats();
  refresh();
  return { r, chat, said: chat.messages.at(-1) };
}
$('ask').addEventListener('submit', (e) => { e.preventDefault(); send(); });
$('prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });
$('newChat').addEventListener('click', () => openChat(null));
$('newChat2').addEventListener('click', () => openChat(null));
let sideOff = false;
try { sideOff = localStorage.getItem('chatsHidden') === '1'; } catch { /* no storage: panel shows */ }
function showSide() {
  $('play').classList.toggle('side-off', sideOff);
  $('newChat2').hidden = !sideOff;
  const b = $('sideToggle'), label = t(sideOff ? 'show_chats' : 'hide_chats');
  b.setAttribute('aria-expanded', String(!sideOff));
  b.setAttribute('aria-label', label);
  b.title = label;
}
$('sideToggle').addEventListener('click', () => {
  sideOff = !sideOff;
  try { localStorage.setItem('chatsHidden', sideOff ? '1' : '0'); } catch { /* not kept */ }
  showSide();
});
// Attach: the person picks a file in the system dialog. Audio is transcribed into the chat; a document joins
// the chat as a message, and the model reads it with the next question.
$('attach').addEventListener('click', async () => {
  if (busy) return;
  $('send').disabled = $('attach').disabled = busy = true;
  const wait = bubble({ role: 'assistant', content: `_${t('reading_file')}_` });
  const r = await api.attach();
  wait.remove();
  $('attach').disabled = busy = false;
  fillModels();
  if (r.canceled) return;
  if (!r.ok) { bubble({ role: 'assistant', content: r.reason, error: true, add: r.add }); return; } // shown, not stored
  const doc = r.kind === 'doc', label = doc ? r.name : t('transcribe_file', { name: r.name ?? '' });
  if (!current) { current = { id: crypto.randomUUID(), title: label.slice(0, 60), model: $('model').value, mode, messages: [], updated: Date.now() }; chats.unshift(current); }
  const chat = current, at = Date.now();
  const added = doc ? [{ id: crypto.randomUUID(), at, role: 'user', content: r.content, kind: 'file' }]
    : [{ id: crypto.randomUUID(), at, role: 'user', content: label, kind: 'file' },
      { id: crypto.randomUUID(), at, role: 'assistant', content: r.text, meta: { provider: r.provider, model: r.model, ms: r.ms } }];
  chat.messages.push(...added);
  chat.updated = Date.now();
  chats = [chat, ...chats.filter((c) => c.id !== chat.id)];
  const saved = await save(chat);
  if (current === chat) for (const m of added) bubble(m);
  if (!saved && current === chat) bubble({ role: 'assistant', content: t('chat_too_long'), error: true });
  else if (doc) { if (r.cut) bubble({ role: 'assistant', content: t('doc_cut'), error: true }); $('prompt').focus(); }
  listChats();
  refresh();
});

// Mic: record in the window, transcribe through your providers, and put the words in the box to edit.
let rec = null, web = false, voice = null;
// The line above the box that says what voice is doing: listening, transcribing, or what to fix.
function voiceNote(text, add, busyNow = false) {
  const n = $('voiceNote');
  n.hidden = !text;
  n.classList.toggle('working', busyNow);
  n.replaceChildren(...(text ? [el('span', '', text)] : []), ...(add ? [' ', addButton(add)] : []));
}
try { web = localStorage.getItem('web') === '1'; } catch { /* no storage: search starts off */ }
const micState = (on) => {
  $('mic').setAttribute('aria-pressed', String(on));
  $('mic').title = t(on ? 'mic_stop' : 'mic_start');
  $('mic').setAttribute('aria-label', $('mic').title);
};
const webState = () => $('web').setAttribute('aria-pressed', String(web));
$('web').addEventListener('click', () => {
  web = !web;
  webState();
  try { localStorage.setItem('web', web ? '1' : '0'); } catch { /* not kept */ }
});
$('mic').addEventListener('click', async () => {
  if (rec) return rec.stop();
  if (busy) return;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { voiceNote(t('mic_denied')); return; }
  const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'].find((x) => MediaRecorder.isTypeSupported(x));
  const parts = [], r = rec = new MediaRecorder(stream, type ? { mimeType: type } : {});
  const cap = setTimeout(() => r.state === 'recording' && r.stop(), 5 * 60_000); // 5 minutes stays far under the 25 MB upload limit
  // While recording: a running time and a level bar, so it is clear the mic hears you.
  const ctx = new AudioContext(), meter = ctx.createAnalyser(), wave = new Uint8Array(512), began = Date.now();
  ctx.createMediaStreamSource(stream).connect(meter);
  const level = el('i'), clock = el('span', 'clock');
  voiceNote(t('listening'), null, true);
  const bar = el('span', 'level');
  bar.append(level);
  $('voiceNote').append(' ', clock, bar);
  const tick = setInterval(() => {
    meter.getByteTimeDomainData(wave);
    let peak = 0; for (const v of wave) peak = Math.max(peak, Math.abs(v - 128));
    level.style.width = `${Math.min(100, peak * 1.6)}%`;
    const sec = Math.floor((Date.now() - began) / 1000);
    clock.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }, 100);
  r.ondataavailable = (e) => parts.push(e.data);
  r.onstop = async () => {
    clearTimeout(cap);
    clearInterval(tick);
    ctx.close();
    for (const tr of stream.getTracks()) tr.stop();
    rec = null;
    micState(false);
    const blob = new Blob(parts);
    if (blob.size < 2000) return voiceNote(''); // a tap, not speech
    $('send').disabled = $('mic').disabled = busy = true;
    voiceNote(t('transcribing'), null, true);
    const got = await api.transcribe(new Uint8Array(await blob.arrayBuffer()));
    $('mic').disabled = busy = false;
    fillModels();
    if (!got.ok) return voiceNote(got.reason, got.add);
    if (!got.text) return voiceNote(t('heard_nothing'));
    voiceNote('');
    const box = $('prompt');
    box.value = box.value.trim() ? `${box.value.trimEnd()} ${got.text}` : got.text;
    box.focus();
  };
  r.start();
  micState(true);
});

// Talk: a voice conversation over the whole chat, like a call. It listens until you pause, sends what you said,
// reads the answer out and listens again. Tap the orb to cut an answer short; every turn stays in the chat.
const TK = { on: false, muted: false, stream: null, ctx: null, meter: null, out: null, rec: null, audio: null, raf: 0, turn: 0, drop: false, mode: 'auto' };
const wave = new Uint8Array(512);
const peak = (an) => { an.getByteTimeDomainData(wave); let p = 0; for (const v of wave) p = Math.max(p, Math.abs(v - 128)); return p; };
function talkPhase(p, said) {
  $('talkover').dataset.phase = p;
  $('talkState').textContent = p ? t(`talk_${p}`) : '';
  if (said !== undefined) $('talkSaid').textContent = said;
}
// The orb swells with whoever is talking: you, or the answer being read.
function orbLoop() {
  const lv = TK.rec ? peak(TK.meter) : TK.out ? peak(TK.out) : 0;
  $('orb').style.setProperty('--lv', Math.min(1, lv / 50).toFixed(3));
  TK.raf = requestAnimationFrame(orbLoop);
}
async function talkOpen() {
  if (busy || TK.on) return;
  if (!voice?.transcription.using.length) return voiceNote(t('no_transcription_providers'), voice?.transcription.add);
  if (!voice?.speech.using.length) return voiceNote(t('no_speech_providers'), voice?.speech.add);
  try { TK.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch { return voiceNote(t('mic_denied')); }
  voiceNote('');
  TK.on = true; TK.muted = false; TK.mode = mode;
  if (mode !== 'chat') setMode('chat'); // spoken turns are conversation, not pictures
  TK.ctx = new AudioContext();
  TK.meter = TK.ctx.createAnalyser();
  TK.ctx.createMediaStreamSource(TK.stream).connect(TK.meter);
  $('talkMute').setAttribute('aria-pressed', 'false');
  talkPhase('listening', '');
  $('talkover').hidden = false;
  $('talkEnd').focus();
  orbLoop();
  listen();
}
function talkClose() {
  if (!TK.on) return;
  TK.on = false; TK.turn++;
  cancelAnimationFrame(TK.raf);
  if (TK.rec?.state === 'recording') TK.rec.stop();
  TK.audio?.pause(); TK.audio = TK.out = null;
  for (const tr of TK.stream.getTracks()) tr.stop();
  TK.ctx.close();
  $('talkover').hidden = true;
  talkPhase('', '');
  setMode(TK.mode);
  if (current) openChat(current); // shows the players for the answers that were read out
  $('talk').focus();
}
// Record until there has been speech and then 1.2 s of quiet. The room's quiet level is learnt in the first half second.
function listen() {
  if (!TK.on || TK.rec || TK.audio || TK.thinking) return;
  if (TK.muted) return talkPhase('muted');
  talkPhase('listening');
  const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'].find((x) => MediaRecorder.isTypeSupported(x));
  const parts = [], r = TK.rec = new MediaRecorder(TK.stream, type ? { mimeType: type } : {}), began = Date.now();
  let floor = 0, spoke = 0, quiet = 0;
  TK.drop = false;
  const tick = setInterval(() => {
    const lv = peak(TK.meter), now = Date.now();
    if (now - began < 500) { floor = Math.max(floor, lv); return; }
    if (lv > Math.max(10, Math.min(floor, 20) * 2)) { spoke ||= now; quiet = 0; } else if (spoke && !quiet) quiet = now;
    if ((quiet && now - quiet > 1200) || now - began > 120_000) r.stop();
  }, 50);
  TK.endTurn = () => { if (spoke) r.stop(); };
  r.ondataavailable = (e) => parts.push(e.data);
  r.onstop = () => {
    clearInterval(tick);
    TK.rec = null;
    if (!TK.on) return;
    if (TK.drop || !spoke) return listen();
    respond(new Blob(parts), TK.turn);
  };
  r.start(250);
}
// A problem is shown for a moment, then Talk listens again.
function trouble(reason, turn) {
  talkPhase('trouble', reason ?? '');
  setTimeout(() => { if (TK.on && turn === TK.turn) listen(); }, 3500);
}
// While an answer is on its way the mic is not listened to (unmuting then waits for the answer).
async function respond(blob, turn) {
  TK.thinking = true;
  let next;
  try { next = await answer(blob, turn); } finally { TK.thinking = false; }
  if (next === 'listen') listen();
}
async function answer(blob, turn) {
  talkPhase('thinking', '');
  const got = await api.transcribe(new Uint8Array(await blob.arrayBuffer()));
  if (!TK.on || turn !== TK.turn) return;
  if (!got.ok) return trouble(got.reason, turn);
  if (!got.text?.trim()) return 'listen';
  $('talkSaid').textContent = got.text;
  $('prompt').value = got.text;
  const sent = await send();
  if (!TK.on || turn !== TK.turn) return;
  if (!sent?.r.ok || !sent.r.text) return trouble(sent?.r.reason, turn);
  const sp = await speakIt(sent.said);
  if (!TK.on || turn !== TK.turn) return;
  if (!sp.ok) return trouble(sp.reason, turn);
  talkPhase('speaking', sent.r.text.replace(/[*_`#>|]/g, '').slice(0, 300));
  const a = TK.audio = new Audio(sp.src), node = TK.ctx.createMediaElementSource(a);
  TK.out = TK.ctx.createAnalyser();
  node.connect(TK.out); TK.out.connect(TK.ctx.destination);
  a.onended = a.onpause = () => {
    if (TK.audio !== a) return;
    TK.audio = TK.out = null;
    node.disconnect();
    listen();
  };
  a.play().catch(() => a.onended());
}
$('talk').addEventListener('click', talkOpen);
$('talkEnd').addEventListener('click', talkClose);
// The orb: cuts the answer short, or ends your turn now instead of waiting for the pause.
$('orb').addEventListener('click', () => { if (TK.audio) TK.audio.pause(); else if (TK.rec) TK.endTurn(); });
$('talkMute').addEventListener('click', () => {
  TK.muted = !TK.muted;
  $('talkMute').setAttribute('aria-pressed', String(TK.muted));
  if (TK.muted && TK.rec) { TK.drop = true; TK.rec.stop(); } else if (!TK.muted) listen();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && TK.on) { e.preventDefault(); talkClose(); } });

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
    const head = el('div', 'line');
    head.append(provLogo(p.name), el('b', '', p.name));
    name.append(head, el('small', '', t('prov_usage', { ok: p.ok, fail: p.fail, tokens: compact(p.tokens) })));
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
  $('updText').textContent = `${t('upd_out', { v: r.latest })} ${r.early ? `${t('upd_early')} ` : ''}`;
  const a = el('a', '', t('upd_download'));
  a.href = r.early && r.url ? r.url : 'https://freeaitokens.co/download'; // a pre-release isn't on the download page yet
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
$('theme').addEventListener('change', async () => { $('theme').value = await api.theme($('theme').value); });

// Settings › Sync. The main process does the work; this shows which of its states we are in.
let syncStatus = { state: 'off' }, syncForm = null; // form: 'new' | 'have' | 'recover' | 'change'
const SYNC_PANELS = ['syncOff', 'syncWait', 'syncForm', 'syncCodeView', 'syncOn', 'syncEnded'];
const showPanel = (id) => { for (const p of SYNC_PANELS) $(p).hidden = p !== id; };
const syncSay = (text, bad = false) => { $('syncMsg').textContent = text ?? ''; $('syncMsg').classList.toggle('bad', bad); };
function fmtSize(bytes = 0) {
  const mb = bytes >= 1_000_000;
  return new Intl.NumberFormat(tag, { style: 'unit', unit: mb ? 'megabyte' : 'kilobyte', maximumFractionDigits: 1 }).format(mb ? bytes / 1_000_000 : Math.max(bytes / 1000, bytes ? 0.1 : 0));
}
const PRICES = { year: 10, life: 49 }; // USD, as on the site and in Stripe
function renderSync() {
  $('syncNudge').hidden = syncStatus.state !== 'off';
  if (syncForm || !$('syncCodeView').hidden) return; // the person is in the middle of something
  const s = syncStatus;
  if (s.key) return openSyncForm('new', s.key);
  if (s.state === 'waiting') return showPanel('syncWait');
  if (s.state === 'off') return showPanel('syncOff');
  if (s.state === 'expired' || s.state === 'revoked') {
    $('syncEndedText').textContent = t(s.state === 'expired' ? 'sync_expired' : 'sync_revoked');
    $('syncRenew').hidden = $('syncUpgrade').hidden = s.state === 'revoked';
    return showPanel('syncEnded');
  }
  const when = s.last ? t('sync_last', { time: new Date(s.last).toLocaleString(tag) }) : t('sync_never');
  const plan = s.plan === 'life' ? t('sync_plan_life') : s.paidUntil ? t('sync_plan_year', { date: new Date(s.paidUntil).toLocaleDateString(tag) }) : '';
  $('syncInfo').textContent = [when, s.items != null ? t('sync_usage', { items: s.items, size: fmtSize(s.bytes) }) : '', plan].filter(Boolean).join(' · ');
  $('syncManage').hidden = $('syncUpgradeOn').hidden = s.plan !== 'year';
  showPanel('syncOn');
  if (s.state === 'error') syncSay(s.reason === 'offline' ? t('sync_offline') : s.reason === 'full' ? t('sync_full') : t('sync_failed', { reason: s.detail ?? s.reason ?? '' }), true);
}
function openSyncForm(kind, key = '') {
  syncForm = kind;
  $('syncGot').hidden = kind !== 'new';
  $('syncKeyRow').hidden = kind === 'change';
  $('syncKey').value = key;
  $('syncKey').readOnly = kind === 'new';
  $('syncCodeRow').hidden = kind !== 'recover';
  $('syncPass2Row').hidden = kind === 'have';
  $('syncForgot').hidden = kind !== 'have';
  $('syncGo').textContent = t(kind === 'change' || kind === 'recover' ? 'sync_use_code' : 'sync_start');
  if (kind === 'change') $('syncGo').textContent = t('sync_change_pass');
  $('syncPass').value = $('syncPass2').value = $('syncCode').value = '';
  syncSay('');
  showPanel('syncForm');
  (kind === 'have' ? $('syncKey') : kind === 'recover' ? $('syncCode') : $('syncPass')).focus();
}
function showCode(code) {
  $('syncCodeText').textContent = code;
  showPanel('syncCodeView');
}
async function syncDo(btn, fn) {
  btn.disabled = true;
  syncSay(t('sync_working'));
  try {
    const r = await fn();
    if (r && r.ok === false) { syncSay(r.error, true); return null; }
    syncSay('');
    return r;
  } finally { btn.disabled = false; }
}
const refreshSync = async () => { syncStatus = await api.sync.status(); renderSync(); };
api.onSync((s) => { syncStatus = s; renderSync(); });
api.onChats(async () => {
  const id = current?.id;
  chats = await api.chats.list();
  current = chats.find((c) => c.id === id) ?? null;
  if (current) openChat(current); else listChats();
});
$('syncYear').addEventListener('click', (e) => syncDo(e.currentTarget, () => api.sync.buy('year')));
$('syncLife').addEventListener('click', (e) => syncDo(e.currentTarget, () => api.sync.buy('life')));
$('syncRenew').addEventListener('click', (e) => syncDo(e.currentTarget, () => api.sync.buy('year')));
$('syncUpgrade').addEventListener('click', (e) => syncDo(e.currentTarget, () => api.sync.buy('life')));
$('syncUpgradeOn').addEventListener('click', (e) => syncDo(e.currentTarget, () => api.sync.buy('life')));
$('syncHave').addEventListener('click', () => openSyncForm('have'));
$('syncCancel').addEventListener('click', () => api.sync.cancel());
$('syncBack').addEventListener('click', () => { syncForm = null; refreshSync(); });
$('syncForgot').addEventListener('click', () => openSyncForm('recover', $('syncKey').value));
$('syncForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const kind = syncForm, pass = $('syncPass').value;
  if (!$('syncPass2Row').hidden && pass !== $('syncPass2').value) return syncSay(t('sync_pass_mismatch'), true);
  const r = await syncDo($('syncGo'), () =>
    kind === 'change' ? api.sync.pass(pass)
    : kind === 'recover' ? api.sync.recover($('syncCode').value, pass, $('syncKey').value)
    : api.sync.setup($('syncKey').value, pass, !$('syncPass2Row').hidden));
  if (!r) return;
  if (r.confirm) { // a key with no account yet: its first passphrase is typed twice
    $('syncPass2Row').hidden = false;
    syncSay(t('sync_confirm_new'));
    return $('syncPass2').focus();
  }
  syncForm = null;
  $('syncPass').value = $('syncPass2').value = '';
  if (r.recovery) return showCode(r.recovery);
  await refreshSync();
  if (kind === 'change' || kind === 'recover') syncSay(t('sync_pass_changed'));
});
$('syncCodeCopy').addEventListener('click', () => navigator.clipboard.writeText($('syncCodeText').textContent));
$('syncCodeDone').addEventListener('click', () => { $('syncCodeText').textContent = ''; showPanel(null); refreshSync(); });
$('syncNow').addEventListener('click', async (e) => { await syncDo(e.currentTarget, () => api.sync.now()); refreshSync(); });
$('syncCopyKey').addEventListener('click', async () => { const b = $('syncCopyKey'); if (await api.sync.copyKey()) { b.textContent = t('copied'); setTimeout(() => { b.textContent = t('sync_copy_key'); }, 1500); } });
$('syncShow').addEventListener('click', async () => { const c = await api.sync.recovery(); if (c) showCode(c); });
$('syncPassBtn').addEventListener('click', () => openSyncForm('change'));
$('syncManage').addEventListener('click', (e) => syncDo(e.currentTarget, () => api.sync.billing()));
for (const id of ['syncOffBtn', 'syncOffBtn2']) $(id).addEventListener('click', () => { if (confirm(t('sync_confirm_off'))) api.sync.off(); });

applyStrings().then(loadChats).then(() => {
  const money = (n) => new Intl.NumberFormat(tag, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
  $('priceYear').textContent = money(PRICES.year);
  $('priceLife').textContent = money(PRICES.life);
  webState();
  showSide();
  listChats();
  refreshSync();
  refresh();
  setInterval(() => { if (document.hidden) return; refresh(); if (!$('usage').hidden) showUsage(); }, 15_000);
  window.addEventListener('focus', refresh);
});
