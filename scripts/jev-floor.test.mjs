// organism-infra/58: jev.mjs verify floors to full when qa never ran specify.
// Seam: exported decide({..., qaSpecified}) and the CLI.
//
// Pinned contract (the developer implements against it):
//   decide accepts `qaSpecified` (boolean, default true, so callers that omit it
//   keep today's behaviour). qaSpecified === false on point "verify" applies
//   minimum = full: result.effective and row.actual are "full" in shadow and
//   live whatever Jev picks; row.pick still records Jev's real pick.
//   The floor is logged as `floor: "full"` on both row and result. Whenever the
//   floor does not apply (specify hop exists, or point is tier) `floor` is null.
//   CLI: qaSpecified is true iff <root>/.scratch/<feature>/handoffs/<NN>-qa-specify*.md
//   exists, where <NN> is the leading number of the ticket slug (07-thing -> 07-).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, "scripts", "jev.mjs");
const NOW = new Date("2026-09-29T01:20:00Z");
const TICKET = "feat/07-thing";
const KEY = "sk-" + "test-KEYVALUE-should-never-leak-123";

const verLight = { pick: "light", probs: { light: 0.71, full: 0.27, other: 0.02 }, usage: { cost: 0.0005 } };
const verFull = { pick: "full", probs: { light: 0.1, full: 0.88, other: 0.02 }, usage: { cost: 0.0005 } };
const tierHard = { pick: "hard", probs: { standard: 0.05, hard: 0.93, other: 0.02 }, usage: { cost: 0.0007 } };

const fake = (answer) => async () => answer;

function args(over = {}) {
  return {
    point: "verify",
    ticket: TICKET,
    ticketText: "# 07\n\n**What to build:** a thing.\n",
    testsText: "ok 1\n# pass 3\n",
    now: NOW,
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    ...over,
  };
}

async function load() {
  return await import("./jev.mjs");
}

test("no qa-specify: live verify is full even when Jev picks light; row logs the floor", async () => {
  const { decide } = await load();
  const { result, row } = await decide(args({ mode: "live", qaSpecified: false, transport: fake(verLight) }));
  assert.equal(result.effective, "full");
  assert.equal(row.actual, "full");
  assert.equal(row.pick, "light");
  assert.equal(row.floor, "full");
  assert.equal(result.floor, "full");
  assert.equal(row.mode, "live");
});

test("no qa-specify: shadow verify is full and the floor is logged", async () => {
  const { decide } = await load();
  const { result, row } = await decide(args({ mode: "shadow", qaSpecified: false, transport: fake(verLight) }));
  assert.equal(result.effective, "full");
  assert.equal(row.actual, "full");
  assert.equal(row.pick, "light");
  assert.equal(row.floor, "full");
});

test("no qa-specify: a full pick stays full and the floor is still logged", async () => {
  const { decide } = await load();
  const { result, row } = await decide(args({ mode: "live", qaSpecified: false, transport: fake(verFull) }));
  assert.equal(result.effective, "full");
  assert.equal(row.floor, "full");
});

test("no qa-specify: the floor holds on fallback paths too", async () => {
  const { decide } = await load();
  const { result, row } = await decide(args({ mode: "live", qaSpecified: false, env: {}, transport: fake(verLight) }));
  assert.equal(row.fallback, "no-key");
  assert.equal(result.effective, "full");
  assert.equal(row.floor, "full");
});

test("with qa-specify: live verify behaves as before and logs no floor", async () => {
  const { decide } = await load();
  const { result, row } = await decide(args({ mode: "live", qaSpecified: true, transport: fake(verLight) }));
  assert.equal(result.effective, "light");
  assert.equal(result.applied, true);
  assert.equal(row.actual, "light");
  assert.equal(row.floor, null);
  assert.equal(result.floor, null);
});

test("omitting qaSpecified keeps current behaviour (light applies in live)", async () => {
  const { decide } = await load();
  const { result, row } = await decide(args({ mode: "live", transport: fake(verLight) }));
  assert.equal(result.effective, "light");
  assert.equal(row.floor, null);
});

test("the floor is verify-only: tier ignores qaSpecified", async () => {
  const { decide } = await load();
  const { result, row } = await decide(
    args({ point: "tier", mode: "live", qaSpecified: false, transport: fake(tierHard) }),
  );
  assert.equal(result.effective, "opus");
  assert.equal(row.floor, null);
});

// ---- CLI: the handoff lookup ----

function boardRoot(handoffs = []) {
  const root = mkdtempSync(path.join(tmpdir(), "jev-floor-"));
  mkdirSync(path.join(root, ".scratch", "feat", "issues"), { recursive: true });
  mkdirSync(path.join(root, ".scratch", "feat", "handoffs"), { recursive: true });
  writeFileSync(path.join(root, ".scratch", "feat", "issues", "07-thing.md"), "# 07\n\n**What to build:** a thing.\n");
  for (const h of handoffs) writeFileSync(path.join(root, ".scratch", "feat", "handoffs", h), "# handoff\n");
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

test("CLI verify with no qa-specify handoff: effective full, floor in stdout and row (live and shadow)", () => {
  for (const mode of ["shadow", "live"]) {
    const root = boardRoot(["07-developer.md", "08-qa-specify.md"]);
    const r = cli(root, ["verify", "--ticket", TICKET, "--mode", mode]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.effective, "full");
    assert.equal(out.floor, "full");
    assert.equal(lastRow(root).floor, "full");
  }
});

test("CLI verify with a 07-qa-specify handoff: no floor recorded", () => {
  for (const name of ["07-qa-specify.md", "07-qa-specify2.md"]) {
    const root = boardRoot([name]);
    const r = cli(root, ["verify", "--ticket", TICKET]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout.trim()).floor, null);
    assert.equal(lastRow(root).floor, null);
  }
});

test("CLI tier never records a floor", () => {
  const root = boardRoot();
  const r = cli(root, ["tier", "--ticket", TICKET]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lastRow(root).floor, null);
});
