// Hierarchy audit replay: the event log is the record, the animation a view of it. Pure: no React, no DOM, no clock,
// no network. Nothing here starts, steers or changes a run; seeking only folds a prefix of recorded events.
// Contract: docs/agents/hierarchy-replay.md (schema version 1, the prototype's field names plus `attempt`, `verdict`
// and `sourceRef`). A file that is unsafe or of an unknown version is refused whole; one that is merely imperfect
// (duplicates, late arrivals, gaps, clock steps, broken hierarchy) is shown with each problem listed beside it.
//   parseRun(text)        -> { run, issues } or throws; validateRun(value) the same for an object
//   replay(run, count)    -> the tree, per-agent times and task times after the first `count` events
//   redactRun / summarize -> exports that keep timing and structure and drop free text, IDs and evidence
export const SCHEMA_VERSION = 1;
export const KINDS = ["queued", "started", "delegated", "working", "waiting", "blocked", "awaiting", "result", "review", "rework", "accepted", "failed", "cancelled", "completed"];
export const LAYERS = ["owner", "manager", "runner"];
export const LIMITS = Object.freeze({ bytes: 1048576, events: 2000, managers: 4, runnersPerManager: 4 });
const TERMINAL = new Set(["accepted", "failed", "cancelled", "completed"]);
const WORK = new Set(["working", "review", "rework"]);
const WAIT = new Set(["queued", "waiting", "blocked", "awaiting"]);
const RELATIONAL = new Set(["delegated"]);
const RUN_KEYS = new Set(["schemaVersion", "runId", "label", "illustrative", "source", "events"]);
const REQUIRED = ["runId", "eventId", "sequence", "timestamp", "agentId", "parentId", "name", "role", "layer", "runtime", "model", "tier", "kind", "taskSummary", "relatedAgentId", "reason", "blockedOn", "commit", "pr", "evidenceRefs"];
const OPTIONAL = ["attempt", "verdict", "sourceRef"];
const EVENT_KEYS = new Set([...REQUIRED, ...OPTIONAL]);
const IDENTITY = ["parentId", "name", "role", "layer", "runtime", "model", "tier"];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const TS_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;
// Text that looks like a credential is replaced before anything can render or export it.
const SECRET_RE = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,})/g;

export class ReplayError extends Error {}
const fail = (message) => { throw new ReplayError(message); };
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function makeText(issues) {
  return (v, max, label, { nullable = false, at = null } = {}) => {
    if (nullable && v === null) return null;
    if (typeof v !== "string" || !v.trim() || v.length > max || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(v)) fail(`${at ? `Event ${at}: ` : ""}invalid ${label} (text of at most ${max} characters).`);
    if (!SECRET_RE.test(v)) return v;
    SECRET_RE.lastIndex = 0;
    issues.push({ sequence: at, level: "warn", code: "credential", message: `${label} held credential-like text; it was replaced and is not shown.` });
    return v.replace(SECRET_RE, "[credential removed]");
  };
}
const id = (v, label, at) => (typeof v === "string" && ID_RE.test(v) ? v : fail(`${at ? `Event ${at}: ` : ""}invalid ${label}.`));

function safeRef(ref, at) {
  if (ref.startsWith("https://")) {
    let u;
    try { u = new URL(ref); } catch { fail(`Event ${at}: evidence URL does not parse.`); }
    if (u.hostname !== "github.com" || u.username || u.password || u.search || u.hash || u.port || !/^\/[\w.-]+\/[\w.-]+\/(blob|commit|pull|actions)\//.test(u.pathname)) fail(`Event ${at}: evidence URLs must be GitHub blob, commit, pull or actions links without credentials, query or fragment.`);
    return { label: null, ref, link: true };
  }
  if (!/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(ref) || ref.split("/").some((s) => s === ".." || s === ".")) fail(`Event ${at}: evidence must be a relative artifact path or an approved GitHub URL.`);
  return { label: null, ref, link: false };
}

function checkEvent(e, runId, text) {
  if (!isRecord(e)) fail("Each event must be an object.");
  const at = Number.isInteger(e.sequence) && e.sequence > 0 ? e.sequence : null;
  const where = at ? `Event ${at}: ` : "An event: ";
  const unknown = Object.keys(e).filter((k) => !EVENT_KEYS.has(k));
  if (unknown.length) fail(`${where}unknown fields (${unknown.slice(0, 3).join(", ")}). Raw prompts and tool payloads are not accepted.`);
  const missing = REQUIRED.filter((k) => !(k in e));
  if (missing.length) fail(`${where}missing ${missing.slice(0, 3).join(", ")}; unknown values must be an explicit null.`);
  if (!at || e.sequence > 1e9) fail(`${where}sequence must be a positive integer.`);
  if (e.runId !== runId) fail(`${where}runId does not match the run.`);
  id(e.eventId, "eventId", at); id(e.agentId, "agentId", at);
  if (typeof e.timestamp !== "string" || !TS_RE.test(e.timestamp)) fail(`${where}timestamp must be UTC ISO 8601.`);
  const time = Date.parse(e.timestamp);
  if (!Number.isFinite(time) || new Date(time).toISOString().replace(".000Z", "Z") !== e.timestamp.replace(".000Z", "Z")) fail(`${where}timestamp is not a real calendar time.`);
  if (!KINDS.includes(e.kind)) fail(`${where}unknown kind "${String(e.kind).slice(0, 20)}".`);
  if (!LAYERS.includes(e.layer)) fail(`${where}unknown layer.`);
  const out = {
    runId, eventId: e.eventId, sequence: e.sequence, timestamp: e.timestamp, time, agentId: e.agentId,
    parentId: e.parentId === null ? null : id(e.parentId, "parentId", at),
    name: text(e.name, 60, "name", { nullable: e.layer === "owner", at }),
    role: text(e.role, 60, "role", { at }), layer: e.layer,
    runtime: text(e.runtime, 80, "runtime", { nullable: true, at }), model: text(e.model, 80, "model", { nullable: true, at }), tier: text(e.tier, 80, "tier", { nullable: true, at }),
    kind: e.kind, taskSummary: text(e.taskSummary, 240, "task", { at }),
    relatedAgentId: e.relatedAgentId === null ? null : id(e.relatedAgentId, "relatedAgentId", at),
    reason: text(e.reason, 200, "reason", { nullable: true, at }),
    blockedOn: Array.isArray(e.blockedOn) && e.blockedOn.length <= 8 ? e.blockedOn.map((v) => id(v, "blockedOn", at)) : fail(`${where}blockedOn must list at most eight agent IDs.`),
    commit: e.commit === null ? null : typeof e.commit === "string" && /^[a-f0-9]{7,40}$/.test(e.commit) ? e.commit : fail(`${where}commit must be a lowercase SHA or null.`),
    pr: e.pr === null ? null : typeof e.pr === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d{0,8}$/.test(e.pr) ? e.pr : fail(`${where}pr must be a GitHub pull request URL or null.`),
    evidenceRefs: Array.isArray(e.evidenceRefs) && e.evidenceRefs.length <= 8 ? e.evidenceRefs.map((r) => {
      if (!isRecord(r) || Object.keys(r).some((k) => k !== "label" && k !== "ref")) fail(`${where}evidence must be { label, ref }.`);
      return { ...safeRef(text(r.ref, 240, "evidence reference", { at }), at), label: text(r.label, 80, "evidence label", { at }) };
    }) : fail(`${where}at most eight evidence references.`),
    attempt: e.attempt === undefined ? 1 : Number.isInteger(e.attempt) && e.attempt >= 1 && e.attempt <= 99 ? e.attempt : fail(`${where}attempt must be 1-99.`),
    verdict: e.verdict === undefined || e.verdict === null ? null : ["pass", "bounce"].includes(e.verdict) ? e.verdict : fail(`${where}verdict must be pass, bounce or null.`),
    sourceRef: e.sourceRef === undefined || e.sourceRef === null ? null : isRecord(e.sourceRef) && Object.keys(e.sourceRef).every((k) => k === "log" || k === "line")
      ? { log: text(e.sourceRef.log, 80, "source log", { at }), line: Number.isInteger(e.sourceRef.line) && e.sourceRef.line >= 0 ? e.sourceRef.line : fail(`${where}sourceRef.line must be a whole number.`) }
      : fail(`${where}sourceRef must be { log, line }.`),
    flags: [],
  };
  if (e.layer === "owner" && out.name !== null && !["Bao", "Jiao"].includes(out.name)) fail(`${where}the owner is Bao, Jiao, or null when not recorded.`);
  if (out.kind === "blocked" && !out.reason) fail(`${where}a blocked event needs its recorded reason.`);
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A run object -> { run, issues }. Throws ReplayError when the file is unsafe or of another version. */
export function validateRun(input) {
  if (!isRecord(input)) fail("The file must hold one run object.");
  if (input.schemaVersion !== SCHEMA_VERSION) fail(`Schema version ${JSON.stringify(input.schemaVersion)?.slice(0, 12) ?? "missing"} is not supported; this viewer reads version ${SCHEMA_VERSION}. Nothing was shown.`);
  const unknown = Object.keys(input).filter((k) => !RUN_KEYS.has(k));
  if (unknown.length) fail(`Unknown run fields (${unknown.slice(0, 3).join(", ")}).`);
  if (typeof input.illustrative !== "boolean") fail("The run must say whether it is illustrative (true or false).");
  const issues = [];
  const text = makeText(issues);
  const runId = id(input.runId, "runId");
  const label = text(input.label, 100, "run label");
  const source = input.source === undefined || input.source === null ? null
    : isRecord(input.source) && Object.keys(input.source).every((k) => k === "kind" || k === "description")
      ? { kind: text(input.source.kind, 40, "source kind"), description: text(input.source.description, 300, "source description") } : fail("source must be { kind, description }.");
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > LIMITS.events) fail(`Supply 1-${LIMITS.events} events.`);

  // Duplicates: the first copy of an eventId or sequence stands; a later copy is dropped, and said so.
  const byId = new Map(), bySeq = new Map(), kept = [];
  input.events.forEach((raw, index) => {
    const e = checkEvent(raw, runId, text);
    e.arrival = index;
    const prior = byId.get(e.eventId) ?? bySeq.get(e.sequence);
    if (prior) {
      const exact = same({ ...prior, arrival: 0, flags: [] }, { ...e, arrival: 0, flags: [] });
      issues.push({ sequence: e.sequence, level: exact ? "info" : "warn", code: exact ? "duplicate" : "conflict", message: exact ? `Event ${e.sequence} arrived twice; the copy was dropped and counted once.` : `Event ${e.sequence} (${e.eventId}) conflicts with an earlier event sharing its ID or sequence; the later one was dropped.` });
      return;
    }
    byId.set(e.eventId, e); bySeq.set(e.sequence, e); kept.push(e);
  });

  // Order is the producer's sequence. A late arrival is placed by its sequence and flagged; a gap is never guessed over.
  const events = [...kept].sort((a, b) => a.sequence - b.sequence);
  // Late: some event with a higher sequence arrived before this one.
  let firstLater = Infinity;
  for (const e of [...events].reverse()) {
    if (e.arrival > firstLater) { e.flags.push("late"); issues.push({ sequence: e.sequence, level: "info", code: "late", message: `Event ${e.sequence} arrived after later events; it is shown in sequence order.` }); }
    firstLater = Math.min(firstLater, e.arrival);
  }
  issues.sort((x, y) => (x.sequence ?? 0) - (y.sequence ?? 0));
  let expected = 1, lastTime = -Infinity;
  for (const e of events) {
    if (e.sequence > expected) { e.flags.push("gap"); issues.push({ sequence: e.sequence, level: "warn", code: "gap", message: `Events ${expected}${e.sequence - 1 > expected ? `-${e.sequence - 1}` : ""} are missing; time across the gap is unknown.` }); }
    expected = e.sequence + 1;
    if (e.time < lastTime) { e.flags.push("clock"); issues.push({ sequence: e.sequence, level: "warn", code: "clock", message: `Event ${e.sequence} is timestamped before the event it follows; the interval it closes is unknown.` }); }
    lastTime = Math.max(lastTime, e.time);
  }

  // Structure: checked in order; an event that cannot apply is kept out of the fold and listed.
  const agents = new Map();
  let owner = null;
  const skip = (e, code, message) => { e.flags.push("skipped"); issues.push({ sequence: e.sequence, level: "warn", code, message: `Event ${e.sequence}: ${message}` }); };
  for (const e of events) {
    const a = agents.get(e.agentId);
    if (e.kind === "started" || e.kind === "queued") {
      if (a) {
        const changed = IDENTITY.find((k) => e[k] !== a[k]);
        if (changed) { skip(e, "identity", `${e.agentId}'s ${changed} changed; a different model or parent needs a new agent ID.`); continue; }
        if (e.kind === "started" && a.status === "queued" && e.attempt === a.attempt) { a.status = "started"; continue; }
        if (e.kind === "started" && e.attempt > a.attempt) { a.attempt = e.attempt; a.status = "started"; continue; }
        if (e.kind === "started") skip(e, "restart", `${e.agentId} started again without a new attempt number; ignored so its work is not counted twice.`);
        else skip(e, "order", `${e.agentId} cannot be queued after it started.`);
        continue;
      }
      if (e.layer === "owner") {
        if (owner) { skip(e, "owner", "a second owner; a run has one accountable owner."); continue; }
        if (e.parentId !== null) { skip(e, "owner", "the owner has no parent."); continue; }
        owner = e.agentId;
      } else {
        const parent = agents.get(e.parentId);
        const want = e.layer === "manager" ? "owner" : "manager";
        if (!parent || parent.layer !== want) issues.push({ sequence: e.sequence, level: "warn", code: "parent", message: `Event ${e.sequence}: ${e.agentId}'s parent ${e.parentId ?? "(none)"} had not started as its ${want}.` });
        const siblings = [...agents.values()].filter((x) => x.parentId === e.parentId && x.layer === e.layer).length;
        const cap = e.layer === "manager" ? LIMITS.managers : LIMITS.runnersPerManager;
        if (siblings >= cap) { e.flags.push("over-limit"); issues.push({ sequence: e.sequence, level: "warn", code: "limit", message: `Event ${e.sequence}: ${e.layer} ${siblings + 1} under ${e.parentId}; the hierarchy allows ${cap}.` }); }
      }
      agents.set(e.agentId, { ...Object.fromEntries(IDENTITY.map((k) => [k, e[k]])), layer: e.layer, attempt: e.attempt, status: e.kind });
      continue;
    }
    if (!a) { skip(e, "order", `${e.agentId} has no recorded start.`); continue; }
    const changed = IDENTITY.find((k) => e[k] !== a[k]);
    if (changed) { skip(e, "identity", `${e.agentId}'s ${changed} changed; a different model or parent needs a new agent ID.`); continue; }
    if (e.attempt !== a.attempt) { skip(e, "attempt", `belongs to attempt ${e.attempt} of ${e.agentId}, but attempt ${a.attempt} is current.`); continue; }
    if (TERMINAL.has(a.status)) { skip(e, "terminal", `${e.agentId} already ended (${a.status}); a retry needs a new attempt.`); continue; }
    if (e.relatedAgentId !== null && !agents.has(e.relatedAgentId)) { skip(e, "related", `${e.relatedAgentId} has not started.`); continue; }
    if (e.kind === "completed" && e.layer !== "owner") { skip(e, "completed", "only the owner completes the task."); continue; }
    if (e.kind === "accepted" && e.relatedAgentId) {
      const child = agents.get(e.relatedAgentId);
      if (child.status !== "result") { skip(e, "accept", `${e.relatedAgentId} has no recorded result to accept.`); continue; }
      child.status = "accepted";
      continue;
    }
    if (e.kind === "accepted" && e.layer !== "owner") { skip(e, "accept", "only the owner accepts its own outcome; use completed for the task."); continue; }
    if (!RELATIONAL.has(e.kind) && e.kind !== "review") a.status = e.kind;
    else if (e.kind === "review") a.status = "review";
  }
  if (!owner) issues.push({ sequence: null, level: "warn", code: "owner", message: "No owner started; the tree has no root." });

  const final = owner ? agents.get(owner).status : null;
  const complete = TERMINAL.has(final) && !issues.some((i) => i.code === "gap");
  return { run: { schemaVersion: SCHEMA_VERSION, runId, label, illustrative: input.illustrative, source, events, complete, finalStatus: final }, issues };
}

/** Text from a file -> { run, issues }. */
export function parseRun(raw) {
  if (typeof raw !== "string") fail("Expected the file's text.");
  if (new TextEncoder().encode(raw).length > LIMITS.bytes) fail("The file is over 1 MiB.");
  let value;
  try { value = JSON.parse(raw); } catch { fail("The file is not JSON."); }
  return validateRun(value);
}

// A result handed back but not yet accepted is its own bucket: execution is done, acceptance is not recorded yet.
export const bucketOf = (status) => (WORK.has(status) ? "work" : WAIT.has(status) ? "wait" : status === "result" ? "handoff" : TERMINAL.has(status) ? null : "unknown");
export const isTerminal = (status) => TERMINAL.has(status);
// Which way a handoff travels: down the tree (work given), up (work returned or judged).
export const flowOf = (kind) => (kind === "delegated" || kind === "started" || kind === "rework" ? "down" : kind === "result" || kind === "review" || kind === "accepted" ? "up" : null);

function union(intervals) {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) { const last = out.at(-1); if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]); }
  return out;
}
const total = (spans) => spans.reduce((s, [a, b]) => s + (b - a), 0);
function minus(spans, cut) {
  const out = [];
  for (const [a, b] of spans) {
    let pieces = [[a, b]];
    for (const [c, d] of cut) pieces = pieces.flatMap(([x, y]) => (d <= x || c >= y ? [[x, y]] : [...(c > x ? [[x, c]] : []), ...(d < y ? [[d, y]] : [])]));
    out.push(...pieces);
  }
  return out;
}

/**
 * The run after its first `count` events (skipped events count toward the cursor but change nothing).
 * Times come only from recorded timestamps: an interval runs from one state event to the agent's next, or to the
 * cursor. An interval closed by an event after a gap or clock step is unknown, never work or wait.
 */
export function replay(run, count) {
  const events = run.events.slice(0, Math.max(0, Math.min(run.events.length, count)));
  const nodes = new Map(), segments = [];
  const accrue = (n, time, unknown = false) => {
    // The owner has no parent to hand a result to, so its time after a result is simply not recorded.
    const key = unknown || (n.layer === "owner" && n.status === "result") ? "unknown" : bucketOf(n.status);
    if (key && time > n.since) { n[`${key}Ms`] += time - n.since; segments.push({ agentId: n.agentId, from: n.since, to: time, status: unknown ? "unknown" : n.status, bucket: key }); }
    n.since = Math.max(n.since, time);
  };
  for (const e of events) {
    if (e.flags.includes("skipped")) continue;
    const odd = e.flags.includes("gap") || e.flags.includes("clock");
    let n = nodes.get(e.agentId);
    if (!n) {
      n = { agentId: e.agentId, name: e.name, role: e.role, layer: e.layer, parentId: e.parentId, runtime: e.runtime, model: e.model, tier: e.tier,
        status: e.kind, attempt: e.attempt, restarts: 0, since: e.time, startedAt: e.time, firstSequence: e.sequence,
        workMs: 0, waitMs: 0, handoffMs: 0, unknownMs: 0, reworks: 0, reviews: 0, bounces: 0, reason: e.reason, blockedOn: e.blockedOn,
        taskSummary: e.taskSummary, commit: e.commit, pr: e.pr, evidence: [...e.evidenceRefs], history: [e.sequence], overLimit: e.flags.includes("over-limit") };
      nodes.set(e.agentId, n);
      continue;
    }
    n.history.push(e.sequence);
    n.evidence.push(...e.evidenceRefs);
    if (e.commit) n.commit = e.commit;
    if (e.pr) n.pr = e.pr;
    n.taskSummary = e.taskSummary;
    if (e.kind === "started") { accrue(n, e.time, odd); if (n.status !== "queued") n.restarts++; n.attempt = e.attempt; n.status = "started"; n.reason = e.reason; n.blockedOn = e.blockedOn; continue; }
    if (e.kind === "delegated") continue;
    if (e.kind === "accepted" && e.relatedAgentId) {
      const child = nodes.get(e.relatedAgentId);
      if (child) { accrue(child, e.time, odd); child.status = "accepted"; child.reason = null; child.blockedOn = []; child.history.push(e.sequence); }
      continue;
    }
    if (e.kind === "review" && e.relatedAgentId) {
      const target = nodes.get(e.relatedAgentId);
      if (target) { target.reviews++; if (e.verdict === "bounce") target.bounces++; target.history.push(e.sequence); }
    }
    accrue(n, e.time, odd);
    n.status = e.kind; n.reason = e.reason; n.blockedOn = e.blockedOn;
    if (e.kind === "rework") n.reworks++;
  }
  const applied = events.filter((e) => !e.flags.includes("skipped"));
  const cursorTime = applied.length ? Math.max(...applied.map((e) => e.time)) : null;
  const firstTime = applied.length ? Math.min(...applied.map((e) => e.time)) : null;
  if (cursorTime !== null) for (const n of nodes.values()) accrue(n, cursorTime);

  const working = union(segments.filter((s) => s.bucket === "work").map((s) => [s.from, s.to]));
  const waiting = minus(union(segments.filter((s) => s.bucket === "wait").map((s) => [s.from, s.to])), working);
  const span = cursorTime === null ? 0 : cursorTime - firstTime;
  const task = { spanMs: span, workingMs: total(working), waitingMs: total(waiting), unrecordedMs: Math.max(0, span - total(working) - total(waiting)), firstTime, cursorTime };
  const owner = [...nodes.values()].find((n) => n.layer === "owner") ?? null;
  return { nodes: [...nodes.values()], segments, events, task, owner, atEnd: events.length === run.events.length, outcome: owner && isTerminal(owner.status) ? owner.status : null };
}

/** The tree from a replay's nodes: owner, its managers, each manager's runners; anything unplaced is listed apart. */
export function treeOf(nodes) {
  const owner = nodes.find((n) => n.layer === "owner") ?? null;
  const managers = nodes.filter((n) => n.layer === "manager" && owner && n.parentId === owner.agentId);
  const runners = (m) => nodes.filter((n) => n.layer === "runner" && n.parentId === m.agentId);
  const placed = new Set([owner?.agentId, ...managers.map((m) => m.agentId), ...managers.flatMap((m) => runners(m).map((r) => r.agentId))]);
  return { owner, managers: managers.map((m) => ({ node: m, runners: runners(m) })), unplaced: nodes.filter((n) => !placed.has(n.agentId)) };
}

export function duration(ms) {
  if (ms == null) return "unknown";
  const s = Math.floor(ms / 1000);
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

// The raw event as recorded, for the inspector: the parsed fields, without the viewer's own bookkeeping.
export function rawOf(e) {
  const { time, arrival, flags, ...rest } = e;
  return { ...rest, evidenceRefs: e.evidenceRefs.map(({ label, ref }) => ({ label, ref })) };
}

/** A replayable copy up to the cursor with free text, names, IDs, models, commits and evidence removed. */
export function redactRun(run, count) {
  const ids = new Map();
  const alias = (v) => { if (v === null) return null; if (!ids.has(v)) ids.set(v, `agent-${ids.size + 1}`); return ids.get(v); };
  const events = run.events.slice(0, count).filter((e) => !e.flags.includes("skipped"));
  return { schemaVersion: SCHEMA_VERSION, runId: "redacted-run", label: "Redacted hierarchy replay", illustrative: run.illustrative, source: { kind: "redacted", description: "Exported from the den's replay viewer; free text, IDs and evidence removed." },
    events: events.map((e) => ({
      runId: "redacted-run", eventId: `event-${e.sequence}`, sequence: e.sequence, timestamp: e.timestamp, agentId: alias(e.agentId), parentId: alias(e.parentId),
      name: e.layer === "owner" ? e.name : e.layer === "manager" ? "Manager" : "Runner", role: e.layer, layer: e.layer, runtime: null, model: null, tier: null,
      kind: e.kind, taskSummary: "[redacted]", relatedAgentId: alias(e.relatedAgentId), reason: e.reason === null ? null : "[redacted]", blockedOn: e.blockedOn.map(alias),
      commit: null, pr: null, evidenceRefs: [], attempt: e.attempt, verdict: e.verdict, sourceRef: null,
    })) };
}

export function summarize(run, count) {
  const s = replay(run, count);
  const t = s.task;
  return [
    "# Hierarchy replay snapshot", "",
    run.illustrative ? "Illustrative sample: not a recorded run." : `Recorded run${run.source ? ` (${run.source.kind})` : ""}; the viewer checks structure, not provenance.`,
    `Cursor: event ${count} of ${run.events.length}${s.events.at(-1) ? `, ${s.events.at(-1).timestamp}` : ""}. Outcome: ${s.outcome ?? (run.complete ? "complete" : "no final outcome recorded")}.`,
    `Task span ${duration(t.spanMs)}: some agent working ${duration(t.workingMs)}, recorded waiting with nobody working ${duration(t.waitingMs)}, neither recorded ${duration(t.unrecordedMs)}.`,
    "Agent times overlap across parallel branches. Unknown is not waiting. No critical path is claimed.", "",
    "| Agent | Layer | State | Working | Waiting | Handed back | Unknown | Attempts | Reworks | Reviews (bounced) |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...s.nodes.map((n, i) => `| ${n.layer === "owner" ? n.name ?? "Owner" : `Agent ${i}`} | ${n.layer} | ${n.status} | ${duration(n.workMs)} | ${duration(n.waitMs)} | ${duration(n.handoffMs)} | ${duration(n.unknownMs)} | ${n.attempt} | ${n.reworks} | ${n.reviews} (${n.bounces}) |`), "",
    "Names, tasks, reasons, commits and evidence are omitted from this summary.", "",
  ].join("\n");
}
