// organism-infra/160: jev.mjs verify in shadow mode reports today's relay rule as `effective`:
// light when qa ran specify for the ticket, full otherwise. Before the fix it always reported
// the point's fallback (full), so shadow rows compared Jev against the wrong baseline.
// Seams: exported decide({..., qaSpecified}) and the CLI against a fixture board.
//
// Pinned contract (the developer implements against it):
//   - Shadow verify, qaSpecified true (the decide default): result.effective and row.actual are
//     "light", whatever Jev picked and even when Jev fell back (no key). row.pick still records
//     Jev's real pick; floor is null; applied is false.
//   - Shadow verify, qaSpecified false: "full" with floor "full" (unchanged from organism-infra/58).
//   - Live mode and the other points (tier) are unchanged.
//   - CLI: qaSpecified is true iff handoffs/<NN>-qa-specify*.md exists (unchanged lookup).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, "scripts", "jev.mjs");
const NOW = new Date("2026-10-06T17:00:00Z");
const FEATURE = "organism-infra";
const SLUG = "160-jev-verify-baseline";
const TICKET = `${FEATURE}/${SLUG}`;
const KEY = "sk-" + "test-KEYVALUE-should-never-leak-123";

const verLight = { pick: "light", probs: { light: 0.71, full: 0.27, other: 0.02 }, usage: { cost: 0.0005 } };
const verFull = { pick: "full", probs: { light: 0.1, full: 0.88, other: 0.02 }, usage: { cost: 0.0005 } };
const fake = (answer) => async () => answer;

function args(over = {}) {
  return {
    point: "verify",
    ticket: TICKET,
    ticketText: "# 160\n\n**What to build:** a thing.\n",
    testsText: "ok 1\n# pass 3\n",
    now: NOW,
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    mode: "shadow",
    ...over,
  };
}

async function load() {
  return await import("./jev.mjs");
}

// ---- decide ----

test("shadow verify with qa specify: effective is light, not the fallback", async () => {
  const { decide } = await load();
  const { result, row } = await decide(args({ qaSpecified: true, transport: fake(verLight) }));
  assert.equal(result.effective, "light");
  assert.equal(row.actual, "light");
  assert.equal(row.mode, "shadow");
  assert.equal(row.floor, null);
  assert.equal(result.floor, null);
  assert.equal(result.applied, false);
});

test("shadow verify with qa specify stays light when Jev picks full; the row keeps Jev's real pick", async () => {
  const { decide } = await load();
  const { result, row } = await decide(args({ qaSpecified: true, transport: fake(verFull) }));
  assert.equal(result.effective, "light");
  assert.equal(row.actual, "light");
  assert.equal(row.pick, "full");
  assert.equal(result.applied, false);
});

test("shadow verify with qa specify stays light when Jev falls back (no key)", async () => {
  const { decide } = await load();
  const { result, row } = await decide(args({ qaSpecified: true, env: {}, transport: fake(verLight) }));
  assert.equal(row.fallback, "no-key");
  assert.equal(result.effective, "light");
  assert.equal(row.actual, "light");
});

test("shadow verify without qa specify: effective is full with the floor logged", async () => {
  const { decide } = await load();
  const { result, row } = await decide(args({ qaSpecified: false, transport: fake(verLight) }));
  assert.equal(result.effective, "full");
  assert.equal(row.actual, "full");
  assert.equal(row.pick, "light");
  assert.equal(row.floor, "full");
});

test("shadow verify with qaSpecified omitted counts as specified (default true): light", async () => {
  const { decide } = await load();
  const { result } = await decide(args({ transport: fake(verFull) }));
  assert.equal(result.effective, "light");
});

test("live verify is unchanged: Jev's pick applies when specified", async () => {
  const { decide } = await load();
  const light = await decide(args({ mode: "live", qaSpecified: true, transport: fake(verLight) }));
  assert.equal(light.result.effective, "light");
  assert.equal(light.result.applied, true);
  const full = await decide(args({ mode: "live", qaSpecified: true, transport: fake(verFull) }));
  assert.equal(full.result.effective, "full");
});

// ---- CLI against a fixture board ----

function boardRoot(handoffs = []) {
  const root = mkdtempSync(path.join(tmpdir(), "jev-shadow-baseline-"));
  mkdirSync(path.join(root, ".scratch", FEATURE, "issues"), { recursive: true });
  mkdirSync(path.join(root, ".scratch", FEATURE, "handoffs"), { recursive: true });
  writeFileSync(path.join(root, ".scratch", FEATURE, "issues", `${SLUG}.md`), "# 160\n\n**What to build:** a thing.\n");
  for (const h of handoffs) writeFileSync(path.join(root, ".scratch", FEATURE, "handoffs", h), "# handoff\n");
  return root;
}

function lastRow(root) {
  const lines = readFileSync(path.join(root, ".scratch", "usage.jsonl"), "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

function cli(root, argv) {
  const env = { ...process.env, DEN_ROOT: root };
  delete env.TYPESAFE_API_KEY;
  return spawnSync(process.execPath, [SCRIPT, ...argv], { cwd: root, env, encoding: "utf8", timeout: 20000 });
}

function writeTests(root) {
  const tests = path.join(root, "tests.txt");
  writeFileSync(tests, "# pass 3\n");
  return tests;
}

test("CLI shadow verify with a published qa specify handoff: effective light", () => {
  const root = boardRoot([`160-qa-specify.md`, "160-developer.md"]);
  const r = cli(root, ["verify", "--ticket", TICKET, "--tests", writeTests(root)]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.mode, "shadow");
  assert.equal(out.effective, "light");
  assert.equal(out.floor, null);
  assert.equal(out.applied, false);
  const row = lastRow(root);
  assert.equal(row.actual, "light");
  assert.equal(row.floor, null);
  assert.equal(row.mode, "shadow");
});

test("CLI shadow verify without a qa specify handoff: effective full", () => {
  const root = boardRoot(["160-developer.md"]);
  const r = cli(root, ["verify", "--ticket", TICKET, "--tests", writeTests(root)]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.effective, "full");
  assert.equal(out.floor, "full");
  assert.equal(lastRow(root).actual, "full");
});

test("CLI shadow verify ignores another ticket's qa specify handoff (16- is not 160-)", () => {
  const root = boardRoot(["16-qa-specify.md", "161-qa-specify.md"]);
  const r = cli(root, ["verify", "--ticket", TICKET, "--tests", writeTests(root)]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim()).effective, "full");
});
