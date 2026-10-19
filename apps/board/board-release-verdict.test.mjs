// organism-infra/54: `board release --verdict` redirects to `board comment --verdict`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBoardFixture, runBoard } from "./board-fixture.mjs";

const NO_ROOT = { DEN_ROOT: "" };

for (const args of [["--verdict", "pass"], ["--verdict=bounce"]]) {
  test(`release ${args.join(" ")} names board comment --verdict and changes nothing`, async () => {
    const fx = await makeBoardFixture();
    try {
      const claim = await runBoard(["claim", fx.ticketRelPath, "security"], { cwd: fx.worktree, env: NO_ROOT });
      assert.equal(claim.code, 0, claim.stderr);
      const before = await fx.readTicket();
      const r = await runBoard(["release", fx.ticketRelPath, "--keep-status", ...args], {
        cwd: fx.worktree,
        env: NO_ROOT,
      });
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /board comment <ref> --verdict/);
      assert.equal(await fx.readTicket(), before);
    } finally {
      await fx.cleanup();
    }
  });
}
