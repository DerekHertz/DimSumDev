// den-mvp outcome 4 (spec section 8): the meetings log. Append-only, in the bridge's state directory, outside every
// agent's worktree. Each line is one meeting's whole record after a change; on replay the last one per meeting wins,
// every field is checked, and nothing is copied that is not named here. The board files are the readable copy; this
// record is what the bridge acts on (which options a brief has, what was decided, who is still to be asked).
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_ID_RE, REF_RE } from "../agents/policy.mjs";
import { MEETING_DIR_RE } from "./store.mjs";
import { CHAIR, MEETING_STATES, SEATS_MAX, SEAT_STATES, SPECIALISTS, TOPIC_MAX_BYTES } from "./types.mjs";

export const MEETING_ID_RE = /^m-[0-9a-f]{16}$/;
const KIND_RE = /^[a-z][a-z-]{0,39}$/;
const PARTS = ["take", "chair", "answer"];
const END_STATES = ["done", "failed", "terminated"];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const ts = (v) => (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null);
const line = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, " ").slice(0, max) : null);
const count = (v) => (Number.isInteger(v) && v >= 0 && v < 1000 ? v : 0);
const optionKey = (v) => (["A", "B", "C"].includes(v) ? v : null);
const runOf = (raw) => (isObject(raw) && AGENT_ID_RE.test(raw.runId) && (SPECIALISTS.includes(raw.role) || raw.role === CHAIR) && PARTS.includes(raw.part) ? { runId: raw.runId, role: raw.role, part: raw.part } : null);

/** A clean meeting record, or null. Unknown keys are not copied. */
export function validateMeeting(raw) {
  if (!isObject(raw) || !MEETING_ID_RE.test(raw.id) || typeof raw.ref !== "string" || !REF_RE.test(raw.ref) || !MEETING_STATES.includes(raw.state) || !ts(raw.startedAt)) return null;
  if (typeof raw.dir !== "string" || !MEETING_DIR_RE.test(raw.dir) || typeof raw.topic !== "string" || Buffer.byteLength(raw.topic) > TOPIC_MAX_BYTES) return null;
  const seats = (Array.isArray(raw.seats) ? raw.seats : []).flatMap((s) =>
    isObject(s) && SPECIALISTS.includes(s.role) && SEAT_STATES.includes(s.status) ? [{ role: s.role, status: s.status, takes: count(s.takes), reason: line(s.reason, 200) }] : []);
  if (seats.length < 1 || seats.length > SEATS_MAX || new Set(seats.map((s) => s.role)).size !== seats.length) return null;
  const options = isObject(raw.brief) && Array.isArray(raw.brief.options) ? raw.brief.options.flatMap((o) => (isObject(o) && optionKey(o.key) && line(o.title, 100) ? [{ key: o.key, title: line(o.title, 100) }] : [])) : [];
  const brief = options.length >= 2 && options.length <= 3 && count(raw.brief.version) > 0 && options.some((o) => o.key === raw.brief.recommended) ? { version: count(raw.brief.version), options, recommended: raw.brief.recommended } : null;
  const pause = isObject(raw.pause) && KIND_RE.test(raw.pause.kind) ? { kind: raw.pause.kind, reason: line(raw.pause.reason, 400) ?? "", next: line(raw.pause.next, 300) ?? "" } : null;
  return {
    id: raw.id, ref: raw.ref, dir: raw.dir, title: line(raw.title, 120) ?? "", topic: raw.topic, state: raw.state, chair: CHAIR,
    pause: raw.state === "paused" ? pause ?? { kind: "unknown", reason: "", next: "" } : null,
    seats, round: ["brief", "answer"].includes(raw.round) ? raw.round : null, brief, briefs: Math.max(count(raw.briefs), brief?.version ?? 0), thread: count(raw.thread),
    decisions: (Array.isArray(raw.decisions) ? raw.decisions : []).slice(-20).flatMap((d) =>
      isObject(d) && optionKey(d.option) && typeof d.ticket === "string" && REF_RE.test(d.ticket) && ts(d.at) ? [{ option: d.option, title: line(d.title, 100) ?? "", ticket: d.ticket, brief: count(d.brief) || 1, at: d.at }] : []),
    live: runOf(raw.live),
    runs: (Array.isArray(raw.runs) ? raw.runs : []).slice(-50).flatMap((r) => (runOf(r) && END_STATES.includes(r.state) ? [{ ...runOf(r), state: r.state }] : [])),
    restedAt: ts(raw.restedAt), retired: raw.retired === true, startedAt: raw.startedAt, updatedAt: ts(raw.updatedAt) ?? raw.startedAt,
  };
}

export function createMeetingLog(dir) {
  const file = path.join(dir, "meetings.jsonl");
  let ensured = null;
  let chain = Promise.resolve();
  const ensure = () =>
    (ensured ??= (async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await appendFile(file, "", { mode: 0o600 });
      await chmod(file, 0o600);
    })().catch((err) => {
      ensured = null;
      throw err;
    }));
  return {
    file,
    /** The meeting's whole record. */
    save(meeting) {
      const text = `${JSON.stringify({ ts: new Date().toISOString(), meeting })}\n`; // taken now: a later change is a later line
      const run = chain.then(async () => {
        await ensure();
        await appendFile(file, text);
      });
      chain = run.catch(() => {});
      return run;
    },
    /** -> [meeting], oldest first. */
    async replay() {
      const text = await readFile(file, "utf8").catch(() => "");
      const meetings = new Map();
      for (const rawLine of text.split("\n")) {
        if (!rawLine.trim()) continue;
        try {
          const meeting = validateMeeting(JSON.parse(rawLine)?.meeting);
          if (meeting) meetings.set(meeting.id, meeting);
        } catch {
          // a torn line: the earlier record of that meeting stands
        }
      }
      return [...meetings.values()];
    },
  };
}
