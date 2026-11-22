import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fromResponses, toResponses, toResponsesStream } from '../src/core/responses.ts';
import { setUpstream, chatJson, chatSse, post, upstreamBodies } from './helpers.ts';

const dir = new URL('./fixtures/responses/', import.meta.url);

test('instructions and developer messages become system messages', () => {
  const c = fromResponses({ model: 'gpt-5', instructions: 'be brief', input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sandbox: on' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ] });
  assert.deepEqual(c.messages, [{ role: 'system', content: 'be brief' }, { role: 'system', content: 'sandbox: on' }, { role: 'user', content: 'hi' }]);
});

test('a plain string input is one user message', () => {
  assert.deepEqual(fromResponses({ model: 'x', input: 'hello' }).messages, [{ role: 'user', content: 'hello' }]);
});

test('function_call and function_call_output round-trip to tool_calls and tool messages', () => {
  const c = fromResponses({ model: 'x', input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run tests' }] },
    { type: 'reasoning', id: 'rs_1', summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Running.' }] },
    { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":["node","--test"]}' },
    { type: 'function_call', call_id: 'call_2', name: 'shell', arguments: '{"command":["ls"]}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'ok 1' },
    { type: 'function_call_output', call_id: 'call_2', output: [{ type: 'input_text', text: 'a.js' }] },
  ] });
  assert.deepEqual(c.messages.slice(1), [
    { role: 'assistant', content: 'Running.', tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":["node","--test"]}' } },
      { id: 'call_2', type: 'function', function: { name: 'shell', arguments: '{"command":["ls"]}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok 1' },
    { role: 'tool', tool_call_id: 'call_2', content: 'a.js' },
  ]);
});

test('flat function tools become nested chat tools; custom tools take one string; others are dropped', () => {
  const c = fromResponses({ model: 'x', input: 'x', tool_choice: 'auto', tools: [
    { type: 'function', name: 'shell', description: 'run', strict: false, parameters: { type: 'object', properties: {} } },
    { type: 'custom', name: 'apply_patch', description: 'patch files', format: { type: 'grammar', syntax: 'lark', definition: '...' } },
    { type: 'web_search' },
    { type: 'local_shell' },
  ] });
  assert.deepEqual(c.tools, [
    { type: 'function', function: { name: 'shell', description: 'run', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'apply_patch', description: 'patch files', parameters: { type: 'object', properties: { input: { type: 'string', description: 'The raw tool input.' } }, required: ['input'] } } },
  ]);
  assert.equal(c.tool_choice, 'auto');
});

test('custom tool calls in history round-trip through the input argument', () => {
  const c = fromResponses({ model: 'x', input: [
    { type: 'custom_tool_call', call_id: 'c9', name: 'apply_patch', input: '*** Begin Patch' },
    { type: 'custom_tool_call_output', call_id: 'c9', output: 'Done' },
  ] });
  assert.deepEqual(c.messages, [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c9', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' } }] },
    { role: 'tool', tool_call_id: 'c9', content: 'Done' },
  ]);
});

test('unknown fields and item types are ignored', () => {
  const c = fromResponses({ model: 'x', reasoning: { effort: 'high' }, store: false, include: ['reasoning.encrypted_content'], prompt_cache_key: 'k', parallel_tool_calls: true, text: { verbosity: 'low' },
    input: [{ type: 'mystery' }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }, { type: 'weird' }] }] });
  assert.deepEqual(c.messages, [{ role: 'user', content: 'hi' }]);
  for (const k of ['reasoning', 'store', 'include', 'prompt_cache_key', 'text']) assert.equal(k in c, false);
});

test('input images become image_url parts', () => {
  const c = fromResponses({ model: 'x', input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA' }, { type: 'input_text', text: 'what' }] }] });
  assert.deepEqual(c.messages[0].content, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }, { type: 'text', text: 'what' }]);
});

test('max_output_tokens and stream carry over', () => {
  const c = fromResponses({ model: 'x', input: 'x', max_output_tokens: 50, stream: true, temperature: 0.1 });
  assert.equal(c.max_tokens, 50);
  assert.equal(c.stream, true);
  assert.equal(c.temperature, 0.1);
});

test('previous_response_id is rejected with 400', () => {
  assert.throws(() => fromResponses({ model: 'x', input: 'x', previous_response_id: 'resp_1' }), (e: any) => e.status === 400 && /previous_response_id/.test(e.message));
});

test('recorded Codex requests convert without throwing', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 2);
  for (const f of files) {
    const body = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    const c = fromResponses(body);
    assert.ok(c.messages.length > 0, f);
    assert.ok(c.tools!.length > 0, f);
  }
});

test('non-streaming response maps text and function calls', () => {
  const r: any = toResponses({ choices: [{ message: { content: 'hi', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 6 } }, 'gpt-5');
  assert.equal(r.object, 'response');
  assert.equal(r.status, 'completed');
  assert.equal(r.model, 'gpt-5');
  assert.equal(r.output[0].type, 'message');
  assert.deepEqual(r.output[0].content[0], { type: 'output_text', text: 'hi', annotations: [] });
  assert.deepEqual({ ...r.output[1], id: undefined }, { id: undefined, type: 'function_call', status: 'completed', call_id: 'c1', name: 'shell', arguments: '{}' });
  assert.deepEqual(r.usage, { input_tokens: 4, output_tokens: 6, total_tokens: 10 });
});

test('a call to a custom tool comes back as a custom_tool_call', () => {
  const body = { model: 'x', input: 'x', tools: [{ type: 'custom', name: 'apply_patch' }] };
  const r: any = toResponses({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' } }] } }] }, 'x', body);
  assert.deepEqual({ ...r.output[0], id: undefined }, { id: undefined, type: 'custom_tool_call', status: 'completed', call_id: 'c1', name: 'apply_patch', input: '*** Begin Patch' });
});

async function events(chunks: object[], body: unknown = { model: 'x', input: 'x' }, done = true) {
  const raw = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
  const text = await new Response(new Response(raw).body!.pipeThrough(toResponsesStream('gpt-5', body))).text();
  return text.trim().split('\n\n').map((e) => { const [ev, data] = e.split('\n'); return { event: ev.slice(7), data: JSON.parse(data.slice(6)) }; });
}

test('text stream produces the Responses event sequence', async () => {
  const ev = await events([{ choices: [{ delta: { content: 'Hel' } }] }, { choices: [{ delta: { content: 'lo' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }]);
  assert.deepEqual(ev.map((e) => e.event), ['response.created', 'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.delta',
    'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed']);
  for (const e of ev) assert.equal(e.data.type, e.event);
  const done = ev.at(-1)!.data.response;
  assert.equal(done.status, 'completed');
  assert.equal(done.output[0].content[0].text, 'Hello');
  assert.deepEqual(done.usage, { input_tokens: 3, output_tokens: 2, total_tokens: 5 });
  assert.equal(ev[5].data.text, 'Hello');
});

test('argument deltas concatenate and the done item carries full arguments', async () => {
  const ev = await events([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'shell', arguments: '{"command":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '["ls"]}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  const deltas = ev.filter((e) => e.event === 'response.function_call_arguments.delta').map((e) => e.data.delta).join('');
  assert.equal(deltas, '{"command":["ls"]}');
  const item = ev.find((e) => e.event === 'response.output_item.done')!.data.item;
  assert.equal(item.type, 'function_call');
  assert.equal(item.call_id, 'call_1');
  assert.equal(item.arguments, '{"command":["ls"]}');
  assert.equal(ev.at(-1)!.data.response.output[0].name, 'shell');
});

test('streamed custom tool call is emitted as a custom_tool_call item', async () => {
  const ev = await events([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'apply_patch', arguments: '{"input":"*** Begin' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' Patch"}' } }] } }] },
  ], { model: 'x', input: 'x', tools: [{ type: 'custom', name: 'apply_patch' }] });
  const item = ev.find((e) => e.event === 'response.output_item.done')!.data.item;
  assert.equal(item.type, 'custom_tool_call');
  assert.equal(item.input, '*** Begin Patch');
  assert.ok(!ev.some((e) => e.event === 'response.function_call_arguments.delta'));
});

test('upstream error chunk becomes response.failed', async () => {
  const ev = await events([{ choices: [{ delta: { content: 'x' } }] }, { error: { message: 'upstream ended' } }], undefined, false);
  const f = ev.at(-1)!;
  assert.equal(f.event, 'response.failed');
  assert.equal(f.data.response.error.message, 'upstream ended');
  assert.ok(!ev.some((e) => e.event === 'response.completed'));
});

// ── through the server ───────────────────────────────────────────────────────

test('server: POST /v1/responses non-streaming', async () => {
  setUpstream(() => chatJson('hello'));
  const r = await post('/v1/responses', { model: 'gpt-5', input: 'hi' });
  const j: any = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.output[0].content[0].text, 'hello');
  assert.equal(upstreamBodies[0].messages[0].content, 'hi');
});

test('server: POST /v1/responses streaming', async () => {
  setUpstream(() => chatSse([{ choices: [{ delta: { content: 'yo' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]));
  const t = await (await post('/v1/responses', { model: 'gpt-5', input: 'hi', stream: true })).text();
  assert.match(t, /event: response.created/);
  assert.match(t, /"delta":"yo"/);
  assert.match(t, /event: response.completed/);
});

test('server: previous_response_id gets a 400', async () => {
  const r = await post('/v1/responses', { model: 'gpt-5', input: 'hi', previous_response_id: 'r1' });
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as any).error.message, /previous_response_id/);
});

test('namespace tool groups from recorded requests are dropped', () => {
  const body = JSON.parse(readFileSync(new URL('codex-tools.json', dir), 'utf8'));
  const names = fromResponses(body).tools!.map((t: any) => t.function.name);
  assert.ok(names.includes('exec_command'));
  assert.ok(!names.some((n: string) => n.startsWith('mcp__')));
});

test('stream reports estimated input tokens when the provider sends none', async () => {
  const body = { model: 'gpt-5', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(4000) }] }] };
  const ev = await events([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }], body);
  const done = ev.find((e) => e.event === 'response.completed')!;
  assert.ok(done.data.response.usage.input_tokens >= 1000, JSON.stringify(done.data.response.usage));
});
