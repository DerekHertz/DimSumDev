// hardening/01 addendum (user, 2026-10-22): a sandboxed shell command cannot read outside the agent's worktree.
// The CLI's own sandbox read setting is `sandbox.filesystem.denyRead` with `sandbox.filesystem.allowRead` ("Paths to re-allow
// reading within denyRead regions. Takes precedence over denyRead"; Claude Code 2.1.293 settings schema, and ADR 0021 l.114).
// Today compileCeiling turns the limit on only when a host or a remote connection is granted, so an agent with a worktree and
// no way out can still `cat ~/anything`. The limit must be on for every agent that has a worktree.
//
// At the public seam: compileCeiling + buildClaudeArgs produce the --settings value. shellCanRead() below models the
// setting's documented semantics (a path under a denyRead entry is unreadable unless an allowRead entry covers it). The live
// check that the kernel really refuses is human-verified with the Wall spike.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeArgs, compileCeiling } from "./claude-adapter.mjs";

const SID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const HOME = "/home/u";
const ROOT = "/home/u/den";
const WT = `${ROOT}/.claude/worktrees/den-x`;
const NODE = "/home/u/.nvm/versions/node/v22.0.0";
const MAIN_GIT = `${ROOT}/.git`;
const TICKET = `${ROOT}/.scratch/den/issues/01-x.md`;
const WRITERS = ["developer", "qa", "security", "code-reviewer", "technical-writer"];

const settingsFor = (role, options = {}) => {
  const argv = buildClaudeArgs({ sessionId: SID, agent: role, ticketFile: TICKET, ...compileCeiling(role, { worktree: WT, root: ROOT, mainGit: MAIN_GIT, home: HOME, toolchain: NODE, ...options }) });
  return JSON.parse(argv[argv.indexOf("--settings") + 1]);
};
const expand = (p) => (p.startsWith("~/") ? HOME + p.slice(1) : p);
const covers = (dir, file) => file === dir.replace(/\/$/, "") || file.startsWith(`${dir.replace(/\/$/, "")}/`);
const shellCanRead = (fs = {}, file) => !(fs.denyRead ?? []).some((d) => covers(expand(d), file)) || (fs.allowRead ?? []).some((a) => covers(expand(a), file));

describe("a shell command cannot read outside the worktree, with no host and no connection granted", () => {
  for (const role of WRITERS) {
    test(`${role}: files under $HOME and the main checkout's own files are unreadable`, () => {
      const fs = settingsFor(role).sandbox.filesystem;
      for (const file of [`${HOME}/.ssh/id_rsa`, `${HOME}/notes/todo.txt`, `${HOME}/other-project/src/a.mjs`, `${HOME}/.config/gh/hosts.yml`, `${ROOT}/package.json`, `${ROOT}/.claude/settings.json`, `${ROOT}/.scratch/den/issues/02-someone-elses.md`]) {
        assert.equal(shellCanRead(fs, file), false, `${role}: ${file} must be unreadable to the shell`);
      }
    });

    test(`${role}: the worktree, the ticket file, the toolchain, the npm cache and the main .git stay readable`, () => {
      const fs = settingsFor(role).sandbox.filesystem;
      assert.equal(shellCanRead(fs, `${HOME}/notes/todo.txt`), false, `${role}: the limit is on, so these reads are a reopening and not the default`);
      for (const file of [`${WT}/src/a.mjs`, `${WT}/.git`, TICKET, `${MAIN_GIT}/objects/ab/cdef`, `${MAIN_GIT}/worktrees/den-x/HEAD`, `${ROOT}/node_modules/left-pad/index.js`, `${NODE}/bin/node`, `${HOME}/.npm/_cacache/index-v5/aa`, `${HOME}/.gitconfig`, "/usr/lib/x86_64-linux-gnu/libc.so.6", "/etc/hosts"]) {
        assert.equal(shellCanRead(fs, file), true, `${role}: ${file} must stay readable`);
      }
    });
  }

  test("the project root itself is never reopened (it holds the worktree: live probe 2026-10-18)", () => {
    const fs = settingsFor("developer").sandbox.filesystem;
    assert.ok(fs.denyRead?.length > 0, "the limit is on");
    assert.equal(fs.allowRead.includes(ROOT), false);
  });

  test("a path grant outside the worktree is readable too; a credential store stays closed", () => {
    const fs = settingsFor("developer", { grants: [{ kind: "path", value: "/home/u/data" }], credentials: ["~/.ssh"] }).sandbox.filesystem;
    assert.equal(shellCanRead(fs, `${HOME}/notes/todo.txt`), false, "the limit is on");
    assert.equal(shellCanRead(fs, "/home/u/data/notes.txt"), true);
    assert.equal(shellCanRead(fs, `${HOME}/.ssh/id_rsa`), false);
  });

  test("the file tools are limited the same way (blockReadsOutsideWorkingDirectories) and the ticket's folder is reopened", () => {
    const s = settingsFor("developer");
    assert.equal(s.permissions.blockReadsOutsideWorkingDirectories, true);
    assert.deepEqual(s.permissions.additionalDirectories, [`${ROOT}/.scratch/den/issues`]);
  });
});
