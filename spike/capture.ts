// Throwaway: log inbound requests on PORT, forward them to the real server on PORT+1.
import http from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
import { startServer } from '../src/node/server.ts';
import { parseCatalogue } from '../src/core/catalogue.ts';
import { LimitTracker } from '../src/core/limits.ts';
import { loadState } from '../src/node/state.ts';
const PORT = +(process.env.PORT ?? 4960), LOG = process.env.LOG!;
const catalogue = parseCatalogue(JSON.parse(readFileSync(new URL('../src/catalogue.json', import.meta.url), 'utf8')));
const real = await startServer({ catalogue, keys: () => null, tracker: new LimitTracker(loadState()), fetch, opts: { freeOnly: true, paidCap: 0 }, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }, PORT + 1);
http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  if (body) appendFileSync(LOG, JSON.stringify({ url: req.url, body: JSON.parse(body) }) + '\n');
  const r = await fetch(`http://127.0.0.1:${real.port}${req.url}`, { method: req.method, headers: req.headers as any, body: body || undefined });
  console.error(req.method, req.url, r.status);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  if (r.body) for await (const c of r.body as any) res.write(c);
  res.end();
}).listen(PORT, '127.0.0.1', () => console.error('capture on', PORT));
