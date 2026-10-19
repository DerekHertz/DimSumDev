// Batch B: organism-infra/68 criterion 2 — jev-report.mjs output supports the tier/verify verdict
// without hand computation.
//
// The orchestrator's exit review (2026-09-30) found: jev-report prints bounce counts but not
// their cause (which pick was on the bounced ticket), and there is no PASS/FAIL label per
// sub-criterion (coverage, value, spend), so the safety judgement required reading each
// handoff manually.
//
// After the fix:
//   buildReport().points[p].checks  →  { coverage: bool, value: bool, spend: bool }
//   buildReport().points[p].safetyBounces  →  [{ ticket, pick, bounces }] for resolved tickets
//     that bounced and had a non-fallback jev pick at that point
//   formatReport() text  →  includes PASS/FAIL per criterion per point, plus the safetyBounces
//     list so the orchestrator can check only the named tickets' handoffs.
import { test } from "node:test";
import assert from "node:assert/strict";

// ─── helpers ─────────────────────────────────────────────────────────────────

const jev = (ticket, point, pick, extra = {}) => ({
  kind: "jev", ts: "2026-09-30T00:30:00Z", ticket, point, pick,
  actual: pick, cost: 0.001, conf: 0.9, fallback: null, ms: 120, model: "jev-1.13.0", ...extra,
});
const role = (ticket, c, mode, tokens) =>
  ({ kind: "agent", ticket, role: c, mode, tokens, ms: 1, outcome: "pass" });
const resolved = (ticket, bounces) =>
  ({ kind: "resolved", ts: "2026-09-30T01:00:00Z", ticket, pr: 1, bounces });

// Six resolved tickets: enough for coverage PASS (≥5); one has 2 bounces; verify has a light pick
// on the bounced ticket so it shows up in verify safetyBounces.
const BASE_ROWS = [
  // f/01: sonnet tier (no savings), light verify (saves 50%), bounced 2×
  jev("f/01-alpha", "tier", "sonnet"),
  jev("f/01-alpha", "verify", "light"),
  role("f/01", "developer", "implement", 1000),
  role("f/01", "qa", "verify", 400),
  resolved("f/01", 2),
  // f/02: sonnet tier, full verify, no bounce
  jev("f/02-beta", "tier", "sonnet"),
  jev("f/02-beta", "verify", "full"),
  role("f/02", "developer", "implement", 1200),
  role("f/02", "qa", "verify", 500),
  resolved("f/02", 0),
  // f/03: sonnet tier, light verify, no bounce
  jev("f/03-gamma", "tier", "sonnet"),
  jev("f/03-gamma", "verify", "light"),
  role("f/03", "developer", "implement", 800),
  role("f/03", "qa", "verify", 300),
  resolved("f/03", 0),
  // f/04–f/06: sonnet tier, full verify, no bounce
  jev("f/04-delta", "tier", "sonnet"), jev("f/04-delta", "verify", "full"),
  role("f/04", "developer", "implement", 900), role("f/04", "qa", "verify", 350), resolved("f/04", 0),
  jev("f/05-eps", "tier", "sonnet"), jev("f/05-eps", "verify", "full"),
  role("f/05", "developer", "implement", 750), role("f/05", "qa", "verify", 280), resolved("f/05", 0),
  jev("f/06-zeta", "tier", "sonnet"), jev("f/06-zeta", "verify", "full"),
  role("f/06", "developer", "implement", 600), role("f/06", "qa", "verify", 220), resolved("f/06", 0),
];

// Rows where verify saves ≥30% (all light picks, qa-verify tokens halved in projection).
// baseline verify = 400 + 500 + 300 + 350 + 280 + 220 = 2050
// projected verify = 200 + 500 + 150 + 350 + 280 + 220 = 1700  → ~17% savings (FAIL)
// To get PASS we need savedPct ≥ 30 on resolved tickets only.
// Use 4 light picks out of 6 → baseline 2050, projected:
// f/01 light: 200, f/02 full: 500, f/03 light: 150, f/04 full: 350, f/05 light: 140, f/06 light: 110 → 1450 → 29%... close
// Simpler: use bigger qa verify tokens for some to push past 30%.
const HIGH_SAVINGS_ROWS = [
  jev("g/01-alpha", "verify", "light"), role("g/01", "developer", "impl", 100), role("g/01", "qa", "verify", 1000), resolved("g/01", 0),
  jev("g/02-beta", "verify", "light"), role("g/02", "developer", "impl", 100), role("g/02", "qa", "verify", 1000), resolved("g/02", 0),
  jev("g/03-gamma", "verify", "light"), role("g/03", "developer", "impl", 100), role("g/03", "qa", "verify", 1000), resolved("g/03", 0),
  jev("g/04-delta", "verify", "light"), role("g/04", "developer", "impl", 100), role("g/04", "qa", "verify", 1000), resolved("g/04", 0),
  jev("g/05-eps", "verify", "light"), role("g/05", "developer", "impl", 100), role("g/05", "qa", "verify", 1000), resolved("g/05", 0),
  jev("g/06-zeta", "tier", "sonnet"), role("g/06", "developer", "impl", 100), resolved("g/06", 0),
];
// g/01–g/05: baseline = 5 × 1100 = 5500; verify projection = 5 × (100 + 500) = 3000 → 45.5% savings → PASS

// ─── 68/2: buildReport checks shape ──────────────────────────────────────────

test("68/2: buildReport points.tier includes checks.coverage, checks.value, checks.spend booleans", async () => {
  const { buildReport } = await import("./jev-report.mjs");
  const { points } = buildReport(BASE_ROWS);
  assert.ok(
    typeof points.tier.checks === "object" && points.tier.checks !== null,
    "points.tier.checks must be an object",
  );
  assert.equal(typeof points.tier.checks.coverage, "boolean", "checks.coverage must be boolean");
  assert.equal(typeof points.tier.checks.value, "boolean", "checks.value must be boolean");
  assert.equal(typeof points.tier.checks.spend, "boolean", "checks.spend must be boolean");
});

test("68/2: buildReport points.verify includes checks.coverage, checks.value, checks.spend booleans", async () => {
  const { buildReport } = await import("./jev-report.mjs");
  const { points } = buildReport(BASE_ROWS);
  assert.ok(
    typeof points.verify.checks === "object" && points.verify.checks !== null,
    "points.verify.checks must be an object",
  );
  assert.equal(typeof points.verify.checks.coverage, "boolean", "checks.coverage must be boolean");
  assert.equal(typeof points.verify.checks.value, "boolean", "checks.value must be boolean");
  assert.equal(typeof points.verify.checks.spend, "boolean", "checks.spend must be boolean");
});

// ─── 68/2: checks.value logic ────────────────────────────────────────────────

test("68/2: checks.value is false when savedPct < 30 (tier: sonnet picks → 0% savings)", async () => {
  const { buildReport } = await import("./jev-report.mjs");
  // All sonnet tier picks → tierW = 1 → no change from baseline → savedPct = 0
  const { points } = buildReport(BASE_ROWS);
  assert.equal(points.tier.checks.value, false,
    "tier checks.value must be false when all picks are sonnet (0% savings)");
});

test("68/2: checks.value is true when savedPct ≥ 30 (verify: light picks on large qa agents)", async () => {
  const { buildReport } = await import("./jev-report.mjs");
  const { points } = buildReport(HIGH_SAVINGS_ROWS);
  assert.equal(points.verify.checks.value, true,
    `verify checks.value must be true when savings ≥ 30%; savedPct = ${points.verify.savedPct.toFixed(1)}%`);
});

// ─── 68/2: checks.coverage logic ─────────────────────────────────────────────

test("68/2: checks.coverage is false when fewer than 5 tickets have a jev row", async () => {
  const { buildReport } = await import("./jev-report.mjs");
  const rows = [
    jev("f/01-a", "tier", "sonnet"), role("f/01", "developer", "impl", 500), resolved("f/01", 0),
    jev("f/02-b", "tier", "sonnet"), role("f/02", "developer", "impl", 500), resolved("f/02", 0),
  ]; // only 2 tickets
  const { points } = buildReport(rows);
  assert.equal(points.tier.checks.coverage, false,
    "checks.coverage must be false with fewer than 5 tickets");
});

test("68/2: checks.spend is false when cap has fired for a point", async () => {
  const { buildReport } = await import("./jev-report.mjs");
  // Add a cap fallback row for tier
  const rows = [
    ...BASE_ROWS,
    { kind: "jev", ts: "2026-09-30T00:35:00Z", ticket: "f/07-h", point: "tier",
      pick: null, actual: "sonnet", cost: 0, conf: null, fallback: "cap", ms: 0, model: "jev-1.13.0" },
    role("f/07", "developer", "impl", 400), resolved("f/07", 0),
  ];
  const { points } = buildReport(rows);
  assert.equal(points.tier.checks.spend, false,
    "checks.spend must be false when the cap fired at least once");
});

// ─── 68/2: safetyBounces — bounce+pick attribution ───────────────────────────

test("68/2: buildReport points include safetyBounces listing resolved tickets that bounced with a specific pick", async () => {
  const { buildReport } = await import("./jev-report.mjs");
  const { points } = buildReport(BASE_ROWS);
  // f/01 bounced 2× with a sonnet tier pick → should appear in tier safetyBounces
  assert.ok(Array.isArray(points.tier.safetyBounces),
    "points.tier.safetyBounces must be an array");
  const hit = points.tier.safetyBounces.find((e) => e.ticket === "f/01");
  assert.ok(hit, "f/01 (2 bounces, sonnet pick) must appear in tier safetyBounces");
  assert.equal(hit.pick, "sonnet", "safetyBounce entry must include the jev pick");
  assert.equal(hit.bounces, 2, "safetyBounce entry must include the bounce count");
});

test("68/2: buildReport safetyBounces excludes zero-bounce tickets", async () => {
  const { buildReport } = await import("./jev-report.mjs");
  const { points } = buildReport(BASE_ROWS);
  const nonZero = points.tier.safetyBounces.every((e) => e.bounces > 0);
  assert.ok(nonZero, "safetyBounces must only list tickets that actually bounced");
});

test("68/2: buildReport safetyBounces excludes fallback rows (no pick to attribute)", async () => {
  const { buildReport } = await import("./jev-report.mjs");
  const rows = [
    { kind: "jev", ts: "2026-09-30T00:30:00Z", ticket: "f/01-alpha", point: "tier",
      pick: null, actual: "sonnet", cost: 0, conf: null, fallback: "timeout", ms: 10000, model: "jev-1.13.0" },
    role("f/01", "developer", "implement", 1000),
    resolved("f/01", 3),
  ];
  const { points } = buildReport(rows);
  // Fallback row → no pick to attribute → must not appear in safetyBounces
  assert.ok(
    !points.tier.safetyBounces.some((e) => e.ticket === "f/01"),
    "safetyBounces must not include tickets whose jev row was a fallback",
  );
});

// ─── 68/2: formatReport text ──────────────────────────────────────────────────

test("68/2: formatReport includes PASS or FAIL for coverage, value, spend per point", async () => {
  const { buildReport, formatReport } = await import("./jev-report.mjs");
  const out = formatReport(buildReport(BASE_ROWS));
  for (const point of ["tier", "verify"]) {
    for (const criterion of ["coverage", "value", "spend"]) {
      const hasPassFail = new RegExp(`${point}[^\\n]*${criterion}[^\\n]*(?:PASS|FAIL)|(?:PASS|FAIL)[^\\n]*${point}[^\\n]*${criterion}`, "i").test(out);
      assert.ok(
        hasPassFail,
        `formatReport must include PASS or FAIL for ${point} ${criterion}; output:\n${out}`,
      );
    }
  }
});

test("68/2: formatReport lists bounced tickets with their picks so safety can be judged without handoffs", async () => {
  const { buildReport, formatReport } = await import("./jev-report.mjs");
  const out = formatReport(buildReport(BASE_ROWS));
  // f/01 bounced 2× with sonnet tier pick — must appear by ticket key in the tier section
  assert.ok(
    out.includes("f/01"),
    `formatReport must mention the bounced ticket f/01 for safety review; output:\n${out}`,
  );
  // The tier section should show the pick alongside so the reader knows what to look for
  const tierSafetyLines = out.split("\n").filter((l) =>
    l.toLowerCase().includes("tier") && l.toLowerCase().includes("safety"),
  );
  const pickMentioned = tierSafetyLines.some((l) => l.includes("sonnet") || l.includes("f/01"));
  assert.ok(
    pickMentioned,
    `tier safety section must show the pick or the ticket key; found:\n${tierSafetyLines.join("\n")}`,
  );
});
