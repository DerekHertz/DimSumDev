// multi-project/04, items 5 and 6: the registry's edge cases and a target's .scratch symlink.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addProject, createProjects, removeProject } from "./projects.mjs";

const sh = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "pipe" });
const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), "proj-")));
function initRepo(dir) {
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "commit", "-q", "--allow-empty", "-m", "init");
  sh(dir, "remote", "add", "origin", dir);
  return dir;
}
const repo = () => initRepo(tmp());
function setup() {
  const control = repo();
  const denState = tmp();
  return { control, denState, projects: createProjects({ control, denState }) };
}
const md = { kind: "markdown" };

test("add refuses a root that is, contains or sits inside the control checkout, with a reason", async () => {
  const { denState, control } = setup();
  const inside = path.join(control, "nested");
  mkdirSync(inside);
  initRepo(inside);
  const parent = initRepo(tmp());
  const nestedControl = path.join(parent, "den");
  mkdirSync(nestedControl);
  for (const [name, dir, ctl] of [["is", control, control], ["inside", inside, control], ["contains", parent, nestedControl]]) {
    const r = await addProject(denState, { slug: `c-${name}`, path: dir, board: md, control: ctl });
    assert.equal(r.ok, false, name);
    assert.match(r.reason, /control checkout/, name);
  }
});

test("a registry row whose root now sits inside the control checkout is not served by get or activate", async () => {
  const { denState, control, projects } = setup();
  assert.deepEqual(await addProject(denState, { slug: "acme", path: repo(), board: md, control }), { ok: true });
  const file = path.join(denState, "projects.json");
  const reg = JSON.parse(readFileSync(file, "utf8"));
  reg.acme.path = control;
  writeFileSync(file, JSON.stringify(reg));
  assert.equal(await projects.get("acme"), null);
  assert.match((await projects.activate("acme", { runs: [] })).reason, /control checkout/);
});

test("slugs like constructor and __proto__ are refused, and a lookup of one finds no project", async () => {
  const { denState, control, projects } = setup();
  const p = repo();
  for (const slug of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal((await addProject(denState, { slug, path: p, board: md, control })).ok, false, slug);
  }
  assert.equal(await projects.get("constructor"), null);
  assert.deepEqual(await projects.activate("constructor", { runs: [] }), { refused: true, reason: '"constructor" is not onboarded', blocking: [] });
  assert.deepEqual(await removeProject(denState, "constructor"), { ok: false, reason: '"constructor" is not onboarded' });
  assert.equal(existsSync(path.join(denState, "projects.json")), false, "nothing was written");
});

test("a corrupt registry is reported and left as it was, not treated as empty and rewritten", async () => {
  const { denState, control } = setup();
  const file = path.join(denState, "projects.json");
  for (const bad of ["{not json", "[1,2]", "null"]) {
    writeFileSync(file, bad);
    const added = await addProject(denState, { slug: "acme", path: repo(), board: md, control });
    assert.equal(added.ok, false, bad);
    assert.match(added.reason, /registry/, bad);
    const removed = await removeProject(denState, "acme");
    assert.equal(removed.ok, false, bad);
    assert.match(removed.reason, /registry/, bad);
    assert.equal(readFileSync(file, "utf8"), bad, "the file is untouched");
  }
});

test("two adds at once both land: the registry is locked for the read-modify-write", async () => {
  const { denState, control } = setup();
  const slugs = ["a1", "a2", "a3", "a4"];
  const results = await Promise.all(slugs.map((slug) => addProject(denState, { slug, path: repo(), board: md, control })));
  assert.deepEqual(results, slugs.map(() => ({ ok: true })));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(denState, "projects.json"), "utf8"))).sort(), slugs);
  assert.equal(existsSync(path.join(denState, "projects.json.lock")), false, "the lock is released");
});

test("a lock left by a dead process does not block add", async () => {
  const { denState, control } = setup();
  writeFileSync(path.join(denState, "projects.json.lock"), "2147483646\n");
  assert.deepEqual(await addProject(denState, { slug: "acme", path: repo(), board: md, control }), { ok: true });
});

test("a project whose .scratch is a symlink is refused at add, get and activate", async () => {
  const { denState, control, projects } = setup();
  const outside = tmp();
  const p = repo();
  symlinkSync(outside, path.join(p, ".scratch"));
  const r = await addProject(denState, { slug: "acme", path: p, board: md, control });
  assert.equal(r.ok, false);
  assert.match(r.reason, /\.scratch.*symlink/);
  const q = repo();
  assert.deepEqual(await addProject(denState, { slug: "beta", path: q, board: md, control }), { ok: true });
  symlinkSync(outside, path.join(q, ".scratch"));
  assert.equal(await projects.get("beta"), null);
  assert.match((await projects.activate("beta", { runs: [] })).reason, /\.scratch.*symlink/);
});
