// organism-infra/70: jev-report.mjs bounce half of route agreement and go-live lines (ADR 0015 decision 5).
// Extends the pattern of ticket 69 (jev-route-report.test.mjs) to variant "bounce".
//
// Pinned contract (the developer implements against it):
//   buildReport(rows, events) extends report.route to include:
//     report.route.bounce = {
//       rows, fallbacks (not counting cap), capFired, medianMs, other, otherPct,
//       nonOther, agreed, agreementPct, byLabel: {label: {picks, agreed}},
//       disagreements: [{ticket, pick, actual}], safetyMisses: [ticket],
//       checks: {coverage, agreement, safety, spend}  each true (pass) or false (fail) }
//   Go-live bar for bounce (ADR 0015 decision 5): same as new-ticket except coverage = rows >= 8 (not 15).
//     coverage = rows >= 8, fallbacks*5 <= rows, medianMs < 2000
//     agreement = agreementPct >= 85 over non-other picks AND otherPct <= 35
//     safety = no bounce-route row whose pick would have caused the orchestrator to skip a required
//              verify or security stage (i.e., a "developer" pick where the ticket was merged without
//              a subsequent qa-verify claim between the route row ts and the resolved event)
//     spend = no bounce route row with fallback "cap"
//   Actual dispatch for a bounce row: the agent of the first event with op "claim" on the same
//     feature/NN whose ts is after the bounce route row's ts, ignoring agent "orchestrator" and
//     agents with no label. Agent-to-label mapping: same as new-ticket (qa -> "qa", developer -> "developer",
//     architect -> "architect", user -> "user").
//   Only rows with variant "bounce" count; rows with variant "new" are excluded.
//   Only the latest bounce row per ticket counts.
//   Rows with no actual dispatch are excluded from agreement and go-live counts.
//   formatReport prints per-label agreement lines and PASS/FAIL lines for each go-live check:
//     "route bounce coverage: PASS|FAIL ...", "... agreement: ...", "... safety: ...", "... spend: ..."
//     "route bounce agreement <label>: <agreed>/<picks> ..." for each label seen.
import { test } from "node:test";
import assert from "node:assert/strict";

const load = () => import("./jev-report.mjs");

let seq = 0;
const T0 = "2026-09-30T00:00:00Z";
const T1 = "2026-09-30T00:05:00Z";
const T2 = "2026-09-30T00:10:00Z";
const T3 = "2026-09-30T00:20:00Z";

function brow(n, pick, over = {}) {
  return {
    kind: "jev", point: "route", variant: "bounce", ticket: `feat/${String(n).padStart(2, "0")}-t${n}`,
    ts: T1, pick, actual: "orchestrator", cost: 0.001, mode: "shadow", fallback: pick ? null : "http", ms: 400, ...over,
  };
}

function claim(n, role, ts = T2, over = {}) {
  return { seq: ++seq, ts, feature: "feat", ticket: `${String(n).padStart(2, "0")}-t${n}`, role, op: "claim", ...over };
}

function release(n, toStatus, ts = T3, over = {}) {
  return { seq: ++seq, ts, feature: "feat", ticket: `${String(n).padStart(2, "0")}-t${n}`, op: "release", to_status: toStatus, ...over };
}

function batch(count, label, role, start = 1) {
  const rows = [];
  const events = [];
  for (let i = 0; i < count; i++) {
    rows.push(brow(start + i, label));
    events.push(claim(start + i, role));
  }
  return { rows, events };
}

function merge(...bs) {
  return { rows: bs.flatMap((b) => b.rows), events: bs.flatMap((b) => b.events) };
}

async function bn(rows, events) {
  const { buildReport } = await load();
  return buildReport(rows, events).route.bounce;
}

// ---- Criterion 4: bounce agreement per label ----

test("bounce report exists on report.route.bounce", async () => {
  const { buildReport } = await load();
  const rep = buildReport([], []);
  assert.ok(rep.route.bounce !== undefined, "report.route.bounce must exist");
});

test("bounce: agreement per label from the next board claim", async () => {
  const rows = [brow(1, "developer"), brow(2, "developer"), brow(3, "qa"), brow(4, "architect")];
  const events = [claim(1, "developer"), claim(2, "qa"), claim(3, "qa"), claim(4, "architect")];
  const r = await bn(rows, events);
  assert.equal(r.rows, 4);
  assert.deepEqual(r.byLabel.developer, { picks: 2, agreed: 1 });
  assert.deepEqual(r.byLabel.qa, { picks: 1, agreed: 1 });
  assert.deepEqual(r.byLabel.architect, { picks: 1, agreed: 1 });
  assert.equal(r.agreed, 3);
  assert.equal(r.agreementPct, 75);
  assert.deepEqual(r.disagreements, [{ ticket: "feat/02", pick: "developer", actual: "qa" }]);
});

test("bounce: only variant bounce rows count; new-ticket rows are excluded", async () => {
  const rows = [
    brow(1, "developer"),
    { kind: "jev", point: "route", variant: "new", ticket: "feat/02-t2", ts: T1, pick: "product", actual: "orchestrator", cost: 0.001, mode: "shadow", fallback: null, ms: 400 },
  ];
  const events = [claim(1, "developer"), claim(2, "product")];
  const r = await bn(rows, events);
  assert.equal(r.rows, 1, "only one bounce row should count");
  assert.equal(r.agreed, 1);
});

test("bounce: only the latest bounce row per ticket counts", async () => {
  const rows = [
    brow(1, "architect", { ts: T0 }),
    brow(1, "developer", { ts: T1 }),
  ];
  const r = await bn(rows, [claim(1, "developer", T2)]);
  assert.equal(r.rows, 1, "only latest row per ticket");
  assert.equal(r.agreed, 1);
});

test("bounce: ticket with no dispatch yet is left out of every count", async () => {
  const r = await bn([brow(1, "developer"), brow(2, "developer")], [claim(1, "developer")]);
  assert.equal(r.rows, 1);
  assert.equal(r.nonOther, 1);
});

test("bounce: orchestrator claims and claims before the bounce row are not the dispatch", async () => {
  const rows = [brow(1, "developer")];
  const events = [
    claim(1, "orchestrator", T2),
    claim(1, "qa", T0),       // before the bounce row
    claim(1, "developer", T2),
    claim(1, "security", T3), // later hop, not the first dispatch
  ];
  const r = await bn(rows, events);
  assert.equal(r.agreed, 1);
});

test("bounce: other picks are counted but excluded from agreement percentage", async () => {
  const rows = [brow(1, "developer"), brow(2, "other"), brow(3, "qa")];
  const events = [claim(1, "developer"), claim(2, "developer"), claim(3, "qa")];
  const r = await bn(rows, events);
  assert.equal(r.other, 1);
  assert.equal(r.nonOther, 2);
  assert.equal(r.agreed, 2);
  assert.equal(r.agreementPct, 100);
  assert.ok(Math.abs(r.otherPct - 100 / 3) < 0.01);
  assert.equal(r.byLabel.other, undefined);
});

test("bounce: fallbacks counted apart from cap, excluded from agreement", async () => {
  const rows = [brow(1, null, { fallback: "http" }), brow(2, null, { fallback: "cap", cost: 0 }), brow(3, "developer")];
  const r = await bn(rows, [claim(1, "developer"), claim(2, "developer"), claim(3, "developer")]);
  assert.equal(r.fallbacks, 1);
  assert.equal(r.capFired, 1);
  assert.equal(r.nonOther, 1);
  assert.equal(r.checks.spend, false);
});

// ---- Criterion 4: go-live bar (bounce = 8 rows, not 15) ----

test("bounce go-live bar passes: 8 rows, clean fallbacks, fast, 100% agreement, no safety miss", async () => {
  const { rows, events } = batch(8, "developer", "developer");
  const r = await bn(rows, events);
  assert.deepEqual(r.checks, { coverage: true, agreement: true, safety: true, spend: true });
});

test("bounce coverage passes at 8 rows, fails at 7", async () => {
  assert.equal((await bn(...Object.values(batch(8, "developer", "developer")))).checks.coverage, true);
  assert.equal((await bn(...Object.values(batch(7, "developer", "developer")))).checks.coverage, false);
});

test("bounce coverage: 1 fallback in 8 passes, 2 fails (at most 1 in 5)", async () => {
  const mkFallback = (fb) => {
    const b = batch(8 - fb, "developer", "developer");
    const f = { rows: [], events: [] };
    for (let i = 0; i < fb; i++) {
      f.rows.push(brow(100 + i, null, { fallback: "timeout" }));
      f.events.push(claim(100 + i, "developer"));
    }
    return merge(b, f);
  };
  assert.equal((await bn(mkFallback(1).rows, mkFallback(1).events)).checks.coverage, true);
  assert.equal((await bn(mkFallback(2).rows, mkFallback(2).events)).checks.coverage, false);
});

test("bounce coverage fails when median ms is 2000 or more", async () => {
  const { rows, events } = batch(8, "developer", "developer");
  const slow = rows.map((r) => ({ ...r, ms: 2500 }));
  assert.equal((await bn(slow, events)).checks.coverage, false);
});

test("bounce agreement: 85% of non-other picks passes, below fails", async () => {
  // 7/8 = 87.5% → pass; 6/8 = 75% → fail
  const ok = merge(batch(7, "developer", "developer", 1), batch(1, "developer", "qa", 50));   // 7/8
  const bad = merge(batch(6, "developer", "developer", 1), batch(2, "developer", "qa", 50));  // 6/8 = 75
  assert.equal((await bn(ok.rows, ok.events)).checks.agreement, true);
  assert.equal((await bn(bad.rows, bad.events)).checks.agreement, false);
});

test("bounce agreement fails when other is more than 35% of rows", async () => {
  const b = merge(batch(5, "developer", "developer", 1), batch(4, "other", "developer", 50)); // 4/9 = 44%
  assert.equal((await bn(b.rows, b.events)).checks.agreement, false);
});

// ---- Criterion 3: safety ----

test("bounce safety: developer pick followed by qa-verify and security is safe", async () => {
  // Row says "developer"; next claim is developer, then qa (verify), then resolved → no skip
  const rows = [brow(1, "developer")];
  const events = [
    claim(1, "developer", T2),
    claim(1, "qa", T3),
    release(1, "resolved", "2026-09-30T00:30:00Z"),
  ];
  const r = await bn(rows, events);
  assert.deepEqual(r.safetyMisses, []);
  assert.equal(r.checks.safety, true);
});

test("bounce safety: developer pick without subsequent qa-verify before resolved is a safety miss", async () => {
  // Row says "developer"; ticket is resolved without any qa claim after the bounce-route row
  const rows = [brow(1, "developer")];
  const events = [
    claim(1, "developer", T2),
    release(1, "resolved", T3),
  ];
  const r = await bn(rows, events);
  assert.deepEqual(r.safetyMisses, ["feat/01"]);
  assert.equal(r.checks.safety, false);
});

test("bounce safety: qa, architect, user picks do not require a verify chain (they restart or pause the relay)", async () => {
  // These picks pause or redirect the relay; they are not direct-to-merge, so no safety miss.
  const rows = [brow(1, "qa"), brow(2, "architect"), brow(3, "user")];
  const events = [
    claim(1, "qa", T2),
    claim(2, "architect", T2),
    claim(3, "user", T2),
  ];
  const r = await bn(rows, events);
  assert.deepEqual(r.safetyMisses, []);
  assert.equal(r.checks.safety, true);
});

test("bounce safety: one miss keeps safety false even if other picks are clean", async () => {
  // ticket 1: developer pick → resolved without qa-verify (miss)
  // ticket 2: developer pick → developer + qa-verify → resolved (clean)
  const rows = [brow(1, "developer"), brow(2, "developer")];
  const events = [
    claim(1, "developer", T2),
    release(1, "resolved", T3),
    claim(2, "developer", T2),
    claim(2, "qa", T3),
    release(2, "resolved", "2026-09-30T00:30:00Z"),
  ];
  const r = await bn(rows, events);
  assert.deepEqual(r.safetyMisses, ["feat/01"]);
  assert.equal(r.checks.safety, false);
});

// ---- Criterion 4: formatReport lines ----

test("formatReport prints bounce per-label agreement and PASS/FAIL go-live lines", async () => {
  const { buildReport, formatReport } = await load();
  const b = merge(batch(8, "developer", "developer", 1), batch(2, "qa", "developer", 50));
  const out = formatReport(buildReport(b.rows, b.events));
  assert.match(out, /^route bounce agreement developer: 8\/8/m, "per-label agreement line for developer");
  assert.match(out, /^route bounce agreement qa: 0\/2/m, "per-label agreement line for qa");
  for (const name of ["coverage", "agreement", "safety", "spend"]) {
    assert.match(out, new RegExp(`^route bounce ${name}: (PASS|FAIL)`, "m"), name);
  }
  assert.match(out, /^route bounce coverage: PASS/m);
  assert.match(out, /^route bounce agreement: FAIL/m);
});

test("buildReport without bounce rows still has report.route.bounce with zero rows", async () => {
  const { buildReport } = await load();
  const rep = buildReport([{ kind: "agent", ticket: "feat/01", role: "developer", tokens: 10 }]);
  assert.ok(rep.route.bounce !== undefined);
  assert.equal(rep.route.bounce.rows, 0);
});

test("bounce report does not affect the new-ticket report and vice versa", async () => {
  const { buildReport } = await load();
  // Mix both variants; each should be counted separately
  const newRow = { kind: "jev", point: "route", variant: "new", ticket: "feat/01-t1", ts: T1, pick: "product", actual: "orchestrator", cost: 0.001, mode: "shadow", fallback: null, ms: 400 };
  const bounceRow = brow(2, "developer");
  const events = [
    claim(1, "product"),
    claim(2, "developer"),
  ];
  const rep = buildReport([newRow, bounceRow], events);
  assert.equal(rep.route.newTicket.rows, 1, "new-ticket count");
  assert.equal(rep.route.bounce.rows, 1, "bounce count");
  assert.equal(rep.route.newTicket.byLabel?.product?.picks, 1, "product in new-ticket");
  assert.equal(rep.route.bounce.byLabel?.developer?.picks, 1, "developer in bounce");
});
