// organism-infra/24: board claim ergonomics -- comment author, reclaim,
// release --keep-status, and only-orchestrator-resolves. See
// .scratch/organism-infra/issues/24-board-claim-ergonomics.md.
//
// Wire shapes pinned here (the ticket names behavior, not syntax):
//   1. `board comment <ref> --as <role> "text"`: `--as` is a declared flag on
//      `comment`; the stamp reads `**<role>, <date>:**`. With no claim lock
//      and no `--as`, the comment is rejected (non-zero, ticket untouched).
//   2. `board reclaim <ref> <role> [--mode m]`: takes over an existing claim
//      lock in one command (lock now names <agent>, status stays `claimed`,
//      an events.jsonl line with op "reclaim"). With no lock to take over it
//      is rejected (use `claim`).
//   3. `board release <ref> --keep-status`: frees the lock, leaves the
//      ticket's status line byte-for-byte alone. It excludes `--status`.
//   4. Scope added (orchestrator comment): a claim held by any agent other
//      than `orchestrator` cannot release at `resolved`, even with
//      `--force --reason`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { makeBoardFixture, runBoard, writeValidHandoff } from "./board-fixture.mjs";

async function exists(p) {
  return access(p).then(
    () => true,
    () => false
  );
}

async function readEvents(fx) {
  const raw = await readFile(fx.eventsPath, "utf8").catch(() => "");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// --- Criterion 1: comment author -------------------------------------------

test("a comment with no claim lock and no --as is rejected and the ticket is untouched", async () => {
  const fx = await makeBoardFixture();
  try {
    const before = await fx.readTicket();
    const r = await runBoard(["comment", fx.ticketRelPath, "orphan text"], { cwd: fx.worktree });
    assert.notEqual(r.code, 0, "a comment with no author source must be rejected");
    assert.equal(await fx.readTicket(), before);
    assert.doesNotMatch(await fx.readTicket(), /unknown/);
  } finally {
    await fx.cleanup();
  }
});

test("`comment --as <role>` with no claim lock records that agent as the author", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await runBoard(["comment", fx.ticketRelPath, "--as", "orchestrator", "hello there"], {
      cwd: fx.worktree,
    });
    assert.equal(r.code, 0, r.stderr);
    const ticket = await fx.readTicket();
    assert.match(ticket, /- \*\*orchestrator, \d{4}-\d{2}-\d{2}:\*\* hello there/);
    assert.doesNotMatch(ticket, /:\*\* --as/, "--as must never be stored as text");
    const events = await readEvents(fx);
    assert.equal(events.at(-1).role, "orchestrator");
  } finally {
    await fx.cleanup();
  }
});

test("a comment with a claim lock and no --as still uses the lock's agent", async () => {
  const fx = await makeBoardFixture();
  try {
    await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    const r = await runBoard(["comment", fx.ticketRelPath, "from the lock"], { cwd: fx.worktree });
    assert.equal(r.code, 0, r.stderr);
    assert.match(await fx.readTicket(), /- \*\*developer, \d{4}-\d{2}-\d{2}:\*\* from the lock/);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 2: reclaim ---------------------------------------------------

test("`board reclaim <ref> <role>` takes over an existing claim in one command", async () => {
  const fx = await makeBoardFixture();
  try {
    const first = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    assert.equal(first.code, 0, first.stderr);

    const r = await runBoard(["reclaim", fx.ticketRelPath, "security", "--reason", "holder gone"], { cwd: fx.worktree });
    assert.equal(r.code, 0, `reclaim should succeed: ${r.stderr}`);

    const lock = await readFile(fx.claimLockPath, "utf8");
    assert.match(lock, /^security /, "the lock should now name the reclaiming agent");
    assert.match(await fx.readTicket(), /Status:\s*claimed/);
    const events = await readEvents(fx);
    assert.equal(events.at(-1).op, "reclaim");
    assert.equal(events.at(-1).role, "security");

    // the new holder can act on the claim
    const c = await runBoard(["comment", fx.ticketRelPath, "took over"], { cwd: fx.worktree });
    assert.equal(c.code, 0, c.stderr);
    assert.match(await fx.readTicket(), /- \*\*security, \d{4}-\d{2}-\d{2}:\*\* took over/);
  } finally {
    await fx.cleanup();
  }
});

test("`board reclaim` on an unclaimed ticket is rejected and creates no lock", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await runBoard(["reclaim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    assert.notEqual(r.code, 0, "nothing to take over: reclaim should be rejected");
    assert.equal(await exists(fx.claimLockPath), false);
    assert.match(await fx.readTicket(), /Status:\s*ready-for-agent/);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 3: release --keep-status ------------------------------------

test("`release --keep-status` frees the lock and leaves the status unchanged", async () => {
  const fx = await makeBoardFixture();
  try {
    // organism-infra/55: a qa specify claim now restores the prior status, so this
    // byte-identical check uses a developer claim.
    const claimed = await runBoard(["claim", fx.ticketRelPath, "developer"], {
      cwd: fx.worktree,
    });
    assert.equal(claimed.code, 0, claimed.stderr);
    await writeValidHandoff(fx); // organism-infra/30: --keep-status is handoff-gated
    const before = await fx.readTicket();

    const r = await runBoard(["release", fx.ticketRelPath, "--keep-status"], { cwd: fx.worktree });
    assert.equal(r.code, 0, `release --keep-status should succeed: ${r.stderr}`);
    assert.equal(await exists(fx.claimLockPath), false, "the claim lock must be gone");
    assert.equal(await fx.readTicket(), before, "the ticket must be byte-identical");
  } finally {
    await fx.cleanup();
  }
});

test("`release --keep-status --status <s>` is rejected and the lock stays", async () => {
  const fx = await makeBoardFixture();
  try {
    await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    const r = await runBoard(["release", fx.ticketRelPath, "--keep-status", "--status", "blocked"], {
      cwd: fx.worktree,
    });
    assert.notEqual(r.code, 0, "--keep-status and --status are mutually exclusive");
    assert.equal(await exists(fx.claimLockPath), true);
    assert.match(await fx.readTicket(), /Status:\s*claimed/);
  } finally {
    await fx.cleanup();
  }
});

// --- Scope added: only the orchestrator resolves ----------------------------

for (const role of ["developer", "security"]) {
  test(`a ${role} claim cannot release at resolved, even with a valid handoff and --force`, async () => {
    const fx = await makeBoardFixture();
    try {
      await runBoard(["claim", fx.ticketRelPath, role], { cwd: fx.worktree });
      await writeValidHandoff(fx);
      const r = await runBoard(["release", fx.ticketRelPath, "--status", "resolved"], {
        cwd: fx.worktree,
      });
      assert.notEqual(r.code, 0, `${role} must not be able to resolve`);
      assert.match(r.stderr, /resolved|chief of staff/);
      assert.match(await fx.readTicket(), /Status:\s*claimed/);

      const forced = await runBoard(
        ["release", fx.ticketRelPath, "--status", "resolved", "--force", "--reason", "trying"],
        { cwd: fx.worktree }
      );
      assert.notEqual(forced.code, 0, "--force must not bypass the only-orchestrator rule");
      assert.match(await fx.readTicket(), /Status:\s*claimed/);
    } finally {
      await fx.cleanup();
    }
  });
}

test("a qa claim (verify mode) cannot release at resolved", async () => {
  const fx = await makeBoardFixture();
  try {
    await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "verify"], { cwd: fx.worktree });
    await writeValidHandoff(fx);
    const r = await runBoard(["release", fx.ticketRelPath, "--status", "resolved"], {
      cwd: fx.worktree,
    });
    assert.notEqual(r.code, 0, "qa must not be able to resolve");
    assert.match(await fx.readTicket(), /Status:\s*claimed/);
  } finally {
    await fx.cleanup();
  }
});

test("a chief-of-staff claim can release at resolved with a valid handoff; reclaiming as one is refused", async () => {
  const fx = await makeBoardFixture();
  try {
    const claimed = await runBoard(["claim", fx.ticketRelPath, "chief-of-staff"], { cwd: fx.worktree });
    assert.equal(claimed.code, 0, claimed.stderr);
    await writeValidHandoff(fx);
    const r = await runBoard(["release", fx.ticketRelPath, "--status", "resolved"], { cwd: fx.worktree });
    assert.equal(r.code, 0, `the chief of staff may resolve: ${r.stderr}`);
    assert.match(await fx.readTicket(), /Status:\s*resolved/);
    const re = await runBoard(["reclaim", fx.ticketRelPath, "chief-of-staff", "--reason", "x"], { cwd: fx.worktree });
    assert.notEqual(re.code, 0);
    assert.match(re.stderr, /chief of staff may resolve/);
  } finally {
    await fx.cleanup();
  }
});

test("an orchestrator claim (the stub, one release) can release at resolved with a valid handoff", async () => {
  const fx = await makeBoardFixture();
  try {
    const claimed = await runBoard(["claim", fx.ticketRelPath, "orchestrator"], { cwd: fx.worktree });
    assert.equal(claimed.code, 0, claimed.stderr);
    await writeValidHandoff(fx);
    const r = await runBoard(["release", fx.ticketRelPath, "--status", "resolved"], {
      cwd: fx.worktree,
    });
    assert.equal(r.code, 0, `the orchestrator may resolve: ${r.stderr}`);
    assert.match(await fx.readTicket(), /Status:\s*resolved/);
  } finally {
    await fx.cleanup();
  }
});
