// Saved chats, kept in the app's state folder so sync can read and write them.
// A removed chat stays as a small stub until sync has told the other computers.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE_FILE = /^[0-9a-f-]{36}\.(png|jpg|webp)$/;
const AUDIO_FILE = /^[0-9a-f-]{36}\.(mp3|wav|ogg|flac|m4a|webm)$/;
const KINDS = new Set(['image', 'speech', 'file']);
const str = (v, max) => typeof v === 'string' && v.length <= max;
const time = (v) => Number.isFinite(v) && v >= 0;

// A chat in the shape the app and sync use, or null. Same limits as a message sent to a model.
export function cleanChat(c) {
  if (!c || typeof c !== 'object' || !UUID.test(c.id) || !time(c.updated)) return null;
  if (c.deleted != null) return time(c.deleted) ? { id: c.id, title: '', model: '', updated: c.updated, deleted: c.deleted, messages: [] } : null;
  if (!str(c.title, 200) || !str(c.model, 200) || !Array.isArray(c.messages) || c.messages.length > 1000) return null;
  const messages = [];
  for (const m of c.messages) {
    if (!m || !UUID.test(m.id) || !time(m.at) || (m.role !== 'user' && m.role !== 'assistant') || !str(m.content, 100_000)) return null;
    if ((m.image != null && !(str(m.image, 60) && IMAGE_FILE.test(m.image))) || (m.prompt != null && !str(m.prompt, 100_000))) return null;
    if (m.audio != null && !(str(m.audio, 60) && AUDIO_FILE.test(m.audio))) return null;
    if (m.meta != null && (typeof m.meta !== 'object' || JSON.stringify(m.meta).length > 2000)) return null;
    messages.push({
      id: m.id, at: m.at, role: m.role, content: m.content,
      ...(m.error ? { error: true } : {}), ...(KINDS.has(m.kind) ? { kind: m.kind } : {}),
      ...(m.image ? { image: m.image } : {}), ...(m.audio ? { audio: m.audio } : {}), ...(m.prompt != null ? { prompt: m.prompt } : {}), ...(m.meta ? { meta: m.meta } : {}),
    });
  }
  return { id: c.id, title: c.title, model: c.model, ...(['auto', 'chat', 'image'].includes(c.mode) ? { mode: c.mode } : {}), updated: c.updated, messages };
}

// The chats the app used to keep in window storage, with ids and times added. Anything malformed is dropped.
export function migrateChats(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== 'object' || !Array.isArray(c.messages)) continue;
    const updated = time(c.updated) ? c.updated : Date.now();
    const n = c.messages.length;
    const chat = cleanChat({
      ...c, id: UUID.test(c.id) ? c.id : randomUUID(), updated,
      // Old messages had no times: spread them a second apart, ending at the chat's last update.
      messages: c.messages.map((m, i) => ({ ...m, id: UUID.test(m?.id) ? m.id : randomUUID(), at: time(m?.at) ? m.at : updated - (n - 1 - i) * 1000 })),
    });
    if (chat) out.push(chat);
  }
  return out;
}

// `merge` (sync's mergeChat) lets `save` combine a copy with the stored one, so an old copy never drops messages.
export function openChatStore(file, merge = null) {
  let all;
  // Stubs older than 90 days are dropped: the sync server forgets deletes after the same time.
  const keepFrom = Date.now() - 90 * 86_400_000;
  try { all = (JSON.parse(readFileSync(file, 'utf8')).chats ?? []).map(cleanChat).filter((c) => c && !(c.deleted < keepFrom)); } catch (e) {
    all = [];
    // A file that is there but unreadable is kept aside, so the next save cannot write an empty list over it.
    if (e?.code !== 'ENOENT') try { renameSync(file, `${file}.bad`); } catch { /* nothing to keep */ }
  }
  const listeners = [];
  const write = (id) => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ chats: all }), { mode: 0o600 });
    renameSync(tmp, file); // never a half-written file
    for (const fn of listeners) fn(id);
  };
  const set = (c) => { all = [c, ...all.filter((x) => x.id !== c.id)]; write(c.id); };
  return {
    list: () => all.filter((c) => !c.deleted).sort((a, b) => b.updated - a.updated),
    all: () => all.slice(),
    put: (c) => set(c),
    save: (c) => { const cur = all.find((x) => x.id === c.id); set(cur && !cur.deleted && merge ? merge(cur, c) : c); },
    // The stub keeps the removed copy's `updated`, so an edit made elsewhere that this copy never had still wins.
    remove: (id) => { const c = all.find((x) => x.id === id); if (c && !c.deleted) set({ id, title: '', model: '', updated: c.updated, deleted: Date.now(), messages: [] }); },
    onChange: (fn) => { listeners.push(fn); },
  };
}
