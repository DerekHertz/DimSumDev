// organism-infra/72: the prelude's board glue (new inputs, cutoff, CI parsing) and its CLI on a temp board.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ciFromPrs, codeDecides, lastOrchestratorTs, newInputs } from "./jev-wake-prelude.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "jev-wake-prelude.mjs");

const ev = (over) => ({ feature: "feat", ticket: "01-a", op: "comment", role: "developer", text: "note", ts: "2026-09-30T10:00:00.000Z", ...over });

test("lastOrchestratorTs picks the orchestrator's newest event, null when it has none", () => {
  const events = [
    ev({ role: "orchestrator", ts: "2026-09-30T08:00:00.000Z" }),
    ev({ role: "orchestrator", op: "release", ts: "2026-09-30T09:00:00.000Z" }),
    ev({ role: "developer", ts: "2026-09-30T11:00:00.000Z" }),
  ];
  assert.equal(lastOrchestratorTs(events), "2026-09-30T09:00:00.000Z");
  assert.equal(lastOrchestratorTs([ev({})]), null);
});

test("newInputs keeps comments after the cutoff, not the orchestrator's own or other ops", () => {
  const events = [
    ev({ text: "old", ts: "2026-09-30T08:00:00.000Z" }),
    ev({ text: "mine", role: "orchestrator" }),
    ev({ op: "claim", text: undefined }),
    ev({ text: "fresh", verdict: "pass", role: "qa" }),
  ];
  const inputs = newInputs(events, "2026-09-30T09:00:00.000Z", (f, t) => `# ${f}/${t}`);
  assert.deepEqual(inputs, [
    { ticket: "feat/01-a", ticketText: "# feat/01-a", newComment: "fresh", author: "qa", verdict: "pass" },
  ]);
});

test("ciFromPrs flags failing checks and conflicting PRs, not passing or pending ones", () => {
  assert.deepEqual(ciFromPrs([]), { ciRed: false, conflicted: false });
  assert.deepEqual(
    ciFromPrs([{ mergeable: "MERGEABLE", statusCheckRollup: [{ conclusion: "SUCCESS" }, { state: "PENDING" }] }]),
    { ciRed: false, conflicted: false },
  );
  assert.equal(ciFromPrs([{ statusCheckRollup: [{ conclusion: "FAILURE" }] }]).ciRed, true);
  assert.equal(ciFromPrs([{ statusCheckRollup: [{ state: "ERROR" }] }]).ciRed, true);
  assert.equal(ciFromPrs([{ mergeable: "CONFLICTING" }]).conflicted, true);
});

test("codeDecides wakes when CI state is unreadable", () => {
  assert.equal(codeDecides({ ciUnknown: true }).wake, true);
});

function board({ ready = false, pendingRequest = false, orchestratorEvent = true, fiveHour = null, lockedBy = null, secondReady = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "wake-prelude-"));
  const issues = path.join(root, ".scratch", "feat", "issues");
  mkdirSync(issues, { recursive: true });
  const status = ready ? "ready-for-agent" : "in-review";
  writeFileSync(path.join(issues, "01-a.md"), `# 01: A\n\n**Status:** ${status}\n\n**Blocked by:** none\n`);
  if (secondReady) writeFileSync(path.join(issues, "02-b.md"), `# 02: B\n\n**Status:** ready-for-agent\n\n**Blocked by:** none\n`);
  if (lockedBy) writeFileSync(path.join(issues, "01-a.lock"), `${lockedBy} 2026-09-30T09:15:00.000Z\n`);
  if (fiveHour !== null) {
    const row = { kind: "usage", five_hour: fiveHour, weekly: 40, ts: "2026-09-30T09:20:00.000Z" };
    writeFileSync(path.join(root, ".scratch", "usage.jsonl"), JSON.stringify(row) + "\n");
  }
  const events = orchestratorEvent ? [ev({ role: "orchestrator", ts: "2026-09-30T09:00:00.000Z" })] : [];
  writeFileSync(path.join(root, ".scratch", "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (pendingRequest) {
    mkdirSync(path.join(root, ".scratch", "_requests"));
    const row = { id: "r1", ts: "2026-09-30T09:30:00.000Z", kind: "merge-approve", ref: "feat/01-a" };
    writeFileSync(path.join(root, ".scratch", "_requests", "requests.jsonl"), JSON.stringify(row) + "\n");
  }
  return root;
}

function run(root, args = ["--since", "last"]) {
  const env = { ...process.env, DEN_ROOT: root };
  delete env.TYPESAFE_API_KEY;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, env, encoding: "utf8", timeout: 20000 });
  return { ...r, out: r.status === 0 ? JSON.parse(r.stdout) : null };
}

test("CLI: a non-empty frontier wakes with no Jev row logged", () => {
  const root = board({ ready: true });
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.wake, true);
  assert.match(r.out.reason, /frontier/);
  assert.equal(r.out.mode, "shadow");
  assert.equal(r.out.jevCalls, 0);
  assert.equal(existsSync(path.join(root, ".scratch", "usage.jsonl")), false);
});

test("CLI: a pending gate request wakes", () => {
  const r = run(board({ pendingRequest: true }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.wake, true);
  assert.match(r.out.reason, /gate request/);
});

test("CLI: --since last with no orchestrator event wakes", () => {
  const r = run(board({ ready: true, orchestratorEvent: false }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.wake, true);
  assert.match(r.out.reason, /no orchestrator event/);
});

test("[91] AC2: CLI at 90% usage an agent in flight still wakes, with no Jev row logged", () => {
  const root = board({ lockedBy: "developer", secondReady: true, fiveHour: 90 });
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.wake, true);
  assert.match(r.out.reason, /in flight/);
  assert.equal(r.out.jevCalls, 0);
});

test("[91] AC1: CLI at 89% usage a non-empty frontier still wakes", () => {
  const r = run(board({ ready: true, fiveHour: 89 }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.wake, true);
  assert.match(r.out.reason, /frontier/);
});

test("[91] AC1: CLI at 85% usage a non-empty frontier still wakes (it was suppressed at the old 80% line)", () => {
  const r = run(board({ ready: true, fiveHour: 85 }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.wake, true);
  assert.match(r.out.reason, /frontier/);
});

test("CLI: a bad --since exits 2", () => {
  const r = run(board(), ["--since", "yesterday-ish"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--since/);
});
