// hardening/01, final round (user, 2026-10-22; security pass with mediums).
//   1. A den agent keeps its spec and handoffs: the shell read limit (sandbox.filesystem.allowRead) and the host's file-tool rule
//      (fileToolRefusal) both let it Read the ticket's own feature `.scratch/<feature>/spec.md` and `.scratch/<feature>/handoffs/**`.
//      Another feature's spec and handoffs, other tickets' files and the rest of the board stay closed; Write and Edit there stay refused.
//   2. A worktree path that cannot be written as a plain rule fails closed: the run is refused, not started with the shell read limit dropped.
//   3. On WSL the Windows drives under /mnt (C:\Users\<user>\.ssh) were readable by the shell: the read limit closes /mnt too.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildClaudeArgs, compileCeiling, fileToolRefusal } from "./claude-adapter.mjs";
import { makeStub } from "./claude-stub.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";
import { unconfinedLauncher } from "./launcher-test-helpers.mjs";

const SID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const HOME = "/home/u";
const ROOT = "/home/u/den";
const WT = `${ROOT}/.claude/worktrees/den-x`;
const NODE = "/home/u/.nvm/versions/node/v22.0.0";
const MAIN_GIT = `${ROOT}/.git`;
const FEATURE = `${ROOT}/.scratch/den`;
const TICKET = `${FEATURE}/issues/01-x.md`;

const settingsFor = (role, options = {}) => {
  const argv = buildClaudeArgs({ sessionId: SID, agent: role, ticketFile: TICKET, ...compileCeiling(role, { worktree: WT, root: ROOT, mainGit: MAIN_GIT, home: HOME, toolchain: NODE, ...options }) });
  return JSON.parse(argv[argv.indexOf("--settings") + 1]);
};
const expand = (p) => (p.startsWith("~/") ? HOME + p.slice(1) : p);
const covers = (dir, file) => file === dir.replace(/\/$/, "") || file.startsWith(`${dir.replace(/\/$/, "")}/`);
const shellCanRead = (fs = {}, file) => !(fs.denyRead ?? []).some((d) => covers(expand(d), file)) || (fs.allowRead ?? []).some((a) => covers(expand(a), file));

const SPEC = `${FEATURE}/spec.md`;
const HANDOFF = `${FEATURE}/handoffs/01-developer.md`;
const CLOSED = [
  `${ROOT}/.scratch/other/spec.md`,
  `${ROOT}/.scratch/other/handoffs/01-developer.md`,
  `${ROOT}/.scratch/other/issues/01-y.md`,
  `${FEATURE}/issues/02-someone-elses.md`,
  `${FEATURE}/notes.md`,
  `${FEATURE}/specs.md`,
  `${FEATURE}/handoffs-old/a.md`,
  `${ROOT}/.scratch/usage.jsonl`,
];

describe("the shell read limit keeps the ticket's own feature spec and handoffs", () => {
  for (const role of ["developer", "qa", "code-reviewer"]) {
    test(`${role}: spec.md and handoffs/ are readable, every other board file stays closed`, () => {
      const fs = settingsFor(role).sandbox.filesystem;
      assert.equal(shellCanRead(fs, SPEC), true);
      assert.equal(shellCanRead(fs, HANDOFF), true);
      for (const file of CLOSED) assert.equal(shellCanRead(fs, file), false, `${file} must stay unreadable`);
    });

    test(`${role}: the shell still cannot write them, and the host still allows no Write or Edit there`, () => {
      const s = settingsFor(role);
      for (const file of [SPEC, HANDOFF]) {
        assert.equal((s.sandbox.filesystem.allowWrite ?? []).some((a) => covers(expand(a), file)), false, `${file} is not an allowWrite path`);
        assert.equal(s.permissions.allow.some((r) => /^(Write|Edit)\(/.test(r) && r.includes(FEATURE)), false, `no Write/Edit allow names ${file}`);
      }
    });
  }
});

describe("the host's file-tool rule keeps the ticket's own feature spec and handoffs", () => {
  const refusal = (tool, file, extra = {}) => fileToolRefusal({ tool, input: { file_path: file }, worktree: WT, ticketFile: TICKET, home: HOME, ...extra });

  test("Read of spec.md and of a file under handoffs/ is allowed", () => {
    assert.equal(refusal("Read", SPEC), null);
    assert.equal(refusal("Read", HANDOFF), null);
    assert.equal(refusal("Read", `${FEATURE}/handoffs/deep/er.md`), null);
  });

  test("another feature's spec and handoffs, other tickets and the rest of the board are refused", () => {
    for (const file of CLOSED) assert.match(refusal("Read", file) ?? "", /outside the worktree/, file);
  });

  test("a path that climbs out of handoffs/ with .. is refused", () => {
    assert.match(refusal("Read", `${FEATURE}/handoffs/../notes.md`) ?? "", /outside/);
    assert.match(refusal("Read", `${FEATURE}/handoffs/../../other/spec.md`) ?? "", /outside/);
  });

  test("Write and Edit there stay refused", () => {
    for (const tool of ["Write", "Edit"]) {
      for (const file of [SPEC, HANDOFF]) assert.match(refusal(tool, file) ?? "", /outside the worktree/, `${tool} ${file}`);
    }
  });

  test("no ticket file, no extra reach", () => {
    assert.match(fileToolRefusal({ tool: "Read", input: { file_path: SPEC }, worktree: WT, home: HOME }) ?? "", /outside/);
  });

  describe("on a real disk", () => {
    let dir;
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    test("a link inside handoffs/ that leads outside the feature is refused", async () => {
      dir = await mkdtemp(path.join(tmpdir(), "wall-final-"));
      const feature = path.join(dir, ".scratch", "den");
      await mkdir(path.join(feature, "handoffs"), { recursive: true });
      await mkdir(path.join(feature, "issues"), { recursive: true });
      await mkdir(path.join(dir, "secret"), { recursive: true });
      await mkdir(path.join(dir, "wt"), { recursive: true });
      await writeFile(path.join(dir, "secret", "key"), "x");
      await writeFile(path.join(feature, "handoffs", "01-a.md"), "ok");
      await symlink(path.join(dir, "secret", "key"), path.join(feature, "handoffs", "evil.md"));
      const ticketFile = path.join(feature, "issues", "01-x.md");
      const ask = (file) => fileToolRefusal({ tool: "Read", input: { file_path: file }, worktree: path.join(dir, "wt"), ticketFile, home: HOME });
      assert.equal(ask(path.join(feature, "handoffs", "01-a.md")), null);
      assert.match(ask(path.join(feature, "handoffs", "evil.md")) ?? "", /outside/);
    });
  });
});

describe("a worktree that is not a plain path fails closed (security medium)", () => {
  const cleanups = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });
  for (const dirName of ["den wall cwd ", "den-wall-é-", "den-wall-(x)-"]) {
    test(`a writer role in "${dirName}" is refused, and no child is started`, async () => {
      const stub = await makeStub({ mode: "hang" });
      const cwd = await mkdtemp(path.join(tmpdir(), dirName));
      cleanups.push(() => rm(cwd, { recursive: true, force: true }));
      const runtime = createClaudeRuntime({ controlRoot: "/", launcher: unconfinedLauncher(), env: { PATH: process.env.PATH, HOME: process.env.HOME, DEN_CLAUDE_BIN: stub.bin } });
      await assert.rejects(runtime.spawn({ role: "developer", cwd, prompt: "do the thing", sessionId: SID }), (err) => err instanceof TypeError && /plain absolute path/.test(err.message) && /worktree|cwd/.test(err.message));
      assert.equal(await stub.start(), undefined, "the child never started");
    });
  }
});

describe("the read limit closes the Windows drives under /mnt (security medium)", () => {
  test("a worktree agent cannot read /mnt/c/Users/<user>/.ssh or any other drive", () => {
    const fs = settingsFor("developer").sandbox.filesystem;
    for (const file of ["/mnt/c/Users/Derek/.ssh/id_rsa", "/mnt/d/backup/keys.txt", "/mnt/wslg/runtime-dir"]) assert.equal(shellCanRead(fs, file), false, file);
  });
  test("it stays closed for an agent with a way out, and the Linux toolchain stays readable", () => {
    const fs = settingsFor("developer", { remote: true }).sandbox.filesystem;
    assert.equal(shellCanRead(fs, "/mnt/c/Users/Derek/.ssh/id_rsa"), false);
    for (const file of [`${NODE}/bin/node`, `${HOME}/.cache/ms-playwright/chromium-1243/chrome`, `${WT}/src/a.mjs`]) assert.equal(shellCanRead(fs, file), true, file);
  });
  test("a path grant under /mnt is the user's choice and stays readable", () => {
    const fs = settingsFor("developer", { grants: [{ kind: "path", value: "/mnt/d/shared" }] }).sandbox.filesystem;
    assert.equal(shellCanRead(fs, "/mnt/d/shared/a.txt"), true);
    assert.equal(shellCanRead(fs, "/mnt/d/other/a.txt"), false);
  });
});
