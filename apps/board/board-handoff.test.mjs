// Acceptance tests for organism-infra/30: `board handoff` and the
// --keep-status handoff gate.
//
// Pinned contract (QA's reading of the ticket; the developer must follow it):
//   - `board handoff <ref> --from <file> [--name <name>]` copies <file> to
//     <main>/.scratch/<feature>/handoffs/<name>. <name> defaults to the
//     basename of <file>. The main checkout is found by the board's own
//     resolution (git worktree list); these tests blank DEN_ROOT.
//   - a --name containing a path separator or `..` is rejected (exit != 0,
//     nothing written anywhere).
//   - the file's State block `ticket` must equal <ref>; a handoff naming a
//     ticket in another feature (or another ticket) is rejected. A ref whose
//     feature does not exist is rejected too.
//   - `release --keep-status` runs the same handoff gate as in-review/resolved:
//     no matching handoff fails without --force; --force --reason bypasses.
//
// Criterion map:
//   1 publish from a worktree        -> "handoff publishes ..." tests
//   2 traversal / other feature      -> "handoff rejects ..." tests
//   3 --keep-status gate             -> "release --keep-status ..." tests
//   4 skill/protocol edits           -> human-verified (orchestrator edit after merge)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { makeBoardFixture, runBoard, validStateJson, claimLockPath } from "./board-fixture.mjs";

const NO_ROOT = { DEN_ROOT: "" };

// organism-infra/78: drafts live beside the worktree; `board handoff` refuses one inside it.
async function localHandoff(fx, filename, stateOverrides = {}) {
  const dir = path.join(path.dirname(fx.worktree), ".local-handoffs");
  await mkdir(dir, { recursive: true });
  const state = validStateJson({
    ticket: `${fx.feature}/${fx.ticket}`,
    role: "developer",
    ...stateOverrides,
  });
  const p = path.join(dir, filename);
  await writeFile(p, "```json\n" + JSON.stringify(state) + "\n```\n\n## Summary\n\nlocal\n", "utf8");
  return p;
}

const handoffsDir = (fx, feature = fx.feature) => path.join(fx.root, ".scratch", feature, "handoffs");
const exists = (p) => access(p).then(() => true, () => false);
const handoff = (fx, args) => runBoard(["handoff", ...args], { cwd: fx.worktree, env: NO_ROOT });

// --- Criterion 1 ---

test("handoff publishes a worktree-local file into the main checkout's handoffs dir", async () => {
  const fx = await makeBoardFixture();
  try {
    const src = await localHandoff(fx, "01-developer.md");
    const r = await handoff(fx, [fx.ticketRelPath, "--from", src]);
    assert.equal(r.code, 0, r.stderr);
    const dest = path.join(handoffsDir(fx), "01-developer.md");
    assert.equal(await readFile(dest, "utf8"), await readFile(src, "utf8"));
    assert.equal(await exists(path.join(fx.worktree, ".scratch", fx.feature, "handoffs", "01-developer.md")), false, "must not leave a copy in the worktree");
  } finally {
    await fx.cleanup();
  }
});

test("handoff publishes a file that lives outside the repo (a scratchpad)", async () => {
  const fx = await makeBoardFixture();
  try {
    const src = path.join(tmpdir(), `scratchpad-30-${process.pid}-01-developer.md`);
    await writeFile(
      src,
      "```json\n" + JSON.stringify(validStateJson({ ticket: fx.ticketRelPath, role: "developer" })) + "\n```\n"
    );
    const r = await handoff(fx, [fx.ticketRelPath, "--from", src, "--name", "01-developer.md"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await readFile(path.join(handoffsDir(fx), "01-developer.md"), "utf8"), await readFile(src, "utf8"));
  } finally {
    await fx.cleanup();
  }
});

test("a published handoff satisfies the release gate", async () => {
  const fx = await makeBoardFixture();
  try {
    const c = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    assert.equal(c.code, 0, c.stderr);
    const src = await localHandoff(fx, "01-developer.md");
    const h = await handoff(fx, [fx.ticketRelPath, "--from", src]);
    assert.equal(h.code, 0, h.stderr);
    const r = await runBoard(["release", fx.ticketRelPath, "--status", "in-review"], {
      cwd: fx.worktree,
      env: NO_ROOT,
    });
    assert.equal(r.code, 0, r.stderr);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 2 ---

for (const bad of ["../escape.md", "sub/01-x.md", "..", "a\\b.md", "/abs.md"]) {
  test(`handoff rejects --name ${JSON.stringify(bad)} and writes nothing`, async () => {
    const fx = await makeBoardFixture();
    try {
      const src = await localHandoff(fx, "01-developer.md");
      const r = await handoff(fx, [fx.ticketRelPath, "--from", src, "--name", bad]);
      assert.notEqual(r.code, 0, "a name outside the handoffs dir must be rejected");
      const dir = handoffsDir(fx);
      assert.deepEqual(await readdir(dir).catch(() => []), [], "handoffs dir must stay empty");
      assert.equal(await exists(path.join(fx.root, ".scratch", fx.feature, "escape.md")), false);
      assert.equal(await exists(path.join(fx.root, ".scratch", fx.feature, "handoffs", "..", "escape.md")), false);
    } finally {
      await fx.cleanup();
    }
  });
}

test("handoff rejects a file whose State block names a ticket in another feature", async () => {
  const fx = await makeBoardFixture();
  try {
    const src = await localHandoff(fx, "01-developer.md", { ticket: `other-feature/${fx.ticket}` });
    const r = await handoff(fx, [fx.ticketRelPath, "--from", src]);
    assert.notEqual(r.code, 0);
    assert.deepEqual(await readdir(handoffsDir(fx)).catch(() => []), []);
    assert.equal(await exists(handoffsDir(fx, "other-feature")), false, "must not create another feature's dir");
  } finally {
    await fx.cleanup();
  }
});

test("handoff rejects a ref in a feature that does not exist", async () => {
  const fx = await makeBoardFixture();
  try {
    const src = await localHandoff(fx, "01-developer.md", { ticket: `nope/${fx.ticket}` });
    const r = await handoff(fx, [`nope/${fx.ticket}`, "--from", src]);
    assert.notEqual(r.code, 0);
    assert.equal(await exists(path.join(fx.root, ".scratch", "nope")), false);
  } finally {
    await fx.cleanup();
  }
});

test("handoff rejects a missing --from file", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await handoff(fx, [fx.ticketRelPath, "--from", path.join(fx.worktree, "does-not-exist.md")]);
    assert.notEqual(r.code, 0);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 3 ---

async function claimAs(fx, role, mode) {
  const r = await runBoard(["claim", fx.ticketRelPath, role, ...(mode ? ["--mode", mode] : [])], {
    cwd: fx.worktree,
  });
  assert.equal(r.code, 0, r.stderr);
}

test("release --keep-status without a matching handoff fails and keeps the lock", async () => {
  const fx = await makeBoardFixture({ status: "in-review" });
  try {
    await claimAs(fx, "security");
    const before = await fx.readTicket();
    const r = await runBoard(["release", fx.ticketRelPath, "--keep-status"], { cwd: fx.worktree });
    assert.notEqual(r.code, 0, "the handoff gate must apply to --keep-status");
    assert.match(r.stderr, /handoff/i);
    assert.equal(await exists(claimLockPath(fx.root, fx.feature, fx.ticket)), true, "lock must stay");
    assert.equal(await fx.readTicket(), before);
  } finally {
    await fx.cleanup();
  }
});

test("release --keep-status --force --reason bypasses the gate", async () => {
  const fx = await makeBoardFixture({ status: "in-review" });
  try {
    await claimAs(fx, "security");
    const r = await runBoard(["release", fx.ticketRelPath, "--keep-status", "--force", "--reason", "test bypass"], {
      cwd: fx.worktree,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await exists(claimLockPath(fx.root, fx.feature, fx.ticket)), false);
  } finally {
    await fx.cleanup();
  }
});

test("release --keep-status passes with a published handoff from the releasing agent", async () => {
  const fx = await makeBoardFixture({ status: "in-review" });
  try {
    await claimAs(fx, "security");
    const src = await localHandoff(fx, "01-security.md", { role: "security" });
    const h = await handoff(fx, [fx.ticketRelPath, "--from", src]);
    assert.equal(h.code, 0, h.stderr);
    const r = await runBoard(["release", fx.ticketRelPath, "--keep-status"], { cwd: fx.worktree, env: NO_ROOT });
    assert.equal(r.code, 0, r.stderr);
    assert.match(await fx.readTicket(), /^Status: in-review$/m);
  } finally {
    await fx.cleanup();
  }
});
