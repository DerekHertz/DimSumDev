// organism-infra/17: regression tests for two bugs found in code review of
// schemas.mjs (commit c8facd1), reported by the spec-review pass. Kept in a
// separate file from qa's schemas.test.mjs, which is never edited.
//
// (a) validateState's pending-item check accepted an item with a named
//     `owner` but no non-empty `item` text, e.g. {owner: "developer"}.
// (b) validateState skipped the pending shape check entirely when `pending`
//     was present but not an array (e.g. a string or object), instead of
//     reporting an error naming "pending".
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateState } from "./schemas.mjs";

function validState() {
  return {
    ticket: "organism-infra/17",
    current_step: "writing regression tests",
    artifacts: ["apps/board/schemas.regression.test.mjs"],
    decisions: [],
    failures: [],
    pending: [],
  };
}

test("validateState rejects a pending item with a named owner but no item text", () => {
  const state = validState();
  state.pending = [{ owner: "developer" }];
  const result = validateState(state);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("pending") || e.includes("owner")),
    `expected an error about the missing item text, got ${JSON.stringify(result.errors)}`
  );
});

test("validateState rejects a pending item whose item text is an empty string", () => {
  const state = validState();
  state.pending = [{ item: "", owner: "developer" }];
  const result = validateState(state);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("pending") || e.includes("owner")),
    `expected an error about the empty item text, got ${JSON.stringify(result.errors)}`
  );
});

test('validateState rejects a "pending" that is present but not an array, naming "pending"', () => {
  const state = validState();
  state.pending = "verify the branch";
  const result = validateState(state);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("pending")),
    `expected an error naming "pending", got ${JSON.stringify(result.errors)}`
  );
});

test('validateState rejects a "pending" object (non-array) shape, naming "pending"', () => {
  const state = validState();
  state.pending = { item: "verify the branch", owner: "qa" };
  const result = validateState(state);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("pending")),
    `expected an error naming "pending", got ${JSON.stringify(result.errors)}`
  );
});
