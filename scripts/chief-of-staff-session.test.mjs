// team-and-den-ux/57 (code review finding 1): the chief of staff replaced the orchestrator, so every
// hook and script that singles out the executive session goes through one check, isChiefOfStaff
// (scripts/context-budget.mjs), with `orchestrator` kept as an alias.
//   context-budget.mjs     -> budgetFor("chief-of-staff") is the 70k / 80k executive budget
//   hooks/context-budget   -> a chief-of-staff session is not gated as a worker
//   statusline, agent-start -> read the budget through CHIEF_OF_STAFF
//   session-start, next-session -> behaviour tests in their own files ("team-and-den-ux/57")
//   no script compares a role to the literal "orchestrator" any more
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILT_IN, CHIEF_OF_STAFF, budgetFor, isChiefOfStaff } from "./context-budget.mjs";
import { isAgentSession } from "./hooks/context-budget.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(path.join(HERE, rel), "utf8");

test("isChiefOfStaff: chief-of-staff and the old orchestrator name, nothing else", () => {
  assert.equal(CHIEF_OF_STAFF, "chief-of-staff");
  assert.ok(isChiefOfStaff("chief-of-staff"));
  assert.ok(isChiefOfStaff("orchestrator"));
  for (const r of ["developer", "qa", "runner", "", undefined, null]) assert.ok(!isChiefOfStaff(r), String(r));
});

test("budgetFor: the chief of staff gets the executive budget (70k / 80k), not the worker one", () => {
  assert.deepEqual(budgetFor("chief-of-staff"), { warn: 70_000, stop: 80_000 });
  assert.deepEqual(budgetFor("chief-of-staff"), budgetFor("orchestrator"));
  assert.deepEqual(BUILT_IN.orchestrator, { warn: 70_000, stop: 80_000 });
});

test("hooks/context-budget: a chief-of-staff session is not gated as a worker agent", () => {
  assert.equal(isAgentSession({ agent_id: "a1", agent_type: "chief-of-staff" }), false);
  assert.equal(isAgentSession({ agent_id: "a1", agent_type: "orchestrator" }), false);
  assert.equal(isAgentSession({ agent_id: "a1", agent_type: "developer" }), true);
});

test("statusline and agent-start read the chief of staff's budget", () => {
  for (const f of ["statusline.mjs", "agent-start.mjs"]) assert.match(src(f), /budgetFor\(CHIEF_OF_STAFF\)/, f);
});

test("no hook or launcher outside the alias compares a role to the literal \"orchestrator\"", () => {
  for (const f of ["hooks/context-budget.mjs", "session-start.mjs", "statusline.mjs", "agent-start.mjs", "next-session.mjs"]) {
    const code = src(f).split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    assert.doesNotMatch(code, /[!=]==\s*"orchestrator"/, f);
    assert.doesNotMatch(code, /budgetFor\("orchestrator"\)|"--agent", "orchestrator"/, f);
  }
});
