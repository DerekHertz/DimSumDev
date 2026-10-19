// agent-os/09 (ADR 0021 Amendment 2, decision 17): a worktree agent cannot write the main checkout's refs or HEAD.
//
// PINNED INTERFACE (from the architect's handoff 07-architect.md; the developer builds to this):
//   compileCeiling(role, { ..., mainGit })   mainGit = absolute plain path of <root>/.git. When given, the compiled ceiling carries
//       denyAbs for the main .git's refs, HEAD, packed-refs and index, for EVERY role with a ceiling (scout, developer, qa, security),
//       with or without grants. Fixed names, no client string. Not keyed on `root`. A mainGit that is not a plain absolute path is a
//       TypeError. Without mainGit the output is as before (grants-paths.test.mjs stays green).
//   Compiled into settings (buildClaudeArgs): sandbox.filesystem.denyWrite has <mainGit>/refs, /HEAD, /packed-refs, /index (plain),
//       and permissions.deny has Write and Edit rules for each (`//<mainGit>/refs/**` for the directory, the bare path for a file).
//       Nothing denies <mainGit>/objects or <mainGit>/worktrees, nor the whole <mainGit>.
//   workspace.mjs: prepareMainGit(root, { exec }) from workspace.mjs: makes each of the four targets exist (git pack-refs --all
//       --no-prune for packed-refs) or rejects; rejects when <root>/.git is not a directory. Resolves { mainGit }.
//   createWorkspaces(root).publish({ dir, branch }) and the detached create are tested in workspace.test.mjs and
//       host-workspace.test.mjs. The host passes `mainGit` (<realpath root>/.git) in runtime.spawn args for EVERY task, grants or not,
//       and runs the preflight before the spawn.
//   POST /tasks: a path grant on ~/.bash_profile, ~/.bash_login, ~/.bash_logout or ~/.bash_aliases is a 400.
//
// Human-verified, not tested here: the live probe through the real createClaudeRuntime (criterion 4), the security review and risk-check.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, test } from "node:test";
import { buildClaudeArgs, compileCeiling } from "./claude-adapter.mjs";
import { makeBridge } from "./host-test-helpers.mjs";
import { DEN_FEATURE } from "./policy.mjs";
import { makeStateFixture } from "../bridge-fixture.mjs";

const run = promisify(execFile);
const git = async (root, ...args) => (await run("git", ["-C", root, ...args])).stdout;
const exists = (p) => access(p).then(() => true, () => false);
const SID = "0b8f1c1e-5c1a-4c0e-9a55-3f2d9e7a4b10";
const ROOT = "/work/den";
const MAIN_GIT = `${ROOT}/.git`;
const WT = `${ROOT}/.claude/worktrees/den-fx-01-abcd1234`;
const TEXT = "Fetch the package index and note which versions changed.";
const ROLES_WITH_CEILING = ["scout", "developer", "qa", "security"];
const WRITING_ROLES = ["developer", "qa", "security"];
const GRANTS = {
  none: [],
  "a host grant": [{ kind: "host", value: "api.example.com" }],
  "a path grant elsewhere": [{ kind: "path", value: "/srv/shared/data" }],
  "a path grant in the main checkout": [{ kind: "path", value: `${ROOT}/docs/notes` }],
};
const path_ = (value) => ({ kind: "path", value });

let t;
const cleanups = [];
afterEach(async () => {
  await t?.close();
  t = undefined;
  while (cleanups.length > 0) await cleanups.pop()();
});

const settingsOf = (role, compiled) => {
  const argv = buildClaudeArgs({ sessionId: SID, agent: role, ...compiled });
  return JSON.parse(argv[argv.indexOf("--settings") + 1]);
};
const compiledFor = (role, grants, extra = {}) => {
  const worktree = role === "scout" ? undefined : WT;
  return compileCeiling(role, { ...(worktree ? { worktree } : {}), root: ROOT, mainGit: MAIN_GIT, grants: grants.length ? grants : undefined, ...extra });
};

describe("compileCeiling with mainGit denies the main .git's refs, HEAD, packed-refs and index", () => {
  for (const role of ROLES_WITH_CEILING) {
    for (const [name, grants] of Object.entries(GRANTS)) {
      if (role === "scout" && grants.length > 0) continue; // a scout takes no grants (ADR 0021 decision 3)
      test(`${role}, ${name}: shell writes (sandbox denyWrite) are denied for the four targets`, () => {
        const s = settingsOf(role, compiledFor(role, grants));
        const denyWrite = s.sandbox.filesystem.denyWrite ?? [];
        for (const target of ["refs", "HEAD", "packed-refs", "index"]) {
          assert.ok(denyWrite.includes(`${MAIN_GIT}/${target}`), `${target} missing from ${JSON.stringify(denyWrite)}`);
        }
      });

      test(`${role}, ${name}: the Write and Edit tools are denied for the four targets`, () => {
        const deny = settingsOf(role, compiledFor(role, grants)).permissions.deny;
        for (const tool of ["Write", "Edit"]) {
          assert.ok(deny.includes(`${tool}(/${MAIN_GIT}/refs/**)`), `${tool} refs: ${JSON.stringify(deny)}`);
          for (const file of ["HEAD", "packed-refs", "index"]) assert.ok(deny.includes(`${tool}(/${MAIN_GIT}/${file})`), `${tool} ${file}: ${JSON.stringify(deny)}`);
        }
      });
    }
  }

  test("objects and the worktrees directory stay writable: no deny names them or the whole .git", () => {
    for (const role of WRITING_ROLES) {
      const s = settingsOf(role, compiledFor(role, []));
      const all = [...s.permissions.deny, ...(s.sandbox.filesystem.denyWrite ?? [])];
      for (const rule of all) {
        assert.equal(/\/\.git\/(?:objects|worktrees)\b/.test(rule), false, `${role}: ${rule}`);
        for (const whole of [MAIN_GIT, `${MAIN_GIT}/**`, `${MAIN_GIT}/`]) assert.equal(rule === whole || rule.endsWith(`/${whole})`), false, `${role}: the whole .git is denied by ${rule}`);
      }
      assert.ok(!(s.sandbox.filesystem.allowWrite ?? []).some((p) => p.includes(MAIN_GIT)), "the denies are not an allow list change");
    }
  });

  test("the denies are added without mainGit being keyed on root: a task with mainGit and no root still gets them", () => {
    const compiled = compileCeiling("developer", { worktree: WT, mainGit: MAIN_GIT });
    const denyWrite = settingsOf("developer", compiled).sandbox.filesystem.denyWrite;
    assert.ok(denyWrite.includes(`${MAIN_GIT}/refs`), JSON.stringify(denyWrite));
  });

  test("with a path grant in the main checkout, the governed denies and the main .git denies are both there", () => {
    const compiled = compiledFor("developer", [path_(`${ROOT}/apps/bridge`)]);
    const s = settingsOf("developer", compiled);
    assert.ok(s.permissions.deny.includes(`Write(/${ROOT}/apps/bridge/agents/ceilings.json)`), "agent-os/02 deny kept");
    assert.ok(s.permissions.deny.includes(`Write(/${MAIN_GIT}/HEAD)`), "agent-os/09 deny added");
  });

  test("without mainGit the output is as before: no main .git deny anywhere", () => {
    for (const role of WRITING_ROLES) {
      const compiled = compileCeiling(role, { worktree: WT, root: ROOT, grants: [path_(`${ROOT}/docs/notes`)] });
      const s = settingsOf(role, compiled);
      const all = JSON.stringify([s.permissions.deny, s.sandbox.filesystem?.denyWrite ?? []]);
      assert.equal(all.includes(`${MAIN_GIT}/refs`), false, role);
      assert.equal(all.includes(`${MAIN_GIT}/HEAD`), false, role);
    }
  });

  test("a mainGit that is not a plain absolute path is a TypeError", () => {
    for (const bad of ["relative/.git", "/work/../etc/.git", "/work/den/.git/*", "/work/den/.git/refs/**", "", 7, null, ["/work/den/.git"], "/work/de n/.git"]) {
      assert.throws(() => compileCeiling("developer", { worktree: WT, mainGit: bad }), TypeError, JSON.stringify(bad));
    }
  });
});

describe("prepareMainGit makes every deny target exist, or refuses", () => {
  async function load() {
    try {
      const mod = await import("./workspace.mjs");
      assert.equal(typeof mod.prepareMainGit, "function", "workspace.mjs must export prepareMainGit");
      return mod;
    } catch (err) {
      if (err?.code === "ERR_ASSERTION") throw err;
      assert.fail(`workspace.mjs does not load: ${err.message}`);
    }
  }
  async function repo() {
    const fx = await makeStateFixture({ git: true });
    cleanups.push(fx.cleanup);
    return fx.root;
  }
  const TARGETS = ["refs", "HEAD", "packed-refs", "index"];

  test("a repo with no packed-refs gets one, without losing a ref or moving HEAD", async () => {
    const { prepareMainGit } = await load();
    const root = await repo();
    await rm(path.join(root, ".git", "packed-refs"), { force: true });
    await git(root, "branch", "keep-me");
    const head = (await git(root, "rev-parse", "HEAD")).trim();
    const out = await prepareMainGit(root);
    assert.equal(await realpath(out.mainGit), await realpath(path.join(root, ".git")));
    for (const target of TARGETS) assert.ok(await exists(path.join(root, ".git", target)), `${target} exists`);
    assert.equal((await git(root, "rev-parse", "HEAD")).trim(), head);
    assert.equal((await git(root, "rev-parse", "keep-me")).trim(), head);
    assert.match(await git(root, "branch", "--list", "keep-me"), /keep-me/);
  });

  test("a second call changes nothing and runs no git", async () => {
    const { prepareMainGit } = await load();
    const root = await repo();
    await prepareMainGit(root);
    const calls = [];
    await prepareMainGit(root, { exec: async (file, args) => (calls.push([file, args]), { stdout: "" }) });
    assert.deepEqual(calls, []);
  });

  test("a target that is still missing after the attempt refuses the spawn", async () => {
    const { prepareMainGit } = await load();
    const root = await repo();
    await rm(path.join(root, ".git", "packed-refs"), { force: true });
    await assert.rejects(prepareMainGit(root, { exec: async () => ({ stdout: "" }) }), "git did nothing, packed-refs is still missing");
  });

  test("a missing index is made to exist or the spawn is refused, never left missing", async () => {
    const { prepareMainGit } = await load();
    const root = await repo();
    await rm(path.join(root, ".git", "index"), { force: true });
    const ok = await prepareMainGit(root).then(() => true, () => false);
    if (ok) assert.ok(await exists(path.join(root, ".git", "index")), "resolved with the index still missing");
  });

  test("a .git that is a file (a linked worktree) or missing is refused", async () => {
    const { prepareMainGit } = await load();
    const dir = await mkdtemp(path.join(tmpdir(), "mgr-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await assert.rejects(prepareMainGit(dir), "no .git at all");
    await writeFile(path.join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    await assert.rejects(prepareMainGit(dir), ".git is a file");
  });
});

describe("the host passes mainGit for every task and runs the preflight before the spawn", () => {
  test("a developer task with no grants spawns with mainGit = <resolved root>/.git", async () => {
    t = await makeBridge();
    const res = await t.post("/tasks", { role: "developer", text: TEXT });
    assert.equal(res.status, 201, res.text);
    assert.equal(t.fake.spawns[0].args.mainGit, path.join(await realpath(t.fx.root), ".git"));
  });

  test("so does a task with grants (root still rides along), and a dispatched agent with no ceiling", async () => {
    t = await makeBridge();
    const resolved = await realpath(t.fx.root);
    const withGrants = await t.post("/tasks", { role: "developer", text: TEXT, grants: [path_("/srv/shared/data")] });
    assert.equal(withGrants.status, 201, withGrants.text);
    assert.equal(t.fake.spawns[0].args.mainGit, path.join(resolved, ".git"));
    assert.equal(t.fake.spawns[0].args.root, resolved);
    const arch = await t.dispatch("architect");
    assert.equal(arch.status, 201, arch.text);
    assert.equal(t.fake.spawns[1].args.mainGit, path.join(resolved, ".git"));
  });

  test("every deny target exists in the main .git by the time the runtime is asked to spawn", async () => {
    t = await makeBridge();
    const gitDir = path.join(t.fx.root, ".git");
    await rm(path.join(gitDir, "packed-refs"), { force: true });
    const res = await t.post("/tasks", { role: "developer", text: TEXT });
    assert.equal(res.status, 201, res.text);
    for (const target of ["refs", "HEAD", "packed-refs", "index"]) assert.ok(await exists(path.join(gitDir, target)), target);
  });
});

describe("POST /tasks refuses a path grant on the four bash startup files security found (agent-os/07 medium finding)", () => {
  const tickets = async () => (await readdir(path.join(t.fx.root, ".scratch", DEN_FEATURE, "issues")).catch(() => [])).filter((n) => n.endsWith(".md"));
  async function assertRefused(role, value) {
    const res = await t.post("/tasks", { role, text: TEXT, grants: [path_(value)] });
    assert.equal(res.status, 400, `${role} ${value}: ${res.text}`);
    assert.equal(typeof res.body.error, "string");
    assert.ok(res.body.error.length > 0);
    assert.equal(res.body.error.includes(value), false, "the error does not echo the grant");
    assert.deepEqual(await tickets(), [], "no ticket");
    assert.equal(t.fake.spawns.length, 0, "no agent");
  }
  const FILES = [".bash_profile", ".bash_login", ".bash_logout", ".bash_aliases"];
  for (const file of FILES) {
    for (const role of WRITING_ROLES) {
      test(`${role}: ~/${file} is a 400`, async () => {
        t = await makeBridge();
        await assertRefused(role, `~/${file}`);
      });
    }
    test(`the absolute home form of ~/${file} is a 400`, { skip: !/^(?:\/[A-Za-z0-9._@+-]+)+$/.test(homedir()) && "home is not a plain path" }, async () => {
      t = await makeBridge();
      await assertRefused("developer", `${homedir()}/${file}`);
    });
  }

  test("a refused startup file among otherwise good grants refuses the whole task", async () => {
    t = await makeBridge();
    const res = await t.post("/tasks", { role: "developer", text: TEXT, grants: [path_("/srv/shared/data"), path_("~/.bash_aliases")] });
    assert.equal(res.status, 400, res.text);
    assert.equal(t.fake.spawns.length, 0);
  });

  test("a plain home path that only looks similar is still allowed", async () => {
    t = await makeBridge();
    const res = await t.post("/tasks", { role: "developer", text: TEXT, grants: [path_("~/bash_notes")] });
    assert.equal(res.status, 201, res.text);
  });
});
