// Renders the link-preview cards from the catalogue's numbers, in the homepage hero's words and look:
// static/og.png (1200x630, Open Graph) and static/x-preview.png (1200x600, X's 2:1 large card).
// Needs Google Chrome; run `npm run og` when the numbers or the hero change, then deploy.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stats } from './build.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const raw = JSON.parse(readFileSync(join(here, '../src/catalogue.json'), 'utf8'));
const t = JSON.parse(readFileSync(join(here, 'i18n/en.json'), 'utf8'));
const { domain } = JSON.parse(readFileSync(join(here, 'site.config.json'), 'utf8'));
const s = stats(raw.providers ?? raw);
const tokens = new Intl.NumberFormat('en', { notation: 'compact', compactDisplay: 'long', maximumFractionDigits: 1 }).format(s.monthlyTokens);
const logo = readFileSync(join(here, 'static/logo.svg'), 'utf8').replace('<svg ', '<svg width="52" height="52" ');

const card = (w, h) => `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:${w}px;height:${h}px;overflow:hidden}
body{background:#FBF6EE;color:#2B2520;font:24px/1.3 -apple-system,'Segoe UI',Roboto,sans-serif;padding:48px 80px 44px;display:flex;flex-direction:column;align-items:center;text-align:center;position:relative}
body::before{content:'';position:absolute;left:50%;top:44%;width:980px;height:520px;transform:translate(-50%,-50%);border-radius:50%;background:radial-gradient(closest-side,#F6E1D6 0%,rgba(251,246,238,0) 100%)}
body>*{position:relative}
.brand{display:flex;align-items:center;gap:14px;font:400 34px Georgia,serif}
.eyebrow{margin-top:auto;font-size:26px;font-weight:600;letter-spacing:.02em;color:#B4471F}
h1{margin-top:18px;font:400 ${h > 610 ? 92 : 86}px/1.04 Georgia,serif;letter-spacing:-1.5px;max-width:1000px}
h1 em{font-style:normal;color:#C4512B}
.stats{margin-top:30px;font-size:28px;color:#5E5249}
.stats b{color:#2B2520;font-weight:600}
.stats i{font-style:normal;opacity:.6;margin:0 14px}
.foot{margin-top:auto;font-size:24px;color:#5E5249}
.foot b{color:#2B2520}
</style><body>
<div class="brand">${logo}FreeAITokens</div>
<p class="eyebrow">${s.providers} providers · one app · free</p>
<h1>Up to <em>${tokens}</em> free tokens every month</h1>
<p class="stats"><b>${s.models}</b> ${t.hero_models}<i>·</i><b>${s.providers}</b> ${t.hero_providers}<i>·</i>${t.hero_kinds}</p>
<p class="foot">Free and open source · Mac, Windows, Linux · <b>${domain}</b></p>
</body>`;

const dir = mkdtempSync(join(tmpdir(), 'og-'));
for (const [name, w, h] of [['og.png', 1200, 630], ['x-preview.png', 1200, 600]]) {
  const page = join(dir, `${name}.html`);
  writeFileSync(page, card(w, h));
  const out = join(here, 'static', name);
  execFileSync(process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    `--screenshot=${out}`, `--window-size=${w},${h}`, `file://${page}`,
  ], { stdio: 'ignore' });
  console.log(`wrote ${out}`);
}
