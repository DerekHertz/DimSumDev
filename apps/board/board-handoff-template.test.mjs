// Acceptance tests for organism-infra/66: `board handoff --template` prints a
// valid State block skeleton.
//
// Pinned contract (QA's reading of the ticket):
//   - `board handoff <ref> --template [--role <r>] [--mode <m>]` prints a
//     fenced ```json block whose content, with placeholders filled, passes
//     validateState (the same check `board handoff` runs).
//   - ticket is filled from <ref>; agent and mode are prefilled from the held
//     lock when one exists, overridden by --role/--mode when provided.
//   - The template criterion requiring the handoff skill to name the command
//     is a .claude/ edit: human-verified.
//
// Criterion map:
//   1 template output passes validateState    -> "template output passes validation" tests
//   2 ticket/role/mode prefilled from ref+lock -> "prefills ticket/role/mode" tests
//   3 handoff skill names the command         -> human-verified (.claude/ edit)
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBoardFixture, runBoard } from "./board-fixture.mjs";
import { validateState } from "./schemas.mjs";

const NO_ROOT = { DEN_ROOT: "" };

function template(fx, extraArgs = []) {
  return runBoard(
    ["handoff", fx.ticketRelPath, "--template", ...extraArgs],
    { cwd: fx.worktree, env: NO_ROOT }
  );
}

async function claim(fx, role, mode) {
  const r = await runBoard(
    ["claim", fx.ticketRelPath, role, ...(mode ? ["--mode", mode] : [])],
    { cwd: fx.worktree, env: NO_ROOT }
  );
  assert.equal(r.code, 0, r.stderr);
}

function extractBlock(r) {
  const out = `${r.stdout}\n${r.stderr}`;
  const m = /```json\s*([\s\S]*?)```/.exec(out);
  assert.ok(m, `expected a fenced json block in output:\n${out}`);
  return JSON.parse(m[1]);
}

// --- Criterion 1: template output passes validateState ---

test("template output with placeholders filled passes validateState", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "developer");
    const r = await template(fx);
    assert.equal(r.code, 0, `--template should succeed:\n${r.stderr}`);
    const block = extractBlock(r);
    // Fill any remaining placeholder strings so the validator can run
    const filled = {
      ...block,
      current_step: block.current_step || "done",
      artifacts: block.artifacts ?? [],
      decisions: block.decisions ?? [],
      failures: block.failures ?? [],
      pending: block.pending ?? [],
    };
    const result = validateState(filled);
    assert.equal(result.ok, true, `validateState failed: ${JSON.stringify(result.errors)}`);
  } finally {
    await fx.cleanup();
  }
});

test("template exits 0 and prints a json block even with no lock held", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await template(fx, ["--role", "developer"]);
    assert.equal(r.code, 0, r.stderr);
    const block = extractBlock(r);
    assert.ok(typeof block === "object" && block !== null);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 2: ticket/role/mode prefilled from ref and the held lock ---

test("ticket field is prefilled from the ref argument", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "developer");
    const r = await template(fx);
    assert.equal(r.code, 0, r.stderr);
    const block = extractBlock(r);
    assert.equal(block.ticket, fx.ticketRelPath, "ticket should match the ref");
  } finally {
    await fx.cleanup();
  }
});

test("agent is prefilled from the held lock (developer)", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "developer");
    const r = await template(fx);
    assert.equal(r.code, 0, r.stderr);
    const block = extractBlock(r);
    assert.equal(block.role, "developer");
  } finally {
    await fx.cleanup();
  }
});

test("agent and mode are prefilled from the held lock (qa specify)", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "qa", "specify");
    const r = await template(fx);
    assert.equal(r.code, 0, r.stderr);
    const block = extractBlock(r);
    assert.equal(block.role, "qa");
    assert.equal(block.mode, "specify");
  } finally {
    await fx.cleanup();
  }
});

test("--role and --mode flags override the lock values", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "developer");
    const r = await template(fx, ["--role", "qa", "--mode", "verify"]);
    assert.equal(r.code, 0, r.stderr);
    const block = extractBlock(r);
    assert.equal(block.role, "qa");
    assert.equal(block.mode, "verify");
  } finally {
    await fx.cleanup();
  }
});
