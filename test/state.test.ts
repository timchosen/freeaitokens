import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadState, saveState, localToken, stateDir } from '../src/node/state.ts';
import { emptyState } from '../src/core/limits.ts';

beforeEach(() => { process.env.FREETOKENS_HOME = mkdtempSync(join(tmpdir(), 'ft-')); });

test('corrupt state file loads empty', () => {
  writeFileSync(join(stateDir(), 'state.json'), '{"windows":');
  assert.deepEqual(loadState(), emptyState());
});

test('missing state file loads empty', () => {
  assert.deepEqual(loadState(), emptyState());
});

test('saveState leaves no temp file and round-trips', () => {
  const s = emptyState();
  s.cooling['groq/m'] = 123;
  saveState(s);
  assert.equal(existsSync(join(stateDir(), 'state.json.tmp')), false);
  assert.deepEqual(loadState(), s);
});

test('localToken has the right format, is stable, and is private', () => {
  const a = localToken();
  assert.match(a, /^ft-[0-9a-f]{32}$/);
  assert.equal(localToken(), a);
  if (process.platform !== 'win32') assert.equal(statSync(join(stateDir(), 'token')).mode & 0o777, 0o600);
});
