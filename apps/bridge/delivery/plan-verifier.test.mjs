// trust-ladder/03: the verify/fix loop in the plan. The runner stamps job.verify from the Profile: how many independent qa
// verify passes a candidate needs (count) and, for a job that drives the running app, the loop cap that replaces
// MAX_BOUNCES (cap) and the text of what still fails (failing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextStep } from "./plan.mjs";
import { validateJob } from "./jobs.mjs";

const BASE = "a".repeat(40), SHA = "b".repeat(40), MAIN = "d".repeat(40);
const risk = { sha: SHA, clean: true, hits: 0, secret: false, security: false, userMerge: false, floor: { roles: ["code-reviewer", "qa"], why: {} } };
const synced = { sha: SHA, main: MAIN, conflicts: [], at: "push" };
const job = (evidence = {}, more = {}) => ({ base: BASE, candidate: { sha: SHA }, bounces: 0, evidence: { review: { sha: SHA, verdict: "pass" }, risk, ...evidence }, ...more });
const qaPass = (passes) => ({ sha: SHA, verdict: "pass", ...(passes ? { passes } : {}) });
const qaRun = { kind: "run", role: "qa", mode: "verify", at: SHA, since: BASE };
const fixRun = { kind: "run", role: "developer", at: SHA, since: BASE, fix: true };

test("a candidate needs as many passing qa verify passes as the Profile's verifier count", () => {
  assert.deepEqual(nextStep(job({ qa: qaPass(1) }, { verify: { count: 2 } })), qaRun);
  assert.deepEqual(nextStep(job({ qa: qaPass(2) }, { verify: { count: 3 } })), qaRun);
  assert.deepEqual(nextStep(job({ qa: qaPass(2), sync: synced }, { verify: { count: 2 } })), { kind: "publish" }, "all passes made: on to the push");
  assert.deepEqual(nextStep(job({ qa: qaPass(1), sync: synced }, { verify: { count: 1 } })), { kind: "publish" });
  assert.deepEqual(nextStep(job({ qa: qaPass(), sync: synced })), { kind: "publish" }, "no count: one pass, as before");
});

test("a pass that follows a bounced code review is not repeated: the fix round comes first", () => {
  assert.deepEqual(nextStep(job({ review: { sha: SHA, verdict: "bounce" }, qa: qaPass(1) }, { bounces: 1, verify: { count: 2 } })), fixRun);
});

test("the loop cap replaces the second-bounce stop, and the pause says what still fails", () => {
  const bounced = job({ qa: { sha: SHA, verdict: "bounce" } }, { verify: { count: 1, cap: 3, failing: "click on #save shows a blank panel" } });
  assert.deepEqual(nextStep({ ...bounced, bounces: 2 }), fixRun, "the third round is still allowed at cap 3");
  const stopped = nextStep({ ...bounced, bounces: 3 });
  assert.equal(stopped.pause, "failed-twice");
  assert.match(stopped.reason, /cap of 3/);
  assert.match(stopped.reason, /click on #save shows a blank panel/);
  assert.equal(nextStep(job({ qa: { sha: SHA, verdict: "bounce" } }, { bounces: 2, verify: { count: 1 } })).pause, "failed-twice", "a job with no cap keeps the second-bounce stop");
});

test("a red check on a job with a loop cap stops at the cap, not at the second bounce", () => {
  const red = job({ qa: qaPass(1), sync: synced, pr: { sha: SHA, state: "OPEN", mergeable: "MERGEABLE" }, ci: { sha: SHA, state: "red", failed: ["test"] } }, { verify: { count: 1, cap: 4 } });
  assert.deepEqual(nextStep({ ...red, bounces: 2 }), fixRun, "the third round is still allowed at cap 4");
  assert.equal(nextStep({ ...red, bounces: 4 }).pause, "failed-twice");
  assert.equal(nextStep({ ...red, verify: { count: 1 }, bounces: 2 }).pause, "failed-twice", "a job with no cap keeps the second-bounce stop");
});

test("the pass count and the verifier evidence of a record read back after a restart", () => {
  const RUN = "c-0123456789abcdef";
  const record = { id: "d-0123456789abcdef", ref: "fx/08-plain", title: "t", type: "feature", state: "running", base: BASE, startedAt: "2026-10-25T00:00:00.000Z",
    candidate: { sha: SHA, runId: RUN }, evidence: { qa: { sha: SHA, runId: RUN, verdict: "pass", passes: 2 } },
    verifierEvidence: { sha: SHA, items: ["screenshot loaded: .scratch/fx/evidence/08-plain/loaded.png", "perf: load 80 ms"], evil: 1 } };
  const back = validateJob(record);
  assert.equal(back.evidence.qa.passes, 2, "a count-N job does not start qa from pass 1 again");
  assert.deepEqual(back.verifierEvidence, { sha: SHA, items: ["screenshot loaded: .scratch/fx/evidence/08-plain/loaded.png", "perf: load 80 ms"] });
  assert.equal(validateJob({ ...record, evidence: { qa: { sha: SHA, runId: RUN, verdict: "pass", passes: "many" } } }).evidence.qa.passes, undefined, "a bad count is dropped: one pass, as before");
  assert.equal(validateJob({ ...record, verifierEvidence: { sha: "main", items: ["x"] } }).verifierEvidence, null);
});
