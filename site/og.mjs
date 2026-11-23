// Renders static/og.png (1200x630), the link-preview card, from the catalogue's numbers.
// Needs Google Chrome; run `npm run og` when the numbers change, then deploy.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stats, kindCounts } from './build.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const raw = JSON.parse(readFileSync(join(here, '../src/catalogue.json'), 'utf8'));
const cat = raw.providers ?? raw;
const { domain } = JSON.parse(readFileSync(join(here, 'site.config.json'), 'utf8'));
const s = stats(cat);
const k = kindCounts(cat);
const big = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(s.monthlyTokens);
const logo = readFileSync(join(here, 'static/logo.svg'), 'utf8').replace('<svg ', '<svg width="64" height="64" ');
const kinds = [['Chat', k.chat], ['Transcription', k.transcription], ['Text to speech', k.speech], ['Images', k.image], ['Embeddings', k.embedding]]
  .filter(([, n]) => n).map(([name, n]) => `<li>${name} <b>${n}</b></li>`).join('');

const html = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:1200px;height:630px;overflow:hidden}
body{background:#FBF6EE;color:#2B2520;font:24px/1.3 -apple-system,'Segoe UI',Roboto,sans-serif;padding:56px 72px;display:flex;flex-direction:column;position:relative}
body::after{content:'';position:absolute;right:-140px;top:-140px;width:520px;height:520px;border-radius:50%;background:radial-gradient(circle,#F3D9CC 0%,rgba(251,246,238,0) 70%)}
.brand{display:flex;align-items:center;gap:16px;font:400 40px Georgia,serif;position:relative;z-index:1}
.main{display:flex;align-items:center;gap:40px;margin-top:44px;position:relative;z-index:1}
.n{font:400 200px/0.9 Georgia,serif;color:#C4512B;letter-spacing:-6px}
.what{font:400 50px/1.1 Georgia,serif}
.what small{display:block;font:500 28px/1.3 -apple-system,sans-serif;color:#5E5249;margin-top:12px}
ul{list-style:none;padding:0;display:flex;gap:12px;margin-top:44px;position:relative;z-index:1}
li{background:#fff;border:2px solid #EADFD0;border-radius:999px;padding:8px 20px;font-size:24px;font-weight:600}
li b{color:#C4512B;margin-left:6px}
.foot{margin-top:auto;display:flex;justify-content:space-between;font-size:26px;color:#5E5249;position:relative;z-index:1}
.foot b{color:#2B2520}
</style><body>
<div class="brand">${logo}FreeAITokens</div>
<div class="main"><div class="n">${big}</div><div class="what">free AI tokens<br>every month<small>${s.models} models from ${s.providers} providers, in one app</small></div></div>
<ul>${kinds}</ul>
<div class="foot"><span>Free and open source · Mac, Windows, Linux</span><b>${domain}</b></div>
</body>`;

const dir = mkdtempSync(join(tmpdir(), 'og-'));
writeFileSync(join(dir, 'og.html'), html);
const out = join(here, 'static/og.png');
execFileSync(process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--screenshot=${out}`, '--window-size=1200,630', `file://${join(dir, 'og.html')}`,
], { stdio: 'ignore' });
console.log(`wrote ${out}`);
