// Internal chat shape: OpenAI chat-completions. Every inbound format converts to this.

export interface ContentPart { type: string; text?: string; image_url?: { url: string }; [k: string]: unknown }
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ChatRequest {
  messages: ChatMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  [k: string]: unknown;
}
export interface Needs { tokens: number; tools: boolean; images: boolean; conversationId: string }

// FNV-1a, so core stays free of node:crypto.
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

export function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return (content ?? []).map((p) => p.text ?? '').join('');
}

// An image costs roughly this many tokens on most models, whatever its encoded size.
const IMAGE_TOKENS = 1500;
const noImages = (k: string, v: unknown) => (k === 'image_url' ? undefined : v);

export function needsOf(req: ChatRequest): Needs {
  const images = req.messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').length : 0), 0);
  const firstUser = req.messages.find((m) => m.role === 'user');
  return {
    // shortcut: chars/4 token estimate, replace with a real tokenizer if context errors appear
    tokens: Math.ceil(JSON.stringify(req.messages, noImages).length / 4) + images * IMAGE_TOKENS + Math.ceil(JSON.stringify(req.tools ?? []).length / 4),
    tools: (req.tools?.length ?? 0) > 0,
    images: images > 0,
    conversationId: hash(firstUser ? textOf(firstUser.content) : ''),
  };
}

// A request the client must fix; servers answer it with HTTP 400.
export class BadRequest extends Error { readonly status = 400; }
