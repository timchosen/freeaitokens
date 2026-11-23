// License keys and hashes. The key is derived from the first checkout session, so it is never stored.
const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function sha256hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

async function hmac(secret: string, s: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(s)));
}

export async function hmacHex(secret: string, s: string): Promise<string> {
  return hex(await hmac(secret, s));
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Uint8Array): string {
  let bits = 0, val = 0, out = '';
  for (const b of bytes) {
    val = ((val << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return bits ? out + B32[(val << (5 - bits)) & 31] : out;
}

export const KEY_RE = /^FAT-(?:[A-Z2-7]{5}-){4}[A-Z2-7]{5}$/;

export async function licenseKey(secret: string, sessionId: string): Promise<string> {
  return 'FAT-' + base32(await hmac(secret, sessionId)).slice(0, 25).match(/.{5}/g)!.join('-');
}
