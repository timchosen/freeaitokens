// Anthropic Messages <-> internal chat format (what Claude Code speaks).
import { needsOf, type ChatMessage, type ChatRequest, type ContentPart, type ToolCall } from './types.js';
import { sseData } from './sse.js';

const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('\n') : '';

function imagePart(b: any): ContentPart | null {
  const s = b?.source;
  if (s?.type === 'base64') return { type: 'image_url', image_url: { url: `data:${s.media_type};base64,${s.data}` } };
  if (s?.type === 'url') return { type: 'image_url', image_url: { url: s.url } };
  return null;
}

// Plain string when the parts are all text, so text-only models get the simplest shape.
function contentOf(parts: ContentPart[]): string | ContentPart[] {
  return parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts;
}

function toolChoice(tc: any): unknown {
  switch (tc?.type) {
    case 'any': return 'required';
    case 'none': return 'none';
    case 'tool': return { type: 'function', function: { name: tc.name } };
    case 'auto': return 'auto';
    default: return undefined;
  }
}

export function fromAnthropic(body: unknown): ChatRequest {
  const b = (body ?? {}) as any;
  const messages: ChatMessage[] = [];
  const system = textOf(b.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const m of Array.isArray(b.messages) ? b.messages : []) {
    if (typeof m?.content === 'string') { messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }); continue; }
    const blocks: any[] = Array.isArray(m?.content) ? m.content : [];
    if (m.role === 'assistant') {
      const text = blocks.filter((x) => x?.type === 'text').map((x) => x.text).join('\n');
      const calls: ToolCall[] = blocks.filter((x) => x?.type === 'tool_use')
        .map((x) => ({ id: x.id, type: 'function', function: { name: x.name, arguments: JSON.stringify(x.input ?? {}) } }));
      if (!text && !calls.length) continue;
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Tool results must directly follow the assistant turn that asked for them.
    for (const x of blocks.filter((x) => x?.type === 'tool_result')) {
      const t = typeof x.content === 'string' ? x.content : textOf(x.content);
      messages.push({ role: 'tool', tool_call_id: x.tool_use_id, content: x.is_error ? `Error: ${t}` : t });
    }
    const parts: ContentPart[] = [];
    for (const x of blocks) {
      if (x?.type === 'text' && x.text) parts.push({ type: 'text', text: x.text });
      else if (x?.type === 'image') { const p = imagePart(x); if (p) parts.push(p); }
    }
    if (parts.length) messages.push({ role: 'user', content: contentOf(parts) });
  }

  const tools = (Array.isArray(b.tools) ? b.tools : [])
    .filter((t: any) => t?.input_schema && typeof t.name === 'string')
    .map((t: any) => ({ type: 'function', function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.input_schema } }));

  const out: ChatRequest = { messages };
  if (tools.length) { out.tools = tools; const tc = toolChoice(b.tool_choice); if (tc !== undefined) out.tool_choice = tc; }
  if (typeof b.max_tokens === 'number') out.max_tokens = b.max_tokens;
  if (typeof b.temperature === 'number') out.temperature = b.temperature;
  if (typeof b.top_p === 'number') out.top_p = b.top_p;
  if (Array.isArray(b.stop_sequences) && b.stop_sequences.length) out.stop = b.stop_sequences;
  if (b.stream === true) out.stream = true;
  return out;
}

const STOP: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'end_turn' };
const msgId = () => 'msg_' + Math.random().toString(36).slice(2, 14);

function parseArgs(s: string): unknown {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

export function toAnthropic(chat: unknown, requestedModel: string): unknown {
  const j = (chat ?? {}) as any;
  const ch = j.choices?.[0] ?? {};
  const m = ch.message ?? {};
  const content: unknown[] = [];
  if (typeof m.content === 'string' && m.content) content.push({ type: 'text', text: m.content });
  for (const c of m.tool_calls ?? []) content.push({ type: 'tool_use', id: c.id, name: c.function?.name, input: parseArgs(c.function?.arguments) });
  const stop = m.tool_calls?.length ? 'tool_use' : STOP[ch.finish_reason] ?? 'end_turn';
  return {
    id: msgId(), type: 'message', role: 'assistant', model: requestedModel, content,
    stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0 },
  };
}

export function toAnthropicStream(requestedModel: string, body?: unknown): TransformStream<Uint8Array, Uint8Array> {
  const enc = new TextEncoder();
  let started = false, ended = false, index = -1, open: 'text' | 'tool' | null = null, sawTool = false;
  // Estimate until the provider reports usage: Claude Code sizes its context (and compacts) from input_tokens.
  let finish: string | undefined, usage = { input_tokens: body ? countTokens(body).input_tokens : 0, output_tokens: 0 };
  const toolBlock = new Map<number, number>(); // chat tool_call index -> block index

  const translate = new TransformStream<string, Uint8Array>({
    transform(data, ctl) {
      if (ended) return;
      const emit = (type: string, d: object) => ctl.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`));
      const start = () => {
        if (started) return;
        started = true;
        emit('message_start', { message: { id: msgId(), type: 'message', role: 'assistant', model: requestedModel, content: [], stop_reason: null, stop_sequence: null, usage } });
      };
      const close = () => { if (open) emit('content_block_stop', { index }); open = null; };
      const finishUp = () => {
        start(); close();
        emit('message_delta', { delta: { stop_reason: sawTool ? 'tool_use' : STOP[finish ?? 'stop'] ?? 'end_turn', stop_sequence: null }, usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } });
        emit('message_stop', {});
        ended = true;
      };
      if (data === '[DONE]') return finishUp();
      let j: any;
      try { j = JSON.parse(data); } catch { return; }
      if (j.error) {
        start(); close();
        emit('error', { error: { type: 'api_error', message: String(j.error.message ?? 'upstream error') } });
        ended = true;
        return;
      }
      start();
      if (j.usage) usage = { input_tokens: j.usage.prompt_tokens ?? usage.input_tokens, output_tokens: j.usage.completion_tokens ?? 0 };
      const ch = j.choices?.[0];
      if (!ch) return;
      const d = ch.delta ?? {};
      if (typeof d.content === 'string' && d.content) {
        if (open !== 'text') { close(); index++; open = 'text'; emit('content_block_start', { index, content_block: { type: 'text', text: '' } }); }
        emit('content_block_delta', { index, delta: { type: 'text_delta', text: d.content } });
      }
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? 0;
        if (!toolBlock.has(i)) {
          close(); index++; open = 'tool'; sawTool = true;
          toolBlock.set(i, index);
          emit('content_block_start', { index, content_block: { type: 'tool_use', id: tc.id ?? `toolu_${index}`, name: tc.function?.name ?? '', input: {} } });
        }
        const args = tc.function?.arguments;
        if (args) emit('content_block_delta', { index: toolBlock.get(i)!, delta: { type: 'input_json_delta', partial_json: args } });
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    },
  });
  const split = sseData();
  return { writable: split.writable, readable: split.readable.pipeThrough(translate) };
}

export function countTokens(body: unknown): { input_tokens: number } {
  return { input_tokens: needsOf(fromAnthropic(body)).tokens };
}

const ERROR_TYPE: Record<number, string> = { 400: 'invalid_request_error', 401: 'authentication_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error' };
export function anthropicError(status: number, message: string): unknown {
  return { type: 'error', error: { type: ERROR_TYPE[status] ?? 'api_error', message } };
}
