import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { Entry } from '@napi-rs/keyring';
import { stateDir } from './state.js';

export interface KeyStore {
  get(providerId: string): string | null;
  set(providerId: string, key: string): void;
  remove(providerId: string): void;
  backend: 'keychain' | 'file';
}

const SERVICE = 'freeaitokens';

function keychainStore(): KeyStore {
  return {
    backend: 'keychain',
    get: (id) => new Entry(SERVICE, id).getPassword() ?? null,
    set: (id, key) => new Entry(SERVICE, id).setPassword(key),
    remove: (id) => { new Entry(SERVICE, id).deleteCredential(); },
  };
}

// For machines with no keychain (headless Linux, Termux). Plain JSON, mode 0600.
function fileStore(): KeyStore {
  const f = join(stateDir(), 'keys.json');
  let warned = false;
  const read = (): Record<string, string> => {
    if (!existsSync(f)) return {};
    try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return {}; }
  };
  const write = (all: Record<string, string>) => {
    writeFileSync(f, JSON.stringify(all, null, 2), { mode: 0o600 });
    chmodSync(f, 0o600);
  };
  return {
    backend: 'file',
    get: (id) => read()[id] ?? null,
    set: (id, key) => {
      if (!warned) { warned = true; process.stderr.write(`No system keychain found. Keys are stored unencrypted in ${f}, readable only by you.\n`); }
      write({ ...read(), [id]: key });
    },
    remove: (id) => { const all = read(); delete all[id]; write(all); },
  };
}

export function openKeyStore(forceFile = false): KeyStore {
  if (forceFile || process.env.FREEAITOKENS_KEYS === 'file') return fileStore();
  try {
    new Entry(SERVICE, '__probe__').getPassword();
    return keychainStore();
  } catch {
    return fileStore();
  }
}
