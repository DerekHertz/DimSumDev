// multi-project/04, item 6: the hub's read of a target's board does not follow a .scratch symlink.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSnapshot } from "./snapshot.mjs";

const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), "snap-")));
const TICKET = "# 01: First\n\n**Type:** feature\n\n**Priority:** P1\n\n**Blocked by:** none\n\n**Status:** ready-for-agent\n\n## Comments\n\n";
function scratchWithTicket(dir) {
  const issues = path.join(dir, ".scratch", "pf", "issues");
  mkdirSync(issues, { recursive: true });
  writeFileSync(path.join(issues, "01-first.md"), TICKET);
}

test("a target's real .scratch is read, and one that is a symlink is not followed", async () => {
  const control = tmp();
  mkdirSync(path.join(control, ".scratch"));
  const real = tmp();
  scratchWithTicket(real);
  assert.deepEqual((await buildSnapshot(control, 0, { boardRoot: real })).tickets.map((t) => t.ref), ["pf/01-first"]);

  const behind = tmp();
  scratchWithTicket(behind);
  const linked = tmp();
  symlinkSync(path.join(behind, ".scratch"), path.join(linked, ".scratch"));
  assert.deepEqual((await buildSnapshot(control, 0, { boardRoot: linked })).tickets, []);
});
