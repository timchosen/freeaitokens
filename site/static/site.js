// The whole site's script: pick the right download, tabs, copy buttons, GitHub stars.
const BASE = '{{repoUrl}}/releases/latest/download/';
const NAMES = { mac: 'Mac', windows: 'Windows', linux: 'Linux' };
// English strings; the build fills I18N with the other languages from site/i18n.
const EN = {
  js_download_any: "Download for your computer",
  js_download_os: "Download for {os}",
  js_also: "Also for {list} · free and open source",
  js_and: " and ",
  js_copy: "Copy",
  js_copied: "Copied",
  js_select: "Select and copy",
  js_count: "{n} of {total} models",
};
const I18N = {};
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
const FILES = { mac: 'FreeAITokens-mac.dmg', windows: 'FreeAITokens-windows.exe', linux: 'FreeAITokens-linux-x86_64.AppImage' };

// platform may end in ':touch' (an iPad says MacIntel but has a touch screen).
export function detectOS(ua, platform = '') {
  if (/iPhone|iPad|iPod|Android|Mobile|CrOS/i.test(ua) || platform.endsWith(':touch')) return null; // no app for these
  if (/Mac/i.test(platform) || /Macintosh/.test(ua)) return 'mac';
  if (/Win/i.test(platform) || /Windows/.test(ua)) return 'windows';
  if (/Linux|X11/i.test(platform + ua)) return 'linux';
  return null;
}

export function downloadFor(os, arm = false, t = EN) {
  t = { ...EN, ...t };
  const all = ['mac', 'windows', 'linux'];
  if (!os) return { label: t.js_download_any, file: null, others: all };
  return { label: fill(t.js_download_os, { os: NAMES[os] }), file: os === 'linux' && arm ? 'FreeAITokens-linux-arm64.AppImage' : FILES[os], others: all.filter((o) => o !== os) };
}

export function starsLabel(n) {
  if (typeof n !== 'number' || n < 10) return '';
  return `★ ${n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : n}`;
}

export function filterModels(rows, f) {
  const q = f.q.trim().toLowerCase();
  return rows.filter((r) => (!q || r.name.toLowerCase().includes(q))
    && (!f.provider || r.provider === f.provider) && (!f.kind || r.kind === f.kind)
    && (!f.tools || r.tools) && (!f.images || r.images) && (!f.keyless || r.keyless)
    && r.context >= f.minContext);
}

function wireFilters(form, t) {
  const trs = [...document.querySelectorAll('tr[data-model]')];
  const rows = trs.map((tr) => ({ tr, provider: tr.dataset.provider, kind: tr.dataset.kind, name: tr.dataset.name, tools: tr.dataset.tools === 'true', images: tr.dataset.images === 'true', keyless: tr.dataset.keyless === 'true', context: Number(tr.dataset.context) }));
  const count = document.querySelector('[data-count]');
  const apply = () => {
    const e = form.elements;
    const shown = new Set(filterModels(rows, { q: e.q.value, provider: e.provider.value, kind: e.kind.value, minContext: Number(e.minContext.value), tools: e.tools.checked, images: e.images.checked, keyless: e.keyless.checked }));
    for (const r of rows) r.tr.hidden = !shown.has(r);
    count.textContent = fill(t.js_count, { n: shown.size, total: rows.length });
  };
  form.addEventListener('input', apply);
  form.addEventListener('submit', (e) => e.preventDefault());
}

function wireMenu() {
  const top = document.querySelector('.top');
  const btn = top?.querySelector('.menu-btn');
  if (!btn) return;
  top.classList.add('js'); // without the script the nav simply stays open
  const set = (open) => { btn.setAttribute('aria-expanded', String(open)); top.classList.toggle('open', open); };
  btn.addEventListener('click', () => set(btn.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (top.classList.contains('open')) { set(false); btn.focus(); }
    for (const d of document.querySelectorAll('details.lang[open]')) { d.open = false; d.querySelector('summary').focus(); }
  });
  document.addEventListener('click', (e) => {
    for (const d of document.querySelectorAll('details.lang[open]')) if (!d.contains(e.target)) d.open = false;
  });
}

function wire() {
  const t = { ...EN, ...I18N[document.documentElement.lang] };
  wireMenu();
  const touch = navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform) ? ':touch' : '';
  const os = detectOS(navigator.userAgent, navigator.platform + touch);
  const d = downloadFor(os, /aarch64|arm/i.test(navigator.platform), t);
  if (os) document.documentElement.dataset.os = os;

  for (const a of document.querySelectorAll('[data-download]')) {
    a.textContent = d.label;
    if (d.file) a.href = BASE + d.file;
  }
  for (const p of document.querySelectorAll('[data-also]')) {
    if (!os) continue; // the default text already lists every system
    const [before, after = ''] = t.js_also.split('{list}');
    p.textContent = before;
    d.others.forEach((o, i) => {
      if (i) p.append(t.js_and);
      const a = document.createElement('a');
      a.href = `${document.querySelector('a.brand').getAttribute('href').replace(/\/$/, '')}/download#${o}`;
      a.textContent = NAMES[o];
      p.append(a);
    });
    p.append(after);
  }
  // Commands for other systems stay reachable under "Other systems".
  if (os) for (const el of document.querySelectorAll('[data-for]')) el.hidden = !el.dataset.for.split(' ').includes(os);

  for (const list of document.querySelectorAll('[role="tablist"]')) {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const select = (t) => {
      for (const x of tabs) {
        const on = x === t;
        x.setAttribute('aria-selected', String(on));
        x.tabIndex = on ? 0 : -1;
        document.getElementById(x.getAttribute('aria-controls')).hidden = !on;
      }
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => select(t));
      t.addEventListener('keydown', (e) => {
        const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
        if (next === null) return;
        const n = tabs[(next + tabs.length) % tabs.length];
        select(n);
        n.focus();
        e.preventDefault();
      });
    });
  }

  for (const b of document.querySelectorAll('[data-copy]')) {
    b.setAttribute('aria-live', 'polite');
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        b.textContent = t.js_copied;
      } catch {
        b.textContent = t.js_select;
      }
      setTimeout(() => { b.textContent = t.js_copy; }, 2000);
    });
  }

  const filters = document.querySelector('form.filters');
  if (filters) wireFilters(filters, t);

  const stars = document.querySelectorAll('[data-stars]');
  if (stars.length) {
    fetch('https://api.github.com/repos/{{repo}}', { signal: AbortSignal.timeout?.(3000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { const t = starsLabel(j?.stargazers_count ?? null); for (const s of stars) s.textContent = t ? ` ${t}` : ''; })
      .catch(() => {}); // the button just says GitHub
  }
}

// Sync page: "send me my key". The answer is the same whatever happens, so it is shown either way.
function wireResend() {
  const form = document.getElementById('resend');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = form.querySelector('button');
    b.disabled = true;
    try { await fetch(form.action, { method: 'POST', body: new FormData(form) }); } catch { /* same answer either way */ }
    document.getElementById('resend-done').hidden = false;
    b.disabled = false;
  });
}

if (typeof document !== 'undefined') { wire(); wireResend(); }
