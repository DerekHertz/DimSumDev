// organism-infra/17: Contract/State/Receipt schema module.
// See .scratch/organism-infra/issues/17-contract-state-receipt-schemas.md and
// docs/adr/0009-mechanical-checks-for-most-skipped-rules.md (decisions 3-5)
// for the authoritative JSON shapes and field meanings.
//
// Each validator is shape-only: it checks that required keys are present
// (and, for `pending`, that each item carries a named owner) and never
// throws. Callers (the board CLI, the orchestrator's handback step, CI) get
// back either `{ok: true}` or `{ok: false, errors: [string]}`, never an
// exception, even when handed `null`, a primitive, or an empty object.
//
// `pending` convention (validateState): the team-protocol relay hands
// unfinished work to a named next cell rather than leaving it implicit, so a
// non-empty `pending` is valid only when every item is an object shaped
// `{item, owner}` with a non-empty `owner` string. This module never
// hardcodes which cell types are legal owners -- any non-empty string
// satisfies the check -- so a new cell type never needs a change here.
//
// The `tests` and `worktree` sub-shapes on Receipt are validated for
// presence only (no value/format checks): `worktree.path`/`worktree.clean`
// are computed by organism-infra/16, not this ticket.

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkRequiredKeys(input, keys, prefix) {
  const errors = [];
  for (const key of keys) {
    if (!(key in input) || input[key] === undefined) {
      errors.push(`${prefix} missing required field "${key}"`);
    }
  }
  return errors;
}

const CONTRACT_KEYS = ["goal", "inputs", "output", "constraints", "done_when"];
const STATE_KEYS = ["ticket", "current_step", "artifacts", "decisions", "failures", "pending"];
const RECEIPT_TOP_KEYS = [
  "context_sources",
  "policy_version",
  "tools_used",
  "tool_refusals",
  "tests",
  "retries",
  "human_corrections",
  "tokens",
  "artifact",
  "rollback_point",
  "worktree",
];

export function validateContract(input) {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["contract must be an object"] };
  }
  const errors = checkRequiredKeys(input, CONTRACT_KEYS, "contract");
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function validateState(input) {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["state must be an object"] };
  }
  const errors = checkRequiredKeys(input, STATE_KEYS, "state");

  if ("pending" in input) {
    if (!Array.isArray(input.pending)) {
      errors.push('state.pending must be an array of {item, owner} objects');
    } else {
      input.pending.forEach((item, index) => {
        const hasNamedOwner =
          isPlainObject(item) &&
          typeof item.item === "string" &&
          item.item.trim() !== "" &&
          typeof item.owner === "string" &&
          item.owner.trim() !== "";
        if (!hasNamedOwner) {
          errors.push(
            `state.pending[${index}] must name an owning cell: {item, owner}, both non-empty strings`
          );
        }
      });
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

export function validateReceipt(input) {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["receipt must be an object"] };
  }
  const errors = checkRequiredKeys(input, RECEIPT_TOP_KEYS, "receipt");

  if (isPlainObject(input.tests)) {
    errors.push(...checkRequiredKeys(input.tests, ["passed", "failed"], "receipt.tests"));
  }
  if (isPlainObject(input.worktree)) {
    errors.push(...checkRequiredKeys(input.worktree, ["path", "clean"], "receipt.worktree"));
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}
