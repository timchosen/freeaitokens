import type { Candidate } from './orchestrator.js';
import type { ChatRequest } from './types.js';

export type Fetch = typeof fetch;

const HEADERS_TIMEOUT_MS = 60_000;

// Request changes some providers need to accept an otherwise standard request.
function adapt(providerId: string, body: any): any {
  return providerId === 'nvidia' && Array.isArray(body.tools) && body.tools.length ? { ...body, parallel_tool_calls: false } : body;
}

// POST to the provider's chat completions. Resolves once response headers arrive.
export async function callUpstream(c: Candidate, req: ChatRequest, f: Fetch, signal?: AbortSignal): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('upstream timed out')), HEADERS_TIMEOUT_MS);
  signal?.addEventListener('abort', () => ctl.abort(signal.reason), { once: true });
  try {
    return await f(`${c.provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
      body: JSON.stringify(adapt(c.provider.id, { ...req, model: c.model.id })),
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
