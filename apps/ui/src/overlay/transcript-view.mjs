// den-v1/05: pure view model for the transcript panel. Never mutates its input and never throws on a bad entry.
// transcriptView(buffer, { expanded, atBottom, seenThrough, connection, pending }) -> { empty, emptyText, droppedNotice,
// droppedText, rows, atBottom, unread, jumpLabel, banner }. Rows keep arrival order: the newest is last.
export const RESULT_BYTES = 4096;
import { cleanText, safeToolInput } from "../../../shared/safe-text.mjs";
import { sourceKey } from "../../../shared/transcript-source.mjs";

const unreadable = (n, type) => ({ kind: "unreadable", n, type, label: "Unreadable event" });
const text = (value) => (typeof value === "string" ? cleanText(value) : "");

function clipResult(result) {
  if (typeof result !== "string") return null;
  const full = cleanText(result);
  const bytes = new TextEncoder().encode(full);
  if (bytes.length <= RESULT_BYTES) return { text: full, truncatedBytes: 0 };
  const head = new TextDecoder().decode(bytes.slice(0, RESULT_BYTES)).replace(/�+$/, "");
  return { text: head, truncatedBytes: bytes.length - RESULT_BYTES };
}

function inputText(input) {
  const safe = safeToolInput(input);
  return safe === undefined ? "" : typeof safe === "string" ? safe : JSON.stringify(safe, null, 2);
}

// den-v1 loop S2: the bridge resends a permission entry with its answer. Anything else still reads as waiting.
const PERMISSION_LABELS = { allowed: "Allowed by you", denied: "Denied by you", expired: "Expired: denied" };

// den-v1 loop S5: a message the user sent carries its delivery status, and the bridge resends the entry as it changes.
const MESSAGE_NOTES = Object.assign(Object.create(null), { queued: "Queued", applied: "Received", undelivered: "Not delivered", cancelled: "Cancelled" });

function rowFor(entry, n, expanded) {
  if (!entry || typeof entry !== "object") return unreadable(n, "unknown");
  switch (entry.kind) {
    case "message":
      return { kind: "message", n, speaker: entry.role === "user" ? "You" : "Agent", text: text(entry.text), at: entry.at, note: entry.role === "user" ? MESSAGE_NOTES[entry.status] ?? null : null };
    case "tool": {
      const key = sourceKey(entry.source);
      const source = key ? { project: entry.source.project, runtime: entry.source.runtime, role: entry.source.role, runId: entry.source.runId, entryId: entry.source.entryId } : null;
      const open = expanded.has(n) || (key !== null && expanded.has(key));
      const statusLabels = { running: "Active", done: "Done", failed: "Failed", refused: "Refused", stopped: "Stopped", ended: "Ended" };
      const row = { kind: "tool", n, source, sourceUnavailable: !source, invocationId: text(entry.invocationId), name: text(entry.name), summary: text(entry.summary).slice(0, 200), status: Object.hasOwn(statusLabels, entry.status) ? entry.status : "unknown", statusLabel: statusLabels[entry.status] ?? "Unknown", expanded: open, toggleLabel: open ? "Hide details" : "Show details" };
      if (open) {
        row.inputText = inputText(entry.input);
        row.result = clipResult(entry.result);
        row.resultLabel = row.result ? "Result" : "Not available yet";
      }
      return row;
    }
    case "permission": {
      const answered = typeof entry.status === "string" && Object.hasOwn(PERMISSION_LABELS, entry.status);
      return { kind: "permission", n, name: text(entry.name), label: answered ? PERMISSION_LABELS[entry.status] : "Waiting on you", waiting: !answered, detail: null, answerable: false };
    }
    case "ended":
      return { kind: "ended", n, state: text(entry.state), label: `Agent ended: ${text(entry.state)}` };
    case "unreadable":
      return unreadable(n, typeof entry.type === "string" ? entry.type : "unknown");
    default:
      return unreadable(n, typeof entry.kind === "string" ? entry.kind : "unknown");
  }
}

function bannerFor(phase) {
  if (phase === "connecting" || phase === "reconnecting") return "Reconnecting...";
  if (phase === "offline") return "Bridge offline: run npm run ui";
  return null;
}

export function transcriptView(buffer, ui = {}) {
  const entries = Array.isArray(buffer?.entries) ? buffer.entries : [];
  const dropped = buffer?.dropped > 0 ? buffer.dropped : 0;
  const expanded = new Set((ui.expanded ?? []).map(v => typeof v === "object" ? sourceKey(v) : v));
  const numbers = entries.map((entry, i) => (Number.isFinite(entry?.n) ? entry.n : dropped + i + 1));
  const rows = entries.map((entry, i) => rowFor(entry, numbers[i], expanded));
  // Live den run, 2026-10-10: the newest waiting row of the tool the agent's pending request names says what is
  // asked and can be answered from here. The target comes from the approval (ui.pending), not the transcript entry.
  const pending = ui.pending && typeof ui.pending === "object" && typeof ui.pending.tool === "string" && ui.pending.tool ? ui.pending : null;
  const asked = pending ? rows.findLast((row) => row.kind === "permission" && row.waiting && row.name === pending.tool) : null;
  if (asked) {
    asked.detail = [pending.tool, text(pending.summary)].filter(Boolean).join(" ");
    asked.answerable = true;
  }
  const atBottom = ui.atBottom !== false;
  const seen = Number.isFinite(ui.seenThrough) ? ui.seenThrough : 0;
  const unread = atBottom ? 0 : numbers.filter((n) => n > seen).length;
  return {
    empty: rows.length === 0,
    emptyText: "Waiting for the agent's first message.",
    droppedNotice: dropped > 0,
    droppedText: "Earlier entries were dropped",
    rows,
    atBottom,
    unread,
    jumpLabel: atBottom ? null : unread > 0 ? `Jump to latest (${unread})` : "Jump to latest",
    banner: bannerFor(ui.connection?.phase),
  };
}
