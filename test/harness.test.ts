import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchSpec, setupFile, undoSetup, manualSetup } from '../src/node/harness.ts';

const TOKEN = 'ft-' + '0'.repeat(32);
const tmp = () => join(mkdtempSync(join(tmpdir(), 'ft-h-')), 'opencode.json');

test('claude spec sets both env vars and passes args through', () => {
  const s = launchSpec('claude', 4949, TOKEN, ['-p', 'hello']);
  assert.equal(s.cmd, 'claude');
  assert.deepEqual(s.args, ['-p', 'hello']);
  assert.equal(s.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4949');
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, TOKEN);
  assert.equal(s.env.ANTHROPIC_API_KEY, '');
});

test('codex spec selects the freeaitokens provider and keeps the token out of args', () => {
  const s = launchSpec('codex', 5000, TOKEN, ['exec', 'fix it']);
  assert.equal(s.cmd, 'codex');
  assert.deepEqual(s.args.slice(-2), ['exec', 'fix it']);
  const joined = s.args.join(' ');
  assert.match(joined, /model_providers\.freeaitokens\.base_url="http:\/\/127\.0\.0\.1:5000\/v1"/);
  assert.match(joined, /model_providers\.freeaitokens\.wire_api="responses"/);
  assert.match(joined, /model_providers\.freeaitokens\.env_key="FREEAITOKENS_TOKEN"/);
  assert.match(joined, /model_provider="freeaitokens"/);
  assert.ok(!joined.includes(TOKEN));
  assert.equal(s.env.FREEAITOKENS_TOKEN, TOKEN);
});

test('opencode setup adds the provider and preserves existing providers and default model', () => {
  const f = tmp();
  writeFileSync(f, JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'anthropic/claude', provider: { mine: { name: 'Mine' } }, theme: 'dark' }));
  setupFile('opencode', 4949, TOKEN, f);
  const j = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(j.model, 'anthropic/claude');
  assert.equal(j.theme, 'dark');
  assert.deepEqual(j.provider.mine, { name: 'Mine' });
  assert.equal(j.provider.freeaitokens.npm, '@ai-sdk/openai-compatible');
  assert.equal(j.provider.freeaitokens.options.baseURL, 'http://127.0.0.1:4949/v1');
  assert.equal(j.provider.freeaitokens.options.apiKey, TOKEN);
  assert.ok(j.provider.freeaitokens.models.free);
});

test('opencode setup writes a backup, undo restores it byte for byte', () => {
  const f = tmp();
  const original = '{\n  "model": "x",   "theme": "dark"\n}\n';
  writeFileSync(f, original);
  const { backup } = setupFile('opencode', 4949, TOKEN, f);
  assert.equal(readFileSync(backup, 'utf8'), original);
  undoSetup('opencode', f);
  assert.equal(readFileSync(f, 'utf8'), original);
  assert.equal(existsSync(backup), false);
});

test('setup aborts on invalid JSON and leaves the file unchanged', () => {
  const f = tmp();
  const bad = '{ "model": "x", // comment\n }';
  writeFileSync(f, bad);
  assert.throws(() => setupFile('opencode', 4949, TOKEN, f), /not valid JSON/);
  assert.equal(readFileSync(f, 'utf8'), bad);
  assert.equal(existsSync(f + '.freeaitokens-backup'), false);
});

test('setup creates the config when none exists; undo removes it', () => {
  const f = tmp();
  setupFile('opencode', 4949, TOKEN, f);
  assert.ok(JSON.parse(readFileSync(f, 'utf8')).provider.freeaitokens);
  undoSetup('opencode', f);
  assert.equal(existsSync(f), false);
});

test('running setup twice does not overwrite the original backup', () => {
  const f = tmp();
  writeFileSync(f, '{"model":"orig"}');
  setupFile('opencode', 4949, TOKEN, f);
  setupFile('opencode', 5000, TOKEN, f);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).provider.freeaitokens.options.baseURL, 'http://127.0.0.1:5000/v1');
  undoSetup('opencode', f);
  assert.equal(readFileSync(f, 'utf8'), '{"model":"orig"}');
});

test('undo without a backup says so', () => {
  assert.throws(() => undoSetup('opencode', tmp()), /Nothing to undo/);
});

test('gemini spec points Gemini CLI at the root with the token and a settings file that picks API-key auth', () => {
  const s = launchSpec('gemini', 4949, TOKEN, ['-p', 'hi'], '/state');
  assert.equal(s.cmd, 'gemini');
  assert.deepEqual(s.args, ['-p', 'hi']);
  assert.equal(s.env.GOOGLE_GEMINI_BASE_URL, 'http://127.0.0.1:4949');
  assert.equal(s.env.GEMINI_API_KEY, TOKEN);
  assert.equal(s.env.GEMINI_MODEL, 'free');
  const file = s.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  assert.equal(file, join('/state', 'gemini-system-settings.json'));
  assert.equal(JSON.parse(s.files![file]).security.auth.selectedType, 'gemini-api-key');
});

test('goose, qwen, aider and kilo launchers keep the token in env, never in args', () => {
  const goose = launchSpec('goose', 4949, TOKEN, []);
  assert.deepEqual([goose.cmd, goose.args[0]], ['goose', 'session']);
  assert.equal(goose.env.OPENAI_HOST, 'http://127.0.0.1:4949');
  assert.equal(goose.env.OPENAI_BASE_PATH, 'v1/chat/completions');
  assert.equal(goose.env.GOOSE_PROVIDER, 'openai');
  const qwen = launchSpec('qwen', 4949, TOKEN, ['x']);
  assert.deepEqual(qwen.args, ['--auth-type', 'openai', '--openai-base-url', 'http://127.0.0.1:4949/v1', '-m', 'free', 'x']);
  const aider = launchSpec('aider', 4949, TOKEN, []);
  assert.equal(aider.env.OPENAI_API_BASE, 'http://127.0.0.1:4949/v1');
  assert.ok(aider.args.includes('openai/free'));
  {
    const s = launchSpec('kilo', 4949, TOKEN, []);
    const conf = JSON.parse(s.env.KILO_CONFIG_CONTENT);
    assert.equal(conf.model, 'freeaitokens/free');
    assert.equal(conf.provider.freeaitokens.options.baseURL, 'http://127.0.0.1:4949/v1');
    assert.equal(conf.provider.freeaitokens.options.apiKey, '{env:FREEAITOKENS_TOKEN}');
    assert.equal(s.env.FREEAITOKENS_TOKEN, TOKEN);
  }
  for (const s of [goose, qwen, aider]) { assert.ok(!s.args.join(' ').includes(TOKEN)); assert.ok(Object.values(s.env).includes(TOKEN)); }
});

test('manual setup gives Zed, JetBrains and VS Code their own steps, and explains Cursor', () => {
  assert.match(manualSetup('zed', 4949, TOKEN), /openai_compatible[\s\S]*http:\/\/127\.0\.0\.1:4949\/v1/);
  assert.match(manualSetup('jetbrains', 4949, TOKEN), /Providers & API keys/);
  assert.match(manualSetup('vscode', 4949, TOKEN), /Custom Endpoint/);
  assert.match(manualSetup('cursor', 4949, TOKEN), /Cursor's servers/);
  assert.match(manualSetup('cline', 4949, TOKEN), new RegExp(TOKEN));
});

test('claude spec names the model, so Claude Code does not show a paid Claude model that is not answering', () => {
  const s = launchSpec('claude', 4949, TOKEN, []);
  assert.equal(s.env.ANTHROPIC_MODEL, 'FreeAITokens');
  // Claude Code's background requests use a second, small model: named too, so nothing is labelled Haiku.
  assert.equal(s.env.ANTHROPIC_SMALL_FAST_MODEL, 'FreeAITokens');
  // An unknown name makes Claude Code assume a 1M-token window; most free models hold about 200K.
  assert.equal(s.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '200000');
});
