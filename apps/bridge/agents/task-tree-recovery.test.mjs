import { test } from "node:test";
import assert from "node:assert/strict";
import { recoveryFailure, reviewFailure } from "./task-tree-workflow.mjs";

const pass = { verdict: "pass", candidate: "a".repeat(40), checks: [], guardVerdicts: [], attemptId: "review" };
test("legacy failure evidence remains terminal without a new-format latch", () => {
  for (const [workflow, code] of [
    [{ reviews: { qa: { ...pass, verdict: "bounce" } } }, "review-bounce"],
    [{ reviews: { qa: { ...pass, checks: [{ passed: false }] } } }, "review-check-failed"],
    [{ reviewSubmissions: { review: { ...pass, guardVerdicts: [{ verdict: "bounce" }] } } }, "test-guard-bounce"],
    [{ userVerdict: { verdict: "decline" } }, "user-declined"],
    [{ completion: { checks: [{ passed: false }] } }, "author-check-failed"],
    [{ attempts: [{ id: "review", phase: "qa", state: "failed" }] }, "review-attempt-failed"],
    [{ attempts: [{ id: "review", phase: "qa", state: "done" }] }, "review-report-missing"],
    [{ cancelledByUser: true }, "cancelled-by-user"],
    [{ terminalFailure: { code: "review-verification-failed" } }, "review-verification-failed"],
  ]) assert.equal(recoveryFailure(workflow), code);
});

test("interrupted reviews and positively submitted reports with uncertain cleanup are not terminal failures", () => {
  assert.equal(recoveryFailure({ attempts: [{ id: "review", phase: "qa", state: "working" }] }), null);
  assert.equal(recoveryFailure({ attempts: [{ id: "review", phase: "qa", state: "terminated", reason: "bridge-shutdown" }] }), null);
  assert.equal(recoveryFailure({ attempts: [{ id: "review", phase: "qa", state: "done", cleanupConfirmed: false }], reviewSubmissions: { review: pass } }), null);
  assert.equal(recoveryFailure({ attempts: [{ id: "review", phase: "qa", state: "done" }], reviews: { qa: pass } }), null);
});

test("review failure classification uses verdicts and check results rather than error text", () => {
  assert.equal(reviewFailure(pass), null);
  assert.equal(reviewFailure({ ...pass, findings: ["The word bounce is quoted in a source comment."] }), null);
  assert.equal(reviewFailure({ ...pass, checks: [{ passed: false, evidence: "ordinary command output" }] }), "review-check-failed");
  assert.equal(reviewFailure({ verdict: "pass" }), "review-evidence-invalid");
});
