// Hierarchy audit replay: a recorded run derived from board rows, and the bundled run checked against its source.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fromBoardEvents } from "./hierarchy-replay-export.mjs";
import { validateRun, replay } from "../apps/ui/src/audit/replay-core.mjs";

const at = (m) => `2026-10-21T10:${String(m).padStart(2, "0")}:00.000Z`;
const row = (seq, m, op, role, more = {}) => ({ seq, ts: at(m), feature: "f", ticket: "07-thing", role, op, ...more });
const ROWS = [
  row(1, 0, "create", null, { to_status: "ready-for-agent" }),
  row(2, 1, "claim", "developer"),
  row(3, 9, "comment", "developer", { text: `committed abc1234def; handoffs/07-developer.md. token ${"ghp"}_${"s3".repeat(13)}` }),
  row(4, 10, "release", "developer", { to_status: "in-review" }),
  row(5, 12, "claim", "code-reviewer"),
  row(6, 15, "comment", "code-reviewer", { text: "bounce at abc1234def: missing test", verdict: "bounce" }),
  row(7, 15, "release", "code-reviewer", { to_status: "claimed" }),
  row(8, 16, "claim", "developer"),
  row(9, 20, "release", "developer", { to_status: "in-review" }),
  row(10, 21, "claim", "orchestrator"),
  row(11, 22, "release", "orchestrator", { to_status: "resolved" }),
  { seq: 12, ts: at(23), feature: "f", ticket: "08-other", role: "qa", op: "claim" },
];

describe("a run from board rows", () => {
  const raw = fromBoardEvents({ ref: "f/07-thing", rows: ROWS, usageRows: [{ kind: "agent", ticket: "f/07-thing", role: "developer", model: "claude-sonnet-5-5" }] });
  const { run, issues } = validateRun(raw);
  test("reads as a valid, complete, recorded run with no issues", () => {
    assert.equal(run.illustrative, false);
    assert.deepEqual(issues, []);
    assert.equal(run.complete, true);
    assert.equal(run.source.kind, "board-events");
  });
  test("a second developer claim is rework on a new attempt, after a bounced review", () => {
    const end = replay(run, run.events.length);
    const dev = end.nodes.find((n) => n.agentId === "developer");
    assert.equal(dev.attempt, 2);
    assert.equal(dev.reworks, 1);
    assert.equal(dev.bounces, 1);
    assert.equal(dev.model, "claude-sonnet-5-5");
    assert.equal(dev.workMs, (9 + 4) * 60000);
  });
  test("a second developer turn with no bounce before it is working, not rework", () => {
    const rows = ROWS.map((r) => (r.seq === 6 ? { ...r, verdict: "pass" } : r));
    const dev = replay(validateRun(fromBoardEvents({ ref: "f/07-thing", rows })).run, 99).nodes.find((n) => n.agentId === "developer");
    assert.equal(dev.attempt, 2);
    assert.equal(dev.reworks, 0);
  });
  test("a ticket whose name contains credential-like letters still exports to a run the viewer opens", () => {
    const rows = ROWS.map((r) => ({ ...r, ticket: "55-risk-path-guardrail-tickets" }));
    assert.equal(validateRun(fromBoardEvents({ ref: "f/55-risk-path-guardrail-tickets", rows })).run.complete, true);
  });
  test("a park reason is copied with credential-like text removed", () => {
    const rows = [...ROWS.slice(0, 2), row(3, 2, "park", null, { reason: `waiting on ${"ghp"}_${"q7".repeat(12)} rotation` })];
    const blocked = fromBoardEvents({ ref: "f/07-thing", rows }).events.find((e) => e.kind === "blocked");
    assert.equal(blocked.reason, "waiting on [credential removed] rotation");
  });
  test("comment text is never copied; the cited commit and handoff path are", () => {
    const text = JSON.stringify(raw);
    assert.ok(!/ghp_|missing test|committed/.test(text));
    const result = raw.events.find((e) => e.agentId === "developer" && e.kind === "result");
    assert.equal(result.commit, "abc1234def");
    assert.deepEqual(result.evidenceRefs, [{ label: "handoff", ref: "f/handoffs/07-developer.md" }]);
  });
  test("the owner's name is not guessed and other tickets' rows are left out", () => {
    assert.equal(raw.events[0].name, null);
    assert.ok(raw.events.every((e) => e.sourceRef.seq <= 11));
    assert.equal(fromBoardEvents({ ref: "f/07-thing", rows: ROWS, owner: "Jiao" }).events[0].name, "Jiao");
  });
  test("the same rows always give the same run", () => {
    assert.deepEqual(fromBoardEvents({ ref: "f/07-thing", rows: ROWS }), fromBoardEvents({ ref: "f/07-thing", rows: [...ROWS].reverse() }));
  });
});

// The bundled run is regenerated from the den's board when one is present (not in CI): it must match exactly, and each
// event's time and role must be the board line it names.
const denRoot = process.env.DEN_ROOT || path.resolve(fileURLToPath(new URL("../", import.meta.url)), "../../..");
const log = path.join(denRoot, ".scratch", "events.jsonl");
describe("the bundled recorded run", { skip: existsSync(log) ? false : "no den board here" }, () => {
  test("matches the board log it was exported from", () => {
    const bundled = JSON.parse(readFileSync(new URL("../apps/ui/src/audit/runs/team-and-den-ux-50.json", import.meta.url), "utf8"));
    const rows = readFileSync(log, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    const bySeq = new Map(rows.map((r) => [r.seq, r]));
    for (const e of bundled.events) {
      const r = bySeq.get(e.sourceRef.seq);
      assert.ok(r, `seq ${e.sourceRef.seq}`);
      assert.equal(e.timestamp, r.ts);
      assert.equal(`${r.feature}/${r.ticket}`, "team-and-den-ux/50-terrain-clearance-only");
      if (e.agentId !== "owner") assert.equal(e.role, r.role);
    }
    const again = fromBoardEvents({ ref: "team-and-den-ux/50-terrain-clearance-only", rows, owner: null, pr: "https://github.com/DerekHertz/dimsumden/pull/384" });
    assert.deepEqual(again.events, bundled.events);
  });
});
