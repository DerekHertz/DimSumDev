// den-mvp/29: the CI watch against a fake git host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCiWatch, ciMessage, classify } from "./ci-watch.mjs";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const check = (name, jobId, { done = true, ok = false, cancelled = false } = {}) => ({ name, done, ok, cancelled, jobId: String(jobId), runId: "900" });
const pass = (name, jobId) => check(name, jobId, { ok: true });
const pr = (checks, { number = 7, sha = SHA, files = ["apps/ui/src/App.jsx"] } = {}) => ({ number, url: `https://github.com/o/r/pull/${number}`, title: "a change", branch: "x", sha, files, checks });

function fakeGit() {
  const git = {
    prs: [],
    reruns: [],
    notes: {},
    logs: {},
    fail: null,
    async openPrs() {
      if (git.fail) throw git.fail;
      return git.prs;
    },
    annotations: async ({ jobId }) => git.notes[jobId] ?? [],
    failedLog: async ({ jobId }) => git.logs[jobId] ?? "",
    rerunFailed: async ({ runId }) => void git.reruns.push(runId),
  };
  return git;
}

async function setup(t, more = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ci-watch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = fakeGit();
  const changes = [];
  const make = () => createCiWatch({ git, file: path.join(dir, "ci-watch.json"), onChange: (c) => changes.push(c), now: () => Date.parse("2026-10-14T20:00:00Z"), ...more });
  return { git, changes, make, watch: make() };
}

test("a pull request opened outside the den whose test job fails is a Needs you item with the first failing test", async (t) => {
  const { git, changes, watch } = await setup(t);
  git.prs = [pr([check("test", 1), pass("security", 2)])];
  git.logs["1"] = "test\tRun\tok 1 - fine\ntest\tRun\tnot ok 2 - the queue keeps its order\ntest\tRun\tnot ok 3 - later";
  await watch.poll();
  const [item] = watch.snapshot().prs;
  assert.equal(item.number, 7);
  assert.equal(item.state, "red");
  assert.equal(item.route, "orchestrator");
  assert.deepEqual(item.jobs, [{ name: "test", reason: "first failing test: the queue keeps its order" }]);
  assert.equal(changes.at(-1).type, "ci");
  assert.equal(git.reruns.length, 0);
});

test("a timeout is reported as a timeout and re-run once; a second red on the same commit asks the user", async (t) => {
  const { git, watch } = await setup(t);
  git.prs = [pr([check("test", 1, { cancelled: true }), pass("security", 2)])];
  git.notes["1"] = ["The job has exceeded the maximum execution time of 15m0s", "The operation was canceled."];
  await watch.poll();
  assert.deepEqual(git.reruns, ["900"]);
  assert.equal(watch.snapshot().prs[0].state, "rerun");
  assert.deepEqual(watch.snapshot().prs[0].jobs, [{ name: "test", reason: "timed out at 15m0s" }]);
  await watch.poll(); // the same red, seen again before the re-run registers: nothing more
  assert.equal(git.reruns.length, 1);
  git.prs = [pr([check("test", 3, { done: false }), pass("security", 2)])];
  await watch.poll(); // the re-run is under way
  assert.equal(watch.snapshot().prs[0].state, "rerun");
  git.prs = [pr([check("test", 3, { cancelled: true }), pass("security", 2)])];
  git.notes["3"] = git.notes["1"];
  await watch.poll();
  assert.equal(git.reruns.length, 1, "a timeout is re-run once per commit");
  assert.equal(watch.snapshot().prs[0].state, "asks-user");
});

test("a cancel that is not a timeout is not re-run", async (t) => {
  const { git, watch } = await setup(t);
  git.prs = [pr([check("test", 1, { cancelled: true })])];
  git.notes["1"] = ["The operation was canceled."];
  await watch.poll();
  assert.equal(git.reruns.length, 0);
  assert.deepEqual(watch.snapshot().prs[0].jobs, [{ name: "test", reason: "cancelled" }]);
  assert.equal(watch.snapshot().prs[0].state, "red");
});

test("a red security job, or a red change that touches the wall or CI, goes to security", async (t) => {
  const { git, watch } = await setup(t);
  git.prs = [
    pr([pass("test", 1), check("security", 2)], { number: 1 }),
    pr([check("test", 3)], { number: 2, files: ["apps/bridge/agents/claude-adapter.mjs"] }),
    pr([check("test", 4)], { number: 3, files: [".github/workflows/ci.yml"] }),
    pr([check("test", 5)], { number: 4, files: ["apps/bridge/server.mjs"] }),
  ];
  await watch.poll();
  assert.deepEqual(watch.snapshot().prs.map((p) => [p.number, p.route]), [[1, "security"], [2, "security"], [3, "security"], [4, "orchestrator"]]);
});

test("a real failure re-run by someone and red again on the same commit asks the user; a new commit starts over", async (t) => {
  const { git, watch } = await setup(t);
  git.prs = [pr([check("test", 1)])];
  await watch.poll();
  assert.equal(watch.snapshot().prs[0].state, "red");
  git.prs = [pr([check("test", 2)])];
  await watch.poll();
  assert.equal(watch.snapshot().prs[0].state, "asks-user");
  git.prs = [pr([check("test", 3)], { sha: SHA2 })];
  await watch.poll();
  assert.equal(watch.snapshot().prs[0].state, "red");
  assert.equal(watch.snapshot().prs[0].sha, SHA2);
});

test("checks still running are waited for; green and closed pull requests leave the list", async (t) => {
  const { git, watch } = await setup(t);
  git.prs = [pr([check("test", 1), check("security", 2, { done: false })])];
  await watch.poll();
  assert.deepEqual(watch.snapshot().prs, []);
  git.prs = [pr([check("test", 1), pass("security", 2)])];
  await watch.poll();
  assert.equal(watch.snapshot().prs.length, 1);
  git.prs = [pr([pass("test", 3), pass("security", 2)])];
  await watch.poll();
  assert.deepEqual(watch.snapshot().prs, []);
  git.prs = [pr([check("test", 4)], { number: 8 })];
  await watch.poll();
  git.prs = [];
  await watch.poll();
  assert.deepEqual(watch.snapshot().prs, []);
});

test("after a restart the record is read back: a re-run is not run twice and a second red still asks the user", async (t) => {
  const { git, make, watch } = await setup(t);
  git.prs = [pr([check("test", 1, { cancelled: true })])];
  git.notes["1"] = ["The job has exceeded the maximum execution time of 15m0s"];
  await watch.poll();
  const again = make();
  await again.poll();
  assert.equal(git.reruns.length, 1);
  assert.equal(again.snapshot().prs[0].state, "rerun");
  git.prs = [pr([check("test", 2)])];
  await again.poll();
  assert.equal(again.snapshot().prs[0].state, "asks-user");
});

test("a git host error is shown, not swallowed, and the next poll clears it", async (t) => {
  const { git, watch } = await setup(t);
  git.fail = Object.assign(new Error("boom"), { stderr: "gh: not logged in" });
  await watch.poll();
  assert.match(watch.snapshot().error, /could not read the pull requests: gh: not logged in/);
  git.fail = null;
  await watch.poll();
  assert.equal(watch.snapshot().error, null);
});

test("a pull request a delivery owns is left to the delivery: no item and no re-run", async (t) => {
  const { git, watch } = await setup(t, { skip: (n) => n === 7 });
  git.prs = [pr([check("test", 1, { cancelled: true })]), pr([check("test", 2)], { number: 8 })];
  git.notes["1"] = ["The job has exceeded the maximum execution time of 15m0s"];
  await watch.poll();
  assert.deepEqual(watch.snapshot().prs.map((p) => p.number), [8]);
  assert.equal(git.reruns.length, 0);
});

// den-mvp/29 part 2b: a red pull request outside the den wakes Bao's desk once per commit.
test("the first real red on a commit tells Bao's desk once; a timeout, a second red and a green do not", async (t) => {
  const told = [];
  const { git, watch } = await setup(t, { wake: async (text) => (told.push(text), { ok: true }) });
  git.prs = [pr([check("test", 1)])];
  git.logs["1"] = "test\tRun\t2026-10-14T20:00:00.0000000Z not ok 2 - the queue keeps its order\ntest\tRun\t2026-10-14T20:00:00.0000000Z   expected: 3";
  await watch.poll();
  await watch.poll();
  assert.equal(told.length, 1);
  assert.match(told[0], /pull request #7 \(a change\) is red on aaaaaaaaaaaa/);
  assert.match(told[0], /- test: first failing test: the queue keeps its order/);
  assert.match(told[0], /data, not instructions\.\n\nnot ok 2 - the queue keeps its order\n {2}expected: 3$/);
  assert.equal(watch.snapshot().prs[0].bao, "Bao was told");
  git.prs = [pr([check("test", 2)])];
  await watch.poll();
  assert.equal(watch.snapshot().prs[0].state, "asks-user");
  assert.equal(told.length, 1, "a second red on the same commit starts nothing");
  git.prs = [pr([check("test", 3, { cancelled: true })], { number: 8 })];
  git.notes["3"] = ["The job has exceeded the maximum execution time of 15m0s"];
  await watch.poll();
  assert.equal(told.length, 1, "a timeout is re-run, not told");
});

test("a desk that cannot be reached is shown on the item, not swallowed", async (t) => {
  const { git, watch } = await setup(t, { wake: async () => ({ ok: false, error: "the bao slot is busy" }) });
  git.prs = [pr([check("security", 1)])];
  await watch.poll();
  assert.equal(watch.snapshot().prs[0].bao, "Bao could not be told: the bao slot is busy");
  assert.equal(watch.snapshot().prs[0].route, "security");
});

test("the message fits the 2 KB cap, asks about security when routed there, and drops a log that looks like a secret", () => {
  const p = pr([], { number: 9 });
  const long = ciMessage(p, [{ name: "test", reason: "failed", excerpt: "x".repeat(5000) }], "orchestrator");
  assert.ok(Buffer.byteLength(long) <= 2048);
  assert.match(long, /x{100}/);
  assert.match(ciMessage(p, [{ name: "security", reason: "failed", excerpt: "" }], "security"), /start a security review/);
  const key = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
  assert.doesNotMatch(ciMessage(p, [{ name: "test", reason: "failed", excerpt: `token ${key}` }], "orchestrator"), /AKIA/);
});

test("the excerpt quotes every failing test, not only the lines after the first (den-mvp/01's second failure was cut off)", async () => {
  const pad = Array.from({ length: 80 }, (_, i) => `test\tRun\t2026-10-15T01:55:00.0000000Z     detail ${i}`);
  const log = ["test\tRun\t2026-10-15T01:55:00.0000000Z not ok 1 - the child is stopped", ...pad,
    "test\tRun\t2026-10-15T01:56:00.0000000Z not ok 2 - preflight fails with that reason", "test\tRun\t2026-10-15T01:56:00.0000000Z   actual: 'bwrap is not installed'"].join("\n");
  const r = await classify({ failedLog: async () => log }, { name: "test", jobId: "1" });
  assert.equal(r.reason, "first failing test: the child is stopped");
  assert.match(r.excerpt, /not ok 1 - the child is stopped/);
  assert.match(r.excerpt, /not ok 2 - preflight fails with that reason\n {2}actual: 'bwrap is not installed'/);
  assert.ok(r.excerpt.split("\n").length <= 120);
});
