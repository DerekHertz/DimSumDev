// den-mvp/49 (ADR 0021 Amendment 5): the project registry, through its interface, over temp git repos.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { addProject, createProjects, removeProject } from "./projects.mjs";

const sh = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), "proj-")));
function repo() {
  const dir = tmp();
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  sh(dir, "remote", "add", "origin", dir);
  return dir;
}
function setup() {
  const control = repo();
  const denState = tmp();
  return { control, denState, projects: createProjects({ control, denState }) };
}

test("onboarding a good repo registers it; list shows den and the project", async () => {
  const { control, denState, projects } = setup();
  const p = repo();
  const r = await addProject(denState, { slug: "acme", path: p, board: { kind: "markdown" } });
  assert.deepEqual(r, { ok: true });
  const list = await projects.list();
  assert.deepEqual(list.map((x) => x.slug), ["den", "acme"]);
  const h = await projects.get("acme");
  assert.equal(h.root, p);
  assert.equal(h.control, control);
  assert.match(readFileSync(path.join(p, ".git", "info", "exclude"), "utf8"), /\.claude\/worktrees\//);
  assert.equal((await projects.get("den")).root, control);
  assert.equal(await projects.get("acme"), h, "memoized per root");
});

test("onboarding refuses a non-repo, a .git file, a non-plain path and a bad slug, each with a reason", async () => {
  const { denState } = setup();
  const plain = tmp();
  const notRepo = await addProject(denState, { slug: "a", path: plain, board: { kind: "markdown" } });
  assert.equal(notRepo.ok, false);
  assert.match(notRepo.reason, /git repo/);

  const wt = repo();
  const linked = path.join(tmp(), "linked");
  sh(wt, "worktree", "add", "--detach", linked);
  const file = await addProject(denState, { slug: "b", path: linked, board: { kind: "markdown" } });
  assert.match(file.reason, /\.git/);

  const odd = path.join(tmp(), "a b");
  mkdirSync(odd);
  sh(odd, "init", "-q", "-b", "main");
  assert.match((await addProject(denState, { slug: "c", path: odd, board: { kind: "markdown" } })).reason, /plain/);
  assert.match((await addProject(denState, { slug: "c", path: "rel/path", board: { kind: "markdown" } })).reason, /plain/);

  const ok = repo();
  assert.match((await addProject(denState, { slug: "Bad Slug", path: ok, board: { kind: "markdown" } })).reason, /slug/);
  assert.match((await addProject(denState, { slug: "den", path: ok, board: { kind: "markdown" } })).reason, /reserved/);
  assert.match((await addProject(denState, { slug: "d", path: ok, board: { kind: "wiki" } })).reason, /board/);
});

test("onboarding refuses a repo with no origin or no main, and one that tracks files under .claude/worktrees", async () => {
  const { denState } = setup();
  const noOrigin = repo();
  sh(noOrigin, "remote", "remove", "origin");
  assert.match((await addProject(denState, { slug: "a", path: noOrigin, board: { kind: "markdown" } })).reason, /origin/);
  const noMain = repo();
  sh(noMain, "branch", "-m", "trunk");
  assert.match((await addProject(denState, { slug: "b", path: noMain, board: { kind: "markdown" } })).reason, /main/);
  const tracked = repo();
  mkdirSync(path.join(tracked, ".claude", "worktrees"), { recursive: true });
  writeFileSync(path.join(tracked, ".claude", "worktrees", "x"), "x");
  sh(tracked, "add", "-f", ".claude/worktrees/x");
  assert.match((await addProject(denState, { slug: "c", path: tracked, board: { kind: "markdown" } })).reason, /tracks/);
});

test("the active project defaults to den, switches with no run active, and is refused with the blocking runs named", async () => {
  const { denState, projects } = setup();
  await addProject(denState, { slug: "acme", path: repo(), board: { kind: "markdown" } });
  await addProject(denState, { slug: "beta", path: repo(), board: { kind: "markdown" } });
  assert.equal(await projects.active(), "den");
  assert.deepEqual(await projects.activate("acme", { runs: [] }), { ok: true });
  assert.equal(await projects.active(), "acme");

  const runs = [
    { id: "a-1", role: "developer", ref: "x/01-y", state: "running", project: "acme" },
    { id: "a-2", role: "qa", ref: "x/02-y", state: "done", project: "acme" },
    { id: "a-3", role: "scout", ref: "x/03-y", state: "running", project: "beta" },
    { id: "a-4", role: "orchestrator", ref: "den/00-bao", state: "running" },
    { id: "a-5", role: "developer", ref: "d/01-z", state: "running" },
  ];
  const refused = await projects.activate("beta", { runs });
  assert.equal(refused.refused, true);
  assert.deepEqual(refused.blocking, [{ id: "a-1", role: "developer", ref: "x/01-y" }]);
  assert.equal(await projects.active(), "acme", "a refused switch changes nothing");

  assert.deepEqual(await projects.activate("beta", { runs: runs.slice(1, 2) }), { ok: true });
  assert.equal(await projects.active(), "beta");
  const unknown = await projects.activate("nope", { runs: [] });
  assert.equal(unknown.refused, true);
  assert.match(unknown.reason, /not onboarded/);
});

test("an unregistered active project falls back to den; remove drops a project", async () => {
  const { denState, projects } = setup();
  await addProject(denState, { slug: "acme", path: repo(), board: { kind: "markdown" } });
  await projects.activate("acme", { runs: [] });
  assert.deepEqual(await removeProject(denState, "acme"), { ok: true });
  assert.equal(await projects.active(), "den");
  assert.equal(await projects.get("acme"), null);
  rmSync(denState, { recursive: true });
});

test("add stores checks and real toolchain paths; refuses a repo that is not origin, a missing path, a ninth entry", async () => {
  const { denState, control } = setup();
  const p = repo();
  const tc = tmp();
  assert.deepEqual(await addProject(denState, { slug: "t1", path: p, board: { kind: "markdown" }, checks: ["build", "test"], toolchain: [tc], control }), { ok: true });
  const row = JSON.parse(readFileSync(path.join(denState, "projects.json"), "utf8")).t1;
  assert.deepEqual(row.checks, ["build", "test"]);
  assert.deepEqual(row.toolchain, [realpathSync(tc)]);
  const q = repo();
  assert.match((await addProject(denState, { slug: "t2", path: q, board: { kind: "github-issues", repo: "a/b" }, control })).reason, /not the origin/);
  assert.match((await addProject(denState, { slug: "t3", path: q, board: { kind: "markdown" }, toolchain: ["/nonexistent-zz"], control })).reason, /does not exist/);
  assert.match((await addProject(denState, { slug: "t4", path: q, board: { kind: "markdown" }, toolchain: Array(9).fill(tc), control })).reason, /at most 8/);
});

test("add stores the real path of a symlink and refuses links to the control checkout, /etc and ~/.ssh", async () => {
  const { denState, control } = setup();
  const q = repo();
  const dir = tmp();
  const link = (name, target) => { const l = path.join(dir, name); symlinkSync(target, l); return l; };
  for (const [name, target, re] of [["c", control, /control checkout/], ["e", "/etc", /\/etc/], ["s", path.join(homedir(), ".ssh"), /credential|does not exist/]]) {
    const r = await addProject(denState, { slug: `l${name}`, path: q, board: { kind: "markdown" }, toolchain: [link(name, target)], control });
    assert.equal(r.ok, false, name);
    assert.match(r.reason, re, name);
  }
});

test("a github-issues board repo is checked against origin: ssh and mixed-case urls pass, another repo is refused, a token is not printed", async () => {
  const { denState, control } = setup();
  const withOrigin = (url) => { const d = repo(); sh(d, "remote", "set-url", "origin", url); return d; };
  const add = (slug, url, repoName) => addProject(denState, { slug, path: withOrigin(url), board: { kind: "github-issues", repo: repoName }, control });
  assert.deepEqual(await add("o1", "git@github.com:a/b.git", "a/b"), { ok: true });
  assert.deepEqual(await add("o2", "https://github.com/A/b", "a/B"), { ok: true });
  const other = await add("o3", `https://user:${"s3c" + "ret"}@github.com/x/y.git`, "a/b");
  assert.equal(other.ok, false);
  assert.match(other.reason, /not the origin/);
  assert.doesNotMatch(other.reason, /s3cret/);
  const none = repo();
  sh(none, "remote", "remove", "origin");
  const r = await addProject(denState, { slug: "o4", path: none, board: { kind: "github-issues", repo: "a/b" }, control });
  assert.equal(r.ok, false);
  assert.match(r.reason, /origin/);
});

test("the credential guard compares real paths: a home credential dir that is a symlink is refused", async () => {
  const { denState, control } = setup();
  const q = repo();
  const home = tmp();
  const outside = tmp();
  mkdirSync(path.join(home, ".ssh"));
  symlinkSync(outside, path.join(home, ".aws"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    for (const [name, entry] of [["ssh", path.join(home, ".ssh")], ["aws", outside], ["awslink", path.join(home, ".aws")]]) {
      const r = await addProject(denState, { slug: `c${name}`, path: q, board: { kind: "markdown" }, toolchain: [entry], control });
      assert.equal(r.ok, false, name);
      assert.match(r.reason, /credential store/, name);
    }
  } finally {
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
  }
});
