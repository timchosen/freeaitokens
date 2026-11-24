// Text from a file someone attaches to a chat: plain text, data and code files (anything that is UTF-8 text),
// Word documents (.docx) and PDFs. Other files give null. Runs in the main process; the window never sees a path.
import { inflateRawSync } from 'node:zlib';
import { extractText } from 'unpdf';

// About 12,000 tokens: room for the question and the answer in most free models' context.
export const DOC_CHARS = 50_000;
const MAX_XML = 20 * 1024 * 1024; // a .docx that inflates past this is not a document we read

// One entry of a zip file, or null. Only what a .docx needs: no zip64, no encryption.
function unzipEntry(buf, want) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > buf.length) return null;
  let p = buf.readUInt32LE(end + 16);
  for (let i = buf.readUInt16LE(end + 10); i > 0 && p + 46 <= buf.length; i--) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const skip = nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32), at = buf.readUInt32LE(p + 42);
    if (buf.toString('utf8', p + 46, p + 46 + nameLen) === want) {
      if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50) return null;
      const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28), data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) { try { return inflateRawSync(data, { maxOutputLength: MAX_XML }); } catch { return null; } }
      return null;
    }
    p += 46 + skip;
  }
  return null;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENT[e] ?? m));

function docxText(buf) {
  const xml = unzipEntry(buf, 'word/document.xml');
  if (!xml) return null;
  return unescape(xml.toString('utf8')
    .replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>|<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')).replace(/\n+$/, '');
}

function plainText(buf) {
  if (buf.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); } catch { return null; }
}

// A PDF's text layer, page after page. A scan has none: `empty` lets the app say so instead of "unreadable".
async function pdfText(buf) {
  try { return (await extractText(new Uint8Array(buf), { mergePages: true })).text.trim(); } catch { return null; }
}

export async function docText(buf, name) {
  const zipped = buf[0] === 0x50 && buf[1] === 0x4b;
  const text = buf.subarray(0, 5).toString('latin1') === '%PDF-' ? await pdfText(buf)
    : zipped ? (/\.docx$/i.test(name) ? docxText(buf) : null) : plainText(buf);
  if (text == null) return null;
  if (!text.trim()) return { text: '', cut: false, empty: true };
  return { text: text.slice(0, DOC_CHARS), cut: text.length > DOC_CHARS };
}
