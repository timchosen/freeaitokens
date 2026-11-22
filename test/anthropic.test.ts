import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromAnthropic, toAnthropic, toAnthropicStream, countTokens } from '../src/core/anthropic.ts';
import { setUpstream, chatJson, chatSse, post } from './helpers.ts';

const fixture = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/anthropic/${n}.json`, import.meta.url), 'utf8'));

test('system blocks become one system message', () => {
  const c = fromAnthropic({ model: 'm', max_tokens: 10, system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(c.messages[0], { role: 'system', content: 'a\nb' });
  assert.deepEqual(c.messages[1], { role: 'user', content: 'hi' });
});

test('tool_use and tool_result round-trip to tool_calls and tool messages', () => {
  const c = fromAnthropic({ model: 'm', max_tokens: 10, messages: [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'file.txt' }] }, { type: 'text', text: 'next' }] },
  ] });
  assert.deepEqual(c.messages[1], { role: 'assistant', content: 'ok', tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] });
  assert.deepEqual(c.messages[2], { role: 'tool', tool_call_id: 'tu_1', content: 'file.txt' });
  assert.deepEqual(c.messages[3], { role: 'user', content: 'next' });
});

test('an error tool_result is marked as an error', () => {
  const c = fromAnthropic({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'boom' }] }] });
  assert.deepEqual(c.messages[0], { role: 'tool', tool_call_id: 't', content: 'Error: boom' });
});

test('images become image_url parts', () => {
  const c = fromAnthropic({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }, { type: 'text', text: 'what?' }] }] });
  assert.deepEqual(c.messages[0].content, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }, { type: 'text', text: 'what?' }]);
});

test('tool definitions map input_schema to parameters', () => {
  const c = fromAnthropic({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'Read', description: 'reads', input_schema: { type: 'object' } }], tool_choice: { type: 'any' } });
  assert.deepEqual(c.tools, [{ type: 'function', function: { name: 'Read', description: 'reads', parameters: { type: 'object' } } }]);
  assert.equal(c.tool_choice, 'required');
});

test('unknown fields are ignored', () => {
  const c = fromAnthropic({
    model: 'm', max_tokens: 10, thinking: { type: 'enabled', budget_tokens: 100 }, metadata: { user_id: 'u' }, context_management: {}, output_config: {},
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }, { type: 'mystery' }] }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }, { name: 'Read', input_schema: { type: 'object' } }],
  });
  assert.deepEqual(c.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(c.tools!.length, 1);
  for (const k of ['thinking', 'metadata', 'context_management', 'output_config']) assert.equal(k in c, false);
});

test('sampling fields carry over', () => {
  const c = fromAnthropic({ model: 'm', max_tokens: 99, temperature: 0.2, stop_sequences: ['X'], stream: true, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(c.max_tokens, 99);
  assert.equal(c.temperature, 0.2);
  assert.deepEqual(c.stop, ['X']);
  assert.equal(c.stream, true);
});

test('recorded Claude Code requests convert without throwing', () => {
  for (const n of ['claude-code-plain', 'claude-code-tools']) {
    const c = fromAnthropic(fixture(n));
    assert.ok(c.messages.length > 0, n);
  }
  const t = fromAnthropic(fixture('claude-code-tools'));
  assert.ok(t.tools!.length > 5);
  assert.ok(t.messages.some((m) => m.role === 'tool'));
  assert.ok(t.messages.some((m) => m.tool_calls?.length));
});

test('non-streaming response maps text, tools and stop reason', () => {
  const a: any = toAnthropic({ id: 'x', choices: [{ message: { content: 'hi', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"p":1}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 7 } }, 'claude-x');
  assert.equal(a.type, 'message');
  assert.equal(a.model, 'claude-x');
  assert.deepEqual(a.content, [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'c1', name: 'Read', input: { p: 1 } }]);
  assert.equal(a.stop_reason, 'tool_use');
  assert.deepEqual(a.usage, { input_tokens: 5, output_tokens: 7 });
  assert.equal((toAnthropic({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }, 'm') as any).stop_reason, 'max_tokens');
});

async function events(chunks: object[], done = true) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
  const text = await new Response(new Response(body).body!.pipeThrough(toAnthropicStream('claude-x'))).text();
  return text.trim().split('\n\n').map((e) => { const [ev, data] = e.split('\n'); return { event: ev.slice(7), data: JSON.parse(data.slice(6)) }; });
}

test('text stream produces the Anthropic event sequence', async () => {
  const ev = await events([{ choices: [{ delta: { role: 'assistant', content: 'Hel' } }] }, { choices: [{ delta: { content: 'lo' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
  assert.deepEqual(ev.map((e) => e.event), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(ev[0].data.message.model, 'claude-x');
  assert.deepEqual(ev[2].data.delta, { type: 'text_delta', text: 'Hel' });
  assert.equal(ev[5].data.delta.stop_reason, 'end_turn');
  for (const e of ev) assert.equal(e.data.type, e.event);
});

test('tool-call stream emits input_json_delta pieces that concatenate to the arguments', async () => {
  const ev = await events([
    { choices: [{ delta: { content: 'Let me look.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'path":"a"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);
  const start = ev.find((e) => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use')!;
  assert.deepEqual(start.data.content_block, { type: 'tool_use', id: 'call_1', name: 'Read', input: {} });
  assert.equal(start.data.index, 1);
  const json = ev.filter((e) => e.data.delta?.type === 'input_json_delta').map((e) => e.data.delta.partial_json).join('');
  assert.deepEqual(JSON.parse(json), { file_path: 'a' });
  assert.equal(ev.filter((e) => e.event === 'content_block_stop').length, 2);
  assert.equal(ev.find((e) => e.event === 'message_delta')!.data.delta.stop_reason, 'tool_use');
});

test('two tool calls become two tool_use blocks', async () => {
  const ev = await events([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'Read', arguments: '{}' } }, { index: 1, id: 'b', function: { name: 'Bash', arguments: '{}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  assert.deepEqual(ev.filter((e) => e.event === 'content_block_start').map((e) => e.data.content_block.id), ['a', 'b']);
});

test('upstream error chunk becomes an error event', async () => {
  const ev = await events([{ choices: [{ delta: { content: 'x' } }] }, { error: { message: 'upstream ended' } }], false);
  const err = ev.find((e) => e.event === 'error')!;
  assert.equal(err.data.error.message, 'upstream ended');
  assert.ok(!ev.some((e) => e.event === 'message_stop'));
});

test('countTokens returns a positive estimate', () => {
  assert.ok(countTokens({ model: 'm', messages: [{ role: 'user', content: 'hello there' }] }).input_tokens > 0);
});

// ── through the server ───────────────────────────────────────────────────────

test('server: POST /v1/messages non-streaming', async () => {
  setUpstream(() => chatJson('hello'));
  const r = await post('/v1/messages?beta=true', { model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
  const j: any = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.model, 'claude-sonnet-5-5');
  assert.deepEqual(j.content, [{ type: 'text', text: 'hello' }]);
});

test('server: POST /v1/messages streaming', async () => {
  setUpstream(() => chatSse([{ choices: [{ delta: { content: 'yo' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]));
  const r = await post('/v1/messages', { model: 'claude-x', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hi' }] });
  const t = await r.text();
  assert.match(t, /event: message_start/);
  assert.match(t, /"text":"yo"/);
  assert.match(t, /event: message_stop/);
});

test('server: count_tokens', async () => {
  const r = await post('/v1/messages/count_tokens', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(((await r.json()) as any).input_tokens > 0);
});

test('server: errors come back in Anthropic shape', async () => {
  const r = await post('/v1/messages', { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }, { 'content-type': 'application/json' });
  assert.equal(r.status, 401);
  const j: any = await r.json();
  assert.equal(j.type, 'error');
  assert.equal(j.error.type, 'authentication_error');
});
