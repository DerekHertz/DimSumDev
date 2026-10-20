// den-v1/05: bounded per-agent transcript buffers. Pure: never mutates its inputs.
// buffers = { [agentId]: { entries, dropped } }, oldest first; each entry carries n, its 1-based arrival number.
export const TRANSCRIPT_CAP = 200;

const KINDS = new Set(["message", "tool", "permission", "ended", "stop"]); // stop: organism-infra/230, the trail of a stop

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const readable = (entry) => (isObject(entry) && KINDS.has(entry.kind) ? entry : { kind: "unreadable", type: isObject(entry) && typeof entry.kind === "string" ? entry.kind : "unknown" });

// den-v1 loop S2: a bridge entry carries `id`, its number in that agent's transcript. An id the buffer holds replaces
// that entry in place (a tool call gets its result, a permission request its answer); an older id the buffer has
// already dropped is ignored; a new one appends with n = id. An entry with no id appends, numbered by arrival.
export function appendTranscript(buffers, agentId, entry, cap = TRANSCRIPT_CAP) {
  const previous = Object.hasOwn(buffers, agentId) ? buffers[agentId] : { entries: [], dropped: 0 }; // den-v1/12: "constructor" and "__proto__" are not buffers
  let n = previous.dropped + previous.entries.length + 1;
  if (Number.isInteger(entry?.id)) {
    const at = previous.entries.findIndex((e) => e.id === entry.id);
    if (at >= 0) {
      const entries = previous.entries.slice();
      const old = entries[at];
      // Terminal output is authoritative over a replayed active/end frame.
      if (old.kind === "tool" && entry.kind === "tool" && (old.status !== "running" && entry.status === "running" || typeof old.result === "string" && entry.result === undefined)) return buffers;
      entries[at] = { ...entry, n: previous.entries[at].n };
      return { ...buffers, [agentId]: { ...previous, entries } };
    }
    if (entry.id <= (previous.entries.at(-1)?.n ?? previous.dropped)) return buffers;
    n = entry.id;
  }
  const entries = [...previous.entries, { ...entry, n }];
  const overflow = Math.max(0, entries.length - cap);
  return {
    ...buffers,
    [agentId]: { entries: overflow ? entries.slice(overflow) : entries, dropped: previous.dropped + overflow },
  };
}

// The snapshot's `transcripts` ({ [agentId]: { entries, dropped } }, what the bridge kept) replaces the buffer of each
// agent it names, so a reloaded page refills the panel. Other agents' buffers stay; a malformed part is skipped.
export function seedTranscripts(buffers, fromSnapshot) {
  if (!isObject(fromSnapshot)) return buffers;
  let next = buffers;
  for (const [agentId, kept] of Object.entries(fromSnapshot)) {
    if (!isObject(kept) || !Array.isArray(kept.entries)) continue;
    const dropped = Number.isInteger(kept.dropped) && kept.dropped > 0 ? kept.dropped : 0;
    const entries = kept.entries.map((entry, i) => {
      const row = readable(entry);
      return { ...row, n: Number.isInteger(row.id) ? row.id : dropped + i + 1 };
    });
    next = { ...next, [agentId]: { entries, dropped } };
  }
  return next;
}

// The one place the SSE frame shape lives: { seq, type: "transcript", agentId, entry }.
// The bridge sends this shape since den-v1 loop S2 (host.mjs); the demo replay builds the same entries.
export function entryFromFrame(frame) {
  if (!frame || frame.type !== "transcript" || typeof frame.agentId !== "string") return null;
  return { agentId: frame.agentId, entry: readable(frame.entry) };
}
