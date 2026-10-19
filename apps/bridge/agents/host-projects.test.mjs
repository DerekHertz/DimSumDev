// den-mvp/49 (ADR 0021 Amendment 5): two roots over HTTP. A project's board is readable while another is active; a switch is
// refused while a run is active on the current project; a new run's worktree is under the active root, and a run keeps its root.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addProject } from "../projects.mjs";
import { DISPATCH_REF, makeBridge, until } from "./host-test-helpers.mjs";

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const sh = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "pipe" });

function projectRepo() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "acme-")));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "remote", "add", "origin", dir);
  const issues = path.join(dir, ".scratch", "pf", "issues");
  mkdirSync(issues, { recursive: true });
  writeFileSync(path.join(issues, "01-first.md"), "# 01: First\n\n**Type:** feature\n\n**Priority:** P1\n\n**Blocked by:** none\n\n**Status:** ready-for-agent\n\n## Comments\n\n");
  sh(dir, "add", "-f", ".scratch");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}

async function boot() {
  const denState = realpathSync(mkdtempSync(path.join(tmpdir(), "den-state-")));
  const t = await makeBridge({ denState });
  cleanups.push(() => t.close());
  const dir = projectRepo();
  assert.deepEqual(await addProject(denState, { slug: "acme", path: dir, board: { kind: "markdown" } }), { ok: true });
  return { t, dir, get: (p) => fetch(`${t.bridge.url}${p}`, { headers: t.headers }).then(async (r) => ({ status: r.status, body: await r.json() })) };
}

test("a project's board is readable while the den is active, and the list shows both", async () => {
  const { t, get } = await boot();
  const list = await get("/projects");
  assert.deepEqual(list.body.projects.map((p) => [p.slug, p.active]), [["den", true], ["acme", false]]);
  const board = await get("/projects/acme/board");
  assert.equal(board.status, 200);
  assert.deepEqual(board.body.tickets.map((x) => x.ref), ["pf/01-first"]);
  assert.ok(!(await t.state()).tickets.some((x) => x.ref === "pf/01-first"), "the hub still shows the den's board");
  assert.equal((await get("/projects/nope/board")).status, 404);
});

test("a switch is refused while a run is active on the current project, naming it; with none, it succeeds", async () => {
  const ctx = await boot();
  const { t, get } = ctx;
  assert.equal((await t.post("/projects/active", { slug: "acme" })).status, 200);
  assert.ok((await t.state()).tickets.some((x) => x.ref === "pf/01-first"), "the hub now shows the active project's board");
  const started = await t.post("/agents", { ref: "pf/01-first", role: "architect" });
  assert.equal(started.status, 201, started.text);
  const id = started.body.agent.id;
  const { dir } = ctx;
  assert.ok(realpathSync(path.join(dir, started.body.agent.worktree)), "the worktree is under the project's root");
  assert.equal(started.body.agent.project, "acme");

  const refused = await t.post("/projects/active", { slug: "den" });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body.blocking.map((b) => b.id), [id]);
  assert.equal((await get("/projects")).body.projects[1].active, true);

  t.fake.spawns.at(-1).exit();
  await until(async () => (await t.state()).agents.find((a) => a.id === id)?.state !== "working", { what: "the run to end" });
  assert.equal((await t.post("/projects/active", { slug: "den" })).status, 200);
});

test("with the den active, a run's worktree is under the den's root, as before", async () => {
  const { t } = await boot();
  const started = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.equal(started.status, 201, started.text);
  assert.equal(started.body.agent.project, "den");
  assert.ok(realpathSync(path.join(t.fx.root, started.body.agent.worktree)));
});
