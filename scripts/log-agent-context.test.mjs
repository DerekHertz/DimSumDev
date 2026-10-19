// organism-infra/119 AC5: log-agent.mjs --context <n> stores the agent's final self-reading on the agent row,
// and the metrics CLI (the retro's numbers) reports partial returns and median final agent context.
//
// Pinned contract:
//   log-agent --context <n>   n is a non-negative integer; the row gets `context: <n>` (a number);
//                            without the flag the row has no `context` key; a bad value exits 1, writes nothing,
//                            and the message names --context.
//   node scripts/metrics.mjs (text mode) prints, for kind:"agent" rows:
//       Partial returns: <count of agent rows whose outcome starts with "partial", case-insensitive>
//       Median final agent context: <median of the numeric `context` values, rounded to an integer>
//   agent rows with no numeric `context` are left out of the median. `--json` output is not changed here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeBoardFixture, REPO_ROOT } from "../apps/board/board-fixture.mjs";

const LOG_AGENT = path.join(REPO_ROOT, "scripts", "log-agent.mjs");
const METRICS = path.join(REPO_ROOT, "scripts", "metrics.mjs");

const rows = (root) =>
  readFileSync(path.join(root, ".scratch", "usage.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const logAgent = (fx, extra) =>
  spawnSync(
    process.execPath,
    [LOG_AGENT, "--ticket", fx.ticketRelPath, "--role", "developer", "--tokens", "10", "--ms", "20", "--outcome", "ok", "--allow-no-handoff", "test setup", ...extra],
    { cwd: fx.root, env: { ...process.env, DEN_ROOT: fx.root }, encoding: "utf8", timeout: 15000 },
  );

test("log-agent --context stores the reading as a number on the agent row", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = logAgent(fx, ["--context", "64500"]);
    assert.equal(r.status, 0, r.stderr);
    const row = rows(fx.root).find((x) => x.kind === "agent");
    assert.strictEqual(row.context, 64500);
  } finally {
    await fx.cleanup();
  }
});

test("log-agent without --context omits the context key", async () => {
  const fx = await makeBoardFixture();
  try {
    assert.equal(logAgent(fx, []).status, 0);
    assert.ok(!("context" in rows(fx.root).find((x) => x.kind === "agent")));
  } finally {
    await fx.cleanup();
  }
});

for (const [name, val] of [["non-numeric", "lots"], ["negative", "-5"], ["fractional", "1.5"], ["empty", ""]]) {
  test(`log-agent rejects ${name} --context without writing`, async () => {
    const fx = await makeBoardFixture();
    try {
      const r = logAgent(fx, ["--context", val]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /--context/);
      assert.doesNotMatch(r.stderr, /unrecognized/, "the flag must be known and its value validated");
      assert.throws(() => rows(fx.root));
    } finally {
      await fx.cleanup();
    }
  });
}

// --- the retro's numbers ---

const agentRow = (ticket, outcome, context) => ({ kind: "agent", ticket, role: "developer", tokens: 1000, ms: 1000, outcome, ...(context === undefined ? {} : { context }) });

function metricsText(usageRows) {
  const root = mkdtempSync(path.join(tmpdir(), "ctx-metrics-"));
  mkdirSync(path.join(root, ".scratch"));
  writeFileSync(path.join(root, ".scratch", "usage.jsonl"), usageRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(path.join(root, ".scratch", "events.jsonl"), "");
  return spawnSync(process.execPath, [METRICS], { cwd: root, env: { ...process.env, DEN_ROOT: root }, encoding: "utf8", timeout: 15000 });
}

test("metrics reports the partial-return count and the median final agent context", () => {
  const r = metricsText([
    agentRow("f/01", "done", 30000),
    agentRow("f/02", "partial: ran out of budget", 40000),
    agentRow("f/03", "Partial", 50000), // case-insensitive
    agentRow("f/04", "done", 70000),
    agentRow("f/05", "done"), // no reading: not part of the median
    { kind: "incident", ts: "2026-10-02T00:00:00Z", ticket: "f/01", role: "developer", tool: "git", what: "x", outcome: "partial" }, // not an agent row
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Partial returns: 2\b/);
  assert.match(r.stdout, /Median final agent context: 45000\b/); // even count: mean of 40000 and 50000
});

test("metrics median of an odd count is the middle reading", () => {
  const r = metricsText([agentRow("f/01", "done", 90000), agentRow("f/02", "done", 20000), agentRow("f/03", "done", 60000)]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Median final agent context: 60000\b/);
  assert.match(r.stdout, /Partial returns: 0\b/);
});

test("metrics with no context readings still runs and prints no NaN", () => {
  const r = metricsText([agentRow("f/01", "done"), agentRow("f/02", "partial")]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Partial returns: 1\b/);
  assert.doesNotMatch(r.stdout, /NaN|undefined/);
});
