// Web search for the playground, on the person's own keys: Groq's gpt-oss models have a browser search tool, and Gemini
// can ground an answer in Google Search. Tried in that order; each answer comes back with the pages it used.
const httpUrl = (u) => typeof u === 'string' && /^https?:\/\//.test(u) && u.length <= 300;
// at most 4 pages, short titles: they ride in the message's meta, which chats keep small
function pages(list) {
  const seen = new Set(), out = [];
  for (const p of list) {
    if (!httpUrl(p?.url) || seen.has(p.url)) continue;
    seen.add(p.url);
    out.push({ t: String(p.title || new URL(p.url).hostname).slice(0, 60), u: p.url });
    if (out.length === 4) break;
  }
  return out;
}

async function groq(key, model, messages, fetchFn) {
  const r = await fetchFn('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, tools: [{ type: 'browser_search' }], tool_choice: 'required' }), signal: AbortSignal.timeout(90_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 200)}`);
  const msg = JSON.parse(text)?.choices?.[0]?.message ?? {};
  const found = (msg.executed_tools ?? []).flatMap((x) => x?.search_results?.results ?? []);
  // the model marks citations like 【1†L8-L12】 in its text; the pages are listed under the answer instead
  return { text: String(msg.content ?? '').replace(/【[^】]*】/g, ''), model, sources: pages(found) };
}

async function gemini(key, model, messages, fetchFn) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const body = {
    contents: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content) }] })),
    tools: [{ google_search: {} }],
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };
  const r = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 200)}`);
  const c = JSON.parse(text)?.candidates?.[0] ?? {};
  const chunks = c.groundingMetadata?.groundingChunks ?? [];
  return { text: (c.content?.parts ?? []).map((p) => p.text ?? '').join(''), model, sources: pages(chunks.map((x) => ({ url: x.web?.uri, title: x.web?.title }))) };
}

/** Which search providers this person has a key for, in the order they are tried. */
export function searchProviders(catalogue, keys) {
  return ['groq', 'gemini'].map((id) => catalogue.find((p) => p.id === id)).filter((p) => p && keys.get(p.id));
}

/** Answer with a web search. Returns { ok, text, sources, provider, model } or { ok: false, reasons }. */
export async function searchAnswer(catalogue, keys, messages, fetchFn = fetch) {
  const reasons = [];
  for (const p of searchProviders(catalogue, keys)) {
    try {
      const got = p.id === 'groq' ? await groq(keys.get(p.id), p.models.find((m) => /gpt-oss/.test(m.id))?.id ?? 'openai/gpt-oss-120b', messages, fetchFn)
        : await gemini(keys.get(p.id), p.models.find((m) => /gemini/.test(m.id))?.id ?? 'gemini-2.5-flash', messages, fetchFn);
      if (got.text.trim()) return { ok: true, ...got, provider: p.name };
      reasons.push(`${p.name}: empty answer`);
    } catch (e) {
      reasons.push(`${p.name}: ${e.message}`);
    }
  }
  return { ok: false, reasons };
}
