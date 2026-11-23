import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openKeyStore, keychainStore } from '../src/node/keys.ts';
import { stateDir } from '../src/node/state.ts';

beforeEach(() => { process.env.FREEAITOKENS_HOME = mkdtempSync(join(tmpdir(), 'ft-')); });

test('set, get and remove round-trip', () => {
  const k = openKeyStore(true);
  assert.equal(k.backend, 'file');
  assert.equal(k.get('groq'), null);
  k.set('groq', 'gsk_abc');
  assert.equal(k.get('groq'), 'gsk_abc');
  assert.equal(openKeyStore(true).get('groq'), 'gsk_abc');
  k.remove('groq');
  assert.equal(k.get('groq'), null);
});

test('a second set replaces the first', () => {
  const k = openKeyStore(true);
  k.set('groq', 'one');
  k.set('groq', 'two');
  assert.equal(k.get('groq'), 'two');
});

test('the key file is readable only by the user', { skip: process.platform === 'win32' }, () => {
  openKeyStore(true).set('groq', 'gsk_x');
  assert.equal(statSync(join(stateDir(), 'keys.json')).mode & 0o777, 0o600);
});

test('keys are never written to stdout or stderr', () => {
  const out: string[] = [];
  const ow = process.stdout.write, ew = process.stderr.write;
  process.stdout.write = ((s: any) => { out.push(String(s)); return true; }) as any;
  process.stderr.write = ((s: any) => { out.push(String(s)); return true; }) as any;
  try {
    const k = openKeyStore(true);
    k.set('groq', 'gsk_SECRET');
    k.get('groq');
  } finally {
    process.stdout.write = ow; process.stderr.write = ew;
  }
  assert.ok(!out.join('').includes('gsk_SECRET'));
  assert.ok(readFileSync(join(stateDir(), 'keys.json'), 'utf8').includes('gsk_SECRET'));
});

test('the file fallback says plainly that keys are unencrypted', () => {
  const out: string[] = [];
  const ew = process.stderr.write;
  process.stderr.write = ((s: any) => { out.push(String(s)); return true; }) as any;
  try { openKeyStore(true).set('groq', 'x'); } finally { process.stderr.write = ew; }
  assert.match(out.join(''), /unencrypted/);
});

test('a keychain read that fails counts as no key instead of throwing', () => {
  const k = keychainStore(() => ({ getPassword() { throw new Error('Platform failure: UNIX[No such file or directory]'); } }) as any);
  assert.equal(k.get('groq'), null);
});

test('keychain read: get says "no key" when the keychain refuses, read throws so sync can tell the difference', () => {
  const s = keychainStore(() => ({ getPassword() { throw new Error('User interaction is not allowed.'); } }) as any);
  assert.equal(s.get('groq'), null);
  assert.throws(() => s.read!('groq'), /not allowed/);
  assert.equal(keychainStore(() => ({ getPassword: () => null }) as any).read!('groq'), null, 'nothing stored is still null');
});
