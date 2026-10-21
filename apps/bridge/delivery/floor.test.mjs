// team-and-den-ux/17 (ADR 0029 decision 3): the planner's floor. A pure function over a ticket's type and changed paths:
// the roles the ticket must have. One table row per rule. The owner adds roles in delivery.start; nothing removes one.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { floor, gaps, FLOOR_ROLES } from "./floor.mjs";

const SHA = "b".repeat(40), OLD = "c".repeat(40);
const CODE = "tools/x.mjs"; // not a docs, instructions, user-merge or UI path: plain code
const run = (type, files, riskClean) => floor({ type, files, riskClean }).roles;

describe("the floor: which roles a ticket must have", () => {
  test("the role names, in their fixed order", () => {
    assert.deepEqual(FLOOR_ROLES, ["technical-writer", "code-reviewer", "qa", "security", "user-verdict"]);
  });

  // [rule, type, files, riskClean, roles]
  const rows = [
    ["code: a code path gets the code reviewer and qa", "feature", [CODE], true, ["code-reviewer", "qa"]],
    ["code: whatever the ticket type, bug", "bug", [CODE], true, ["code-reviewer", "qa"]],
    ["code: a code ticket whose paths are not known yet", "feature", [], undefined, ["code-reviewer", "qa"]],
    ["code: files absent altogether", "task", undefined, undefined, ["code-reviewer", "qa"]],
    ["instructions: an ADR gets the code reviewer and no qa", "task", ["docs/adr/0030-x.md"], true, ["code-reviewer"]],
    ["instructions: .claude/skills (a user-merge path too) adds security", "task", [".claude/skills/x/SKILL.md"], true, ["code-reviewer", "security"]],
    ["instructions: CLAUDE.md is a user-merge path too", "task", ["CLAUDE.md"], true, ["code-reviewer", "security"]],
    ["security: a risk-check hit", "feature", [CODE], false, ["code-reviewer", "qa", "security"]],
    ["security: no risk result yet adds nothing", "feature", [CODE], undefined, ["code-reviewer", "qa"]],
    ["security: a user-merge path, risk clean", "feature", ["scripts/x.mjs"], true, ["code-reviewer", "qa", "security"]],
    ["security: the bridge is a user-merge path", "feature", ["apps/bridge/agents/host.mjs"], true, ["code-reviewer", "qa", "security"]],
    ["writer: ticket type docs", "docs", ["docs/guide.md"], true, ["technical-writer"]],
    ["writer: a docs ticket whose paths are not known yet", "docs", [], undefined, ["technical-writer"]],
    ["writer: CONTEXT.md, a README and docs/** on any ticket type", "feature", ["CONTEXT.md", "README.md", "docs/agents/x.md"], true, ["technical-writer"]],
    ["docs-only with a risk hit still gets security, and nothing else", "docs", ["docs/a.md"], false, ["technical-writer", "security"]],
    ["docs/adr is not a docs path", "docs", ["docs/adr/0030-x.md"], true, ["technical-writer", "code-reviewer"]],
    ["mixed: docs and code add up, in the fixed order", "feature", ["docs/a.md", CODE], true, ["technical-writer", "code-reviewer", "qa"]],
    ["type docs that changes code still gets the code rules", "docs", [CODE], true, ["technical-writer", "code-reviewer", "qa"]],
    ["ui: a UI path gets everything", "task", ["apps/ui/src/App.jsx"], true, ["technical-writer", "code-reviewer", "qa", "security", "user-verdict"]],
    ["ui: a shared package the UI bundles is a UI path", "task", ["packages/board-refs/index.mjs"], true, ["technical-writer", "code-reviewer", "qa", "security", "user-verdict"]],
    ["ui type with plain code: the user's verdict, no writer or security", "ui", [CODE], true, ["code-reviewer", "qa", "user-verdict"]],
    ["asset type: the user's verdict", "asset", ["assets/mochi.glb"], true, ["code-reviewer", "qa", "user-verdict"]],
    ["empty files on a ui ticket", "ui", [], undefined, ["code-reviewer", "qa", "user-verdict"]],
  ];
  for (const [name, type, files, riskClean, roles] of rows) test(name, () => assert.deepEqual(run(type, files, riskClean), roles));

  test("a path is as git prints it: forward slashes, no leading dot-slash needed for the classes", () => {
    assert.deepEqual(run("task", ["docs/sub/dir/page.md"], true), ["technical-writer"]);
    assert.deepEqual(run("task", ["docsx/page.md"], true), ["code-reviewer", "qa"], "docsx/ is not docs/");
  });

  test("why names a reason for each role in the floor, and for no other", () => {
    const { roles, why } = floor({ type: "feature", files: [CODE, "docs/a.md"], riskClean: false });
    assert.deepEqual(roles, ["technical-writer", "code-reviewer", "qa", "security"]);
    assert.deepEqual(Object.keys(why).sort(), [...roles].sort());
    for (const r of roles) assert.ok(typeof why[r] === "string" && why[r].length > 0, r);
    assert.match(why["code-reviewer"], /tools\/x\.mjs/, "a code reason names the path");
    assert.match(why["technical-writer"], /docs\/a\.md/);
    assert.deepEqual(Object.keys(floor({ type: "docs", files: ["docs/a.md"], riskClean: true }).why), ["technical-writer"]);
  });

  test("it reads nothing: the same input gives the same answer, and the input is not changed", () => {
    const files = [CODE, "docs/a.md"];
    const input = { type: "feature", files, riskClean: true };
    assert.deepEqual(floor(input), floor(input));
    assert.deepEqual(files, [CODE, "docs/a.md"]);
    assert.deepEqual(input, { type: "feature", files: [CODE, "docs/a.md"], riskClean: true });
  });
});

describe("gaps: the required roles with no counted result at the commit", () => {
  const all = ["technical-writer", "code-reviewer", "qa", "security", "user-verdict"];
  const done = {
    writer: { sha: SHA, runId: "c-0123456789abcdef" }, review: { sha: SHA, verdict: "pass" }, qa: { sha: SHA, verdict: "pass" },
    security: { sha: SHA, verdict: "pass" }, verdict: { sha: SHA, ok: true },
  };

  test("nothing is missing when every required role has a result at the commit", () => {
    assert.deepEqual(gaps({ roles: all, evidence: done, sha: SHA }), []);
    assert.deepEqual(gaps({ roles: [], evidence: {}, sha: SHA }), []);
  });

  test("a role with no evidence is a gap, listed in the fixed order", () => {
    assert.deepEqual(gaps({ roles: all, evidence: {}, sha: SHA }), all);
    assert.deepEqual(gaps({ roles: ["code-reviewer", "qa"], evidence: { qa: done.qa }, sha: SHA }), ["code-reviewer"]);
  });

  test("a result for another commit does not count", () => {
    for (const [role, slot] of [["technical-writer", "writer"], ["code-reviewer", "review"], ["qa", "qa"], ["security", "security"], ["user-verdict", "verdict"]]) {
      assert.deepEqual(gaps({ roles: [role], evidence: { ...done, [slot]: { ...done[slot], sha: OLD } }, sha: SHA }), [role], role);
    }
  });

  test("a bounce is not a counted result, and neither is a declined verdict; a role not required is not asked for", () => {
    assert.deepEqual(gaps({ roles: ["code-reviewer"], evidence: { review: { sha: SHA, verdict: "bounce" } }, sha: SHA }), ["code-reviewer"]);
    assert.deepEqual(gaps({ roles: ["qa"], evidence: { qa: { sha: SHA, verdict: "bounce" } }, sha: SHA }), ["qa"]);
    assert.deepEqual(gaps({ roles: ["security"], evidence: { security: { sha: SHA, verdict: "bounce" } }, sha: SHA }), ["security"]);
    assert.deepEqual(gaps({ roles: ["user-verdict"], evidence: { verdict: { sha: SHA, ok: false } }, sha: SHA }), ["user-verdict"]);
    assert.deepEqual(gaps({ roles: ["qa"], evidence: {}, sha: SHA }), ["qa"]);
    assert.deepEqual(gaps({ roles: ["qa"], evidence: { qa: done.qa, review: undefined }, sha: SHA }), []);
  });
});
