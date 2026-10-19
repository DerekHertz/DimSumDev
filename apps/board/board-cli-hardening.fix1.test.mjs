// organism-infra/18 fix-1: regression tests for security's HIGH-bounce
// findings against 008fb3d (origin/claude/organism-infra-18-tests).
// See .scratch/organism-infra/handoffs/18-security.md and
// .scratch/organism-infra/handoffs/18-developer-fix-1.md.
//
//   HIGH #1 (board-service.mjs validateHandoffState/validateState): the
//   handoff-gate check was not bound to the ticket being released -- it
//   picked the newest *.md by mtime across the whole feature handoffs dir,
//   with no check that the State block's `ticket` field named the ticket
//   actually being released. Fixed by filtering to filenames starting with
//   the ticket's "NN-" prefix, then requiring the State block's `ticket`
//   field to equal the full slug ("<feature>/<ticket>") or short form
//   ("<feature>/<NN>"); mtime is only the tie-break within that set.
//
//   HIGH #2 (the qa-specify transition block / `--mode`): `--mode` was
//   optional free text with no allow-list, so a qa claim made with no mode
//   (or any string other than "specify") was never blocked from releasing
//   at in-review -- reproducing the incident the ticket exists to close.
//   Fixed: `--mode` is required for a qa claim, restricted to
//   specify|verify, rejected if unrecognized for any agent, and a qa release
//   to in-review is now allowed only when the claim's mode was "verify".
//
//   Low (board.mjs parseFlags): a non-boolean flag's value could start with
//   "--", so `--reason --force` silently swallowed `--force` as the literal
//   reason text instead of erroring. Fixed: a flag value must not itself
//   look like a flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeBoardFixture, runBoard, writeValidHandoff, eventsPath } from "./board-fixture.mjs";

async function readEvents(root) {
  const raw = await readFile(eventsPath(root), "utf8").catch(() => "");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// --- HIGH #1: handoff-to-ticket binding -------------------------------------

test("release ignores a handoff whose filename doesn't carry the ticket's NN- prefix, even if it is the only one and would win on mtime", async () => {
  const fx = await makeBoardFixture(); // feature "sample", ticket "01-do-thing"
  try {
    const claimed = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    assert.equal(claimed.code, 0, claimed.stderr);
    // Filename prefix "07-" does not match this ticket's "01-", even though
    // its State block's own `ticket` field is correct.
    await writeValidHandoff(fx, { filename: "07-unrelated.md" });

    const before = await fx.readTicket();
    const r = await runBoard(["release", fx.ticketRelPath, "--status", "in-review"], {
      cwd: fx.worktree,
    });
    assert.notEqual(r.code, 0, "a non-ticket-prefixed handoff must not satisfy the gate");
    assert.equal(await fx.readTicket(), before);
  } finally {
    await fx.cleanup();
  }
});

test("release refuses a ticket-prefixed handoff whose State.ticket names a different ticket", async () => {
  const fx = await makeBoardFixture();
  try {
    const claimed = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    assert.equal(claimed.code, 0, claimed.stderr);
    // Filename prefix matches ("01-"), but the State block itself belongs to
    // a different ticket in the same feature.
    await writeValidHandoff(fx, { filename: "01-wrong-ticket.md", overrides: { ticket: "sample/99-other" } });

    const before = await fx.readTicket();
    const r = await runBoard(["release", fx.ticketRelPath, "--status", "in-review"], {
      cwd: fx.worktree,
    });
    assert.notEqual(r.code, 0, "a prefix match alone must not satisfy the gate without a ticket match");
    assert.equal(await fx.readTicket(), before);
  } finally {
    await fx.cleanup();
  }
});

test("release accepts the short '<feature>/<NN>' form of the ticket ref in State.ticket", async () => {
  const fx = await makeBoardFixture();
  try {
    const claimed = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    assert.equal(claimed.code, 0, claimed.stderr);
    await writeValidHandoff(fx, { overrides: { ticket: "sample/01" } });

    const r = await runBoard(["release", fx.ticketRelPath, "--status", "in-review"], {
      cwd: fx.worktree,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(await fx.readTicket(), /Status:\s*in-review/);
  } finally {
    await fx.cleanup();
  }
});

test("release picks the correct ticket-bound handoff over a newer, unrelated-ticket handoff in the same feature", async () => {
  const fx = await makeBoardFixture();
  try {
    const claimed = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    assert.equal(claimed.code, 0, claimed.stderr);
    // Correct handoff written first (older mtime)...
    await writeValidHandoff(fx, { filename: "01-correct.md" });
    // ...then a newer handoff for an unrelated ticket in the same feature.
    await writeValidHandoff(fx, { filename: "05-other.md", ticket: "05-other-thing" });

    const r = await runBoard(["release", fx.ticketRelPath, "--status", "in-review"], {
      cwd: fx.worktree,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(await fx.readTicket(), /Status:\s*in-review/);
  } finally {
    await fx.cleanup();
  }
});

test("mtime is only a tie-break among the ticket's own matching handoffs: the newest matching one wins", async () => {
  const fx = await makeBoardFixture();
  try {
    const claimed = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    assert.equal(claimed.code, 0, claimed.stderr);
    // Older, ticket-matching handoff is invalid (missing "pending").
    await writeValidHandoff(fx, {
      filename: "01-first.md",
      overrides: { pending: [{ item: "not-an-owner-shape" }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Newer, ticket-matching handoff is valid.
    await writeValidHandoff(fx, { filename: "01-second.md" });

    const r = await runBoard(["release", fx.ticketRelPath, "--status", "in-review"], {
      cwd: fx.worktree,
    });
    assert.equal(r.code, 0, r.stderr);
  } finally {
    await fx.cleanup();
  }
});

// --- HIGH #2: qa `--mode` allow-list, required, and verify-only release ----

test("`board claim <ref> qa` with no --mode is rejected", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await runBoard(["claim", fx.ticketRelPath, "qa"], { cwd: fx.worktree });
    assert.notEqual(r.code, 0, "a qa claim with no mode must be rejected");
    assert.match(r.stderr, /--mode/);
    assert.match(await fx.readTicket(), /Status:\s*ready-for-agent/, "ticket must be untouched");
  } finally {
    await fx.cleanup();
  }
});

test("`board claim <ref> qa --mode bogus` is rejected (unknown mode)", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "bogus"], { cwd: fx.worktree });
    assert.notEqual(r.code, 0, "an unrecognized mode must be rejected");
    assert.match(r.stderr, /mode/);
  } finally {
    await fx.cleanup();
  }
});

test("`board claim <ref> developer --mode bogus` is rejected too (unknown modes are rejected for any agent)", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await runBoard(["claim", fx.ticketRelPath, "developer", "--mode", "bogus"], {
      cwd: fx.worktree,
    });
    assert.notEqual(r.code, 0, "an unrecognized mode must be rejected regardless of role");
  } finally {
    await fx.cleanup();
  }
});

test("a qa claim in verify mode may release at in-review with a valid handoff", async () => {
  const fx = await makeBoardFixture();
  try {
    const claimed = await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "verify"], {
      cwd: fx.worktree,
    });
    assert.equal(claimed.code, 0, claimed.stderr);
    await writeValidHandoff(fx);

    const r = await runBoard(["release", fx.ticketRelPath, "--status", "in-review"], {
      cwd: fx.worktree,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(await fx.readTicket(), /Status:\s*in-review/);
  } finally {
    await fx.cleanup();
  }
});

test("a qa claim in specify mode still cannot release at in-review, even with a valid handoff and --force", async () => {
  const fx = await makeBoardFixture();
  try {
    const claimed = await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "specify"], {
      cwd: fx.worktree,
    });
    assert.equal(claimed.code, 0, claimed.stderr);
    await writeValidHandoff(fx);

    const before = await fx.readTicket();
    const r = await runBoard(
      ["release", fx.ticketRelPath, "--status", "in-review", "--force", "--reason", "trying to bypass"],
      { cwd: fx.worktree }
    );
    assert.notEqual(
      r.code,
      0,
      "--force only overrides the handoff-state check (item 3), never the qa-mode transition rule (item 2)"
    );
    assert.equal(await fx.readTicket(), before);
  } finally {
    await fx.cleanup();
  }
});

// --- Low: a flag value must not itself start with "--" ----------------------

test("`release --reason --force` errors instead of swallowing --force as the reason text", async () => {
  const fx = await makeBoardFixture();
  try {
    const claimed = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    assert.equal(claimed.code, 0, claimed.stderr);
    // Deliberately no handoff, so the only way this could succeed is if
    // "--force" were consumed as --reason's value (and --force silently
    // dropped, as it did before the fix).
    const before = await fx.readTicket();
    const eventsBefore = await readEvents(fx.root);
    const r = await runBoard(
      ["release", fx.ticketRelPath, "--status", "in-review", "--reason", "--force"],
      { cwd: fx.worktree }
    );
    assert.notEqual(r.code, 0, "a flag value that looks like a flag must be rejected, not swallowed");
    assert.match(r.stderr, /--reason/);
    assert.equal(await fx.readTicket(), before);
    assert.deepEqual(
      await readEvents(fx.root),
      eventsBefore,
      "a rejected release must append no additional event"
    );
  } finally {
    await fx.cleanup();
  }
});

test("a flag missing its value entirely (at end of args) is rejected", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await runBoard(["release", fx.ticketRelPath, "--status", "in-review", "--reason"], {
      cwd: fx.worktree,
    });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--reason/);
  } finally {
    await fx.cleanup();
  }
});
