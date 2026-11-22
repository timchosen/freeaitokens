// Live check: one tiny request to the first model of every usable provider.
// Calls providers directly (the router would pick only one). Run: npx tsx scripts/smoke.ts
import { readFileSync } from 'node:fs';
import { parseCatalogue } from '../src/core/catalogue.ts';
import { callUpstream } from '../src/core/upstream.ts';
import { openKeyStore } from '../src/node/keys.ts';

const catalogue = parseCatalogue(JSON.parse(readFileSync(new URL('../src/catalogue.json', import.meta.url), 'utf8')));
const keys = openKeyStore();
let bad = 0;
for (const provider of catalogue) {
  const apiKey = provider.keyless ? null : keys.get(provider.id);
  if (!provider.keyless && !apiKey) { console.log(`${provider.id.padEnd(11)} skipped (no key)`); continue; }
  for (const model of provider.models) {
    const t = Date.now();
    let status: number | string;
    try {
      const r = await callUpstream({ provider, model, apiKey, key: `${provider.id}/${model.id}` }, { messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 5 }, fetch);
      status = r.status; await r.text();
    } catch (e) { status = (e as Error).message; }
    if (status !== 200 && status !== 429) bad++;
    console.log(`${provider.id.padEnd(11)} ${model.id.padEnd(42)} ${String(status).padEnd(5)} ${Date.now() - t} ms`);
  }
}
process.exit(bad ? 1 : 0);
