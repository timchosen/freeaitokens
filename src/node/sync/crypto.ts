// Sync encryption, on the device only. A random data key encrypts every item; the passphrase only wraps
// that key, so changing the passphrase never re-encrypts items. The server sees ciphertext.
import { randomBytes, scrypt, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export class WrongPassphraseError extends Error { constructor() { super('That passphrase does not open this sync account.'); } }
export class CorruptItemError extends Error { constructor() { super('A synced item could not be decrypted.'); } }

type Params = { N: number; r: number; p: number };
const DEFAULT: Params = { N: 2 ** 17, r: 8, p: 1 };

const derive = (passphrase: string, salt: Buffer, { N, r, p }: Params) => new Promise<Buffer>((ok, fail) =>
  scrypt(passphrase.normalize('NFC'), salt, 32, { N, r, p, maxmem: 256 * N * r }, (e, k) => (e ? fail(e) : ok(k))));

function seal(key: Buffer, data: Buffer, aad?: Buffer): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  if (aad) c.setAAD(aad);
  return Buffer.concat([nonce, c.update(data), c.final(), c.getAuthTag()]);
}
function open(key: Buffer, box: Uint8Array, aad?: Buffer): Buffer {
  const b = Buffer.from(box);
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  if (aad) d.setAAD(aad);
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]);
}

export const newDataKey = (): Buffer => randomBytes(32);

// The vault body stored on the server: the data key sealed under a key derived from the passphrase.
export async function wrapDataKey(dataKey: Buffer, passphrase: string, params: Params = DEFAULT): Promise<string> {
  const salt = randomBytes(16);
  const box = seal(await derive(passphrase, salt, params), dataKey);
  return JSON.stringify({ v: 1, salt: salt.toString('base64'), ...params, box: box.toString('base64') });
}

// The vault comes from the server, so its scrypt settings are checked before they can cost memory or time.
const sane = (v: any) => v?.v === 1 && v.r === 8 && Number.isInteger(v.p) && v.p >= 1 && v.p <= 4 &&
  Number.isInteger(v.N) && v.N >= 2 ** 14 && v.N <= 2 ** 20 && (v.N & (v.N - 1)) === 0;

export async function unwrapDataKey(body: string, passphrase: string): Promise<Buffer> {
  const v = JSON.parse(body);
  if (!sane(v)) throw new Error('This sync account uses encryption settings this version cannot open.');
  const key = await derive(passphrase, Buffer.from(v.salt, 'base64'), { N: v.N, r: v.r, p: v.p });
  try { return open(key, Buffer.from(v.box, 'base64')); } catch { throw new WrongPassphraseError(); }
}

// nonce(12) | ciphertext | tag(16); the item id is bound in, so a blob cannot be moved to another id.
export const encryptItem = (dataKey: Buffer, id: string, value: object): Uint8Array =>
  seal(dataKey, Buffer.from(JSON.stringify(value)), Buffer.from(id));

export function decryptItem(dataKey: Buffer, id: string, bytes: Uint8Array): any {
  try { return JSON.parse(open(dataKey, bytes, Buffer.from(id)).toString()); } catch { throw new CorruptItemError(); }
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32(bytes: Uint8Array): string {
  let bits = 0, val = 0, out = '';
  for (const b of bytes) { val = ((val << 8) | b) & 0xffff; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  return bits ? out + B32[(val << (5 - bits)) & 31] : out;
}
function unb32(s: string): Buffer {
  const out: number[] = [];
  let bits = 0, val = 0;
  for (const ch of s) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('That recovery code has a character that cannot be in it.');
    val = ((val << 5) | i) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
const check = (key: Buffer) => b32(createHash('sha256').update(key).digest()).slice(0, 2);

// The data key in groups of four, plus two check characters, for printing or saving.
export const recoveryCode = (dataKey: Buffer): string => (b32(dataKey) + check(dataKey)).match(/.{1,4}/g)!.join('-');

export function fromRecoveryCode(code: string): Buffer {
  const s = code.toUpperCase().replace(/[\s-]/g, '');
  const key = unb32(s.slice(0, -2)).subarray(0, 32);
  if (key.length !== 32 || check(key) !== s.slice(-2)) throw new Error('That recovery code is not right. Check it for typos.');
  return key;
}
