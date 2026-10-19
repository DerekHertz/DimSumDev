// den-mvp/49 security bounce, finding 2 (MEDIUM): delivery is not project-aware yet (its claim, handoffs, push, PR and merge are
// the control checkout's), so Deliver and every delivery run are refused unless the den is the active project.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { addProject } from "../projects.mjs";
import { FEATURE, makeBridge, until } from "../agents/host-test-helpers.mjs";

const REF = `${FEATURE}/08-plain`;
const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const git = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();

async function boot() {
  const denState = realpathSync(mkdtempSync(path.join(tmpdir(), "den-state-")));
  const t = await makeBridge({ denState, gitHost: (root) => ({ mainSha: async () => git(root, "rev-parse", "HEAD") }) });
  cleanups.push(() => t.close());
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "acme-")));
  cleanups.unshift(() => rm(dir, { recursive: true, force: true })); // after the bridge has closed
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", dir);
  mkdirSync(path.join(dir, ".scratch", "pf", "issues"), { recursive: true });
  writeFileSync(path.join(dir, ".scratch", "pf", "issues", "01-first.md"), "# 01: First\n\n**Type:** feature\n\n**Blocked by:** none\n\n**Status:** ready-for-agent\n\n## Comments\n\n");
  git(dir, "add", "-f", ".scratch");
  git(dir, "commit", "-q", "-m", "init");
  assert.deepEqual(await addProject(denState, { slug: "acme", path: dir, board: { kind: "markdown" } }), { ok: true });
  return t;
}

test("POST /deliveries is refused with a clear message while a target project is active, and starts nothing", async () => {
  const t = await boot();
  assert.equal((await t.post("/projects/active", { slug: "acme" })).status, 200);
  const res = await t.post("/deliveries", { ref: REF });
  assert.equal(res.status, 409, res.text);
  assert.match(res.body.error, /Deliver runs on the den project only/);
  assert.equal((await t.state()).deliveries?.length ?? 0, 0);
  assert.equal(t.fake.spawns.length, 0);
});

test("a delivery paused under the den cannot resume into a target project", async () => {
  const t = await boot();
  const res = await t.post("/deliveries", { ref: REF });
  assert.equal(res.status, 201, res.text);
  const first = await until(() => t.fake.spawns[0], { what: "the first step" });
  first.emit({ type: "done", ok: false });
  const paused = await until(async () => { const j = (await t.state()).deliveries?.at(-1); return j?.state === "paused" ? j : null; }, { what: "the job to pause", ms: 5000 });
  assert.equal((await t.post("/projects/active", { slug: "acme" })).status, 200);
  assert.equal((await t.post(`/deliveries/${paused.id}/resume`)).status, 202);
  const again = await until(async () => { const j = (await t.state()).deliveries?.at(-1); return j?.state === "paused" && /Deliver runs on the den project only/.test(j.pause.reason ?? j.pause.message ?? JSON.stringify(j.pause)) ? j : null; }, { what: "the resume to be refused", ms: 5000 });
  assert.equal(again.id, paused.id);
  assert.equal(t.fake.spawns.length, 1, "no second step was spawned in the target");
});
