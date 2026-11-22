// OpenAI Responses <-> internal chat format (what Codex speaks). Stateless only.
import { BadRequest, needsOf, type ChatMessage, type ChatRequest, type ContentPart, type ToolCall } from './types.js';
import { sseData } from './sse.js';

const CUSTOM_PARAMS = { type: 'object', properties: { input: { type: 'string', description: 'The raw tool input.' } }, required: ['input'] };

const textOfParts = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('') : '';

function partsOf(content: unknown): string | ContentPart[] {
  if (typeof content === 'string') return content;
  const parts: ContentPart[] = [];
  for (const p of Array.isArray(content) ? content : []) {
    if ((p?.type === 'input_text' || p?.type === 'output_text' || p?.type === 'text') && typeof p.text === 'string') parts.push({ type: 'text', text: p.text });
    else if (p?.type === 'input_image' && (p.image_url || p.url)) parts.push({ type: 'image_url', image_url: { url: p.image_url ?? p.url } });
  }
  return parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('') : parts;
}

function customToolNames(body: any): Set<string> {
  return new Set((Array.isArray(body?.tools) ? body.tools : []).filter((t: any) => t?.type === 'custom').map((t: any) => t.name));
}

export function fromResponses(body: unknown): ChatRequest {
  const b = (body ?? {}) as any;
  if (b.previous_response_id) throw new BadRequest('previous_response_id is not supported: send the whole conversation in "input" (store: false).');
  const messages: ChatMessage[] = [];
  if (typeof b.instructions === 'string' && b.instructions) messages.push({ role: 'system', content: b.instructions });

  // Consecutive calls join one assistant turn; their outputs follow as tool messages.
  let pending: ChatMessage | null = null;
  const assistant = (): ChatMessage => {
    const last = messages.at(-1);
    if (last?.role === 'assistant' && last === pending) return last;
    pending = { role: 'assistant', content: null };
    messages.push(pending);
    return pending;
  };
  const addCall = (call: ToolCall) => { const a = assistant(); (a.tool_calls ??= []).push(call); };

  const input = typeof b.input === 'string' ? [{ type: 'message', role: 'user', content: b.input }] : Array.isArray(b.input) ? b.input : [];
  for (const it of input) {
    const type = it?.type ?? (it?.role ? 'message' : undefined);
    if (type === 'message') {
      const content = partsOf(it.content);
      if (content === '' || (Array.isArray(content) && !content.length)) continue;
      if (it.role === 'assistant') {
        const a = assistant();
        a.content = typeof content === 'string' ? content : textOfParts(content);
      } else {
        messages.push({ role: it.role === 'developer' || it.role === 'system' ? 'system' : 'user', content });
      }
    } else if (type === 'function_call') {
      addCall({ id: it.call_id, type: 'function', function: { name: it.name, arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments ?? {}) } });
    } else if (type === 'custom_tool_call') {
      addCall({ id: it.call_id, type: 'function', function: { name: it.name, arguments: JSON.stringify({ input: it.input ?? '' }) } });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      messages.push({ role: 'tool', tool_call_id: it.call_id, content: typeof it.output === 'string' ? it.output : textOfParts(it.output) });
    }
  }

  const tools = (Array.isArray(b.tools) ? b.tools : []).flatMap((t: any) => {
    const desc = t?.description ? { description: t.description } : {};
    if (t?.type === 'function' && t.name) return [{ type: 'function', function: { name: t.name, ...desc, parameters: t.parameters ?? { type: 'object', properties: {} } } }];
    if (t?.type === 'custom' && t.name) return [{ type: 'function', function: { name: t.name, ...desc, parameters: CUSTOM_PARAMS } }];
    return [];
  });

  const out: ChatRequest = { messages };
  if (tools.length) {
    out.tools = tools;
    if (typeof b.tool_choice === 'string') out.tool_choice = b.tool_choice;
    else if (b.tool_choice?.name) out.tool_choice = { type: 'function', function: { name: b.tool_choice.name } };
  }
  if (typeof b.max_output_tokens === 'number') out.max_tokens = b.max_output_tokens;
  if (typeof b.temperature === 'number') out.temperature = b.temperature;
  if (typeof b.top_p === 'number') out.top_p = b.top_p;
  if (b.stream === true) out.stream = true;
  return out;
}

const rid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 14)}`;
const usageOf = (u: any) => {
  const i = u?.prompt_tokens ?? 0, o = u?.completion_tokens ?? 0;
  return { input_tokens: i, output_tokens: o, total_tokens: i + o };
};

function callItem(id: string, callId: string, name: string, args: string, custom: Set<string>): any {
  if (!custom.has(name)) return { id, type: 'function_call', status: 'completed', call_id: callId, name, arguments: args };
  let input = args;
  try { const j = JSON.parse(args); if (typeof j?.input === 'string') input = j.input; } catch { /* keep raw */ }
  return { id, type: 'custom_tool_call', status: 'completed', call_id: callId, name, input };
}

const messageItem = (id: string, text: string) =>
  ({ id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });

export function toResponses(chat: unknown, requestedModel: string, body?: unknown): unknown {
  const j = (chat ?? {}) as any;
  const m = j.choices?.[0]?.message ?? {};
  const custom = customToolNames(body);
  const output: any[] = [];
  if (typeof m.content === 'string' && m.content) output.push(messageItem(rid('msg'), m.content));
  for (const c of m.tool_calls ?? []) output.push(callItem(rid('fc'), c.id, c.function?.name, c.function?.arguments ?? '{}', custom));
  return { id: rid('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: requestedModel, output, usage: usageOf(j.usage) };
}

// Until the provider reports usage, Codex gets an estimate to size its context by.
function estimate(body: unknown): number {
  try { return needsOf(fromResponses(body)).tokens; } catch { return 0; }
}

export function toResponsesStream(requestedModel: string, body?: unknown): TransformStream<Uint8Array, Uint8Array> {
  const enc = new TextEncoder();
  const custom = customToolNames(body);
  const id = rid('resp');
  const created = Math.floor(Date.now() / 1000);
  let seq = 0, started = false, ended = false, usage = usageOf({ prompt_tokens: estimate(body) });
  const output: any[] = [];
  let text: { idx: number; id: string; text: string } | null = null;
  const calls = new Map<number, { idx: number; id: string; callId: string; name: string; args: string; open: boolean }>();
  const base = (status: string) => ({ id, object: 'response', created_at: created, status, model: requestedModel });

  const translate = new TransformStream<string, Uint8Array>({
    transform(data, ctl) {
      if (ended) return;
      const emit = (type: string, d: object) => ctl.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...d })}\n\n`));
      const start = () => { if (!started) { started = true; emit('response.created', { response: { ...base('in_progress'), output: [] } }); } };
      const closeText = () => {
        if (!text) return;
        const item = messageItem(text.id, text.text);
        emit('response.output_text.done', { item_id: text.id, output_index: text.idx, content_index: 0, text: text.text });
        emit('response.content_part.done', { item_id: text.id, output_index: text.idx, content_index: 0, part: item.content[0] });
        emit('response.output_item.done', { output_index: text.idx, item });
        output[text.idx] = item;
        text = null;
      };
      const closeCalls = () => {
        for (const c of calls.values()) {
          if (!c.open) continue;
          c.open = false;
          const item = callItem(c.id, c.callId, c.name, c.args, custom);
          if (item.type === 'function_call') emit('response.function_call_arguments.done', { item_id: c.id, output_index: c.idx, arguments: c.args });
          emit('response.output_item.done', { output_index: c.idx, item });
          output[c.idx] = item;
        }
      };
      if (data === '[DONE]') {
        start(); closeText(); closeCalls();
        emit('response.completed', { response: { ...base('completed'), output, usage } });
        ended = true;
        return;
      }
      let j: any;
      try { j = JSON.parse(data); } catch { return; }
      start();
      if (j.error) {
        emit('response.failed', { response: { ...base('failed'), output, error: { code: 'server_error', message: String(j.error.message ?? 'upstream error') } } });
        ended = true;
        return;
      }
      if (j.usage) usage = usageOf(j.usage);
      const d = j.choices?.[0]?.delta ?? {};
      if (typeof d.content === 'string' && d.content) {
        if (!text) {
          closeCalls();
          text = { idx: output.length, id: rid('msg'), text: '' };
          output.push(null);
          emit('response.output_item.added', { output_index: text.idx, item: { id: text.id, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
          emit('response.content_part.added', { item_id: text.id, output_index: text.idx, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        }
        text.text += d.content;
        emit('response.output_text.delta', { item_id: text.id, output_index: text.idx, content_index: 0, delta: d.content });
      }
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? 0;
        let c = calls.get(i);
        if (!c) {
          closeText();
          c = { idx: output.length, id: rid('fc'), callId: tc.id ?? rid('call'), name: tc.function?.name ?? '', args: '', open: true };
          output.push(null);
          calls.set(i, c);
          const isCustom = custom.has(c.name);
          emit('response.output_item.added', { output_index: c.idx, item: isCustom
            ? { id: c.id, type: 'custom_tool_call', status: 'in_progress', call_id: c.callId, name: c.name, input: '' }
            : { id: c.id, type: 'function_call', status: 'in_progress', call_id: c.callId, name: c.name, arguments: '' } });
        }
        const a = tc.function?.arguments;
        if (a) {
          c.args += a;
          if (!custom.has(c.name)) emit('response.function_call_arguments.delta', { item_id: c.id, output_index: c.idx, delta: a });
        }
      }
    },
  });
  const split = sseData();
  return { writable: split.writable, readable: split.readable.pipeThrough(translate) };
}

export function responsesError(_status: number, message: string): unknown {
  return { error: { message, type: 'freeaitokens_error' } };
}
