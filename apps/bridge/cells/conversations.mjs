// Durable conversations are scoped by project, canonical runtime and role. The den/Claude file keeps its legacy
// location at .scratch/_run/conversations/<role>.jsonl. Every transcript entry the host records goes here as it happens,
// tagged with the run that made it and that run's ticket, so the thread a role has with the user outlives the run, a
// reload and a bridge restart, and two runs of one role stay apart. A changed entry is appended again as a patch
// under the same run and id; a read folds them, oldest first.
//
//   append(role, { runId, ref, id, ...fields }, { project?, runtime? })   entry or patch
//   read(role, { before?, limit?, project?, runtime? }) -> { entries, more, before }
//       the newest `limit` entries that end at position `before` (default: the end); `before` in the answer is the
//       position to ask with for the page above it, and `more` says whether there is one
//
// Like sessions.jsonl, the files are untrusted input: a read checks every field, cleans every string again and returns
// plain data only. Nothing read here is authority for anything; it is shown, never run.
import { mkdir, chmod, appendFile, open } from "node:fs/promises";
import path from "node:path";
import { runtimeId, validProject } from "./identity.mjs";
import { cleanText } from "./approvals.mjs";
import {
  AGENT_ID_RE, APPROVAL_ID_RE, APPROVAL_NOTE_MAX, CONVERSATION_PAGE, CONVERSATION_PAGE_MAX, CONVERSATION_READ_BYTES, DIRECT_MODE, MODES,
  REF_RE, ROLES, TRANSCRIPT_RESULT_MAX, TRANSCRIPT_TEXT_MAX, UUID_RE,
} from "./policy.mjs";

const PATCHABLE = ["status", "result", "note", "answeredAt"]; // the fields the host revises on an entry it already wrote
const CLIP_NOTE = 80; // room for the "[clipped: n more characters]" line the host adds to a cut text
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const validTs = (v) => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
const text = (v, max) => (typeof v === "string" ? cleanText(v).slice(0, max) : null);
const oneOf = (v, list) => (list.includes(v) ? v : null);

// What each kind of entry may carry. A field that fails its check is left out; a required one that fails drops the entry.
const KINDS = {
  // The marker a run opens with: which ticket it serves and, for a follow-up, the run whose session it continues.
  run: (e) => ({ mode: e.mode === DIRECT_MODE ? DIRECT_MODE : oneOf(e.mode, MODES), resumeOf: typeof e.resumeOf === "string" && AGENT_ID_RE.test(e.resumeOf) ? e.resumeOf : null }),
  message: (e) => {
    const body = text(e.text, TRANSCRIPT_TEXT_MAX + CLIP_NOTE);
    if (body === null || !["agent", "user"].includes(e.role)) return null;
    const status = oneOf(e.status, ["queued", "applied", "undelivered"]);
    return { role: e.role, text: body, ...(typeof e.messageId === "string" && UUID_RE.test(e.messageId) ? { messageId: e.messageId } : {}), ...(status ? { status } : {}) };
  },
  tool: (e) => {
    const name = text(e.name, 100);
    const status = oneOf(e.status, ["running", "done", "failed", "stopped"]);
    if (!name || !status) return null;
    const result = text(e.result, TRANSCRIPT_RESULT_MAX + CLIP_NOTE);
    return { name, summary: text(e.summary, 200) ?? "", status, ...(result === null ? {} : { result }) };
  },
  permission: (e) => {
    const name = text(e.name, 100);
    const status = oneOf(e.status, ["pending", "allowed", "denied", "expired"]);
    if (!name || !status) return null;
    return {
      name, status,
      ...(typeof e.approvalId === "string" && APPROVAL_ID_RE.test(e.approvalId) ? { approvalId: e.approvalId } : {}),
      ...(typeof e.note === "string" ? { note: text(e.note, APPROVAL_NOTE_MAX) } : {}),
      ...(validTs(e.answeredAt) ? { answeredAt: e.answeredAt } : {}),
    };
  },
  stop: (e) => (e.status === "requested" ? { status: "requested" } : null),
  ended: (e) => (["terminated", "done", "failed"].includes(e.state) ? { state: e.state } : null),
};

/** A clean entry or null. Unknown keys are not copied. */
export function validateEntry(raw) {
  if (!isObject(raw) || !AGENT_ID_RE.test(raw.runId) || typeof raw.ref !== "string" || !REF_RE.test(raw.ref)) return null;
  if (!Number.isInteger(raw.id) || raw.id < 0 || !validTs(raw.at) || !Object.hasOwn(KINDS, raw.kind)) return null;
  const identified = Object.hasOwn(raw, "runtime") || Object.hasOwn(raw, "project");
  if (identified && (!runtimeId(raw.runtime) || !validProject(raw.project))) return null;
  const fields = KINDS[raw.kind](raw);
  return fields === null ? null : { runId: raw.runId, ref: raw.ref, id: raw.id, at: raw.at, kind: raw.kind, ...(identified ? { runtime: raw.runtime, project: raw.project } : {}), ...fields };
}

export function createConversations(root, { projectForRun = () => "den" } = {}) {
  const dir = path.join(root, ".scratch", "_run", "conversations");
  const tuple = (role, { runtime, project = "den" } = {}) => {
    const selected = runtimeId(runtime);
    if (!ROLES.includes(role) || !selected || !validProject(project)) throw new TypeError("conversations: invalid identity");
    return { runtime: selected, project, key: `${project}/${selected}/${role}`, file: path.join(dir, ...(project === "den" && selected === "claude" ? [] : ["projects", project, selected]), `${role}.jsonl`) };
  };
  const ensured = new Map(); // tuple -> the promise that its file exists with the right mode
  const chains = new Map(); // tuple -> the tail of its append queue

  // Dir 0700, file 0600, set explicitly so a pre-existing looser mode is tightened too.
  const ensure = ({ key: role, file }) => {
    if (!ensured.has(role)) {
      ensured.set(role, (async () => {
        const parent = path.dirname(file);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        for (let current = parent; current.startsWith(dir); current = path.dirname(current)) await chmod(current, 0o700);
        await appendFile(file, "", { mode: 0o600 });
        await chmod(file, 0o600);
      })().catch((err) => {
        ensured.delete(role);
        throw err;
      }));
    }
    return ensured.get(role);
  };

  // The last CONVERSATION_READ_BYTES of the file, cut at a line start: a thread older than that is not read back.
  async function tail(file) {
    let handle;
    try {
      handle = await open(file, "r");
    } catch {
      return "";
    }
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - CONVERSATION_READ_BYTES);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const body = buffer.toString("utf8");
      return start === 0 ? body : body.slice(body.indexOf("\n") + 1);
    } finally {
      await handle.close();
    }
  }

  return {
    dir,
    // Appends are serialised per tuple; the promise rejects on a failed write.
    append(role, entry, selectors) {
      let selected;
      try { selected = tuple(role, selectors); } catch (err) { return Promise.reject(err); }
      const run = (chains.get(selected.key) ?? Promise.resolve()).then(async () => {
        await ensure(selected);
        await appendFile(selected.file, JSON.stringify({ ...entry, runtime: selected.runtime, project: selected.project }) + "\n");
      });
      chains.set(selected.key, run.catch(() => {}));
      return run;
    },
    async read(role, { before, limit, ...selectors } = {}) {
      const selected = tuple(role, selectors);
      await chains.get(selected.key);
      const legacy = tuple(role);
      await chains.get(legacy.key);
      const folded = new Map();
      const files = selected.runtime === "claude" && selected.file !== legacy.file ? [legacy.file, selected.file] : [selected.file];
      for (const file of files) {
        const local = new Map();
        for (const line of (await tail(file)).split("\n")) {
          let raw;
          try { raw = JSON.parse(line); } catch { continue; }
          if (!isObject(raw) || typeof raw.runId !== "string" || !Number.isInteger(raw.id)) continue;
          const explicit = Object.hasOwn(raw, "runtime") || Object.hasOwn(raw, "project");
          if (explicit) {
            const expectedProject = file === legacy.file ? "den" : selected.project;
            const expectedRuntime = file === legacy.file ? "claude" : selected.runtime;
            if (raw.runtime !== expectedRuntime || raw.project !== expectedProject || raw.runtime !== selected.runtime || raw.project !== selected.project) continue;
          } else if (file !== legacy.file || selected.runtime !== "claude" || (projectForRun(raw.runId) ?? "den") !== selected.project) continue;
          const key = `${raw.runId} ${raw.id}`;
          const known = local.get(key);
          local.set(key, known ? { ...known, ...Object.fromEntries(PATCHABLE.filter((k) => Object.hasOwn(raw, k)).map((k) => [k, raw[k]])) } : raw);
        }
        for (const [key, raw] of local) folded.set(key, raw);
      }
      const all = [...folded.values()].map(validateEntry).filter(Boolean);
      if (files.length > 1) all.sort((a, b) => a.at.localeCompare(b.at) || a.runId.localeCompare(b.runId) || a.id - b.id);
      const size = Number.isInteger(limit) && limit > 0 ? Math.min(limit, CONVERSATION_PAGE_MAX) : CONVERSATION_PAGE;
      const end = Number.isInteger(before) && before >= 0 ? Math.min(before, all.length) : all.length;
      const start = Math.max(0, end - size);
      return { entries: all.slice(start, end), more: start > 0, before: start };
    },
  };
}
