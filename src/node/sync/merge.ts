// How two copies of the same synced thing combine. Both orders give the same answer, so devices converge.
export type Msg = { id: string; at: number; role: 'user' | 'assistant'; content: string; error?: boolean; meta?: object };
export type Chat = { id: string; title: string; model: string; updated: number; deleted?: number; messages: Msg[] };
export type KeyBundle = Record<string, { key: string | null; updated: number }>;

// Deterministic pick on ties, so the result never depends on which side is "a".
const later = <T extends { updated: number }>(a: T, b: T): T =>
  a.updated !== b.updated ? (a.updated > b.updated ? a : b) : JSON.stringify(a) >= JSON.stringify(b) ? a : b;

export function mergeChat(a: Chat, b: Chat): Chat {
  const byId = new Map<string, Msg>();
  for (const m of [...a.messages, ...b.messages]) {
    const had = byId.get(m.id);
    byId.set(m.id, had && JSON.stringify(had) > JSON.stringify(m) ? had : m);
  }
  const messages = [...byId.values()].sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const top = later(a, b);
  const updated = Math.max(a.updated, b.updated);
  const deletedAt = Math.max(a.deleted ?? -Infinity, b.deleted ?? -Infinity);
  const editedAt = Math.max(...[a, b].filter((c) => c.deleted == null).map((c) => c.updated), -Infinity);
  // A delete stands unless one side edited the chat after it; a deleted chat carries no messages.
  if (deletedAt > -Infinity && deletedAt >= editedAt) return { id: a.id, title: '', model: '', updated, deleted: deletedAt, messages: [] };
  return { id: a.id, title: top.title, model: top.model, updated, messages };
}

export function mergeKeys(a: KeyBundle, b: KeyBundle): KeyBundle {
  const out: KeyBundle = { ...a };
  for (const [p, v] of Object.entries(b)) out[p] = out[p] ? later(out[p], v) : v;
  return out;
}

// What changed here since the last sync, including keys added or removed with the CLI.
export function localKeyChanges(snapshot: Record<string, string>, current: Record<string, string | null>, now: number): KeyBundle {
  const out: KeyBundle = {};
  for (const p of new Set([...Object.keys(snapshot), ...Object.keys(current)])) {
    const cur = current[p] ?? null;
    if (cur !== (snapshot[p] ?? null)) out[p] = { key: cur, updated: now };
  }
  return out;
}
