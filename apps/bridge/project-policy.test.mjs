import assert from "node:assert/strict";
import test from "node:test";
import { projectPolicy } from "./project-policy.mjs";

const rule = projectPolicy({ checks: ["build", "test"] });
test("policy carries the required check names and security reviews every change", () => {
  assert.deepEqual(rule.checks, ["build", "test"]);
  assert.equal(rule.mergeRule.security, "every-change");
  assert.deepEqual(projectPolicy({}).checks, []);
});
test("plain source changes the bridge merges on green", () => {
  assert.equal(rule.mergeRule.classify(["src/a.mjs", "docs/x.md", "sub/package.json"]).action, "bridge");
});
test("package.json at the root waits for the user", () => {
  assert.deepEqual(rule.mergeRule.classify(["src/a.mjs", "package.json"]), { action: "user", reasons: ["package.json"] });
});
test("a lockfile waits for the user", () => {
  assert.equal(rule.mergeRule.classify(["package-lock.json"]).action, "user");
  assert.equal(rule.mergeRule.classify(["web/yarn.lock"]).action, "user");
});
test("a root dot path or CI config waits for the user", () => {
  assert.equal(rule.mergeRule.classify([".npmrc"]).action, "user");
  assert.equal(rule.mergeRule.classify([".github/workflows/ci.yml"]).action, "user");
  assert.equal(rule.mergeRule.classify(["src/.hidden"]).action, "bridge");
});
