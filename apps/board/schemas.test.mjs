// organism-infra/17: failing tests for the Contract/State/Receipt schema module.
// See .scratch/organism-infra/issues/17-contract-state-receipt-schemas.md and
// docs/adr/0009-mechanical-checks-for-most-skipped-rules.md (decisions 3-5) for
// the authoritative JSON shapes.
//
// Seam under test: apps/board/schemas.mjs, exporting
// validateContract, validateState, validateReceipt. Each takes a parsed
// object and must return `{ok: true}` or `{ok: false, errors: [string]}`
// without throwing, even on malformed input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateContract, validateState, validateReceipt } from "./schemas.mjs";

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function validContract() {
  return {
    goal: "ship the schema module",
    inputs: ["ticket 17", "ADR 0009"],
    output: "validateContract/validateState/validateReceipt",
    constraints: ["no throwing", "no new dependency"],
    done_when: ["unit tests pass"],
  };
}

function validState() {
  return {
    ticket: "organism-infra/17",
    current_step: "writing failing tests",
    artifacts: ["apps/board/schemas.test.mjs"],
    decisions: ["pending items must name an owning agent"],
    failures: [],
    pending: [],
  };
}

function validReceipt() {
  return {
    context_sources: ["ticket 17", "ADR 0009"],
    policy_version: "9feb2a5c27f33a03139a84ce8b7f3fea69f997d0",
    tools_used: ["Read", "Write", "Bash"],
    tool_refusals: [],
    tests: { passed: 0, failed: 0 },
    retries: 0,
    human_corrections: 0,
    tokens: 0,
    artifact: ".scratch/organism-infra/handoffs/17-qa.md",
    rollback_point: "b0c20a3",
    worktree: { path: "C:/example/worktree", clean: true },
  };
}

// --- Criterion: each validator rejects a missing required key, named --------

const CONTRACT_KEYS = ["goal", "inputs", "output", "constraints", "done_when"];
const STATE_KEYS = ["ticket", "current_step", "artifacts", "decisions", "failures", "pending"];
const RECEIPT_TOP_KEYS = [
  "context_sources", "policy_version", "tools_used", "tool_refusals",
  "tests", "retries", "human_corrections", "tokens", "artifact",
  "rollback_point", "worktree",
];

test("validateContract accepts a fully-populated contract", () => {
  const result = validateContract(validContract());
  assert.equal(result.ok, true);
});

for (const key of CONTRACT_KEYS) {
  test(`validateContract rejects a contract missing "${key}" with a named error`, () => {
    const bad = validContract();
    delete bad[key];
    const result = validateContract(bad);
    assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0, "errors is a non-empty array");
    assert.ok(
      result.errors.some((e) => e.includes(key)),
      `expected an error naming "${key}", got ${JSON.stringify(result.errors)}`
    );
  });
}

test("validateState accepts a fully-populated state with empty pending", () => {
  const result = validateState(validState());
  assert.equal(result.ok, true);
});

for (const key of STATE_KEYS) {
  test(`validateState rejects a state missing "${key}" with a named error`, () => {
    const bad = validState();
    delete bad[key];
    const result = validateState(bad);
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.includes(key)),
      `expected an error naming "${key}", got ${JSON.stringify(result.errors)}`
    );
  });
}

test("validateReceipt accepts a fully-populated receipt", () => {
  const result = validateReceipt(validReceipt());
  assert.equal(result.ok, true);
});

for (const key of RECEIPT_TOP_KEYS) {
  test(`validateReceipt rejects a receipt missing "${key}" with a named error`, () => {
    const bad = validReceipt();
    delete bad[key];
    const result = validateReceipt(bad);
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.includes(key)),
      `expected an error naming "${key}", got ${JSON.stringify(result.errors)}`
    );
  });
}

// Receipt's nested shapes (tests{passed,failed}, worktree{path,clean}) are
// shape-only per the ticket, but a missing nested key is still a missing
// required key and must be named.
for (const [outer, inner] of [["tests", "passed"], ["tests", "failed"], ["worktree", "path"], ["worktree", "clean"]]) {
  test(`validateReceipt rejects a receipt missing "${outer}.${inner}" with a named error`, () => {
    const bad = validReceipt();
    delete bad[outer][inner];
    const result = validateReceipt(bad);
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.includes(inner)),
      `expected an error naming "${inner}", got ${JSON.stringify(result.errors)}`
    );
  });
}

// --- Criterion: validateReceipt treats tool_refusals: [] as the valid "none" case ---

test('validateReceipt treats an empty tool_refusals array as valid, not a missing key', () => {
  const receipt = validReceipt();
  receipt.tool_refusals = [];
  const result = validateReceipt(receipt);
  assert.equal(result.ok, true);
  assert.ok(
    !result.errors || !result.errors.some((e) => e.includes("tool_refusals")),
    "an empty tool_refusals array must not be reported as a missing/invalid key"
  );
});

test("validateReceipt accepts a non-empty tool_refusals array with the documented shape", () => {
  const receipt = validReceipt();
  receipt.tool_refusals = [{ tool: "AskUserQuestion", what: "not available inside subagents" }];
  const result = validateReceipt(receipt);
  assert.equal(result.ok, true);
});

// --- Criterion: validateState's pending convention -------------------------
// Per the ticket, a non-empty `pending` is valid only when each item is
// explicitly handed to a named next agent (team-protocol's relay
// convention), and the check must not hardcode relay names (so a
// not-yet-invented role still satisfies it as long as it's named).
// We treat "named" as: each pending item is an object carrying a non-empty
// `owner` string alongside its `item` text.

test("validateState accepts a non-empty pending array when every item names an owning agent", () => {
  const state = validState();
  state.pending = [
    { item: "verify the branch", owner: "qa" },
    { item: "review a novel role this schema must not hardcode", owner: "some-future-agent" },
  ];
  const result = validateState(state);
  assert.equal(result.ok, true);
});

test("validateState rejects a pending item that is a bare string with no named owner", () => {
  const state = validState();
  state.pending = ["verify the branch"];
  const result = validateState(state);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("pending") || e.includes("owner")),
    `expected an error about the unnamed pending item, got ${JSON.stringify(result.errors)}`
  );
});

test("validateState rejects a pending item whose owner is an empty string", () => {
  const state = validState();
  state.pending = [{ item: "verify the branch", owner: "" }];
  const result = validateState(state);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("pending") || e.includes("owner")),
    `expected an error about the unnamed pending item, got ${JSON.stringify(result.errors)}`
  );
});

test("validateState rejects a pending item missing the owner field entirely", () => {
  const state = validState();
  state.pending = [{ item: "verify the branch" }];
  const result = validateState(state);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("pending") || e.includes("owner")),
    `expected an error about the unnamed pending item, got ${JSON.stringify(result.errors)}`
  );
});

// --- Criterion: no throwing, callers get a clean {ok:false, errors} back ---

for (const [label, garbage] of [
  ["null", null],
  ["undefined", undefined],
  ["a string", "not an object"],
  ["a number", 42],
  ["an empty object", {}],
]) {
  test(`validateContract does not throw on ${label}`, () => {
    assert.doesNotThrow(() => {
      const result = validateContract(garbage);
      assert.equal(result.ok, false);
      assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
    });
  });

  test(`validateState does not throw on ${label}`, () => {
    assert.doesNotThrow(() => {
      const result = validateState(garbage);
      assert.equal(result.ok, false);
      assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
    });
  });

  test(`validateReceipt does not throw on ${label}`, () => {
    assert.doesNotThrow(() => {
      const result = validateReceipt(garbage);
      assert.equal(result.ok, false);
      assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
    });
  });
}
