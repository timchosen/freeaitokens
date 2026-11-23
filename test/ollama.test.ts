import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromOllamaChat, fromOllamaGenerate, toOllamaChat, toOllamaChatStream, toOllamaGenerate } from '../src/core/ollama.ts';
import { setUpstream, chatJson, chatSse, post, url, auth, upstreamBodies } from './helpers.ts';

test('fromOllamaChat maps images, tool calls with their results, options, and streams by default', () => {
  const c = fromOllamaChat({
    model: 'free',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Look', images: ['AAA'] },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'weather', arguments: { city: 'Paris' } } }] },
      { role: 'tool', content: '20C', tool_name: 'weather' },
    ],
    tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }],
    options: { temperature: 0.1, num_predict: 50, stop: ['END'] },
  });
  assert.equal(c.stream, true);
  assert.deepEqual(c.messages[1].content, [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }]);
  const call = c.messages[2].tool_calls![0];
  assert.deepEqual(call.function, { name: 'weather', arguments: '{"city":"Paris"}' });
  assert.deepEqual(c.messages[3], { role: 'tool', tool_call_id: call.id, content: '20C' });
  assert.equal(c.tools!.length, 1);
  assert.equal(c.temperature, 0.1);
  assert.equal(c.max_tokens, 50);
  assert.deepEqual(c.stop, ['END']);
  assert.equal(fromOllamaChat({ messages: [], stream: false }).stream, undefined);
});

test('fromOllamaGenerate turns prompt and system into messages', () => {
  const c = fromOllamaGenerate({ prompt: 'Hi', system: 'S', stream: false });
  assert.deepEqual(c.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'Hi' }]);
});

test('toOllamaChat returns the message, tool calls as objects, and token counts', () => {
  const o: any = toOllamaChat({ choices: [{ message: { content: 'ok', tool_calls: [{ id: 'a', function: { name: 'w', arguments: '{"x":1}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 2 } }, 'free');
  assert.deepEqual(o.message, { role: 'assistant', content: 'ok', tool_calls: [{ function: { name: 'w', arguments: { x: 1 } } }] });
  assert.equal(o.done, true);
  assert.equal(o.prompt_eval_count, 4);
  assert.equal(o.eval_count, 2);
  assert.equal((toOllamaGenerate({ choices: [{ message: { content: 'yo' } }] }, 'free') as any).response, 'yo');
});

test('toOllamaChatStream writes one JSON object per line and a final done line', async () => {
  const chunks = [
    { choices: [{ delta: { content: 'He' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'w', arguments: '{"x"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':2}' } }] }, finish_reason: 'tool_calls' }] },
  ];
  const src = new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n').body!;
  const lines = (await new Response(src.pipeThrough(toOllamaChatStream('free'))).text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines[0].message, { role: 'assistant', content: 'He' });
  assert.equal(lines[0].done, false);
  const last = lines.at(-1);
  assert.equal(last.done, true);
  assert.deepEqual(last.message.tool_calls, [{ function: { name: 'w', arguments: { x: 2 } } }]);
});

test('server answers /api/chat as NDJSON and /api/generate without streaming', async () => {
  setUpstream(() => chatSse([{ choices: [{ delta: { content: 'yo' } }] }]));
  const r = await post('/api/chat', { model: 'free', messages: [{ role: 'user', content: 'x' }] });
  assert.match(r.headers.get('content-type')!, /application\/x-ndjson/);
  assert.match(await r.text(), /"content":"yo"/);
  assert.equal(upstreamBodies[0].stream, true);
  setUpstream(() => chatJson('hello'));
  const g: any = await (await post('/api/generate', { model: 'free', prompt: 'x', stream: false })).json();
  assert.equal(g.response, 'hello');
});

test('server lists the model, shows its capabilities and reports a version', async () => {
  const tags: any = await (await fetch(url('/api/tags'), { headers: auth() })).json();
  assert.equal(tags.models[0].name, 'free');
  const show: any = await (await post('/api/show', { model: 'free' })).json();
  assert.ok(show.capabilities.includes('tools'));
  assert.ok(Object.values(show.model_info).some((v) => typeof v === 'number' && v > 0));
  const v: any = await (await fetch(url('/api/version'), { headers: auth() })).json();
  assert.match(v.version, /\d+\.\d+/);
});
