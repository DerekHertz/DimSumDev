// Hierarchy audit replay: the contract's checks and how times are derived, as pure functions.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRun, validateRun, replay, treeOf, redactRun, summarize, rawOf, ReplayError, LIMITS } from "./replay-core.mjs";
import { SAMPLE_RUN } from "./sample-run.mjs";

const clone = (v) => structuredClone(v);
const node = (state, id) => state.nodes.find((n) => n.agentId === id);
const freeze = (v) => { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
// A small run: owner, one manager doing 60s of work, 30s of waiting, then a result the owner accepts.
const ev = (sequence, seconds, agentId, kind, o = {}) => ({
  runId: "t-run", eventId: `e${sequence}`, sequence, timestamp: new Date(Date.UTC(2026, 9, 21, 9, 0, seconds)).toISOString(),
  agentId, parentId: agentId === "own" ? null : o.parentId ?? "own", name: agentId === "own" ? "Bao" : agentId, role: agentId === "own" ? "owner" : "developer",
  layer: agentId === "own" ? "owner" : o.layer ?? "manager", runtime: null, model: null, tier: null, kind, taskSummary: o.task ?? "task",
  relatedAgentId: o.related ?? null, reason: o.reason ?? null, blockedOn: o.blockedOn ?? [], commit: null, pr: null, evidenceRefs: o.evidence ?? [],
  attempt: o.attempt ?? 1, verdict: o.verdict ?? null, sourceRef: null,
});
const small = () => ({ schemaVersion: 1, runId: "t-run", label: "test", illustrative: true, events: [
  ev(1, 0, "own", "started"), ev(2, 0, "dev", "started"), ev(3, 0, "own", "delegated", { related: "dev" }), ev(4, 0, "dev", "working"),
  ev(5, 60, "dev", "waiting", { reason: "needs a decision", blockedOn: ["own"] }), ev(6, 90, "dev", "result", { related: "own" }),
  ev(7, 100, "own", "accepted", { related: "dev" }), ev(8, 110, "own", "completed"),
] });
const times = (state, id) => { const n = node(state, id); return { work: n.workMs / 1000, wait: n.waitMs / 1000, back: n.handoffMs / 1000, unknown: n.unknownMs / 1000 }; };

describe("the illustrative sample", () => {
  const { run, issues } = validateRun(clone(SAMPLE_RUN));
  const end = replay(run, run.events.length);
  test("is labelled illustrative, reads cleanly and reaches a final outcome", () => {
    assert.equal(run.illustrative, true);
    assert.deepEqual(issues, []);
    assert.equal(run.complete, true);
    assert.equal(end.outcome, "completed");
  });
  test("shows delegation, waiting, a bounced review and rework, acceptance, failure, cancellation and a restart", () => {
    const kinds = new Set(run.events.map((e) => e.kind));
    for (const k of ["delegated", "waiting", "blocked", "awaiting", "queued", "rework", "accepted", "failed", "cancelled", "completed"]) assert.ok(kinds.has(k), k);
    assert.ok(run.events.some((e) => e.kind === "review" && e.verdict === "bounce"));
    const inspector = node(end, "r-inspector");
    assert.equal(inspector.attempt, 2);
    assert.equal(inspector.restarts, 1);
    assert.equal(inspector.reworks, 2);
    assert.equal(inspector.bounces, 1);
    assert.equal(node(end, "r-import").status, "failed");
    assert.equal(node(end, "r-polish").status, "cancelled");
  });
  test("the inspector runner's time is the recorded intervals, the restart adding nothing twice", () => {
    // working 40-120 and 210-300, rework 320-360 and 370-430: 270s; blocked 120-210: 90s; results 300-320, 430-445: 35s.
    assert.deepEqual(times(end, "r-inspector"), { work: 270, wait: 90, back: 35, unknown: 0 });
  });
  test("stays within one owner, four managers and four runners each", () => {
    const tree = treeOf(end.nodes);
    assert.equal(tree.owner.name, "Jiao");
    assert.ok(tree.managers.length <= LIMITS.managers);
    for (const m of tree.managers) assert.ok(m.runners.length <= LIMITS.runnersPerManager);
    assert.deepEqual(tree.unplaced, []);
  });
});

describe("work and wait", () => {
  test("come from explicit state events; a result is handed back, not waiting", () => {
    const { run } = validateRun(small());
    assert.deepEqual(times(replay(run, 8), "dev"), { work: 60, wait: 30, back: 10, unknown: 0 });
  });
  test("task time splits into someone working, only waiting, and neither recorded", () => {
    const { run } = validateRun(small());
    const t = replay(run, 8).task;
    assert.deepEqual([t.spanMs, t.workingMs, t.waitingMs, t.unrecordedMs].map((v) => v / 1000), [110, 60, 30, 20]);
  });
  test("a prefix ends at the cursor: no outcome, nothing counted past the last event", () => {
    const { run } = validateRun(small());
    const mid = replay(run, 5);
    assert.equal(mid.outcome, null);
    assert.equal(mid.atEnd, false);
    assert.deepEqual(times(mid, "dev"), { work: 60, wait: 0, back: 0, unknown: 0 });
  });
  test("a run with no final outcome is marked incomplete", () => {
    const raw = small(); raw.events = raw.events.slice(0, 6);
    assert.equal(validateRun(raw).run.complete, false);
  });
  test("an interval closed after a gap is unknown, and the run is not complete", () => {
    const raw = small(); raw.events = raw.events.filter((e) => e.sequence !== 5);
    const { run, issues } = validateRun(raw);
    assert.ok(issues.some((i) => i.code === "gap" && /Events 5 are missing/.test(i.message)));
    assert.equal(run.complete, false);
    assert.deepEqual(times(replay(run, run.events.length), "dev"), { work: 0, wait: 0, back: 10, unknown: 90 });
  });
  test("a timestamp that steps backwards makes its interval unknown, never negative", () => {
    const raw = small(); raw.events[5].timestamp = "2026-10-21T09:00:30.000Z";
    const { run, issues } = validateRun(raw);
    assert.ok(issues.some((i) => i.code === "clock"));
    const t = times(replay(run, run.events.length), "dev");
    assert.ok(Object.values(t).every((v) => v >= 0));
    assert.equal(t.wait, 0);
  });
});

describe("duplicates, late arrivals and restarts", () => {
  const base = replay(validateRun(small()).run, 8);
  test("an exact duplicate is dropped once and counted once", () => {
    const raw = small(); raw.events.splice(5, 0, clone(raw.events[3]));
    const { run, issues } = validateRun(raw);
    assert.equal(run.events.length, 8);
    assert.equal(issues[0].code, "duplicate");
    assert.deepEqual(times(replay(run, 8), "dev"), times(base, "dev"));
  });
  test("a conflicting duplicate is dropped and flagged as a warning", () => {
    const raw = small(); raw.events.push({ ...clone(raw.events[4]), kind: "working" });
    const { issues } = validateRun(raw);
    assert.equal(issues[0].code, "conflict");
    assert.equal(issues[0].level, "warn");
  });
  test("a late arrival is placed by sequence and flagged", () => {
    const raw = small(); const [late] = raw.events.splice(4, 1); raw.events.push(late);
    const { run, issues } = validateRun(raw);
    assert.ok(issues.some((i) => i.code === "late" && i.sequence === 5));
    assert.deepEqual(times(replay(run, 8), "dev"), times(base, "dev"));
  });
  test("a second start without a new attempt is ignored, so work is not counted twice", () => {
    const raw = small(); raw.events.splice(4, 0, ev(99, 30, "dev", "started"));
    raw.events.forEach((e, i) => { e.sequence = i + 1; e.eventId = `e${i + 1}`; });
    const { run, issues } = validateRun(raw);
    assert.ok(issues.some((i) => i.code === "restart"));
    const n = node(replay(run, run.events.length), "dev");
    assert.equal(n.restarts, 0);
    assert.equal(n.workMs, 60000);
  });
  test("a new attempt after failure is a restart; events of the old attempt are refused", () => {
    const raw = { ...small(), events: [ev(1, 0, "own", "started"), ev(2, 0, "dev", "started"), ev(3, 0, "dev", "working"), ev(4, 20, "dev", "failed", { reason: "exit" }),
      ev(5, 30, "dev", "working"), ev(6, 40, "dev", "started", { attempt: 2 }), ev(7, 40, "dev", "working", { attempt: 2 }), ev(8, 70, "dev", "result", { attempt: 2, related: "own" })] };
    const { run, issues } = validateRun(raw);
    assert.ok(issues.some((i) => i.code === "terminal" && i.sequence === 5));
    const n = node(replay(run, 8), "dev");
    assert.equal(n.attempt, 2);
    assert.equal(n.restarts, 1);
    assert.equal(n.workMs, 50000);
  });
  test("more than four managers is shown as over the limit, not refused", () => {
    const raw = small();
    for (let i = 0; i < 5; i++) raw.events.push(ev(9 + i, 120, `m${i}`, "started"));
    raw.events.splice(7, 1); raw.events.forEach((e, i) => { e.sequence = i + 1; e.eventId = `e${i + 1}`; });
    const { issues } = validateRun(raw);
    assert.equal(issues.filter((i) => i.code === "limit").length, 2);
  });
});

describe("what the viewer refuses", () => {
  test("an unknown schema version shows nothing", () => {
    assert.throws(() => validateRun({ ...small(), schemaVersion: 2 }), (e) => e instanceof ReplayError && /version 2 is not supported/.test(e.message));
  });
  test("unknown fields, such as a raw prompt, are refused", () => {
    const raw = small(); raw.events[0].prompt = "x";
    assert.throws(() => validateRun(raw), /unknown fields \(prompt\)/);
  });
  test("a missing field must be an explicit null", () => {
    const raw = small(); delete raw.events[0].model;
    assert.throws(() => validateRun(raw), /missing model/);
  });
  test("evidence links outside GitHub artifact paths are refused", () => {
    const raw = small(); raw.events[5].evidenceRefs = [{ label: "x", ref: "https://evil.example/pull/1" }];
    assert.throws(() => validateRun(raw), /GitHub/);
    raw.events[5].evidenceRefs = [{ label: "x", ref: "../../etc/passwd" }];
    assert.throws(() => validateRun(raw), /relative artifact path/);
  });
  test("credential-like text is replaced before it can render", () => {
    const raw = small(); raw.events[4].reason = `token ${"ghp"}_${"a1".repeat(15)} leaked`; // built here so secret scanners do not flag a fake
    const { run, issues } = validateRun(raw);
    assert.equal(run.events[4].reason, "token [credential removed] leaked");
    assert.ok(issues.some((i) => i.code === "credential"));
  });
  test("a file over 1 MiB or not JSON is refused", () => {
    assert.throws(() => parseRun("x".repeat(LIMITS.bytes + 1)), /1 MiB/);
    assert.throws(() => parseRun("{"), /not JSON/);
  });
});

describe("replay is read-only and repeatable", () => {
  test("seeking and replaying never changes the run and gives the same answer", () => {
    const { run } = validateRun(clone(SAMPLE_RUN));
    freeze(run);
    const a = replay(run, 30), b = (replay(run, run.events.length), replay(run, 30));
    assert.deepEqual(a, b);
  });
  test("the inspector's raw event is the recorded event", () => {
    const { run } = validateRun(clone(SAMPLE_RUN));
    assert.deepEqual(rawOf(run.events[10]), SAMPLE_RUN.events[10]);
  });
  test("a redacted export re-imports with the same times and no free text", () => {
    const { run } = validateRun(clone(SAMPLE_RUN));
    const red = redactRun(run, run.events.length);
    const text = JSON.stringify(red);
    assert.ok(!/Inspector|timestamp label|illustrative standard/.test(text));
    const again = validateRun(red).run;
    const t = (r) => replay(r, r.events.length).nodes.map((n) => [n.workMs, n.waitMs, n.handoffMs, n.unknownMs]);
    assert.deepEqual(t(again), t(run));
    assert.match(summarize(run, run.events.length), /Illustrative sample: not a recorded run\./);
  });
});

describe("the recorded run bundled with the den", () => {
  const recorded = parseRun(readFileSync(new URL("./runs/team-and-den-ux-50.json", import.meta.url), "utf8"));
  test("is not illustrative, completes, and every event names its board line", () => {
    assert.equal(recorded.run.illustrative, false);
    assert.equal(recorded.run.complete, true);
    assert.ok(recorded.run.events.every((e) => e.sourceRef?.log === ".scratch/events.jsonl" && e.sourceRef.line > 0));
  });
  test("replays the developer's rework and the second review round", () => {
    const end = replay(recorded.run, recorded.run.events.length);
    const dev = node(end, "developer");
    assert.equal(dev.attempt, 2);
    assert.equal(dev.reworks, 1);
    assert.equal(dev.reviews, 6);
    assert.equal(end.outcome, "completed");
    assert.ok(recorded.issues.every((i) => i.code === "limit"), "a flat relay uses more than four managers");
  });
});
