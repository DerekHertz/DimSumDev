// organism-infra/79: jev.mjs route in advisory-live mode (ADR 0015).
//
// Pinned contract (developer implements against it):
//   decide({point:"route", mode:"advisory"}) behaves like live pick-visibility:
//     result.pick and result.conf ARE present (not deleted as in shadow).
//     result.applied is false; result.effective is always "orchestrator".
//     row.mode is "advisory"; row.kind is "jev"; row.point is "route".
//   Any fallback (no-key, outage, cap) still exits 0; dispatch proceeds without a pick.
//   The CLI accepts --mode advisory for the route point (only).
//   Other points (tier, verify, priority, scope, wake) are shadow-only; the shadow
//   rules and hide-the-pick behaviour for those points are unchanged by this ticket.
//
// Criteria covered:
//   [1] jev.mjs route --mode advisory returns pick+conf and logs an advisory row;
//       shadow rules for other points are unchanged
//   [3] Jev outage, missing key or cap still exits 0 and dispatch proceeds
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, "scripts", "jev.mjs");
const NOW = new Date("2026-09-30T10:00:00Z");
const TICKET = "feat/07-thing";
const KEY = "sk" + "-test-KEYVALUE-advisory-79-123";

const load = () => import("./jev.mjs");
const ans = (pick, cost = 0.0004) => ({ pick, probs: { [pick]: 0.87, other: 0.13 }, usage: { cost } });
function fake(answer, calls = []) {
  return async (req) => { calls.push(req); return answer; };
}
function args(over = {}) {
  return {
    point: "route",
    ticket: TICKET,
    ticketText: "# 07\n\n**What to build:** a thing.\n",
    now: NOW,
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    mode: "advisory",
    ...over,
  };
}
const jrow = (point, cost) => ({ kind: "jev", ts: NOW.toISOString(), point, cost });

function makeBoard(ticketText) {
  const root = mkdtempSync(path.join(tmpdir(), "jev-advisory-cli-"));
  mkdirSync(path.join(root, ".scratch", "feat", "issues"), { recursive: true });
  writeFileSync(path.join(root, ".scratch", "feat", "issues", "07-thing.md"), ticketText);
  return root;
}
function runCli(root, argv) {
  const env = { ...process.env, DEN_ROOT: root };
  delete env.TYPESAFE_API_KEY;
  return spawnSync(process.execPath, [SCRIPT, ...argv], { cwd: root, env, encoding: "utf8", timeout: 20000 });
}
function readRows(root) {
  return readFileSync(path.join(root, ".scratch", "usage.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
}

// ── Criterion 1: advisory mode shows pick and conf ──────────────────────────

test("advisory mode: result.pick is present and equals the model label (not deleted like shadow)", async () => {
  const { decide } = await load();
  const { result } = await decide(args({ transport: fake(ans("architect")) }));
  assert.equal(result.pick, "architect");
});

test("advisory mode: result.conf is present and is a number between 0 and 1", async () => {
  const { decide } = await load();
  const { result } = await decide(args({ transport: fake(ans("product")) }));
  assert.ok(typeof result.conf === "number", `conf should be a number, got ${typeof result.conf}`);
  assert.ok(result.conf > 0 && result.conf <= 1, `conf out of range: ${result.conf}`);
});

test("advisory mode: result.applied is false and result.effective is orchestrator", async () => {
  const { decide } = await load();
  const { result } = await decide(args({ transport: fake(ans("qa-specify")) }));
  assert.equal(result.applied, false);
  assert.equal(result.effective, "orchestrator");
});

test("advisory mode: row.mode is advisory, row.kind is jev, row.point is route", async () => {
  const { decide } = await load();
  const { row } = await decide(args({ transport: fake(ans("designer")) }));
  assert.equal(row.mode, "advisory");
  assert.equal(row.kind, "jev");
  assert.equal(row.point, "route");
  assert.equal(row.fallback, null);
});

test("advisory mode: row.pick is the model label, row.actual is orchestrator", async () => {
  const { decide } = await load();
  const { row } = await decide(args({ transport: fake(ans("architect")) }));
  assert.equal(row.pick, "architect");
  assert.equal(row.actual, "orchestrator");
});

test("advisory mode: pick other → result.pick is other, applied false, effective orchestrator", async () => {
  const { decide } = await load();
  const { result, row } = await decide(args({ transport: fake(ans("other")) }));
  assert.equal(row.pick, "other");
  assert.equal(result.pick, "other");
  assert.equal(result.effective, "orchestrator");
  assert.equal(result.applied, false);
});

// ── Criterion 1: shadow rules for other points are unchanged ─────────────────

test("tier in shadow mode: pick hidden from result.pick (no change from advisory ticket)", async () => {
  const { decide } = await load();
  const tierAns = { pick: "hard", probs: { hard: 0.9, standard: 0.08, other: 0.02 }, usage: { cost: 0.0005 } };
  const { result, row } = await decide({
    point: "tier",
    ticket: TICKET,
    ticketText: "# 07\n",
    testsText: "# pass 1\n",
    now: NOW,
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    mode: "shadow",
    transport: fake(tierAns),
  });
  assert.equal(row.mode, "shadow");
  // tier uses a map: hard -> opus; shadow does not hide the pick (tier is not a CLOSED_SET point)
  assert.equal(result.pick, "opus");
  assert.equal(result.applied, false);
  assert.equal(result.effective, "sonnet"); // shadow: not applied, fallback is "sonnet"
});

// ── Criterion 3: outage / missing key / cap → effective orchestrator, exit 0 ─

test("advisory + no-key: fallback no-key, effective orchestrator, no transport call", async () => {
  const { decide } = await load();
  const calls = [];
  const { result, row } = await decide(args({ env: {}, transport: fake(ans("product"), calls) }));
  assert.equal(calls.length, 0);
  assert.equal(row.fallback, "no-key");
  assert.equal(row.pick, null);
  assert.equal(result.effective, "orchestrator");
  assert.equal(row.cost, 0);
});

test("advisory + http outage: fallback http, effective orchestrator, cost 0", async () => {
  const { decide } = await load();
  const boom = async () => { throw Object.assign(new Error("HTTP 503"), { status: 503 }); };
  const { result, row } = await decide(args({ transport: boom }));
  assert.equal(row.fallback, "http");
  assert.equal(result.effective, "orchestrator");
  assert.equal(row.pick, null);
  assert.equal(row.cost, 0);
});

test("advisory + network error: fallback network, effective orchestrator", async () => {
  const { decide } = await load();
  const { result, row } = await decide(args({
    transport: async () => { throw new Error("ECONNRESET"); },
  }));
  assert.equal(row.fallback, "network");
  assert.equal(result.effective, "orchestrator");
});

test("advisory + cap exhausted: fallback cap, effective orchestrator, no transport call", async () => {
  const { decide } = await load();
  const calls = [];
  const usageRows = [jrow("priority", 0.3), jrow("wake", 0.21)]; // total 0.51 > 0.50 CAP
  const { result, row } = await decide(args({ usageRows, transport: fake(ans("product"), calls) }));
  assert.equal(calls.length, 0);
  assert.equal(row.fallback, "cap");
  assert.equal(result.effective, "orchestrator");
  assert.equal(row.cost, 0);
});

test("advisory + state machine (in-review): no transport call, fallback state-machine, exit ok", async () => {
  const { decide } = await load();
  const calls = [];
  const { result, row } = await decide(args({ status: "in-review", transport: fake(ans("product"), calls) }));
  assert.equal(calls.length, 0);
  assert.equal(row.fallback, "state-machine");
  assert.equal(result.effective, "orchestrator");
});

// ── CLI: --mode advisory is accepted ────────────────────────────────────────

test("CLI --mode advisory exits 0 and appends a row with mode advisory to usage.jsonl", () => {
  const root = makeBoard("# 07\n\n**Type:** feature\n\n**Status:** ready-for-agent\n");
  const r = runCli(root, ["route", "--ticket", "feat/07-thing", "--mode", "advisory"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const out = JSON.parse(lines[0]);
  assert.equal(out.mode, "advisory");
  assert.equal(out.effective, "orchestrator");
  const rows = readRows(root);
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].mode, "advisory");
  assert.equal(rows[0].point, "route");
});

test("CLI --mode advisory on in-review ticket: state-machine fallback, row.mode advisory, exit 0", () => {
  const root = makeBoard("# 07\n\n**Status:** in-review\n");
  const r = runCli(root, ["route", "--ticket", "feat/07-thing", "--mode", "advisory"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const rows = readRows(root);
  assert.equal(rows[0].fallback, "state-machine");
  assert.equal(rows[0].mode, "advisory");
});

test("CLI --mode advisory with no API key: exit 0, effective orchestrator, fallback no-key", () => {
  const root = makeBoard("# 07\n\n**Type:** feature\n\n**Status:** ready-for-agent\n");
  const r = runCli(root, ["route", "--ticket", "feat/07-thing", "--mode", "advisory"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.effective, "orchestrator");
  const rows = readRows(root);
  assert.equal(rows[0].fallback, "no-key");
  assert.equal(rows[0].mode, "advisory");
});
