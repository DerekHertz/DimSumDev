// organism-infra/18: board CLI hardening -- unknown flags, bad status
// transitions, handoff-gated release. See
// .scratch/organism-infra/issues/18-board-cli-hardening.md and
// docs/adr/0009-mechanical-checks-for-most-skipped-rules.md (decision 2,
// rule #1 and decision 4).
//
// Design decisions this test file pins, since the ticket names the behavior
// but not every wire detail (same convention board-fixture.mjs uses for the
// write-lock path): the developer's implementation must match these, or say
// so in their handoff if a different convention is picked.
//
//   1. `board claim <ref> <role> --mode <specify|verify>` is a new,
//      declared flag on `claim` that records the calling agent's mode
//      alongside its type, so `release` can later tell "qa in specify mode"
//      apart from "qa in verify mode" or a plain claim with no mode.
//   2. A handoff's State block is the first fenced ```json code block in the
//      newest file under `.scratch/<feature>/handoffs/*.md` ("newest" by
//      mtime). `release --status in-review|resolved` parses it and calls
//      `validateState` (organism-infra/17, apps/board/schemas.mjs).
//
// Until the developer implements these, every test below fails on a missing
// feature (an unknown flag wrongly accepted, a bad transition wrongly
// allowed, a missing/invalid handoff wrongly ignored) -- not on a syntax or
// setup error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, utimes } from "node:fs/promises";
import path from "node:path";
import { makeBoardFixture, runBoard, eventsPath } from "./board-fixture.mjs";

async function writeHandoff(root, feature, filename, body) {
  const dir = path.join(root, ".scratch", feature, "handoffs");
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, filename);
  await writeFile(p, body, "utf8");
  // organism-infra/35: the gate wants a handoff newer than the claim.
  const later = new Date(Date.now() + 60_000);
  await utimes(p, later, later);
}

function stateBlock(overrides = {}) {
  const state = {
    ticket: "sample/01-do-thing",
    role: "developer",
    current_step: "qa wrote failing tests",
    artifacts: ["apps/board/board-cli-hardening.test.mjs"],
    decisions: [],
    failures: [],
    pending: [],
    ...overrides,
  };
  return "```json\n" + JSON.stringify(state) + "\n```\n";
}

function validHandoffBody(overrides = {}) {
  return `${stateBlock(overrides)}\n## Summary\n\nfixture handoff\n`;
}

async function readEvents(root) {
  const raw = await readFile(eventsPath(root), "utf8").catch(() => "");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// --- Criterion 1: unknown flags are rejected on every subcommand -----------
// (board-comment-hardening.test.mjs already covers `comment`; this covers
// the rest, per the ticket's "any subcommand" wording.)

test("`board claim <ref> <role> --bogus x` is rejected and no claim lock is created", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await runBoard(["claim", fx.ticketRelPath, "qa", "--bogus", "x"], {
      cwd: fx.worktree,
    });
    assert.notEqual(r.code, 0, "an unrecognized flag on claim should be rejected");
    assert.match(r.stderr, /--bogus/, "the error should name the bad flag");
    assert.match(await fx.readTicket(), /Status:\s*ready-for-agent/, "ticket must be untouched");
  } finally {
    await fx.cleanup();
  }
});

test("`board release <ref> --status in-review --bogus x` is rejected and the ticket is left unchanged", async () => {
  const fx = await makeBoardFixture();
  try {
    const claimed = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    assert.equal(claimed.code, 0, claimed.stderr);
    await writeHandoff(fx.root, fx.feature, "01-developer.md", validHandoffBody());

    const before = await fx.readTicket();
    const r = await runBoard(
      ["release", fx.ticketRelPath, "--status", "in-review", "--bogus", "x"],
      { cwd: fx.worktree }
    );
    assert.notEqual(r.code, 0, "an unrecognized flag on release should be rejected");
    assert.match(r.stderr, /--bogus/, "the error should name the bad flag");
    assert.equal(await fx.readTicket(), before, "a rejected release must not touch the ticket");
  } finally {
    await fx.cleanup();
  }
});

test("`board list --bogus x` is rejected", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await runBoard(["list", "--bogus", "x"], { cwd: fx.worktree });
    assert.notEqual(r.code, 0, "an unrecognized flag on list should be rejected");
    assert.match(r.stderr, /--bogus/, "the error should name the bad flag");
  } finally {
    await fx.cleanup();
  }
});

test("`board status <ref> --bogus x` is rejected", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await runBoard(["status", fx.ticketRelPath, "--bogus", "x"], { cwd: fx.worktree });
    assert.notEqual(r.code, 0, "an unrecognized flag on status should be rejected");
    assert.match(r.stderr, /--bogus/, "the error should name the bad flag");
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 2: invalid status transition for the calling agent's mode ----

test("`board release --status in-review` is rejected when the claim was `qa --mode specify`", async () => {
  const fx = await makeBoardFixture();
  try {
    const claimed = await runBoard(
      ["claim", fx.ticketRelPath, "qa", "--mode", "specify"],
      { cwd: fx.worktree }
    );
    assert.equal(claimed.code, 0, claimed.stderr);
    // A valid handoff exists too, so a failure here can only be the
    // mode/transition rule, not the handoff-gate from criterion 3.
    await writeHandoff(fx.root, fx.feature, "01-qa.md", validHandoffBody());

    const before = await fx.readTicket();
    const r = await runBoard(["release", fx.ticketRelPath, "--status", "in-review"], {
      cwd: fx.worktree,
    });
    assert.notEqual(
      r.code,
      0,
      "qa-specify releasing at in-review should be rejected: qa never sets ticket status itself"
    );
    assert.equal(await fx.readTicket(), before, "a rejected release must not touch the ticket");
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 3: release at in-review/resolved requires a valid State block ---

test("`board release --status in-review` is rejected when no handoff file exists for the ticket", async () => {
  const fx = await makeBoardFixture();
  try {
    const claimed = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    assert.equal(claimed.code, 0, claimed.stderr);
    // Deliberately no .scratch/<feature>/handoffs/ directory at all.

    const before = await fx.readTicket();
    const r = await runBoard(["release", fx.ticketRelPath, "--status", "in-review"], {
      cwd: fx.worktree,
    });
    assert.notEqual(r.code, 0, "release without any handoff file should be refused");
    assert.equal(await fx.readTicket(), before, "a rejected release must not touch the ticket");
  } finally {
    await fx.cleanup();
  }
});

test("`board release --status in-review` is rejected when the handoff's State block is missing a required field", async () => {
  const fx = await makeBoardFixture();
  try {
    const claimed = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    assert.equal(claimed.code, 0, claimed.stderr);

    const state = {
      ticket: "sample/01-do-thing",
      role: "developer",
      current_step: "developer made tests pass",
      artifacts: [],
      decisions: [],
      // "failures" and "pending" both omitted: invalid per validateState.
    };
    const body = "```json\n" + JSON.stringify(state) + "\n```\n\n## Summary\n";
    await writeHandoff(fx.root, fx.feature, "01-developer.md", body);

    const before = await fx.readTicket();
    const r = await runBoard(["release", fx.ticketRelPath, "--status", "in-review"], {
      cwd: fx.worktree,
    });
    assert.notEqual(r.code, 0, "release with an invalid State block should be refused");
    assert.match(
      r.stderr,
      /pending/,
      "the refusal should surface validateState's named errors (e.g. the missing \"pending\" field)"
    );
    assert.equal(await fx.readTicket(), before, "a rejected release must not touch the ticket");
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 4: --force --reason bypasses the handoff gate, logging an override ---

test("`board release --status in-review --force --reason \"...\"` succeeds despite a missing handoff and logs a `kind:\"override\"` event", async () => {
  const fx = await makeBoardFixture();
  try {
    const claimed = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    assert.equal(claimed.code, 0, claimed.stderr);
    // No handoff file at all.

    const r = await runBoard(
      [
        "release",
        fx.ticketRelPath,
        "--status",
        "in-review",
        "--force",
        "--reason",
        "shipping without a handoff, approved by the user",
      ],
      { cwd: fx.worktree }
    );
    assert.equal(r.code, 0, r.stderr);
    assert.match(await fx.readTicket(), /Status:\s*in-review/);

    const events = await readEvents(fx.root);
    const override = events.find((e) => e.kind === "override");
    assert.ok(override, `expected a kind:"override" event, got ${JSON.stringify(events)}`);
    assert.match(override.reason ?? "", /shipping without a handoff/);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 5: a valid State block with empty pending releases normally ---

test("a valid State block with empty pending releases at in-review normally, no --force needed", async () => {
  const fx = await makeBoardFixture();
  try {
    const claimed = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    assert.equal(claimed.code, 0, claimed.stderr);
    await writeHandoff(fx.root, fx.feature, "01-developer.md", validHandoffBody({ pending: [] }));

    const r = await runBoard(["release", fx.ticketRelPath, "--status", "in-review"], {
      cwd: fx.worktree,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(await fx.readTicket(), /Status:\s*in-review/);

    const events = await readEvents(fx.root);
    assert.equal(
      events.some((e) => e.kind === "override"),
      false,
      "a normal, valid-handoff release must not log an override event"
    );
  } finally {
    await fx.cleanup();
  }
});
