import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromGemini, toGemini, toGeminiStream, geminiCount } from '../src/core/gemini.ts';
import { setUpstream, chatJson, chatSse, post, url, auth, token, upstreamBodies } from './helpers.ts';

const conversation = {
  systemInstruction: { parts: [{ text: 'Be brief.' }] },
  contents: [
    { role: 'user', parts: [{ text: 'Weather in Paris?' }, { inlineData: { mimeType: 'image/png', data: 'AAA' } }] },
    { role: 'model', parts: [{ text: 'Checking.' }, { functionCall: { name: 'weather', args: { city: 'Paris' } } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'weather', response: { temp: 20 } } }] },
  ],
  tools: [{ functionDeclarations: [{ name: 'weather', description: 'w', parameters: { type: 'OBJECT', properties: { city: { type: 'STRING' } } } }] }],
  toolConfig: { functionCallingConfig: { mode: 'ANY' } },
  generationConfig: { maxOutputTokens: 100, temperature: 0.2, stopSequences: ['END'] },
};

test('fromGemini maps system, images, tool calls and their results, tools and settings', () => {
  const c = fromGemini(conversation, '/v1beta/models/free:generateContent');
  assert.deepEqual(c.messages[0], { role: 'system', content: 'Be brief.' });
  assert.deepEqual(c.messages[1], { role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] });
  const call = c.messages[2].tool_calls![0];
  assert.equal(c.messages[2].content, 'Checking.');
  assert.deepEqual(call.function, { name: 'weather', arguments: '{"city":"Paris"}' });
  assert.deepEqual(c.messages[3], { role: 'tool', tool_call_id: call.id, content: '{"temp":20}' });
  assert.deepEqual(c.tools, [{ type: 'function', function: { name: 'weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }]);
  assert.equal(c.tool_choice, 'required');
  assert.equal(c.max_tokens, 100);
  assert.equal(c.temperature, 0.2);
  assert.deepEqual(c.stop, ['END']);
  assert.equal(c.stream, undefined);
  assert.equal(fromGemini(conversation, '/v1beta/models/free:streamGenerateContent').stream, true);
});

test('toGemini returns text and function calls as parts with usage', () => {
  const g: any = toGemini({ choices: [{ message: { content: 'Hi', tool_calls: [{ id: 'a', function: { name: 'weather', arguments: '{"city":"Rome"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }, 'free');
  assert.deepEqual(g.candidates[0].content, { role: 'model', parts: [{ text: 'Hi' }, { functionCall: { name: 'weather', args: { city: 'Rome' } } }] });
  assert.equal(g.candidates[0].finishReason, 'STOP');
  assert.deepEqual(g.usageMetadata, { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 });
});

test('toGeminiStream sends text as it comes and a tool call once complete', async () => {
  const chunks = [
    { choices: [{ delta: { content: 'He' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'weather', arguments: '{"ci' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Oslo"}' } }] }, finish_reason: 'tool_calls' }] },
  ];
  const src = new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n').body!;
  const out = await new Response(src.pipeThrough(toGeminiStream('free'))).text();
  const events = out.trim().split('\n\n').map((e) => JSON.parse(e.replace(/^data: /, '')));
  assert.deepEqual(events[0].candidates[0].content.parts, [{ text: 'He' }]);
  const last = events.at(-1);
  assert.deepEqual(last.candidates[0].content.parts, [{ functionCall: { name: 'weather', args: { city: 'Oslo' } } }]);
  assert.equal(last.candidates[0].finishReason, 'STOP');
});

test('geminiCount estimates tokens', () => {
  assert.ok((geminiCount(conversation) as any).totalTokens > 0);
});

test('server answers generateContent with the Gemini key header and the key query', async () => {
  setUpstream(() => chatJson('hello'));
  const body = { contents: [{ role: 'user', parts: [{ text: 'x' }] }] };
  const r = await post('/v1beta/models/free:generateContent', body, { 'x-goog-api-key': token, 'content-type': 'application/json' });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as any).candidates[0].content.parts[0].text, 'hello');
  assert.equal((await post(`/v1beta/models/gemini-2.5-pro:generateContent?key=${token}`, body, { 'content-type': 'application/json' })).status, 200);
  assert.equal((await post('/v1beta/models/free:generateContent', body, { 'x-goog-api-key': 'wrong' })).status, 401);
});

test('server streams streamGenerateContent as SSE', async () => {
  setUpstream(() => chatSse([{ choices: [{ delta: { content: 'yo' } }] }]));
  const r = await post('/v1beta/models/free:streamGenerateContent?alt=sse', { contents: [{ role: 'user', parts: [{ text: 'x' }] }] }, { 'x-goog-api-key': token });
  assert.match(r.headers.get('content-type')!, /text\/event-stream/);
  assert.match(await r.text(), /"text":"yo"/);
  assert.equal(upstreamBodies[0].stream, true);
});

test('server answers countTokens and lists the model', async () => {
  const c: any = await (await post('/v1beta/models/free:countTokens', { contents: [{ role: 'user', parts: [{ text: 'hello there' }] }] }, { 'x-goog-api-key': token })).json();
  assert.ok(c.totalTokens > 0);
  const m: any = await (await fetch(url('/v1beta/models'), { headers: { 'x-goog-api-key': token } })).json();
  assert.equal(m.models[0].name, 'models/free');
  assert.equal((await fetch(url('/v1beta/models'), { headers: auth() })).status, 200);
});
