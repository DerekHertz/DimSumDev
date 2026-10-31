// den-meetings/01: a meeting seat's read-only profile, compiled by compileCeiling and written by buildClaudeArgs.
// Expected values are hand-written literals.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildClaudeArgs, compileCeiling } from "./claude-adapter.mjs";

const SID = "0b8f1c1e-5c1a-4c0e-9a55-3f2d9e7a4b10";
const ROOT = "/work/den";
const WT = "/work/den/.claude/worktrees/den-meetings-00-m-1-abcd1234";
const HOME = "/home/u";
const settingsOf = (argv) => JSON.parse(argv[argv.indexOf("--settings") + 1]);
const seat = (extra = {}) => settingsOf(buildClaudeArgs({ sessionId: SID, agent: "architect", ...compileCeiling("architect", { worktree: WT, root: ROOT, home: HOME, readOnly: true, ...extra }) }));

describe("meeting seat read-only profile", () => {
  test("reads the whole project root (untracked files, .scratch/) with no request", () => {
    const { allow } = seat().permissions;
    assert.ok(allow.includes("Read(//work/den/**)"), JSON.stringify(allow));
  });

  test("Edit, Write and NotebookEdit are denied outright and no write is allowed", () => {
    const { allow, deny } = seat().permissions;
    for (const tool of ["Write", "Edit", "NotebookEdit"]) assert.ok(deny.includes(tool), tool);
    assert.deepEqual(allow.filter((r) => /^(Write|Edit)\(/.test(r)), []);
  });

  test("a writing shell is refused: git writers denied, the worktree read-only to the sandbox", () => {
    const settings = seat();
    assert.ok(settings.permissions.deny.includes("Bash(*git *commit*)"));
    assert.ok(settings.permissions.deny.includes("Bash(*git *push*)"));
    assert.ok(settings.sandbox.filesystem.denyWrite.includes(WT));
  });

  test("the state folder, ~/.claude and ~/.codex stay unreadable to the file tools and the shell", () => {
    const settings = seat();
    for (const p of ["~/.local/state/den", "~/.claude", "~/.codex"]) {
      assert.ok(settings.permissions.deny.includes(`Read(${p}/**)`), p);
      assert.ok(settings.sandbox.filesystem.denyRead.includes(p), p);
    }
  });

  test("a governed path and a credential store stay denied", () => {
    const settings = settingsOf(buildClaudeArgs({ sessionId: SID, agent: "architect", ...compileCeiling("architect", { worktree: WT, root: ROOT, home: HOME, readOnly: true, credentials: ["~/.ssh"] }) }));
    assert.ok(settings.permissions.deny.includes("Read(~/.ssh/**)"));
    assert.ok(settings.permissions.deny.includes("Write(.claude/**)"));
    assert.ok(settings.sandbox.filesystem.denyRead.includes("~/.ssh"));
  });

  test("a read-only run needs the project root and takes no grants", () => {
    assert.throws(() => compileCeiling("architect", { worktree: WT, readOnly: true }), /root/);
    assert.throws(() => compileCeiling("architect", { worktree: WT, root: ROOT, readOnly: true, grants: [{ kind: "path", value: "/tmp/x" }] }), /grants/);
  });

  test("a run that is not read-only is unchanged", () => {
    const { allow, deny } = settingsOf(buildClaudeArgs({ sessionId: SID, agent: "architect", ...compileCeiling("architect", { worktree: WT, root: ROOT }) })).permissions;
    assert.ok(allow.includes(`Write(/${WT}/**)`));
    assert.equal(deny.includes("Write"), false);
    assert.equal(allow.some((r) => r.startsWith("Read(//work/den")), false);
  });
});
