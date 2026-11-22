// Throwaway stop-test shim (Task 0). Anthropic Messages in, one OpenAI-format upstream out.
// Calls upstream non-streaming and replays the answer as Anthropic SSE: enough to test model ability.
import http from 'node:http';
import fs from 'node:fs';

const URL_ = process.env.UPSTREAM_URL ?? 'https://api.kilo.ai/api/gateway/v1';
const KEY = process.env.UPSTREAM_KEY ?? '';
const MODEL = process.env.UPSTREAM_MODEL!;
const PORT = +(process.env.PORT ?? 4950);
const LOG = process.env.SHIM_LOG; // when set, append raw inbound requests here (fixtures for Task 6)

const text = (c: any) => typeof c === 'string' ? c : (c ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');

function toChat(b: any) {
  const msgs: any[] = [];
  if (b.system) msgs.push({ role: 'system', content: text(b.system) });
  for (const m of b.messages) {
    if (typeof m.content === 'string') { msgs.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const calls = m.content.filter((x: any) => x.type === 'tool_use').map((x: any) => ({ id: x.id, type: 'function', function: { name: x.name, arguments: JSON.stringify(x.input ?? {}) } }));
      msgs.push({ role: 'assistant', content: text(m.content) || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const x of m.content) if (x.type === 'tool_result') msgs.push({ role: 'tool', tool_call_id: x.tool_use_id, content: text(x.content) || (typeof x.content === 'string' ? x.content : '') });
      const t = text(m.content); if (t) msgs.push({ role: 'user', content: t });
    }
  }
  const tools = (b.tools ?? []).filter((t: any) => t.input_schema).map((t: any) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  return { model: MODEL, messages: msgs, ...(tools.length ? { tools } : {}), max_tokens: Math.min(b.max_tokens ?? 4096, 8192) };
}

function toAnthropic(j: any, model: string) {
  const ch = j.choices?.[0] ?? {}; const m = ch.message ?? {};
  const content: any[] = [];
  if (m.content) content.push({ type: 'text', text: m.content });
  for (const c of m.tool_calls ?? []) { let input = {}; try { input = JSON.parse(c.function.arguments || '{}'); } catch {} content.push({ type: 'tool_use', id: c.id, name: c.function.name, input }); }
  const stop = ch.finish_reason === 'tool_calls' || (m.tool_calls?.length) ? 'tool_use' : ch.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
  return { id: 'msg_' + Date.now(), type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0 } };
}

function sse(res: http.ServerResponse, msg: any) {
  const w = (ev: string, d: any) => res.write(`event: ${ev}\ndata: ${JSON.stringify({ type: ev, ...d })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  w('message_start', { message: { ...msg, content: [], stop_reason: null } });
  msg.content.forEach((b: any, i: number) => {
    if (b.type === 'text') { w('content_block_start', { index: i, content_block: { type: 'text', text: '' } }); w('content_block_delta', { index: i, delta: { type: 'text_delta', text: b.text } }); }
    else { w('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }); w('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }); }
    w('content_block_stop', { index: i });
  });
  w('message_delta', { delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: msg.usage });
  w('message_stop', {}); res.end();
}

http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  if (LOG && body) fs.appendFileSync(LOG, JSON.stringify({ url: req.url, body: JSON.parse(body) }) + '\n');
  if (req.url?.startsWith('/v1/messages/count_tokens')) { res.end(JSON.stringify({ input_tokens: Math.ceil(body.length / 4) })); return; }
  if (!req.url?.startsWith('/v1/messages')) { res.writeHead(404).end('{}'); return; }
  const b = JSON.parse(body);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(URL_ + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...(KEY ? { authorization: 'Bearer ' + KEY } : {}) }, body: JSON.stringify(toChat(b)) });
    const t = await r.text();
    if (r.status === 429 || r.status >= 500) { console.error('upstream', r.status, t.slice(0, 200)); await new Promise(s => setTimeout(s, 5000 * (attempt + 1))); continue; }
    if (r.status !== 200) { console.error('upstream', r.status, t.slice(0, 300)); res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: t.slice(0, 500) } })); return; }
    const msg = toAnthropic(JSON.parse(t), b.model);
    if (b.stream) sse(res, msg); else res.end(JSON.stringify(msg));
    return;
  }
  res.writeHead(529).end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'upstream busy' } }));
}).listen(PORT, '127.0.0.1', () => console.error('shim on', PORT, '->', MODEL));
