import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { emptyState, type LimitState } from '../core/limits.js';

export function stateDir(): string {
  const d = process.env.FREETOKENS_HOME || join(homedir(), '.freetokens');
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

export function loadState(): LimitState {
  const f = join(stateDir(), 'state.json');
  if (!existsSync(f)) return emptyState();
  try {
    return { ...emptyState(), ...JSON.parse(readFileSync(f, 'utf8')) };
  } catch {
    process.stderr.write(`freetokens: ${f} was unreadable, starting with empty usage counters\n`);
    return emptyState();
  }
}

export function saveState(s: LimitState): void {
  const f = join(stateDir(), 'state.json');
  writeFileSync(f + '.tmp', JSON.stringify(s));
  renameSync(f + '.tmp', f);
}

export function localToken(): string {
  const f = join(stateDir(), 'token');
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  const t = 'ft-' + randomBytes(16).toString('hex');
  writeFileSync(f, t, { mode: 0o600 });
  return t;
}
