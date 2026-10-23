// den-v1 loop S0 (ADR 0016 decisions 3 and 6.6, amendment 7): the agent workspace, one git worktree and branch per agent.
// Names come only from the validated ref and the bridge-minted agent id; git is run with an argument list, never a shell.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeStateFixture } from "../bridge-fixture.mjs";

const run = promisify(execFile);
const REF = "fx/02-ready-p0";
const ID = "c-0123456789abcdef";
const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function load() {
  try {
    return await import("./workspace.mjs");
  } catch (err) {
    assert.fail(`apps/bridge/agents/workspace.mjs does not exist yet (missing feature): ${err.message}`);
  }
}
async function fixture(options) {
  const fx = await makeStateFixture(options);
  cleanups.push(fx.cleanup);
  return fx;
}
const exists = (p) => access(p).then(() => true, () => false);
const git = async (root, ...args) => (await run("git", ["-C", root, ...args])).stdout;

describe("workspaceNames", () => {
  test("derives the directory and the branch from the ref and the agent id alone", async () => {
    const { workspaceNames } = await load();
    assert.deepEqual(workspaceNames({ ref: REF, agentId: ID }), {
      worktree: ".claude/worktrees/den-fx-02-ready-p0-01234567",
      branch: "den/fx/02-ready-p0-01234567",
    });
  });

  test("rejects a ref or an agent id that fails its pattern", async () => {
    const { workspaceNames } = await load();
    for (const ref of ["-x/01-a", "fx/01-a/../../etc", "fx/01-a b", "fx/-01-a", "../01-a", "fx", "", null, 7, ["fx/01-a"]]) {
      assert.throws(() => workspaceNames({ ref, agentId: ID }), TypeError, `ref ${JSON.stringify(ref)}`);
    }
    for (const agentId of ["c-xyz", "a-0123456789abcdef", "c-0123456789abcdef/..", "", null, 7]) {
      assert.throws(() => workspaceNames({ ref: REF, agentId }), TypeError, `agentId ${JSON.stringify(agentId)}`);
    }
  });
});

describe("createWorkspaces", () => {
  test("create runs git once, with an argument list built from the derived names", async () => {
    const { createWorkspaces } = await load();
    const fx = await fixture();
    const calls = [];
    const ws = createWorkspaces(fx.root, { exec: async (file, args) => (calls.push({ file, args }), { stdout: "" }) });
    await ws.create({ ref: REF, agentId: ID }).catch(() => {}); // the fake creates nothing, so resolving the path may fail
    assert.deepEqual(calls[0], {
      file: "git",
      // agent-os/09 (ADR 0021 Amendment 2): detached, no `-b`. The branch name is only recorded; the bridge creates it at the final commit.
      args: ["-C", fx.root, "worktree", "add", "--detach", path.join(fx.root, ".claude", "worktrees", "den-fx-02-ready-p0-01234567"), "HEAD"],
    });
  });

  test("a bad ref or agent id is refused before git runs", async () => {
    const { createWorkspaces } = await load();
    const fx = await fixture();
    const calls = [];
    const ws = createWorkspaces(fx.root, { exec: async (file, args) => (calls.push({ file, args }), { stdout: "" }) });
    await assert.rejects(ws.create({ ref: "--upload-pack=x/01-a", agentId: ID }), TypeError);
    await assert.rejects(ws.create({ ref: REF, agentId: "c-../../x" }), TypeError);
    assert.equal(calls.length, 0);
  });

  // agent-os/09 (ADR 0021 Amendment 2, amending ADR 0016 amendment 7): the worktree is DETACHED, so the agent holds no branch and
  // the sandbox can deny every ref in the main .git. `branch` stays the name the bridge will publish to.
  test("create adds a detached worktree at the root's HEAD and makes no branch; remove takes the worktree away", async () => {
    const { createWorkspaces } = await load();
    const fx = await fixture({ git: true });
    const ws = createWorkspaces(fx.root);
    const made = await ws.create({ ref: REF, agentId: ID });
    assert.equal(made.branch, "den/fx/02-ready-p0-01234567");
    assert.equal(made.worktree, ".claude/worktrees/den-fx-02-ready-p0-01234567");
    assert.equal(made.dir, await realpath(path.join(fx.root, made.worktree)));
    assert.equal((await git(made.dir, "rev-parse", "HEAD")).trim(), (await git(fx.root, "rev-parse", "HEAD")).trim());
    assert.equal((await git(made.dir, "branch", "--show-current")).trim(), "", "HEAD is detached: no current branch");
    assert.equal((await git(made.dir, "rev-parse", "--abbrev-ref", "HEAD")).trim(), "HEAD");
    assert.equal((await git(fx.root, "branch", "--list", "den/*")).trim(), "", "no branch exists for the agent");
    assert.notEqual(await realpath(await git(made.dir, "rev-parse", "--show-toplevel").then((s) => s.trim())), await realpath(fx.root));

    await ws.remove(made);
    assert.equal(await exists(made.dir), false);
    assert.equal((await git(fx.root, "branch", "--list", "den/*")).trim(), "");
  });

  // PINNED INTERFACE (agent-os/09 criterion 2): ws.publish({ dir, branch }) creates `branch` in the main checkout at the worktree's
  // current HEAD (the agent's final commit) and resolves { branch, sha }. It never moves a branch that already exists.
  test("publish creates the branch at the agent's final commit and leaves the main checkout's HEAD alone", async () => {
    const { createWorkspaces } = await load();
    const fx = await fixture({ git: true });
    const ws = createWorkspaces(fx.root);
    const made = await ws.create({ ref: REF, agentId: ID });
    const base = (await git(fx.root, "rev-parse", "HEAD")).trim();
    const mainBranch = (await git(fx.root, "branch", "--show-current")).trim();
    await git(made.dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-m", "first");
    await git(made.dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-m", "final");
    const final = (await git(made.dir, "rev-parse", "HEAD")).trim();
    assert.notEqual(final, base);

    const out = await ws.publish(made);
    assert.deepEqual(out, { branch: made.branch, sha: final });
    assert.equal((await git(fx.root, "rev-parse", `refs/heads/${made.branch}`)).trim(), final);
    assert.equal((await git(fx.root, "rev-parse", "HEAD")).trim(), base, "the main checkout's HEAD did not move");
    assert.equal((await git(fx.root, "branch", "--show-current")).trim(), mainBranch);

    await ws.remove(made);
    assert.equal((await git(fx.root, "branch", "--list", "den/*")).trim(), "", "remove also takes a published branch away");
  });

  test("publish refuses to move a branch that already exists", async () => {
    const { createWorkspaces } = await load();
    const fx = await fixture({ git: true });
    const ws = createWorkspaces(fx.root);
    const made = await ws.create({ ref: REF, agentId: ID });
    const base = (await git(fx.root, "rev-parse", "HEAD")).trim();
    await git(fx.root, "branch", made.branch, base);
    await git(made.dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-m", "work");
    await assert.rejects(ws.publish(made));
    assert.equal((await git(fx.root, "rev-parse", `refs/heads/${made.branch}`)).trim(), base);
  });

  test("publish refuses a branch name that is not the derived one for a den agent", async () => {
    const { createWorkspaces } = await load();
    const fx = await fixture({ git: true });
    const ws = createWorkspaces(fx.root);
    const made = await ws.create({ ref: REF, agentId: ID });
    for (const branch of ["main", "--delete", "den/../main", ""]) {
      await assert.rejects(ws.publish({ dir: made.dir, branch }), `branch ${JSON.stringify(branch)}`);
    }
    assert.notEqual((await git(fx.root, "branch", "--show-current")).trim(), "");
  });

  test("the findings file is written new: a link the commit left at .den is removed, never written through", async () => {
    const { createWorkspaces } = await load();
    const fx = await fixture({ git: true });
    const ws = createWorkspaces(fx.root);
    const outside = path.join(fx.root, "outside.txt");
    await writeFile(outside, "the user's own file\n");
    for (const [n, plant] of [
      async (dir) => (await mkdir(path.join(dir, ".den")), symlink(outside, path.join(dir, ".den", "findings.md"))),
      async (dir) => symlink(fx.root, path.join(dir, ".den")),
    ].entries()) {
      const made = await ws.create({ ref: REF, agentId: `c-${n}000000000000000` });
      await plant(made.dir);
      await ws.brief(made, "what the review found\n");
      await assert.rejects(ws.brief(made, "x", "../../outside.txt"), /unknown note name/, "only the bridge's two note names are written");
      assert.equal(await readFile(outside, "utf8"), "the user's own file\n", "nothing outside the worktree is written");
      assert.equal(await exists(path.join(fx.root, "findings.md")), false);
      assert.equal((await lstat(path.join(made.dir, ".den"))).isDirectory(), true);
      assert.equal((await lstat(path.join(made.dir, ".den", "findings.md"))).isFile(), true);
      assert.equal(await readFile(path.join(made.dir, ".den", "findings.md"), "utf8"), "what the review found\n");
    }
  });

  test("create rejects when the root is not a git repository", async () => {
    const { createWorkspaces } = await load();
    const fx = await fixture();
    await assert.rejects(createWorkspaces(fx.root).create({ ref: REF, agentId: ID }));
    assert.equal(await exists(path.join(fx.root, ".claude", "worktrees", "den-fx-02-ready-p0-01234567")), false);
  });
});

// Bao's desk reopens one worktree for every message, so without this it would read the repository (its own role file
// included) as it was at the desk's first run: GitHub's tools stayed hidden after the role file named them on main.
describe("reopen with catchUp (Bao's desk)", () => {
  const ID2 = "c-fedcba9876543210";
  const commitIn = async (dir, name) => {
    await writeFile(path.join(dir, name), `${name}\n`);
    await git(dir, "add", name);
    await git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", name);
  };
  test("a clean worktree behind the root's HEAD moves up to it, and base is the new HEAD", async () => {
    const { createWorkspaces } = await load();
    const fx = await fixture({ git: true });
    const ws = createWorkspaces(fx.root);
    const made = await ws.create({ ref: REF, agentId: ID });
    await commitIn(fx.root, "later.txt");
    const head = (await git(fx.root, "rev-parse", "HEAD")).trim();
    const again = await ws.reopen({ ref: REF, agentId: ID2, origin: ID, catchUp: true });
    assert.equal(again.dir, made.dir);
    assert.equal((await git(made.dir, "rev-parse", "HEAD")).trim(), head);
    assert.equal(again.base, head);
    const plain = await ws.reopen({ ref: REF, agentId: ID2, origin: ID });
    assert.equal(plain.base, head, "without catchUp nothing moves");
  });
  test("a worktree with its own change or its own commit stays where it is", async () => {
    const { createWorkspaces } = await load();
    const fx = await fixture({ git: true });
    const ws = createWorkspaces(fx.root);
    await commitIn(fx.root, "base.txt");
    const made = await ws.create({ ref: REF, agentId: ID });
    await commitIn(fx.root, "later.txt");
    const start = (await git(made.dir, "rev-parse", "HEAD")).trim();
    const tracked = "base.txt";
    await writeFile(path.join(made.dir, tracked), "edited\n");
    assert.equal((await ws.reopen({ ref: REF, agentId: ID2, origin: ID, catchUp: true })).base, start, "an edit keeps it");
    await git(made.dir, "checkout", "-q", "--", tracked);
    await commitIn(made.dir, "mine.txt");
    const own = (await git(made.dir, "rev-parse", "HEAD")).trim();
    assert.equal((await ws.reopen({ ref: REF, agentId: ID2, origin: ID, catchUp: true })).base, own, "its own commit keeps it");
  });

  // den-mvp/43: a finished delivery's worktrees go; what is not on main is kept on a wip/ branch.
  test("retire removes a clean worktree and its den branch, and keeps nothing for a worktree on main", async () => {
    const { createWorkspaces } = await load();
    const fx = await fixture({ git: true });
    const ws = createWorkspaces(fx.root);
    const made = await ws.create({ ref: REF, agentId: ID });
    await ws.publish({ dir: made.dir, branch: made.branch });
    await mkdir(path.join(made.dir, ".agents", "skills"), { recursive: true });
    await writeFile(path.join(made.dir, ".agents", "skills", "a.md"), "copy\n");
    const out = await ws.retire({ ref: REF, agentId: ID });
    assert.equal(out.saved, null);
    assert.equal(await exists(made.dir), false);
    assert.equal((await git(fx.root, "branch", "--list", "den/*", "wip/*")).trim(), "");
  });

  test("retire saves an uncommitted change to a wip/ branch before it removes the worktree", async () => {
    const { createWorkspaces } = await load();
    const fx = await fixture({ git: true });
    const ws = createWorkspaces(fx.root);
    const made = await ws.create({ ref: REF, agentId: ID });
    await writeFile(path.join(made.dir, "mine.txt"), "work\n");
    const out = await ws.retire({ ref: REF, agentId: ID });
    assert.equal(out.saved, "wip/fx-02-ready-p0-01234567");
    assert.equal(await exists(made.dir), false);
    assert.equal((await git(fx.root, "show", `${out.saved}:mine.txt`)), "work\n");
  });

  test("retire keeps a branch for a commit that is not on main, and ignores a worktree that is gone", async () => {
    const { createWorkspaces } = await load();
    const fx = await fixture({ git: true });
    const ws = createWorkspaces(fx.root);
    const made = await ws.create({ ref: REF, agentId: ID });
    await git(made.dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-m", "x");
    const sha = (await git(made.dir, "rev-parse", "HEAD")).trim();
    await ws.publish({ dir: made.dir, branch: made.branch });
    const out = await ws.retire({ ref: REF, agentId: ID });
    assert.equal((await git(fx.root, "rev-parse", out.saved)).trim(), sha);
    assert.equal((await git(fx.root, "branch", "--list", "den/*")).trim(), "");
    assert.deepEqual(await ws.retire({ ref: REF, agentId: ID }), { removed: false, saved: null });
  });
});

// hardening/10 (hardening/13 security, M): an agent can write the config git reads in its worktree. The bridge's own git there
// (head, status, add, commit, diff) must not run an fsmonitor or a hook the agent planted.
test("host git in an agent worktree runs no planted fsmonitor or hook", async () => {
  const { createWorkspaces } = await load();
  const fx = await fixture({ git: true });
  const ws = createWorkspaces(fx.root);
  const made = await ws.create({ ref: REF, agentId: ID });
  const marks = path.join(fx.root, "..", `planted-${process.pid}`);
  cleanups.push(() => import("node:fs/promises").then((fs) => fs.rm(marks, { recursive: true, force: true })));
  await mkdir(path.join(marks, "hooks"), { recursive: true });
  await writeFile(path.join(marks, "hooks", "post-commit"), `#!/bin/sh\ntouch ${path.join(marks, "hook-ran")}\n`, { mode: 0o755 });
  await run("git", ["-C", made.dir, "config", "core.fsmonitor", `touch ${path.join(marks, "fsmonitor-ran")}; false`]);
  await run("git", ["-C", made.dir, "config", "core.hooksPath", path.join(marks, "hooks")]);
  await writeFile(path.join(made.dir, "agent-change.txt"), "x\n");
  await ws.head(made);
  const { saved } = await ws.retire({ ref: REF, agentId: ID });
  assert.ok(saved, "the change was committed to a wip branch");
  for (const m of ["fsmonitor-ran", "hook-ran"]) assert.equal(await access(path.join(marks, m)).then(() => true, () => false), false, m);
});

// hardening/10 (hardening/13 security, M, second half): the agent can write its worktree's `.git` file and its admin dir's
// `commondir` (both mounted rw), and so point the bridge's git at a config it planted. The bridge pins GIT_DIR, GIT_COMMON_DIR
// and GIT_WORK_TREE from its own records, and reads no attributes from the tree, so no planted driver runs on the host.
describe("host git ignores the worktree's own pointers and attributes", () => {
  const marked = async (marks, m) => exists(path.join(marks, m));
  async function setup() {
    const { createWorkspaces } = await load();
    const fx = await fixture({ git: true });
    const ws = createWorkspaces(fx.root);
    const made = await ws.create({ ref: REF, agentId: ID });
    const marks = path.join(fx.root, "..", `planted-attr-${process.pid}`);
    await mkdir(marks, { recursive: true });
    cleanups.push(() => import("node:fs/promises").then((fs) => fs.rm(marks, { recursive: true, force: true })));
    const mainGit = path.join(await realpath(fx.root), ".git");
    const admin = path.join(mainGit, "worktrees", path.basename(made.dir));
    return { ws, fx, made, marks, mainGit, admin };
  }

  test("a rewritten .git and commondir toward a planted config run no filter driver in head, brief or retire", async () => {
    const { ws, made, marks, mainGit, admin } = await setup();
    const planted = path.join(made.dir, ".planted");
    const { cp } = await import("node:fs/promises");
    await cp(mainGit, planted, { recursive: true });
    await git(planted, "--git-dir", planted, "config", "filter.x.clean", `touch ${path.join(marks, "filter-ran")}; cat`);
    await git(planted, "--git-dir", planted, "config", "filter.x.smudge", `touch ${path.join(marks, "filter-ran")}; cat`);
    await writeFile(path.join(made.dir, ".git"), `gitdir: ${path.join(planted, "worktrees", path.basename(made.dir))}\n`);
    await writeFile(path.join(admin, "commondir"), `${planted}\n`);
    await writeFile(path.join(made.dir, ".gitattributes"), "* filter=x\n");
    await writeFile(path.join(made.dir, "agent-change.txt"), "x\n");
    await ws.head(made);
    await ws.brief(made, "findings\n");
    assert.equal(await exists(path.join(planted, "info", "exclude")) && (await readFile(path.join(planted, "info", "exclude"), "utf8")).includes(".den/"), false, "brief wrote the planted exclude");
    assert.ok((await readFile(path.join(mainGit, "info", "exclude"), "utf8")).includes(".den/"), "brief writes the main repository's exclude");
    // retire's `add -A ... :(exclude).den` fails while an excluded .den exists (filed separately), so the note goes first here.
    await import("node:fs/promises").then((fs) => fs.rm(path.join(made.dir, ".den"), { recursive: true }));
    const { saved } = await ws.retire({ ref: REF, agentId: ID });
    assert.ok(saved, "the change was committed to a wip branch");
    assert.equal(await marked(marks, "filter-ran"), false, "a planted filter driver ran on the host");
  });

  test("a planted .gitattributes selects no driver from the trusted config", async () => {
    const { ws, fx, made, marks } = await setup();
    await git(fx.root, "config", "filter.y.clean", `touch ${path.join(marks, "trusted-filter-ran")}; cat`);
    await writeFile(path.join(made.dir, ".gitattributes"), "* filter=y\n");
    await writeFile(path.join(made.dir, "agent-change.txt"), "x\n");
    await ws.head(made);
    const { saved } = await ws.retire({ ref: REF, agentId: ID });
    assert.ok(saved, "the change was committed to a wip branch");
    assert.equal(await marked(marks, "trusted-filter-ran"), false, "a driver chosen by the tree's .gitattributes ran on the host");
  });
});

// hardening/10 fix round (qa F1, security L3): the common dir comes from the trusted root, so a bridge whose root is itself a
// linked worktree (where `.git` is a file) still works; the admin dir is the one `worktree add` recorded, checked at create.
describe("the bridge's git dirs come from the root and from worktree add", () => {
  test("a root that is a linked worktree creates, reads, briefs and retires an agent worktree", async () => {
    const { createWorkspaces } = await load();
    const fx = await fixture({ git: true });
    const linked = path.join(fx.root, "..", `linked-root-${process.pid}`);
    await git(fx.root, "worktree", "add", "--detach", linked);
    cleanups.push(() => run("git", ["-C", fx.root, "worktree", "remove", "--force", linked]).catch(() => {}));
    const ws = createWorkspaces(linked);
    const made = await ws.create({ ref: REF, agentId: ID });
    assert.equal(await ws.head(made), (await git(linked, "rev-parse", "HEAD")).trim());
    await ws.brief(made, "findings\n");
    assert.ok((await readFile(path.join(await realpath(fx.root), ".git", "info", "exclude"), "utf8")).includes(".den/"), "brief writes the common exclude");
    await import("node:fs/promises").then((fs) => fs.rm(path.join(made.dir, ".den"), { recursive: true }));
    await writeFile(path.join(made.dir, "agent-change.txt"), "x\n");
    const { removed, saved } = await ws.retire({ ref: REF, agentId: ID });
    assert.equal(removed, true);
    assert.ok(saved, "the change was committed to a wip branch");
  });

  test("create refuses, and leaves no worktree, when git gave the admin dir another name than the worktree's", async () => {
    const { createWorkspaces } = await load();
    const fx = await fixture({ git: true });
    const { worktree } = (await load()).workspaceNames({ ref: REF, agentId: ID });
    const stale = path.join(fx.root, ".git", "worktrees", path.basename(worktree));
    await mkdir(stale, { recursive: true });
    const ws = createWorkspaces(fx.root);
    await assert.rejects(ws.create({ ref: REF, agentId: ID }), /admin/);
    assert.equal(await exists(path.join(fx.root, worktree)), false, "the worktree was taken away");
  });
});
