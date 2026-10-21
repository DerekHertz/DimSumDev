import { test } from "node:test";
import assert from "node:assert/strict";
import { readTreeEvidence, reviewPassed } from "./task-tree-workflow.mjs";

const candidate = "a".repeat(40);
const contract = { acceptanceCriteria: ["Preserve the existing output.", "Handle empty input."], verificationCommands: ["node --test src/parse.test.mjs"] };
const completion = () => ({ criteria: contract.acceptanceCriteria.map((criterion) => ({ criterion, evidence: "The named covering fixture passed." })),
  checks: [{ command: contract.verificationCommands[0], passed: true, evidence: "The literal covering test file exited zero." }] });
const review = () => ({ ...completion(), candidate, verdict: "pass", findings: [] });
const parseReview = (input, options = {}) => readTreeEvidence(contract, input, { review: true, candidate, ...options });

test("completion must account for each approved criterion and exact check command without new authority", () => {
  const good = completion();
  const report = readTreeEvidence(contract, good);
  assert.deepEqual(report.criteria, good.criteria);
  good.criteria[0].evidence = "mutated caller state";
  assert.notEqual(report.criteria[0].evidence, good.criteria[0].evidence);
  for (const change of [
    (body) => body.criteria.pop(),
    (body) => body.criteria.push({ ...body.criteria[0] }),
    (body) => { body.criteria[1].criterion = body.criteria[0].criterion; },
    (body) => { body.criteria[0].criterion = "Invented success condition"; },
    (body) => { body.checks[0].command = "echo passed"; },
    (body) => { body.checks = []; },
    (body) => { body.model = "caller-selected"; },
    (body) => { body.criteria[0].accepted = true; },
  ]) {
    const body = completion();
    change(body);
    assert.throws(() => readTreeEvidence(contract, body));
  }
});

test("review evidence is bound to the exact frozen candidate and cannot grant publication or parent authority", () => {
  assert.equal(reviewPassed(parseReview(review())), true);
  for (const fields of [
    { candidate: "b".repeat(40) }, { candidate: "HEAD" }, { candidate: null },
    { verdict: "approve" }, { accepted: true }, { parentId: "another-parent" }, { publish: true },
  ]) assert.throws(() => parseReview({ ...review(), ...fields }));
});

test("failed literal checks and bounced reviews retain evidence and cannot become acceptance", () => {
  const body = review();
  body.checks[0].passed = false;
  body.checks[0].evidence = "The covering test failed before any retry.";
  const failed = parseReview(body);
  assert.equal(failed.checks[0].passed, false);
  assert.equal(reviewPassed(failed), false);
  assert.equal(reviewPassed(parseReview({ ...review(), verdict: "bounce", findings: ["The empty-input case still throws."] })), false);
});

test("every trusted guard hit requires an exact attributable verdict; omissions, duplicates and invented hits fail", () => {
  const guardHits = ["src/parse.test.mjs: removed assertion", "src/parse.test.mjs: renamed case"];
  const rows = guardHits.map((hit) => ({ hit, verdict: "accept", reason: "Reviewed the unchanged assertion against the candidate diff." }));
  const options = { guardHits };
  assert.equal(reviewPassed(parseReview({ ...review(), guardVerdicts: rows }, options)), true);
  const bounced = structuredClone(rows);
  bounced[1].verdict = "bounce";
  assert.equal(reviewPassed(parseReview({ ...review(), guardVerdicts: bounced }, options)), false);
  for (const guardVerdicts of [[], [rows[0]], [rows[0], rows[0]], [...rows, rows[0]],
    [rows[0], { ...rows[1], hit: "not in the trusted guard result" }],
    [rows[0], { ...rows[1], reason: " " }],
    [rows[0], { ...rows[1], verdict: "ignore" }]]) {
    assert.throws(() => parseReview({ ...review(), guardVerdicts }, options));
  }
});

test("unbounded or secret-bearing evidence is refused before durable acceptance records", () => {
  const secret = `ghp_${"a".repeat(36)}`;
  for (const evidence of ["", " ", "x".repeat(2001), secret]) {
    const body = review();
    body.criteria[0].evidence = evidence;
    assert.throws(() => parseReview(body));
  }
  assert.throws(() => parseReview({ ...review(), findings: [secret] }));
  assert.throws(() => readTreeEvidence({ acceptanceCriteria: [], verificationCommands: [] }, { criteria: [], checks: [] }));
});
