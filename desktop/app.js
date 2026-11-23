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

// Playground: the conversation stays in this window until "New chat".
let messages = [];
function bubble(cls, text) {
  const m = el('div', `msg ${cls}`, text);
  $('chat').append(m);
  m.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return m;
}
async function send() {
  const text = $('prompt').value.trim();
  if (!text || $('send').disabled) return;
  messages.push({ role: 'user', content: text });
  bubble('user', text);
  $('prompt').value = '';
  $('send').disabled = true;
  const wait = bubble('ai', 'Thinking…');
  const r = await api.chat(messages);
  wait.remove();
  $('send').disabled = false;
  if (!r.ok) {
    messages.pop();
    bubble('err', r.reason);
    $('prompt').value = text;
    return;
  }
  messages.push({ role: 'assistant', content: r.text });
  const m = bubble('ai', r.text);
  const meta = el('div', 'meta');
  meta.append(el('span', 'chip who', r.provider), el('span', 'chip', r.model), el('span', 'chip', `${(r.ms / 1000).toFixed(1)} s`));
  if (r.tokens) meta.append(el('span', 'chip', `${num(r.tokens)} tokens`));
  m.append(meta);
  refresh();
}
$('ask').addEventListener('submit', (e) => { e.preventDefault(); send(); });
$('prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });
$('clear').addEventListener('click', () => { messages = []; $('chat').replaceChildren(); $('prompt').focus(); });

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 15_000);
window.addEventListener('focus', refresh);
