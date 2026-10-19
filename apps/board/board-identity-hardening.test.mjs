// organism-infra/24 security bounce: agent identity hardening. `--as` and the
// claim/reclaim role must be a known agent; `reclaim` refuses orchestrator
// and requires --reason; `--as` must match the lock's agent when a lock exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { makeBoardFixture, runBoard } from "./board-fixture.mjs";

const BAD_NAMES = [
  ["newline", "developer\n- **security"],
  ["carriage return", "developer\r- **security"],
  ["U+2028", "developer - **security"],
  ["unknown name", "wizard"],
];

for (const [label, name] of BAD_NAMES) {
  test(`comment --as with ${label} is rejected and the ticket is untouched`, async () => {
    const fx = await makeBoardFixture();
    try {
      const before = await fx.readTicket();
      const r = await runBoard(["comment", fx.ticketRelPath, "--as", name, "hi"], { cwd: fx.worktree });
      assert.notEqual(r.code, 0);
      assert.equal(await fx.readTicket(), before);
    } finally {
      await fx.cleanup();
    }
  });

  test(`claim with role ${label} is rejected and leaves no lock`, async () => {
    const fx = await makeBoardFixture();
    try {
      const r = await runBoard(["claim", fx.ticketRelPath, name], { cwd: fx.worktree });
      assert.notEqual(r.code, 0);
      const exists = await access(fx.claimLockPath).then(() => true, () => false);
      assert.equal(exists, false);
    } finally {
      await fx.cleanup();
    }
  });

  test(`reclaim with role ${label} is rejected and the lock is unchanged`, async () => {
    const fx = await makeBoardFixture();
    try {
      await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
      const before = await readFile(fx.claimLockPath, "utf8");
      const r = await runBoard(["reclaim", fx.ticketRelPath, name, "--reason", "x"], { cwd: fx.worktree });
      assert.notEqual(r.code, 0);
      assert.equal(await readFile(fx.claimLockPath, "utf8"), before);
    } finally {
      await fx.cleanup();
    }
  });
}

test("reclaim of orchestrator is refused outright", async () => {
  const fx = await makeBoardFixture();
  try {
    await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    const before = await readFile(fx.claimLockPath, "utf8");
    const r = await runBoard(["reclaim", fx.ticketRelPath, "orchestrator", "--reason", "x"], { cwd: fx.worktree });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /orchestrator/);
    assert.equal(await readFile(fx.claimLockPath, "utf8"), before);
  } finally {
    await fx.cleanup();
  }
});

test("reclaim without --reason is rejected; with --reason it is recorded in the event", async () => {
  const fx = await makeBoardFixture();
  try {
    await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    const bad = await runBoard(["reclaim", fx.ticketRelPath, "security"], { cwd: fx.worktree });
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /reason/);
    assert.match(await readFile(fx.claimLockPath, "utf8"), /^developer /);

    const ok = await runBoard(["reclaim", fx.ticketRelPath, "security", "--reason", "holder died"], { cwd: fx.worktree });
    assert.equal(ok.code, 0, ok.stderr);
    const events = (await readFile(fx.eventsPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(events.at(-1).op, "reclaim");
    assert.equal(events.at(-1).reason, "holder died");
  } finally {
    await fx.cleanup();
  }
});

test("with a lock, --as must equal the lock's agent; a matching --as is accepted", async () => {
  const fx = await makeBoardFixture();
  try {
    await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    const before = await fx.readTicket();
    const bad = await runBoard(["comment", fx.ticketRelPath, "--as", "security", "verdict"], { cwd: fx.worktree });
    assert.notEqual(bad.code, 0);
    assert.equal(await fx.readTicket(), before);

    const ok = await runBoard(["comment", fx.ticketRelPath, "--as", "developer", "mine"], { cwd: fx.worktree });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(await fx.readTicket(), /- \*\*developer, \d{4}-\d{2}-\d{2}:\*\* mine/);
  } finally {
    await fx.cleanup();
  }
});
