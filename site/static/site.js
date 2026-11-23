// The whole site's script: pick the right download, tabs, copy buttons, GitHub stars.
const BASE = 'https://github.com/timchosen/freeaitokens/releases/latest/download/';
const NAMES = { mac: 'Mac', windows: 'Windows', linux: 'Linux' };
const FILES = { mac: 'FreeAITokens-mac.dmg', windows: 'FreeAITokens-windows.exe', linux: 'FreeAITokens-linux-x86_64.AppImage' };

// platform may end in ':touch' (an iPad says MacIntel but has a touch screen).
export function detectOS(ua, platform = '') {
  if (/iPhone|iPad|iPod|Android|Mobile|CrOS/i.test(ua) || platform.endsWith(':touch')) return null; // no app for these
  if (/Mac/i.test(platform) || /Macintosh/.test(ua)) return 'mac';
  if (/Win/i.test(platform) || /Windows/.test(ua)) return 'windows';
  if (/Linux|X11/i.test(platform + ua)) return 'linux';
  return null;
}

export function downloadFor(os) {
  const all = ['mac', 'windows', 'linux'];
  if (!os) return { label: 'Download for your computer', file: null, others: all };
  return { label: `Download for ${NAMES[os]}`, file: FILES[os], others: all.filter((o) => o !== os) };
}

export function starsLabel(n) {
  if (typeof n !== 'number' || n < 10) return '';
  return `★ ${n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : n}`;
}

function wire() {
  const touch = navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform) ? ':touch' : '';
  const os = detectOS(navigator.userAgent, navigator.platform + touch);
  const d = downloadFor(os);
  if (os) document.documentElement.dataset.os = os;

  for (const a of document.querySelectorAll('[data-download]')) {
    a.textContent = d.label;
    if (d.file) a.href = BASE + d.file;
  }
  for (const p of document.querySelectorAll('[data-also]')) {
    if (!os) continue; // the default text already lists every system
    p.textContent = 'Also for ';
    d.others.forEach((o, i) => {
      if (i) p.append(' and ');
      const a = document.createElement('a');
      a.href = `/download#${o}`;
      a.textContent = NAMES[o];
      p.append(a);
    });
    p.append(' · free and open source');
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
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        b.textContent = 'Copied';
      } catch {
        b.textContent = 'Select and copy';
      }
      setTimeout(() => { b.textContent = 'Copy'; }, 2000);
    });
  }

  const stars = document.querySelectorAll('[data-stars]');
  if (stars.length) {
    fetch('https://api.github.com/repos/timchosen/freeaitokens', { signal: AbortSignal.timeout(3000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { const t = starsLabel(j?.stargazers_count ?? null); for (const s of stars) s.textContent = t ? ` ${t}` : ''; })
      .catch(() => {}); // the button just says GitHub
  }
}

if (typeof document !== 'undefined') wire();
