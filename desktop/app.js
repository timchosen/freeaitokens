// The FreeAITokens window: home, playground, tool launcher and providers.
const api = window.freeaitokens;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});
const num = (n) => n.toLocaleString();

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
const STATUS = { ready: 'Ready', keyless: 'No key needed', add: 'Not added' };
async function refresh() {
  const s = await api.status();
  $('running').textContent = s.reused ? `Using FreeAITokens on port ${s.port}` : `Running on port ${s.port}`;
  $('endpoint').textContent = s.endpoint;
  $('endpoint2').textContent = s.endpoint;
  $('version').textContent = s.version;
  $('login').checked = s.startAtLogin;
  fillModels(s.models);
  const usable = s.providers.filter((p) => p.status !== 'add');
  $('s-ready').textContent = num(usable.length);
  $('s-left').textContent = num(usable.reduce((n, p) => n + p.left, 0));
  $('s-add').textContent = num(s.providers.length - usable.length);
  $('provList').replaceChildren(...s.providers.map((p) => {
    const row = el('div', 'prov');
    const name = el('div', 'name');
    name.append(el('b', '', p.name), el('small', '', [`${p.models} model${p.models === 1 ? '' : 's'}`, p.status !== 'add' && p.left ? `${num(p.left)} requests left today` : '', p.media.length ? `also ${p.media.join(', ')}` : ''].filter(Boolean).join(' · ')));
    row.append(name, el('span', `badge ${p.status}`, STATUS[p.status]));
    if (p.status === 'add') {
      const b = el('button', 'btn quiet', 'Add');
      b.addEventListener('click', () => api.add(p.id));
      row.append(b);
    }
    return row;
  }));
  if (!$('toolGrid').children.length) {
    $('toolGrid').replaceChildren(...s.tools.map((t) => {
      const card = el('div', 'tool');
      const b = el('button', 'btn', 'Open in Terminal');
      b.addEventListener('click', async () => {
        b.disabled = true;
        const r = await api.launch(t.id);
        b.disabled = false;
        $('toolStatus').className = r.ok ? 'status' : 'status bad';
        $('toolStatus').textContent = r.ok ? `Opening ${t.name} in a new terminal window.` : `Could not open ${t.name}: ${r.reason}`;
      });
      card.append(el('b', '', t.name), el('small', '', t.note), b);
      return card;
    }));
  }
}

for (const b of document.querySelectorAll('[data-copy]')) {
  b.addEventListener('click', async () => {
    await api.copy(b.dataset.copy);
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
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

function listChats() {
  $('chats').replaceChildren(...chats.map((c) => {
    const li = el('li');
    const b = el('button', c === current ? 'on' : '', c.title);
    b.type = 'button';
    b.title = new Date(c.updated).toLocaleString();
    b.addEventListener('click', () => openChat(c));
    const x = el('button', 'del', '×');
    x.type = 'button';
    x.setAttribute('aria-label', `Delete chat: ${c.title}`);
    x.addEventListener('click', () => { chats = chats.filter((y) => y !== c); save(); if (current === c) openChat(null); else listChats(); });
    li.append(b, x);
    return li;
  }));
}
function bubble(m) {
  const box = el('div', `msg ${m.role === 'user' ? 'user' : m.error ? 'err' : 'ai'}`);
  if (m.role === 'assistant' && !m.error) {
    box.classList.add('md');
    box.innerHTML = renderMarkdown(m.content); // renderMarkdown escapes everything it does not create itself
  } else box.textContent = m.content;
  if (m.meta) {
    const meta = el('div', 'meta');
    meta.append(el('span', 'chip who', m.meta.provider), el('span', 'chip', m.meta.model), el('span', 'chip', `${(m.meta.ms / 1000).toFixed(1)} s`));
    if (m.meta.tokens) meta.append(el('span', 'chip', `${num(m.meta.tokens)} tokens`));
    box.append(meta);
  }
  $('empty').hidden = true;
  $('chat').append(box);
  box.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return box;
}
function openChat(c) {
  current = c;
  $('chat').replaceChildren($('empty'));
  $('empty').hidden = false;
  if (c) { for (const m of c.messages) bubble(m); if ([...$('model').options].some((o) => o.value === c.model)) $('model').value = c.model; }
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
  if (!current) { current = { id: Date.now(), title: text.slice(0, 60), model: $('model').value, messages: [], updated: Date.now() }; chats.unshift(current); }
  const chat = current;
  chat.messages.push({ role: 'user', content: text });
  bubble(chat.messages.at(-1));
  $('prompt').value = '';
  $('send').disabled = true;
  const wait = bubble({ role: 'assistant', content: '_Thinking…_' });
  const history = chat.messages.filter((m) => !m.error).map(({ role, content }) => ({ role, content }));
  const r = await api.chat(history, $('model').value);
  wait.remove();
  $('send').disabled = false;
  chat.messages.push(r.ok
    ? { role: 'assistant', content: r.text, meta: { provider: r.provider, model: r.model, ms: r.ms, tokens: r.tokens } }
    : { role: 'assistant', content: r.reason, error: true });
  chat.model = $('model').value;
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

function fillModels(models) {
  const sel = $('model');
  const keep = sel.value || 'free';
  const groups = new Map();
  for (const m of models) { if (!groups.has(m.provider)) groups.set(m.provider, el('optgroup')); groups.get(m.provider).label = m.provider; groups.get(m.provider).append(Object.assign(el('option', '', m.label), { value: m.value })); }
  sel.replaceChildren(Object.assign(el('option', '', 'Auto: best free model'), { value: 'free' }), ...groups.values());
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : 'free';
}

// Settings
$('login').addEventListener('change', async () => { $('login').checked = await api.login($('login').checked); });
$('checkUpd').addEventListener('click', async () => {
  $('checkUpd').disabled = true;
  const r = await api.updates();
  $('checkUpd').disabled = false;
  if (!r.ok) { $('updText').textContent = `Could not check: ${r.reason}`; return; }
  if (!r.newer) { $('updText').textContent = `Version ${$('version').textContent} is the latest.`; return; }
  $('updText').textContent = `${r.latest} is out. `;
  const a = el('a', '', 'Download it');
  a.href = 'https://freeaitokens.co/download';
  a.addEventListener('click', (e) => { e.preventDefault(); api.open(a.href); });
  $('updText').append(a);
});
$('clearChats').addEventListener('click', () => {
  if (!confirm('Delete all saved chats? This cannot be undone.')) return;
  chats = [];
  save();
  openChat(null);
});
listChats();

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 15_000);
window.addEventListener('focus', refresh);
