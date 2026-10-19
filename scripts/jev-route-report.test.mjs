// organism-infra/69: jev-report.mjs route agreement and go-live lines (ADR 0015 decisions 3 and 5).
// Seam: exported buildReport(rows, events = []) and formatReport(report).
//
// Pinned contract (the developer implements against it):
//   events are lines of .scratch/events.jsonl: {feature, ticket:"<NN-slug>", agent, op, ts}.
//   Claim events DO carry the role, so `actual` is read from the board, not logged.
//   Actual dispatch for a route row = the agent of the first event with op "claim" on the same
//   feature/NN whose ts is after the route row's ts, ignoring agent "orchestrator" and agents with no
//   label. Agent to label: product, architect, designer -> same; qa -> "qa-specify";
//   developer -> "developer-direct".
//   Only the latest route row with variant "new" per ticket counts. Rows with no actual dispatch
//   are excluded from agreement and from the go-live counts.
//   report.route.newTicket = {
//     rows, fallbacks (not counting cap), capFired, medianMs, other, otherPct,
//     nonOther, agreed, agreementPct, byLabel: {label: {picks, agreed}},
//     disagreements: [{ticket, pick, actual}], safetyMisses: [ticket],
//     checks: {coverage, agreement, safety, spend}  each true (pass) or false (fail) }
//   Bar (ADR 0015 decision 5): coverage = rows >= 15, fallbacks*5 <= rows, medianMs < 2000;
//   agreement = agreedPct >= 85 over non-other picks and otherPct <= 35; safety = no row whose
//   pick is developer-direct on a ticket where a qa claim exists; spend = no route row with
//   fallback "cap".
//   formatReport prints one line per check:
//     "route new-ticket coverage: PASS|FAIL ...", "... agreement: ...", "... safety: ...", "... spend: ..."
//   and a per-label agreement line "route agreement <label>: <agreed>/<picks> ..." for each label seen.
import { test } from "node:test";
import assert from "node:assert/strict";

const load = () => import("./jev-report.mjs");
let seq = 0;
const T0 = "2026-09-29T00:00:00Z";
const T1 = "2026-09-29T00:05:00Z";
const T2 = "2026-09-29T00:10:00Z";

function route(n, pick, over = {}) {
  return {
    kind: "jev", point: "route", variant: "new", ticket: `feat/${String(n).padStart(2, "0")}-t${n}`,
    ts: T1, pick, actual: "orchestrator", cost: 0.001, mode: "shadow", fallback: pick ? null : "http", ms: 400, ...over,
  };
}
function claim(n, role, ts = T2, over = {}) {
  return { seq: ++seq, ts, feature: "feat", ticket: `${String(n).padStart(2, "0")}-t${n}`, role, op: "claim", ...over };
}
// n tickets, each routed to `label` and dispatched to `role`
function batch(count, label, role, start = 1) {
  const rows = [];
  const events = [];
  for (let i = 0; i < count; i++) {
    rows.push(route(start + i, label));
    events.push(claim(start + i, role));
  }
  return { rows, events };
}
function merge(...bs) {
  return { rows: bs.flatMap((b) => b.rows), events: bs.flatMap((b) => b.events) };
}
async function nt(rows, events) {
  const { buildReport } = await load();
  return buildReport(rows, events).route.newTicket;
}

test("agreement per label from the next board claim, qa claim maps to qa-specify", async () => {
  const rows = [route(1, "product"), route(2, "product"), route(3, "qa-specify"), route(4, "architect")];
  const events = [claim(1, "product"), claim(2, "architect"), claim(3, "qa"), claim(4, "architect")];
  const r = await nt(rows, events);
  assert.equal(r.rows, 4);
  assert.deepEqual(r.byLabel.product, { picks: 2, agreed: 1 });
  assert.deepEqual(r.byLabel["qa-specify"], { picks: 1, agreed: 1 });
  assert.deepEqual(r.byLabel.architect, { picks: 1, agreed: 1 });
  assert.equal(r.nonOther, 4);
  assert.equal(r.agreed, 3);
  assert.equal(r.agreementPct, 75);
  assert.deepEqual(r.disagreements, [{ ticket: "feat/02", pick: "product", actual: "architect" }]);
});

test("developer claim maps to developer-direct; other picks are excluded from agreement but counted", async () => {
  const rows = [route(1, "developer-direct"), route(2, "other"), route(3, "designer")];
  const events = [claim(1, "developer"), claim(2, "product"), claim(3, "designer")];
  const r = await nt(rows, events);
  assert.equal(r.other, 1);
  assert.equal(r.nonOther, 2);
  assert.equal(r.agreed, 2);
  assert.equal(r.agreementPct, 100);
  assert.ok(Math.abs(r.otherPct - 100 / 3) < 0.01);
  assert.equal(r.byLabel.other, undefined);
});

test("orchestrator claims and claims before the route row are not the dispatch", async () => {
  const rows = [route(1, "product")];
  const events = [
    claim(1, "orchestrator", T2),
    claim(1, "architect", T0), // before the route row
    claim(1, "product", T2),
    claim(1, "developer", "2026-09-29T00:20:00Z"), // later hop, not the first dispatch
  ];
  const r = await nt(rows, events);
  assert.equal(r.agreed, 1);
});

test("a ticket with no dispatch yet is left out of every count", async () => {
  const r = await nt([route(1, "product"), route(2, "product")], [claim(1, "product")]);
  assert.equal(r.rows, 1);
  assert.equal(r.nonOther, 1);
});

test("only variant new counts, and only the latest row per ticket", async () => {
  const rows = [
    route(1, "architect", { ts: T0 }),
    route(1, "product", { ts: T1 }),
    route(2, "developer", { variant: "bounce" }),
  ];
  const r = await nt(rows, [claim(1, "product", T2), claim(2, "developer", T2)]);
  assert.equal(r.rows, 1);
  assert.equal(r.agreed, 1);
});

test("safety: developer-direct on a ticket that ran qa specify is a miss", async () => {
  const rows = [route(1, "developer-direct")];
  const events = [claim(1, "qa", T2), claim(1, "developer", "2026-09-29T00:30:00Z")];
  const r = await nt(rows, events);
  assert.deepEqual(r.safetyMisses, ["feat/01"]);
  assert.equal(r.checks.safety, false);
});

test("fallbacks are counted apart from cap, and out of agreement", async () => {
  const rows = [route(1, null, { fallback: "http" }), route(2, null, { fallback: "cap", cost: 0 }), route(3, "product")];
  const r = await nt(rows, [claim(1, "product"), claim(2, "product"), claim(3, "product")]);
  assert.equal(r.fallbacks, 1);
  assert.equal(r.capFired, 1);
  assert.equal(r.nonOther, 1);
  assert.equal(r.checks.spend, false);
});

test("go-live bar passes: 15 rows, clean fallbacks, fast, 100% agreement, no misses", async () => {
  const { rows, events } = batch(15, "product", "product");
  const r = await nt(rows, events);
  assert.deepEqual(r.checks, { coverage: true, agreement: true, safety: true, spend: true });
});

test("coverage fails under 15 rows", async () => {
  const { rows, events } = batch(14, "product", "product");
  assert.equal((await nt(rows, events)).checks.coverage, false);
});

test("coverage: 3 fallbacks in 15 passes, 4 fails (at most 1 in 5)", async () => {
  const mk = (fb) => {
    const b = batch(15 - fb, "product", "product");
    const f = { rows: [], events: [] };
    for (let i = 0; i < fb; i++) {
      f.rows.push(route(100 + i, null, { fallback: "timeout" }));
      f.events.push(claim(100 + i, "product"));
    }
    return merge(b, f);
  };
  assert.equal((await nt(mk(3).rows, mk(3).events)).checks.coverage, true);
  assert.equal((await nt(mk(4).rows, mk(4).events)).checks.coverage, false);
});

test("coverage fails when median ms is 2000 or more", async () => {
  const { rows, events } = batch(15, "product", "product");
  const slow = rows.map((r) => ({ ...r, ms: 2500 }));
  assert.equal((await nt(slow, events)).checks.coverage, false);
});

test("agreement: 85% of non-other picks passes, below fails", async () => {
  const ok = merge(batch(17, "product", "product", 1), batch(3, "product", "architect", 50)); // 17/20 = 85
  const bad = merge(batch(16, "product", "product", 1), batch(4, "product", "architect", 50)); // 80
  assert.equal((await nt(ok.rows, ok.events)).checks.agreement, true);
  assert.equal((await nt(bad.rows, bad.events)).checks.agreement, false);
});

test("agreement fails when other is more than 35% of rows", async () => {
  const b = merge(batch(12, "product", "product", 1), batch(8, "other", "product", 50)); // 40% other
  assert.equal((await nt(b.rows, b.events)).checks.agreement, false);
});

test("formatReport prints per-label agreement and one PASS/FAIL line per go-live check", async () => {
  const { buildReport, formatReport } = await load();
  const b = merge(batch(15, "product", "product", 1), batch(3, "architect", "product", 50));
  const out = formatReport(buildReport(b.rows, b.events));
  assert.match(out, /^route agreement product: 15\/15/m);
  assert.match(out, /^route agreement architect: 0\/3/m);
  for (const name of ["coverage", "agreement", "safety", "spend"]) {
    assert.match(out, new RegExp(`^route new-ticket ${name}: (PASS|FAIL)`, "m"), name);
  }
  assert.match(out, /^route new-ticket coverage: PASS/m);
  assert.match(out, /^route new-ticket agreement: FAIL/m);
});

test("buildReport without events still returns the existing tier and verify report", async () => {
  const { buildReport } = await load();
  const rep = buildReport([{ kind: "agent", ticket: "feat/01", role: "developer", tokens: 10 }]);
  assert.ok(rep.points.tier);
  assert.ok(rep.points.verify);
  assert.equal(rep.route.newTicket.rows, 0);
});
