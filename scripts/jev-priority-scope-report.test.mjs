// organism-infra/71: jev-report.mjs priority/scope additions (ADR 0015 decision 4).
//
// Pinned contract:
//
// buildReport(rows, events) now also populates:
//   report.priority = {
//     rows,          // count of kind:"jev" point:"priority" rows
//     flagged,       // rows where pick = "mismatch"
//     flagRate,      // flagged / rows (0 when rows = 0)
//     checks: { flagging: boolean }  // PASS when ≥70% user-verdict-right AND ≥10 flags
//   }
//   report.scope = {
//     rows,               // scope rows with a non-zero baseline ticket (has tercile ground truth)
//     sameTercile,        // rows where Jev's label matches the tercile label
//     sameTercileRate,    // sameTercile / rows (0 when rows = 0)
//     smallWasLargeInLast10, // count in the most recent 10 scope rows where pick="small" and tercile="large"
//                            //   OR pick="large" and tercile="small"
//     checks: { scope: boolean }  // PASS when ≥60% same-tercile AND ≥20 rows AND smallWasLargeInLast10 = 0
//   }
//
// Tercile computation:
//   - Collect baseline (sum of tokens from kind:"agent" rows) for each ticket.
//   - Exclude tickets with baseline = 0 or no agent rows.
//   - Sort baselines ascending. Split into three equal-ish thirds (floor rounding for bottom and middle).
//   - Bottom third → "small", middle third → "medium", top third → "large".
//   - Recomputed each run from usage.jsonl.
//
// Priority go-live bar ("flagging"):
//   - Uses kind:"jev-priority-verdict" rows: {ticket, right: true|false, ts}.
//   - flagVerdict = verdicts where right === true, divided by total verdicts.
//   - PASS when flagVerdict >= 0.70 AND verdict count >= 10.
//   - If no verdict rows: FAIL.
//
// Scope go-live bar:
//   - PASS when sameTercileRate >= 0.60 AND rows >= 20 AND smallWasLargeInLast10 = 0.
//
// formatReport additions:
//   "priority flagging: PASS|FAIL (N verdicts, X% right; M flags)"
//   "scope: PASS|FAIL (N rows, X% same-tercile, Y small-vs-large in last 10)"
import { test } from "node:test";
import assert from "node:assert/strict";

const load = () => import("./jev-report.mjs");

const T0 = "2026-09-30T00:00:00Z";
const T1 = "2026-09-30T00:05:00Z";
const T2 = "2026-09-30T00:10:00Z";

function agentRow(ticket, tokens, role = "developer") {
  return { kind: "agent", ticket, role, tokens, ts: T0 };
}
function jevPriority(ticket, pick, over = {}) {
  return { kind: "jev", point: "priority", ticket, pick, fallback: pick ? null : "no-line", ts: T1, cost: 0.0003, ms: 300, ...over };
}
function jevScope(ticket, pick, over = {}) {
  return { kind: "jev", point: "scope", ticket, pick, fallback: pick ? null : "no-key", ts: T1, cost: 0.0003, ms: 300, ...over };
}
function priorityVerdict(ticket, right, ts = T2) {
  return { kind: "jev-priority-verdict", ticket, right, ts };
}

// ---- Criterion 3: tercile computation ----

test("tercile splits non-zero baseline tickets into small/medium/large thirds", async () => {
  const { buildReport } = await load();
  // 6 tickets, baselines 10,20,30,40,50,60 → bottom 2 = small (10,20), mid 2 = medium (30,40), top 2 = large (50,60)
  const rows = [
    agentRow("feat/01", 10), agentRow("feat/02", 20), agentRow("feat/03", 30),
    agentRow("feat/04", 40), agentRow("feat/05", 50), agentRow("feat/06", 60),
  ];
  const rep = buildReport(rows, []);
  // Add a scope row for each ticket and check the same-tercile logic is computed
  const scoped = [
    ...rows,
    jevScope("feat/01", "small"),   // baseline 10 → small tercile → match
    jevScope("feat/02", "small"),   // baseline 20 → small tercile → match
    jevScope("feat/03", "medium"),  // baseline 30 → medium tercile → match
    jevScope("feat/04", "large"),   // baseline 40 → medium tercile → miss
    jevScope("feat/05", "large"),   // baseline 50 → large tercile → match
    jevScope("feat/06", "large"),   // baseline 60 → large tercile → match
  ];
  const r = buildReport(scoped, []).scope;
  assert.equal(r.rows, 6);
  assert.equal(r.sameTercile, 5); // feat/04 missed (large vs medium)
  assert.ok(Math.abs(r.sameTercileRate - 5 / 6) < 0.001);
});

test("tercile excludes 0-baseline tickets from tercile computation and from scope rows", async () => {
  const { buildReport } = await load();
  const rows = [
    agentRow("feat/01", 100), agentRow("feat/02", 200),
    // feat/03 has no agent rows (0 baseline)
    jevScope("feat/01", "small"),
    jevScope("feat/02", "large"),
    jevScope("feat/03", "small"), // no baseline → excluded from scope metrics
  ];
  const r = buildReport(rows, []).scope;
  // Only feat/01 and feat/02 have baselines; feat/03 excluded
  assert.equal(r.rows, 2);
});

test("tercile is recomputed each run: same rows always give same result", async () => {
  const { buildReport } = await load();
  const rows = [
    agentRow("feat/01", 10), agentRow("feat/02", 50), agentRow("feat/03", 100),
    jevScope("feat/01", "small"),
    jevScope("feat/02", "medium"),
    jevScope("feat/03", "large"),
  ];
  const r1 = buildReport(rows, []).scope;
  const r2 = buildReport(rows, []).scope;
  assert.equal(r1.sameTercile, r2.sameTercile);
  assert.equal(r1.rows, r2.rows);
});

// ---- Criterion 3: small-vs-large misses in the last 10 ----

test("smallWasLargeInLast10: counts rows where pick=small but tercile=large, or pick=large but tercile=small", async () => {
  const { buildReport } = await load();
  // 3 tickets: feat/01 (baseline 10=small), feat/02 (baseline 50=medium), feat/03 (baseline 100=large)
  const agentRows = [agentRow("feat/01", 10), agentRow("feat/02", 50), agentRow("feat/03", 100)];
  const scoped = [
    ...agentRows,
    jevScope("feat/01", "large"),  // small tercile but pick large → miss
    jevScope("feat/03", "small"),  // large tercile but pick small → miss
    jevScope("feat/02", "medium"), // correct → not a miss
  ];
  const r = buildReport(scoped, []).scope;
  assert.equal(r.smallWasLargeInLast10, 2);
});

test("smallWasLargeInLast10: only the most recent 10 scope rows are examined", async () => {
  const { buildReport } = await load();
  // 2 tickets: feat/01 (small), feat/02 (large)
  const agentRows = [agentRow("feat/01", 10), agentRow("feat/02", 100)];
  // 12 scope rows total: first 2 are misses (small→large, large→small), then 10 correct rows
  const scoped = [
    ...agentRows,
    jevScope("feat/01", "large", { ts: "2026-09-29T00:01:00Z" }),  // miss (old, outside last 10)
    jevScope("feat/02", "small", { ts: "2026-09-29T00:02:00Z" }),  // miss (old, outside last 10)
    // 10 correct rows, more recent
    ...Array.from({ length: 5 }, (_, i) => jevScope("feat/01", "small", { ts: `2026-09-30T01:0${i}:00Z` })),
    ...Array.from({ length: 5 }, (_, i) => jevScope("feat/02", "large", { ts: `2026-09-30T02:0${i}:00Z` })),
  ];
  const r = buildReport(scoped, []).scope;
  assert.equal(r.smallWasLargeInLast10, 0); // misses are outside the last 10
});

// ---- Criterion 3: priority flag rate ----

test("report.priority: rows = total priority rows, flagged = pick mismatch rows", async () => {
  const { buildReport } = await load();
  const rows = [
    jevPriority("feat/01", "mismatch"),
    jevPriority("feat/02", "ok"),
    jevPriority("feat/03", "mismatch"),
    jevPriority("feat/04", "other"),
    jevPriority("feat/05", null),  // fallback row, no pick
  ];
  const p = buildReport(rows, []).priority;
  assert.equal(p.rows, 5);
  assert.equal(p.flagged, 2);
  assert.ok(Math.abs(p.flagRate - 2 / 5) < 0.001);
});

test("report.priority: flagRate = 0 when no priority rows", async () => {
  const { buildReport } = await load();
  const p = buildReport([], []).priority;
  assert.equal(p.rows, 0);
  assert.equal(p.flagged, 0);
  assert.equal(p.flagRate, 0);
});

// ---- Criterion 4: priority go-live bar (needs user verdicts) ----

test("priority flagging bar: PASS when ≥10 verdicts and ≥70% right", async () => {
  const { buildReport } = await load();
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => jevPriority(`feat/${String(i + 1).padStart(2, "0")}`, "mismatch")),
    ...Array.from({ length: 10 }, (_, i) => priorityVerdict(`feat/${String(i + 1).padStart(2, "0")}`, true)),
  ];
  const p = buildReport(rows, []).priority;
  assert.equal(p.checks.flagging, true);
});

test("priority flagging bar: FAIL when fewer than 10 verdicts", async () => {
  const { buildReport } = await load();
  const rows = [
    ...Array.from({ length: 9 }, (_, i) => jevPriority(`feat/${String(i + 1).padStart(2, "0")}`, "mismatch")),
    ...Array.from({ length: 9 }, (_, i) => priorityVerdict(`feat/${String(i + 1).padStart(2, "0")}`, true)),
  ];
  const p = buildReport(rows, []).priority;
  assert.equal(p.checks.flagging, false);
});

test("priority flagging bar: FAIL when fewer than 70% right", async () => {
  const { buildReport } = await load();
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => jevPriority(`feat/${String(i + 1).padStart(2, "0")}`, "mismatch")),
    // 6 right, 4 wrong → 60% < 70%
    ...Array.from({ length: 6 }, (_, i) => priorityVerdict(`feat/${String(i + 1).padStart(2, "0")}`, true)),
    ...Array.from({ length: 4 }, (_, i) => priorityVerdict(`feat/${String(i + 7).padStart(2, "0")}`, false)),
  ];
  const p = buildReport(rows, []).priority;
  assert.equal(p.checks.flagging, false);
});

test("priority flagging bar: FAIL when no verdict rows", async () => {
  const { buildReport } = await load();
  const rows = Array.from({ length: 15 }, (_, i) => jevPriority(`feat/${String(i + 1).padStart(2, "0")}`, "mismatch"));
  const p = buildReport(rows, []).priority;
  assert.equal(p.checks.flagging, false);
});

// ---- Criterion 4: scope go-live bar ----

test("scope bar: PASS when ≥60% same-tercile AND ≥20 rows AND no small-vs-large in last 10", async () => {
  const { buildReport } = await load();
  // 20 tickets, baselines 10,20,...,200 (10-token increments)
  // Bottom 7 → small, middle 6 → medium, top 7 → large (floor division)
  const agentRows = Array.from({ length: 20 }, (_, i) => agentRow(`feat/${String(i + 1).padStart(2, "0")}`, (i + 1) * 10));
  // All 20 scope picks correct (small/medium/large matches tercile)
  const scopeRows = agentRows.map((_, i) => {
    const rank = i < 7 ? "small" : i < 13 ? "medium" : "large";
    return jevScope(`feat/${String(i + 1).padStart(2, "0")}`, rank);
  });
  const r = buildReport([...agentRows, ...scopeRows], []).scope;
  assert.equal(r.rows, 20);
  assert.equal(r.sameTercile, 20);
  assert.equal(r.smallWasLargeInLast10, 0);
  assert.equal(r.checks.scope, true);
});

test("scope bar: FAIL when fewer than 20 rows", async () => {
  const { buildReport } = await load();
  const agentRows = Array.from({ length: 19 }, (_, i) => agentRow(`feat/${String(i + 1).padStart(2, "0")}`, (i + 1) * 10));
  const scopeRows = agentRows.map((_, i) => {
    const rank = i < 6 ? "small" : i < 13 ? "medium" : "large";
    return jevScope(`feat/${String(i + 1).padStart(2, "0")}`, rank);
  });
  const r = buildReport([...agentRows, ...scopeRows], []).scope;
  assert.equal(r.rows, 19);
  assert.equal(r.checks.scope, false);
});

test("scope bar: FAIL when same-tercile rate is below 60%", async () => {
  const { buildReport } = await load();
  // 20 tickets; only 11/20 = 55% match tercile → FAIL
  const agentRows = Array.from({ length: 20 }, (_, i) => agentRow(`feat/${String(i + 1).padStart(2, "0")}`, (i + 1) * 10));
  const scopeRows = agentRows.map((_, i) => {
    const correct = i < 7 ? "small" : i < 13 ? "medium" : "large";
    const wrong = i < 7 ? "large" : i < 13 ? "small" : "medium";
    return jevScope(`feat/${String(i + 1).padStart(2, "0")}`, i < 11 ? correct : wrong);
  });
  const r = buildReport([...agentRows, ...scopeRows], []).scope;
  assert.ok(r.sameTercileRate < 0.60);
  assert.equal(r.checks.scope, false);
});

test("scope bar: FAIL when any small-vs-large miss in last 10", async () => {
  const { buildReport } = await load();
  const agentRows = Array.from({ length: 20 }, (_, i) => agentRow(`feat/${String(i + 1).padStart(2, "0")}`, (i + 1) * 10));
  const scopeRows = agentRows.map((_, i) => {
    const rank = i < 7 ? "small" : i < 13 ? "medium" : "large";
    // Make the last row a small-vs-large miss
    if (i === 19) return jevScope("feat/20", "small", { ts: "2026-09-30T23:59:00Z" }); // large tercile, small pick
    return jevScope(`feat/${String(i + 1).padStart(2, "0")}`, rank);
  });
  const r = buildReport([...agentRows, ...scopeRows], []).scope;
  assert.ok(r.smallWasLargeInLast10 >= 1);
  assert.equal(r.checks.scope, false);
});

// ---- Criterion 4: formatReport lines ----

test("formatReport prints priority flagging PASS/FAIL line", async () => {
  const { buildReport, formatReport } = await load();
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => jevPriority(`feat/${String(i + 1).padStart(2, "0")}`, "mismatch")),
    ...Array.from({ length: 10 }, (_, i) => priorityVerdict(`feat/${String(i + 1).padStart(2, "0")}`, true)),
  ];
  const out = formatReport(buildReport(rows, []));
  assert.match(out, /^priority flagging: (PASS|FAIL)/m, "priority flagging line");
  assert.match(out, /^priority flagging: PASS/m, "should be PASS with 100% right");
});

test("formatReport prints scope PASS/FAIL line", async () => {
  const { buildReport, formatReport } = await load();
  const agentRows = Array.from({ length: 20 }, (_, i) => agentRow(`feat/${String(i + 1).padStart(2, "0")}`, (i + 1) * 10));
  const scopeRows = agentRows.map((_, i) => {
    const rank = i < 7 ? "small" : i < 13 ? "medium" : "large";
    return jevScope(`feat/${String(i + 1).padStart(2, "0")}`, rank);
  });
  const out = formatReport(buildReport([...agentRows, ...scopeRows], []));
  assert.match(out, /^scope: (PASS|FAIL)/m, "scope line");
  assert.match(out, /^scope: PASS/m, "should be PASS");
});

test("formatReport includes small-vs-large miss count in the scope line", async () => {
  const { buildReport, formatReport } = await load();
  const out = formatReport(buildReport([], []));
  assert.match(out, /^scope: FAIL/m, "FAIL with no data");
});

// ---- Existing report unaffected ----

test("buildReport without priority/scope rows still returns the existing tier/verify/route report", async () => {
  const { buildReport } = await load();
  const rep = buildReport([{ kind: "agent", ticket: "feat/01", role: "developer", tokens: 10 }], []);
  assert.ok(rep.points?.tier, "tier report still present");
  assert.ok(rep.points?.verify, "verify report still present");
  assert.ok(rep.route?.newTicket !== undefined, "route new-ticket still present");
  assert.ok(rep.priority !== undefined, "priority report added");
  assert.ok(rep.scope !== undefined, "scope report added");
});
