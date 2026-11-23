// Gemini generateContent <-> internal chat format (what Gemini CLI speaks).
import { needsOf, type ChatMessage, type ChatRequest, type ContentPart, type ToolCall } from './types.js';
import { sseData } from './sse.js';

// Gemini schemas may use upper-case types ("OBJECT"); OpenAI-style providers want JSON Schema.
function jsonSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(jsonSchema);
  if (!s || typeof s !== 'object') return s;
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === 'type' && typeof v === 'string' ? v.toLowerCase() : jsonSchema(v)]));
}

const MODE: Record<string, string> = { AUTO: 'auto', ANY: 'required', NONE: 'none' };

export function fromGemini(body: unknown, path = ''): ChatRequest {
  const b = (body ?? {}) as any;
  const messages: ChatMessage[] = [];
  const system = (b.systemInstruction?.parts ?? []).map((p: any) => p?.text ?? '').join('\n');
  if (system) messages.push({ role: 'system', content: system });

  // Gemini pairs results with calls by name (ids are optional), so remember the open calls.
  let open: ToolCall[] = [];
  (Array.isArray(b.contents) ? b.contents : []).forEach((c: any, ci: number) => {
    const parts: any[] = Array.isArray(c?.parts) ? c.parts : [];
    if (c?.role === 'model') {
      const text = parts.filter((p) => typeof p?.text === 'string' && !p.thought).map((p) => p.text).join('');
      open = parts.filter((p) => p?.functionCall).map((p, i) => ({
        id: p.functionCall.id ?? `call_${ci}_${i}`, type: 'function',
        function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
      }));
      if (text || open.length) messages.push({ role: 'assistant', content: text || null, ...(open.length ? { tool_calls: [...open] } : {}) });
      return;
    }
    const content: ContentPart[] = [];
    for (const p of parts) {
      if (p?.functionResponse) {
        const r = p.functionResponse;
        const i = Math.max(0, open.findIndex((t) => (r.id ? t.id === r.id : t.function.name === r.name)));
        const [call] = open.splice(i, 1);
        const text = JSON.stringify(r.response ?? {});
        // A result with no call to answer would be rejected upstream; keep it as plain text instead.
        if (call) messages.push({ role: 'tool', tool_call_id: call.id, content: text });
        else content.push({ type: 'text', text: `Result of ${r.name}: ${text}` });
      } else if (typeof p?.text === 'string' && p.text) content.push({ type: 'text', text: p.text });
      else if (p?.inlineData) content.push({ type: 'image_url', image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } });
      else if (p?.fileData?.fileUri) content.push({ type: 'image_url', image_url: { url: p.fileData.fileUri } });
    }
    if (content.length) messages.push({ role: 'user', content: content.every((p) => p.type === 'text') ? content.map((p) => p.text).join('\n') : content });
  });

  const tools = (Array.isArray(b.tools) ? b.tools : []).flatMap((t: any) => t?.functionDeclarations ?? [])
    .filter((f: any) => typeof f?.name === 'string')
    .map((f: any) => ({ type: 'function', function: { name: f.name, ...(f.description ? { description: f.description } : {}), parameters: jsonSchema(f.parametersJsonSchema ?? f.parameters ?? { type: 'object', properties: {} }) } }));

  const out: ChatRequest = { messages };
  if (tools.length) {
    out.tools = tools;
    const fc = b.toolConfig?.functionCallingConfig;
    const names: string[] = fc?.allowedFunctionNames ?? [];
    if (fc?.mode === 'ANY' && names.length === 1) out.tool_choice = { type: 'function', function: { name: names[0] } };
    else if (MODE[fc?.mode]) out.tool_choice = MODE[fc.mode];
  }
  const g = b.generationConfig ?? {};
  if (typeof g.maxOutputTokens === 'number') out.max_tokens = g.maxOutputTokens;
  if (typeof g.temperature === 'number') out.temperature = g.temperature;
  if (typeof g.topP === 'number') out.top_p = g.topP;
  if (Array.isArray(g.stopSequences) && g.stopSequences.length) out.stop = g.stopSequences;
  if (path.endsWith(':streamGenerateContent')) out.stream = true;
  return out;
}

const FINISH: Record<string, string> = { stop: 'STOP', tool_calls: 'STOP', length: 'MAX_TOKENS', content_filter: 'SAFETY' };
const parseArgs = (s: string) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const usageOf = (u: any) => u && ({ promptTokenCount: u.prompt_tokens ?? 0, candidatesTokenCount: u.completion_tokens ?? 0, totalTokenCount: (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0) });
const candidate = (parts: unknown[], finish?: string) => ({ candidates: [{ content: { role: 'model', parts }, index: 0, ...(finish ? { finishReason: FINISH[finish] ?? 'STOP' } : {}) }] });

export function toGemini(chat: unknown, requestedModel: string): unknown {
  const j = (chat ?? {}) as any;
  const ch = j.choices?.[0] ?? {};
  const m = ch.message ?? {};
  const parts: unknown[] = [];
  if (typeof m.content === 'string' && m.content) parts.push({ text: m.content });
  for (const c of m.tool_calls ?? []) parts.push({ functionCall: { name: c.function?.name, args: parseArgs(c.function?.arguments) } });
  return { ...candidate(parts, ch.finish_reason ?? 'stop'), ...(j.usage ? { usageMetadata: usageOf(j.usage) } : {}), modelVersion: requestedModel };
}

// shortcut: always answers as SSE (alt=sse, what Gemini CLI and the SDKs ask for), not the JSON-array stream.
export function toGeminiStream(requestedModel: string): TransformStream<Uint8Array, Uint8Array> {
  const enc = new TextEncoder();
  const calls = new Map<number, { name: string; args: string }>();
  let finish: string | undefined, usage: unknown, ended = false;
  const send = (ctl: TransformStreamDefaultController<Uint8Array>, o: object) => ctl.enqueue(enc.encode(`data: ${JSON.stringify({ ...o, modelVersion: requestedModel })}\n\n`));
  const translate = new TransformStream<string, Uint8Array>({
    transform(data, ctl) {
      if (ended) return;
      if (data === '[DONE]') {
        // Tool-call arguments arrive in pieces; Gemini sends each call whole, so they go out at the end.
        const parts = [...calls.values()].map((c) => ({ functionCall: { name: c.name, args: parseArgs(c.args) } }));
        send(ctl, { ...candidate(parts, finish ?? 'stop'), ...(usage ? { usageMetadata: usage } : {}) });
        ended = true;
        return;
      }
      let j: any;
      try { j = JSON.parse(data); } catch { return; }
      if (j.error) { send(ctl, { error: { code: 500, message: String(j.error.message ?? 'upstream error'), status: 'INTERNAL' } }); ended = true; return; }
      if (j.usage) usage = usageOf(j.usage);
      const ch = j.choices?.[0];
      if (!ch) return;
      const d = ch.delta ?? {};
      if (typeof d.content === 'string' && d.content) send(ctl, candidate([{ text: d.content }]));
      for (const tc of d.tool_calls ?? []) {
        const c = calls.get(tc.index ?? 0) ?? { name: '', args: '' };
        c.name ||= tc.function?.name ?? '';
        c.args += tc.function?.arguments ?? '';
        calls.set(tc.index ?? 0, c);
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    },
  });
  const split = sseData();
  return { writable: split.writable, readable: split.readable.pipeThrough(translate) };
}

export function geminiCount(body: unknown): unknown {
  const b = (body ?? {}) as any;
  return { totalTokens: needsOf(fromGemini(b.generateContentRequest ?? b)).tokens };
}

const STATUS: Record<number, string> = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 404: 'NOT_FOUND', 413: 'INVALID_ARGUMENT', 429: 'RESOURCE_EXHAUSTED' };
export function geminiError(status: number, message: string): unknown {
  return { error: { code: status, message, status: STATUS[status] ?? 'INTERNAL' } };
}

export const GEMINI_MODEL = {
  name: 'models/free', displayName: 'freeaitokens', inputTokenLimit: 1_000_000, outputTokenLimit: 65_536,
  supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
};
