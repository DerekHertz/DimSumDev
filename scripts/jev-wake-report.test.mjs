// organism-infra/72: wake go-live bar encoded in jev-report.mjs (ADR 0015 decision 6).
//
// Seam: exported buildReport(rows, events) must include report.wake, and
//   formatReport(report) must print wake pass/fail lines.
//
// Pinned contract (developer implements against this):
//   report.wake = {
//     rows: number,           // total wake jev rows
//     informational: number,  // rows where pick === "informational"
//     fallbacks: number,      // non-cap fallbacks
//     capFired: number,
//     medianMs: number,
//     missedWakes: string[],  // tickets labeled "informational" where orchestrator later acted
//     checks: {
//       coverage: boolean,    // rows >= 15 AND fallbacks*5 <= rows AND medianMs < 2000
//       safety: boolean,      // missedWakes.length === 0
//       spend: boolean,       // capFired === 0
//     }
//   }
//
//   "Orchestrator later acted" = a board event (op: "claim", "comment", or "release") on the
//   same ticket (same feature/NN key) with ts after the wake row's ts.
//
//   formatReport prints three lines for wake (in any order):
//     "wake coverage: PASS|FAIL ..."
//     "wake safety: PASS|FAIL ..."
//     "wake spend: PASS|FAIL ..."
//
//   Only the latest wake row per ticket counts (consistent with tier/verify treatment).
//   Rows with fallback "cap" count toward capFired but not fallbacks.
import { test } from "node:test";
import assert from "node:assert/strict";

const load = () => import("./jev-report.mjs");

const T0 = "2026-09-30T08:00:00Z";
const T1 = "2026-09-30T09:00:00Z"; // wake row time
const T2 = "2026-09-30T10:00:00Z"; // event time (after wake)
const BEFORE = "2026-09-30T07:00:00Z"; // before the wake row

function wakeRow(n, pick, over = {}) {
  const ticket = `feat/${String(n).padStart(2, "0")}-t${n}`;
  return {
    kind: "jev",
    point: "wake",
    ticket,
    pick: pick ?? null,
    actual: pick ? pick : null,
    fallback: pick ? null : (over.fallback ?? "timeout"),
    cost: 0.0003,
    ms: 400,
    ts: T1,
    mode: "shadow",
    model: "jev-1.13.0",
    ...over,
  };
}

function event(n, op, ts = T2) {
  return {
    feature: "feat",
    ticket: `${String(n).padStart(2, "0")}-t${n}`,
    role: "orchestrator",
    op,
    ts,
  };
}

// ─── report.wake exists and has the right shape ────────────────────────────────

test("buildReport includes a report.wake object with checks", async () => {
  const { buildReport } = await load();
  const report = buildReport([wakeRow(1, "informational")], []);
  assert.ok(report.wake !== undefined, "report.wake must exist");
  const { checks } = report.wake;
  assert.ok("coverage" in checks, "checks.coverage required");
  assert.ok("safety" in checks, "checks.safety required");
  assert.ok("spend" in checks, "checks.spend required");
  assert.ok(typeof checks.coverage === "boolean");
  assert.ok(typeof checks.safety === "boolean");
  assert.ok(typeof checks.spend === "boolean");
});

// ─── AC5: coverage check: rows >= 15, fallbacks*5 <= rows, medianMs < 2000 ────

test("coverage passes with 15 non-fallback rows and medianMs < 2000", async () => {
  const { buildReport } = await load();
  const rows = Array.from({ length: 15 }, (_, i) => wakeRow(i + 1, "informational", { ms: 400 }));
  const { wake } = buildReport(rows, []);
  assert.equal(wake.rows, 15);
  assert.equal(wake.checks.coverage, true, "15 rows at fast median should pass coverage");
});

test("coverage fails with fewer than 15 rows", async () => {
  const { buildReport } = await load();
  const rows = Array.from({ length: 14 }, (_, i) => wakeRow(i + 1, "informational"));
  const { wake } = buildReport(rows, []);
  assert.equal(wake.checks.coverage, false, "14 rows must fail coverage");
});

test("coverage fails when more than 1 in 5 rows are non-cap fallbacks", async () => {
  const { buildReport } = await load();
  // 15 rows, 4 fallbacks → 4*5=20 > 15 → fail
  const rows = [
    ...Array.from({ length: 11 }, (_, i) => wakeRow(i + 1, "informational")),
    ...Array.from({ length: 4 }, (_, i) => wakeRow(i + 12, null, { fallback: "timeout" })),
  ];
  const { wake } = buildReport(rows, []);
  assert.equal(wake.checks.coverage, false, "too many fallbacks must fail coverage");
});

test("coverage fails when medianMs >= 2000", async () => {
  const { buildReport } = await load();
  const rows = Array.from({ length: 15 }, (_, i) => wakeRow(i + 1, "informational", { ms: 2000 }));
  const { wake } = buildReport(rows, []);
  assert.equal(wake.checks.coverage, false, "medianMs >= 2000 must fail coverage");
});

test("cap fallbacks count toward capFired but not fallbacks", async () => {
  const { buildReport } = await load();
  // 15 rows: 14 normal + 1 cap. Fallbacks = 0, capFired = 1. Coverage: 0*5<=15 OK, capFired=1.
  const rows = [
    ...Array.from({ length: 14 }, (_, i) => wakeRow(i + 1, "informational")),
    wakeRow(15, null, { fallback: "cap" }),
  ];
  const { wake } = buildReport(rows, []);
  assert.equal(wake.fallbacks, 0, "cap fallback must not count as a fallback");
  assert.equal(wake.capFired, 1);
  assert.equal(wake.checks.spend, false, "capFired must fail the spend check");
});

// ─── AC5: safety check: no missed wakes ───────────────────────────────────────

test("safety passes when no informational row is followed by an orchestrator action", async () => {
  const { buildReport } = await load();
  const rows = Array.from({ length: 15 }, (_, i) => wakeRow(i + 1, "informational"));
  // Events on different tickets or before the wake row
  const events = [event(99, "claim", T2), event(1, "claim", BEFORE)];
  const { wake } = buildReport(rows, events);
  assert.equal(wake.checks.safety, true);
  assert.deepEqual(wake.missedWakes, []);
});

test("safety fails when orchestrator claims a ticket labeled informational after the wake row", async () => {
  const { buildReport } = await load();
  const rows = [wakeRow(1, "informational", { ts: T1 })];
  const events = [event(1, "claim", T2)]; // T2 > T1 = missed wake
  const { wake } = buildReport(rows, events);
  assert.equal(wake.checks.safety, false, "a post-wake claim must fail safety");
  assert.equal(wake.missedWakes.length, 1);
});

test("safety fails when orchestrator comments on a ticket labeled informational after the wake row", async () => {
  const { buildReport } = await load();
  const rows = [wakeRow(1, "informational", { ts: T1 })];
  const events = [event(1, "comment", T2)];
  const { wake } = buildReport(rows, events);
  assert.equal(wake.checks.safety, false);
  assert.equal(wake.missedWakes.length, 1);
});

test("safety is not affected by events before the wake row", async () => {
  const { buildReport } = await load();
  const rows = [wakeRow(1, "informational", { ts: T1 })];
  const events = [event(1, "claim", BEFORE)]; // before T1 → not a missed wake
  const { wake } = buildReport(rows, events);
  assert.equal(wake.checks.safety, true);
  assert.deepEqual(wake.missedWakes, []);
});

test("needs-claude rows never count as missed wakes", async () => {
  const { buildReport } = await load();
  const rows = [wakeRow(1, "needs-claude", { ts: T1 })];
  const events = [event(1, "claim", T2)];
  const { wake } = buildReport(rows, events);
  assert.equal(wake.checks.safety, true, "needs-claude is not an informational label");
  assert.deepEqual(wake.missedWakes, []);
});

// ─── AC5: spend check ─────────────────────────────────────────────────────────

test("spend passes when no cap rows appear", async () => {
  const { buildReport } = await load();
  const rows = Array.from({ length: 15 }, (_, i) => wakeRow(i + 1, "informational"));
  const { wake } = buildReport(rows, []);
  assert.equal(wake.capFired, 0);
  assert.equal(wake.checks.spend, true);
});

test("spend fails when any cap row appears", async () => {
  const { buildReport } = await load();
  const rows = [
    ...Array.from({ length: 14 }, (_, i) => wakeRow(i + 1, "informational")),
    wakeRow(15, null, { fallback: "cap" }),
  ];
  const { wake } = buildReport(rows, []);
  assert.equal(wake.capFired, 1);
  assert.equal(wake.checks.spend, false);
});

// ─── Counts are correct ────────────────────────────────────────────────────────

test("informational count reflects rows with pick 'informational' only", async () => {
  const { buildReport } = await load();
  const rows = [
    wakeRow(1, "informational"),
    wakeRow(2, "informational"),
    wakeRow(3, "needs-claude"),
    wakeRow(4, null, { fallback: "timeout" }),
  ];
  const { wake } = buildReport(rows, []);
  assert.equal(wake.rows, 4);
  assert.equal(wake.informational, 2);
});

// ─── formatReport includes wake pass/fail lines ────────────────────────────────

test("formatReport prints 'wake coverage: PASS' and 'wake safety: PASS' and 'wake spend: PASS'", async () => {
  const { buildReport, formatReport } = await load();
  const rows = Array.from({ length: 15 }, (_, i) => wakeRow(i + 1, "informational", { ms: 300 }));
  const out = formatReport(buildReport(rows, []));
  assert.match(out, /wake coverage: PASS/i, "formatReport must include wake coverage PASS");
  assert.match(out, /wake safety: PASS/i, "formatReport must include wake safety PASS");
  assert.match(out, /wake spend: PASS/i, "formatReport must include wake spend PASS");
});

test("formatReport prints 'wake coverage: FAIL' when coverage fails", async () => {
  const { buildReport, formatReport } = await load();
  const rows = Array.from({ length: 5 }, (_, i) => wakeRow(i + 1, "informational"));
  const out = formatReport(buildReport(rows, []));
  assert.match(out, /wake coverage: FAIL/i);
});

test("formatReport prints 'wake safety: FAIL' when a missed wake exists", async () => {
  const { buildReport, formatReport } = await load();
  const rows = [wakeRow(1, "informational", { ts: T1 })];
  const events = [event(1, "claim", T2)];
  const out = formatReport(buildReport(rows, events));
  assert.match(out, /wake safety: FAIL/i);
});
