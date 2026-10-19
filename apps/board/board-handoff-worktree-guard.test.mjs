// Acceptance tests for organism-infra/78: `board handoff` refuses a draft
// saved inside a git worktree other than the main checkout.
//
// Pinned contract (QA's reading of the ticket):
//   - `board handoff --from <file>` where <file> resolves to a path inside
//     any registered git worktree (other than the main checkout) exits
//     non-zero, publishes nothing, and its output mentions /tmp as an
//     alternative drafting location.
//   - A draft under /tmp or any other path outside a worktree still publishes
//     successfully.
//
// Criterion map:
//   1 worktree-path draft rejected, mentions /tmp  -> "refuses --from inside a worktree" tests
//   2 /tmp-path draft still publishes              -> "accepts --from outside any worktree" test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { makeBoardFixture, runBoard, validStateJson } from "./board-fixture.mjs";

const NO_ROOT = { DEN_ROOT: "" };

async function publishFrom(fx, fromFile, name) {
  return runBoard(
    ["handoff", fx.ticketRelPath, "--from", fromFile, ...(name ? ["--name", name] : [])],
    { cwd: fx.worktree, env: NO_ROOT }
  );
}

function validHandoffBody(fx) {
  return (
    "```json\n" +
    JSON.stringify(
      validStateJson({ ticket: fx.ticketRelPath, role: "developer" })
    ) +
    "\n```\n\n## Summary\n\nhandoff\n"
  );
}

const handoffsDir = (fx) =>
  path.join(fx.root, ".scratch", fx.feature, "handoffs");

// --- Criterion 1: reject a draft saved inside a linked worktree ---

test("refuses --from a path inside the linked worktree and exits non-zero", async () => {
  const fx = await makeBoardFixture();
  try {
    // Write the draft inside the worktree directory (not /tmp).
    const draftDir = path.join(fx.worktree, ".scratch", "drafts");
    await mkdir(draftDir, { recursive: true });
    const draft = path.join(draftDir, "01-developer.md");
    await writeFile(draft, validHandoffBody(fx), "utf8");

    const r = await publishFrom(fx, draft, "01-developer.md");
    assert.notEqual(r.code, 0, "should reject a draft inside a worktree");
    assert.deepEqual(
      await readdir(handoffsDir(fx)).catch(() => []),
      [],
      "no handoff should be published"
    );
  } finally {
    await fx.cleanup();
  }
});

test("rejection message mentions /tmp as the correct drafting location", async () => {
  const fx = await makeBoardFixture();
  try {
    const draftDir = path.join(fx.worktree, "tmp-handoffs");
    await mkdir(draftDir, { recursive: true });
    const draft = path.join(draftDir, "01-developer.md");
    await writeFile(draft, validHandoffBody(fx), "utf8");

    const r = await publishFrom(fx, draft, "01-developer.md");
    assert.notEqual(r.code, 0);
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(out, /\/tmp/i, "rejection should name /tmp as the drafting location");
  } finally {
    await fx.cleanup();
  }
});

test("refuses --from a path directly in the worktree root", async () => {
  const fx = await makeBoardFixture();
  try {
    const draft = path.join(fx.worktree, "01-developer.md");
    await writeFile(draft, validHandoffBody(fx), "utf8");

    const r = await publishFrom(fx, draft, "01-developer.md");
    assert.notEqual(r.code, 0);
    assert.deepEqual(
      await readdir(handoffsDir(fx)).catch(() => []),
      []
    );
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 2: accept a draft outside any worktree ---

test("accepts --from a path under /tmp and publishes it", async () => {
  const fx = await makeBoardFixture();
  try {
    const draft = path.join(
      tmpdir(),
      `78-handoff-guard-${process.pid}-01-developer.md`
    );
    await writeFile(draft, validHandoffBody(fx), "utf8");

    const r = await publishFrom(fx, draft, "01-developer.md");
    assert.equal(r.code, 0, r.stderr);
    const published = await readdir(handoffsDir(fx));
    assert.ok(
      published.includes("01-developer.md"),
      "handoff should be published from /tmp"
    );
  } finally {
    await fx.cleanup();
  }
});
