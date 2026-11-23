// Ollama /api/chat and /api/generate <-> internal chat format (what Zed, JetBrains and other local-model clients speak).
import type { ChatMessage, ChatRequest, ContentPart, ToolCall } from './types.js';
import { sseData } from './sse.js';

function options(b: any, out: ChatRequest): ChatRequest {
  const o = b.options ?? {};
  if (typeof o.temperature === 'number') out.temperature = o.temperature;
  if (typeof o.top_p === 'number') out.top_p = o.top_p;
  if (typeof o.num_predict === 'number' && o.num_predict > 0) out.max_tokens = o.num_predict;
  if (Array.isArray(o.stop) && o.stop.length) out.stop = o.stop;
  if (b.format === 'json') out.response_format = { type: 'json_object' };
  else if (b.format && typeof b.format === 'object') out.response_format = { type: 'json_schema', json_schema: { name: 'output', schema: b.format } };
  if (b.stream !== false) out.stream = true; // Ollama streams unless told not to
  return out;
}

// Ollama images are bare base64; the mime type is not sent, and providers accept png for any common format.
const withImages = (text: string, images: unknown): string | ContentPart[] =>
  Array.isArray(images) && images.length
    ? [...(text ? [{ type: 'text', text }] : []), ...images.map((d) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${d}` } }))]
    : text;

export function fromOllamaChat(body: unknown): ChatRequest {
  const b = (body ?? {}) as any;
  const messages: ChatMessage[] = [];
  let open: ToolCall[] = [];
  (Array.isArray(b.messages) ? b.messages : []).forEach((m: any, mi: number) => {
    const text = typeof m?.content === 'string' ? m.content : '';
    if (m?.role === 'assistant') {
      open = (m.tool_calls ?? []).map((t: any, i: number) => ({
        id: t.id ?? `call_${mi}_${i}`, type: 'function',
        function: { name: t.function?.name, arguments: typeof t.function?.arguments === 'string' ? t.function.arguments : JSON.stringify(t.function?.arguments ?? {}) },
      }));
      if (text || open.length) messages.push({ role: 'assistant', content: text || null, ...(open.length ? { tool_calls: [...open] } : {}) });
    } else if (m?.role === 'tool') {
      // Ollama results carry a tool name at most; pair each with the matching open call.
      const i = Math.max(0, open.findIndex((t) => t.function.name === m.tool_name));
      const [call] = open.splice(i, 1);
      messages.push(call ? { role: 'tool', tool_call_id: call.id, content: text } : { role: 'user', content: `Tool result: ${text}` });
    } else {
      messages.push({ role: m?.role === 'system' ? 'system' : 'user', content: withImages(text, m?.images) });
    }
  });
  const out: ChatRequest = { messages };
  if (Array.isArray(b.tools) && b.tools.length) out.tools = b.tools;
  return options(b, out);
}

export function fromOllamaGenerate(body: unknown): ChatRequest {
  const b = (body ?? {}) as any;
  const messages: ChatMessage[] = [];
  if (typeof b.system === 'string' && b.system) messages.push({ role: 'system', content: b.system });
  messages.push({ role: 'user', content: withImages(typeof b.prompt === 'string' ? b.prompt : '', b.images) });
  return options(b, { messages });
}

const parseArgs = (s: string) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const DONE: Record<string, string> = { length: 'length' };
const counts = (u: any) => ({ prompt_eval_count: u?.prompt_tokens ?? 0, eval_count: u?.completion_tokens ?? 0 });
const base = (model: string) => ({ model, created_at: new Date().toISOString() });

export function toOllamaChat(chat: unknown, requestedModel: string): unknown {
  const j = (chat ?? {}) as any;
  const ch = j.choices?.[0] ?? {};
  const m = ch.message ?? {};
  const calls = (m.tool_calls ?? []).map((c: any) => ({ function: { name: c.function?.name, arguments: parseArgs(c.function?.arguments) } }));
  return {
    ...base(requestedModel),
    message: { role: 'assistant', content: m.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) },
    done: true, done_reason: DONE[ch.finish_reason] ?? 'stop', ...counts(j.usage),
  };
}

export function toOllamaGenerate(chat: unknown, requestedModel: string): unknown {
  const { message, ...rest } = toOllamaChat(chat, requestedModel) as any;
  return { ...rest, response: message.content };
}

function ndjson(requestedModel: string, kind: 'chat' | 'generate'): TransformStream<Uint8Array, Uint8Array> {
  const enc = new TextEncoder();
  const calls = new Map<number, { name: string; args: string }>();
  let finish: string | undefined, usage: unknown, ended = false;
  const line = (ctl: TransformStreamDefaultController<Uint8Array>, o: object) => ctl.enqueue(enc.encode(JSON.stringify({ ...base(requestedModel), ...o }) + '\n'));
  const piece = (text: string, extra: object = {}) => (kind === 'chat' ? { message: { role: 'assistant', content: text, ...extra } } : { response: text });
  const translate = new TransformStream<string, Uint8Array>({
    transform(data, ctl) {
      if (ended) return;
      if (data === '[DONE]') {
        const tc = [...calls.values()].map((c) => ({ function: { name: c.name, arguments: parseArgs(c.args) } }));
        line(ctl, { ...piece('', tc.length ? { tool_calls: tc } : {}), done: true, done_reason: DONE[finish ?? ''] ?? 'stop', ...counts(usage) });
        ended = true;
        return;
      }
      let j: any;
      try { j = JSON.parse(data); } catch { return; }
      if (j.error) { line(ctl, { error: String(j.error.message ?? 'upstream error'), done: true }); ended = true; return; }
      if (j.usage) usage = j.usage;
      const ch = j.choices?.[0];
      if (!ch) return;
      const d = ch.delta ?? {};
      if (typeof d.content === 'string' && d.content) line(ctl, { ...piece(d.content), done: false });
      for (const t of d.tool_calls ?? []) {
        const c = calls.get(t.index ?? 0) ?? { name: '', args: '' };
        c.name ||= t.function?.name ?? '';
        c.args += t.function?.arguments ?? '';
        calls.set(t.index ?? 0, c);
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    },
  });
  const split = sseData();
  return { writable: split.writable, readable: split.readable.pipeThrough(translate) };
}

export const toOllamaChatStream = (m: string) => ndjson(m, 'chat');
export const toOllamaGenerateStream = (m: string) => ndjson(m, 'generate');
export const ollamaError = (_s: number, message: string) => ({ error: message });

// What clients read to size context and decide which features to offer.
export const OLLAMA_CONTEXT = 131072;
export const OLLAMA_TAGS = { models: [{ name: 'free', model: 'free', modified_at: '2026-01-01T00:00:00Z', size: 0, digest: 'freeaitokens', details: { format: 'gguf', family: 'freeaitokens', parameter_size: '', quantization_level: '' } }] };
export const ollamaShow = () => ({
  modelfile: '', parameters: '', template: '{{ .Prompt }}',
  details: OLLAMA_TAGS.models[0].details,
  model_info: { 'general.architecture': 'freeaitokens', 'freeaitokens.context_length': OLLAMA_CONTEXT },
  capabilities: ['completion', 'tools', 'vision'],
});
