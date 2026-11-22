// Splits a server-sent-events byte stream into the payloads of its `data:` lines ("[DONE]" included).
export function sseData(): TransformStream<Uint8Array, string> {
  const dec = new TextDecoder();
  let buf = '';
  const emit = (line: string, ctl: TransformStreamDefaultController<string>) => {
    if (line.startsWith('data:')) ctl.enqueue(line.slice(5).trim());
  };
  return new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop()!;
      for (const l of lines) emit(l, ctl);
    },
    flush(ctl) { if (buf) emit(buf, ctl); },
  });
}

// Maps each JSON data payload through `fn` and re-encodes as chat-format SSE.
export function mapChatSse(fn: (chunk: any) => any): TransformStream<string, Uint8Array> {
  const enc = new TextEncoder();
  return new TransformStream({
    transform(data, ctl) {
      if (data === '[DONE]') { ctl.enqueue(enc.encode('data: [DONE]\n\n')); return; }
      let j: unknown;
      try { j = JSON.parse(data); } catch { return; }
      ctl.enqueue(enc.encode(`data: ${JSON.stringify(fn(j))}\n\n`));
    },
  });
}
