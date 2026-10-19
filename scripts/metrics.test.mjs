// dimsumden-ui-v0/03: scripts/metrics.mjs (ADR 0011 decision 4, "Rules for ticket 03").
// Seams: exported computeMetrics({ usageLines, eventLines }) -> metrics object (pure, parsed rows),
// and the CLI `node scripts/metrics.mjs [--json]`, which reads
// <DEN_ROOT or cwd>/.scratch/usage.jsonl and events.jsonl, skips malformed lines,
// and with --json prints exactly the computeMetrics result. Fixture data only.
//
// Pinned by this test (developer implements against it):
//  - usage row { kind:"usage", ts, five_hour, weekly } -> usage { fiveHour, weekly, sampledAt } (latest by ts).
//  - free-text incident tool "board comment" maps to the fixed tool "board-comment"; an unmappable
//    tool ("PowerShell Start-Job") goes under "other".
//  - perTicket for incidents is incidents / resolvedTickets rounded to two decimals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, "scripts", "metrics.mjs");

async function load() {
  return import("./metrics.mjs");
}

const resolved = (ticket, ts) => ({ kind: "resolved", ts, ticket, pr: 1, bounces: 0 });
const role = (ticket, c, tokens) => ({ kind: "agent", ticket, role: c, tokens, ms: 1000, outcome: "done" });
const incident = (ticket, tool) => ({ kind: "incident", ts: "2026-09-28T20:00:00Z", ticket, role: "developer", tool, what: "x" });

const usageRows = [
  resolved("f/01", "2026-09-28T19:30:00Z"),
  resolved("f/02", "2026-09-28T23:59:00Z"),
  resolved("g/03", "2026-09-29T02:00:00Z"),
  resolved("g/04", "2026-09-29T12:00:00Z"),
  role("f/01", "developer", 1000),
  role("f/02", "developer", 3000),
  role("g/03", "developer", 500),
  role("g/03", "developer", 500),
  role("f/99", "developer", 9999), // never resolved: excluded
  role("f/01", "qa", 400),
  role("g/04", "qa", 600),
  incident("f/01", "board-claim"),
  incident("f/02", "board-claim"),
  incident("g/03", "board comment"),
  incident("g/04", "PowerShell Start-Job"),
  incident("g/04", "other"),
  { kind: "usage", ts: "2026-09-29T04:36:50.650Z", five_hour: 74, weekly: 72 },
  { kind: "usage", ts: "2026-09-28T03:30:00Z", five_hour: 1, weekly: 32, note: "session start" },
];
const eventRows = [
  { feature: "f", ticket: "01", role: "developer", op: "claim", ts: "2026-09-28T19:00:00Z" },
];

test("fixture rows produce the four metric keys with the ADR values", async () => {
  const { computeMetrics } = await load();
  const m = computeMetrics({ usageLines: usageRows, eventLines: eventRows });
  assert.deepEqual(m, {
    schema: 1,
    throughput: {
      windowHours: 5,
      windows: [
        { start: "2026-09-28T19:00:00.000Z", resolved: 2 },
        { start: "2026-09-29T00:00:00.000Z", resolved: 1 },
        { start: "2026-09-29T05:00:00.000Z", resolved: 0 },
        { start: "2026-09-29T10:00:00.000Z", resolved: 1 },
      ],
    },
    tokensByRole: {
      developer: { tickets: 3, tokens: 5000, perTicket: 1667 },
      qa: { tickets: 2, tokens: 1000, perTicket: 500 },
    },
    resolvedTickets: 4,
    incidentsByTool: {
      "board-claim": { incidents: 2, perTicket: 0.5 },
      "board-comment": { incidents: 1, perTicket: 0.25 },
      other: { incidents: 2, perTicket: 0.5 },
    },
    usage: { fiveHour: 74, weekly: 72, sampledAt: "2026-09-29T04:36:50.650Z" },
  });
});

test("no resolved rows: empty windows, no tokens, no incident ratios", async () => {
  const { computeMetrics } = await load();
  const m = computeMetrics({ usageLines: [incident("f/01", "git")], eventLines: [] });
  assert.equal(m.schema, 1);
  assert.deepEqual(m.throughput.windows, []);
  assert.equal(m.resolvedTickets, 0);
  assert.deepEqual(m.tokensByRole, {});
  assert.deepEqual(m.incidentsByTool, {});
});

test("throughput windows are capped at the newest 24", async () => {
  const { computeMetrics } = await load();
  const H5 = 5 * 3600 * 1000;
  const base = Date.parse("2026-09-01T00:00:00Z");
  const rows = Array.from({ length: 30 }, (_, i) => resolved(`f/${i}`, new Date(base + i * H5 + 1000).toISOString()));
  const { throughput } = computeMetrics({ usageLines: rows, eventLines: [] });
  assert.equal(throughput.windows.length, 24);
  const lastStart = Math.floor((base + 29 * H5 + 1000) / H5) * H5;
  assert.equal(throughput.windows[23].start, new Date(lastStart).toISOString());
  assert.equal(throughput.windows[0].start, new Date(lastStart - 23 * H5).toISOString());
});

function makeRoot(usage, events) {
  const root = mkdtempSync(path.join(tmpdir(), "metrics-"));
  mkdirSync(path.join(root, ".scratch"));
  writeFileSync(path.join(root, ".scratch", "usage.jsonl"), usage);
  writeFileSync(path.join(root, ".scratch", "events.jsonl"), events);
  return root;
}
const run = (root, args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, DEN_ROOT: root }, encoding: "utf8", cwd: root });

test("CLI --json over fixture files prints computeMetrics output", async () => {
  const { computeMetrics } = await load();
  const root = makeRoot(usageRows.map((r) => JSON.stringify(r)).join("\n") + "\n", eventRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = run(root, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out, computeMetrics({ usageLines: usageRows, eventLines: eventRows }));
  assert.equal(out.resolvedTickets, 4);
});

test("malformed lines are skipped, not fatal", () => {
  const usage = [
    "not json at all",
    JSON.stringify(resolved("f/01", "2026-09-28T19:30:00Z")),
    "",
    "{\"kind\":\"agent\",\"ticket\":",
    JSON.stringify(role("f/01", "developer", 100)),
    "[1,2",
  ].join("\n") + "\n";
  const root = makeRoot(usage, "garbage\n{broken\n");
  const r = run(root, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.resolvedTickets, 1);
  assert.deepEqual(out.tokensByRole, { developer: { tickets: 1, tokens: 100, perTicket: 100 } });
});

test("text output without --json succeeds and is not empty", () => {
  const root = makeRoot(usageRows.map((r) => JSON.stringify(r)).join("\n") + "\n", "");
  const r = run(root, []);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.trim().length > 0);
});
