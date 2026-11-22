import { parseCatalogue } from '../../src/core/catalogue.js';
import { buildCatalogue, signPayload } from './build.js';

interface Env {
  CATALOGUE: KVNamespace;
  SIGNING_KEY: string; // base64 PKCS#8 Ed25519 private key
  SOURCE_URL: string; // the repo's src/catalogue.json on main
  [secret: `KEY_${string}`]: string | undefined; // maintainer keys used only for probing
}

async function refresh(env: Env): Promise<void> {
  const res = await fetch(env.SOURCE_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`source ${res.status}`);
  const base = parseCatalogue(await res.json());
  const keyFor = (id: string) => env[`KEY_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}` as `KEY_${string}`];
  const providers = await buildCatalogue(base, keyFor, fetch);
  const envelope = await signPayload({ issued: new Date().toISOString(), providers }, env.SIGNING_KEY);
  await env.CATALOGUE.put('latest', JSON.stringify(envelope));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method !== 'GET' || pathname !== '/catalogue.json') return new Response('Not found', { status: 404 });
    const body = await env.CATALOGUE.get('latest');
    if (!body) return new Response('Not ready', { status: 503 });
    return new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' } });
  },
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refresh(env));
  },
};
