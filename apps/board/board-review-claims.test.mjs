// organism-infra/28: a review-hop claim (qa verify, security) on an in-review
// ticket must not clobber `in-review`. See
// .scratch/organism-infra/issues/28-review-claims-keep-in-review.md.
//
// Wire shape pinned: after `claim` by the agent and `release --keep-status`
// (how qa and security release), the status is still `in-review`. The status
// also stays `in-review` while the claim is held. Other claims are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { makeBoardFixture, runBoard, writeValidHandoff } from "./board-fixture.mjs";

async function exists(p) {
  return access(p).then(
    () => true,
    () => false
  );
}

async function statusOf(fx) {
  const r = await runBoard(["status", fx.ticketRelPath], { cwd: fx.worktree });
  assert.equal(r.code, 0, r.stderr);
  return r.stdout.trim();
}

for (const [role, claimArgs] of [
  ["qa", ["--mode", "verify"]],
  ["security", []],
]) {
  test(`a ${role} claim on an in-review ticket keeps it in-review while held and after release`, async () => {
    const fx = await makeBoardFixture({ status: "in-review" });
    try {
      const c = await runBoard(["claim", fx.ticketRelPath, role, ...claimArgs], { cwd: fx.worktree });
      assert.equal(c.code, 0, c.stderr);
      assert.match(await statusOf(fx), /in-review/, "status must stay in-review while claimed");
      assert.match(await fx.readTicket(), /^Status: in-review$/m);

      await writeValidHandoff(fx); // organism-infra/30: --keep-status is handoff-gated
      const r = await runBoard(["release", fx.ticketRelPath, "--keep-status"], { cwd: fx.worktree });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(await exists(fx.claimLockPath), false, "the claim lock must be gone");
      assert.match(await statusOf(fx), /in-review/, "status must be in-review after release");
    } finally {
      await fx.cleanup();
    }
  });
}

test("a developer claim on a ready-for-agent ticket still sets claimed", async () => {
  const fx = await makeBoardFixture();
  try {
    const c = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    assert.equal(c.code, 0, c.stderr);
    assert.match(await fx.readTicket(), /^Status: claimed$/m);
  } finally {
    await fx.cleanup();
  }
});
