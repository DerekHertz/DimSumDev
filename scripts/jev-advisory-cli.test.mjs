// organism-infra/79: developer-owned tests for what the qa specify files leave open: advisory on the bounce
// half of route, advisory refused for other points, and the log-only CLI points the orchestrator uses at the
// dispatch step (advisory-outcome).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "./jev.mjs";

const SCRIPT = fileURLToPath(new URL("./jev.mjs", import.meta.url));
const NOW = new Date("2026-09-30T10:00:00Z");
const KEY = "sk" + "-test-KEYVALUE-advisory-79-456";

function makeBoard(files = {}, usageRows = []) {
  const root = mkdtempSync(path.join(tmpdir(), "jev-advisory-cli-"));
  mkdirSync(path.join(root, ".scratch", "feat", "issues"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(root, ".scratch", "feat", "issues", name), text);
  if (usageRows.length) writeFileSync(path.join(root, ".scratch", "usage.jsonl"), usageRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return root;
}
function runCli(root, argv) {
  const env = { ...process.env, DEN_ROOT: root };
  delete env.TYPESAFE_API_KEY;
  return spawnSync(process.execPath, [SCRIPT, ...argv], { cwd: root, env, encoding: "utf8", timeout: 20000 });
}
const usagePath = (root) => path.join(root, ".scratch", "usage.jsonl");
const readRows = (root) => readFileSync(usagePath(root), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("route-bounce in advisory mode shows the pick and conf; effective stays orchestrator", async () => {
  const { result, row } = await decide({
    point: "route-bounce", ticket: "feat/07-thing", ticketText: "# 07\n", bounceComment: "tests are wrong",
    now: NOW, usageRows: [], env: { TYPESAFE_API_KEY: KEY }, mode: "advisory",
    transport: async () => ({ pick: "qa", probs: { qa: 0.8 }, usage: { cost: 0.0004 } }),
  });
  assert.equal(result.pick, "qa");
  assert.equal(result.conf, 0.8);
  assert.equal(result.effective, "orchestrator");
  assert.equal(result.applied, false);
  assert.equal(row.mode, "advisory");
  assert.equal(row.variant, "bounce");
});

test("priority still hides the pick when called with mode advisory (the exemption is route only)", async () => {
  const { result } = await decide({
    point: "priority", ticket: "feat/07-thing", ticketText: "# 07\n\n**Priority:** P3\n",
    now: NOW, usageRows: [], env: { TYPESAFE_API_KEY: KEY }, mode: "advisory",
    transport: async () => ({ pick: "mismatch", probs: { mismatch: 0.9 }, usage: { cost: 0.0003 } }),
  });
  assert.equal(result.pick, undefined);
  assert.equal(result.conf, undefined);
});

test("CLI refuses --mode advisory for a point other than route (exit 2, no row)", () => {
  const root = makeBoard({ "07-thing.md": "# 07\n\n**Priority:** P1\n" });
  for (const point of ["tier", "verify", "priority", "scope"]) {
    const r = runCli(root, [point, "--ticket", "feat/07-thing", "--mode", "advisory"]);
    assert.equal(r.status, 2, `${point}: ${r.stderr}`);
    assert.match(r.stderr, /advisory/);
  }
  assert.equal(existsSync(usagePath(root)), false);
});

test("CLI accepts --mode advisory for route-bounce", () => {
  const root = makeBoard({ "07-thing.md": "# 07\n\n**Status:** in-review\n" });
  const r = runCli(root, ["route-bounce", "--ticket", "feat/07-thing", "--mode", "advisory"]);
  assert.equal(r.status, 0, r.stderr);
  const [row] = readRows(root);
  assert.equal(row.mode, "advisory");
  assert.equal(row.variant, "bounce");
});

test("CLI advisory-outcome logs orchestrator pick, Jev pick, user choice and bounce", () => {
  const root = makeBoard();
  const r = runCli(root, [
    "advisory-outcome", "--ticket", "feat/07-thing", "--orchestrator", "qa-specify", "--jev", "architect",
    "--user", "architect", "--bounced", "true",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const [row] = readRows(root);
  assert.equal(row.kind, "jev-advisory-outcome");
  assert.equal(typeof row.ts, "string");
  assert.equal(row.ticket, "feat/07-thing");
  assert.equal(row.orchestratorPick, "qa-specify");
  assert.equal(row.jevPick, "architect");
  assert.equal(row.userChoice, "architect");
  assert.equal(row.bounced, true);
  assert.deepEqual(JSON.parse(r.stdout), row);
});

test("CLI advisory-outcome --jev none logs a null Jev pick (a fallback gave no pick)", () => {
  const root = makeBoard();
  const r = runCli(root, [
    "advisory-outcome", "--ticket", "feat/07-thing", "--orchestrator", "product", "--jev", "none",
    "--user", "product", "--bounced", "false",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const [row] = readRows(root);
  assert.equal(row.jevPick, null);
  assert.equal(row.bounced, false);
});

test("CLI advisory-outcome refuses missing or malformed fields (exit 2, no row)", () => {
  const root = makeBoard();
  const base = ["advisory-outcome", "--ticket", "feat/07-thing"];
  const bad = [
    [...base, "--orchestrator", "product", "--jev", "none", "--user", "product"],
    [...base, "--orchestrator", "product", "--jev", "none", "--user", "product", "--bounced", "maybe"],
    [...base, "--orchestrator", "pro duct", "--jev", "none", "--user", "product", "--bounced", "false"],
    [...base, "--orchestrator", "product", "--jev", "none", "--bounced", "false"],
    [...base, "--orchestrator", "product", "--jev", "none", "--user", "product", "--bounced", "false", "--mode", "live"],
  ];
  for (const argv of bad) assert.equal(runCli(root, argv).status, 2, argv.join(" "));
  assert.equal(existsSync(usagePath(root)), false);
});

test("CLI priority-verdict refuses a verdict other than right or wrong", () => {
  const root = makeBoard();
  const r = runCli(root, ["priority-verdict", "--ticket", "feat/07-thing", "--verdict", "maybe"]);
  assert.equal(r.status, 2);
  assert.equal(existsSync(usagePath(root)), false);
});
