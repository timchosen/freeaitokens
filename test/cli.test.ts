import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { banner, parseArgs, HELP } from '../src/node/cli.ts';

const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/node/cli.ts', ...args], {
  encoding: 'utf8', env: { ...process.env, FREEAITOKENS_HOME: mkdtempSync(join(tmpdir(), 'ft-c-')), FREEAITOKENS_KEYS: 'file', FREEAITOKENS_CATALOGUE: 'bundled' },
});

test('--help lists every command', () => {
  const r = run('--help');
  assert.equal(r.status, 0);
  for (const c of ['add', 'list', 'remove', 'claude', 'codex', 'setup', '--free-only', '--port', '--paid-cap']) assert.ok(r.stdout.includes(c), c);
  assert.equal(r.stdout.trim(), HELP.trim());
});

test('unknown command exits 1 with a hint', () => {
  const r = run('frobnicate');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown command "frobnicate".*--help/s);
});

test('remove of an unknown provider exits 1', () => {
  const r = run('remove', 'nope');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nope/);
});

test('setup of an unknown tool exits 1', () => {
  const r = run('setup', 'emacs');
  assert.equal(r.status, 1);
});

test('parseArgs reads flags anywhere and passes the rest through', () => {
  assert.deepEqual(parseArgs(['claude', '--port', '5000', '-p', 'hi']), { command: 'claude', rest: ['-p', 'hi'], port: 5000, freeOnly: false, paidCap: 200 });
  assert.deepEqual(parseArgs(['--free-only']), { command: 'serve', rest: [], port: 4949, freeOnly: true, paidCap: 200 });
  assert.equal(parseArgs(['--paid-cap', '5']).paidCap, 5);
  assert.throws(() => parseArgs(['--port', 'abc']), /--port/);
});

test('arguments after a launcher command are not read as our flags', () => {
  assert.deepEqual(parseArgs(['codex', 'exec', '--port', 'x']).rest, ['exec', '--port', 'x']);
});

test('first-run banner contains the endpoint URL, the token once, and "freeaitokens add"', () => {
  const token = 'ft-' + 'a'.repeat(32);
  const b = banner(4949, token, { keyless: 2, keyed: 0, backend: 'keychain' });
  assert.ok(b.includes('http://127.0.0.1:4949/v1'));
  assert.equal(b.split(token).length - 1, 1);
  assert.ok(b.includes('freeaitokens add'));
});

test('banner leads with adding a key when nothing is usable', () => {
  const b = banner(4949, 'ft-x', { keyless: 0, keyed: 0, backend: 'keychain' });
  assert.match(b.split('\n')[0] + b.split('\n')[1], /freeaitokens add/);
});
