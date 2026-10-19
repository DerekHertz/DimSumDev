// codex-residents/05: the one admission transaction, ownership and the runtime allowlist.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAdmission } from "./admission.mjs";

let root;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "adm-"));
  await mkdir(path.join(root, "src", "deep"), { recursive: true });
  await mkdir(path.join(root, ".claude"), { recursive: true });
  await mkdir(path.join(root, "apps", "bridge", "agents"), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));
const open = () => createAdmission({ root });
const ask = (a, extra = {}) => a.admit({ ref: "f/01-x", project: "den", runtime: "claude", entry: "start", scopes: ["src"], ...extra });

describe("single attempt per identified work", () => {
  test("concurrent starts from every entry admit exactly one", async () => {
    const a = open();
    const entries = ["dispatch", "start", "direct", "delivery", "follow-up", "retry", "coordinator", "router"];
    const results = await Promise.all(entries.map((entry) => ask(a, { entry })));
    assert.equal(results.filter((r) => r.ok).length, 1);
    for (const r of results.filter((x) => !x.ok)) assert.equal(r.status, 409);
  });
  test("settling the attempt lets the next one in", async () => {
    const a = open();
    const first = await ask(a);
    assert.equal((await ask(a)).ok, false);
    await a.settle(first.intent.id, "ended");
    assert.equal((await ask(a)).ok, true);
  });
  test("different tickets do not block each other", async () => {
    const a = open();
    const both = await Promise.all([ask(a), ask(a, { ref: "f/02-y" })]);
    assert.deepEqual(both.map((r) => r.ok), [true, true]);
  });
});

describe("crash recovery", () => {
  test("an intent with no settlement is uncertain after a restart and blocks a respawn", async () => {
    const a = open();
    const first = await ask(a);
    const b = open();
    await b.ready;
    const again = await ask(b);
    assert.equal(again.ok, false);
    assert.match(again.error, /unconfirmed/);
    assert.deepEqual(b.uncertain().map((u) => u.id), [first.intent.id]);
  });
  test("an explicit reconciliation clears it; a settled one never blocks", async () => {
    const a = open();
    const first = await ask(a);
    const done = await ask(a, { ref: "f/02-y" });
    await a.settle(done.intent.id, "ended");
    const b = open();
    await b.ready;
    assert.deepEqual(b.uncertain().map((u) => u.id), [first.intent.id]);
    await b.reconcile(first.intent.id, "never-started");
    assert.equal((await ask(b)).ok, true);
  });
  test("a torn journal line is ignored", async () => {
    const a = open();
    await ask(a);
    await a.ready;
    const file = path.join(root, ".scratch", "_run", "admission.jsonl");
    await writeFile(file, (await readFile(file, "utf8")) + '{"event":"intent","id":');
    const b = open();
    await b.ready;
    assert.equal(b.uncertain().length, 1);
  });
});

describe("ownership", () => {
  test("a ticket with no record belongs to Bao, as a legacy default", async () => {
    const a = open();
    assert.deepEqual(a.ownerOf("f/01-x"), { owner: "bao", epoch: 0, legacy: true, root: "f/01-x" });
  });
  test("approval records the user's choice and persists it", async () => {
    const a = open();
    assert.equal((await a.approve("f/01-x", { owner: "jiao" })).ok, true);
    const b = open();
    await b.ready;
    assert.equal(b.ownerOf("f/01-x").owner, "jiao");
    assert.equal((await b.approve("f/01-x", { owner: "bao" })).ok, false);
    assert.equal((await b.approve("f/02-y", { owner: "nobody" })).ok, false);
  });
  test("an approved descendant follows its parent's owner", async () => {
    const a = open();
    await a.approve("f/01-x", { owner: "jiao" });
    await a.approve("f/01-x/child", { owner: "jiao", parent: "f/01-x" });
    assert.equal(a.ownerOf("f/01-x/child").owner, "jiao");
    assert.equal(a.ownerOf("f/01-x/child").root, "f/01-x");
  });
  test("a capability covers owned tickets and approved descendants only", async () => {
    const a = open();
    await a.approve("f/01-x", { owner: "jiao" });
    await a.approve("f/01-x/child", { owner: "jiao", parent: "f/01-x" });
    await a.approve("f/02-y", { owner: "bao" });
    const cap = a.capability("jiao", "f/01-x");
    assert.equal((await ask(a, { ref: "f/01-x/child", capability: cap })).ok, true);
    assert.equal((await ask(a, { ref: "f/02-y", capability: cap })).status, 403);
    assert.equal((await ask(a, { ref: "f/09-unapproved", capability: cap })).status, 403);
  });
  test("a capability goes stale when ownership transfers", async () => {
    const a = open();
    await a.approve("f/01-x", { owner: "jiao" });
    const cap = a.capability("jiao", "f/01-x");
    assert.equal((await a.transfer("f/01-x", "bao")).ok, true);
    const r = await ask(a, { capability: cap });
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal((await ask(a, { capability: a.capability("bao", "f/01-x") })).ok, true);
  });
  test("a transfer waits for the attempt to end and for reconciliation", async () => {
    const a = open();
    await a.approve("f/01-x", { owner: "jiao" });
    const first = await ask(a);
    assert.equal((await a.transfer("f/01-x", "bao")).status, 409);
    await a.settle(first.intent.id, "ended");
    const b = open();
    await b.ready;
    assert.equal((await b.transfer("f/01-x", "bao")).ok, true);
    const c = open();
    await c.ready;
    assert.equal(c.ownerOf("f/01-x").owner, "bao");
    const stuck = await ask(c, { capability: c.capability("bao", "f/01-x") });
    const d = open();
    await d.ready;
    assert.equal((await d.transfer("f/01-x", "jiao")).status, 409, JSON.stringify(stuck));
  });
});

describe("runtime allowlist", () => {
  test("defaults to both, persists, and rejects unknown values", async () => {
    const a = open();
    assert.equal(a.allowlist(), "both");
    assert.equal((await a.setAllowlist("everything")).ok, false);
    assert.equal((await a.setAllowlist("codex")).ok, true);
    const b = open();
    await b.ready;
    assert.equal(b.allowlist(), "codex");
  });
  test("every entry is checked; a disallowed start pauses with a reason and records nothing", async () => {
    const a = open();
    await a.setAllowlist("codex");
    for (const entry of ["dispatch", "start", "direct", "delivery", "follow-up", "retry"]) {
      const r = await ask(a, { entry });
      assert.equal(r.ok, false);
      assert.equal(r.paused, true);
      assert.match(r.error, /claude.*not allowed/i);
    }
    assert.equal((await ask(a, { runtime: "codex" })).ok, true);
  });
  test("a change governs new admissions only: an active attempt is untouched", async () => {
    const a = open();
    const first = await ask(a);
    await a.setAllowlist("codex");
    assert.equal(a.active().length, 1);
    await a.settle(first.intent.id, "ended");
    assert.equal(a.active().length, 0);
  });
  test("the runtime of approved work cannot silently change", async () => {
    const a = open();
    const first = await ask(a, { runtime: "claude" });
    await a.settle(first.intent.id, "ended");
    const swapped = await ask(a, { runtime: "codex" });
    assert.equal(swapped.ok, false);
    assert.equal(swapped.status, 409);
    assert.equal((await a.changeRuntime("f/01-x", "codex")).ok, true);
    assert.equal((await ask(a, { runtime: "codex" })).ok, true);
  });
});

describe("file scopes", () => {
  test("unknown or empty scope is refused", async () => {
    const a = open();
    for (const scopes of [undefined, [], [""], [42]]) assert.equal((await ask(a, { scopes })).status, 400);
  });
  test("escapes, absolute paths and governed paths are refused", async () => {
    const a = open();
    for (const s of ["../outside", "/etc", ".claude", ".claude/agents", ".git/hooks", "apps/bridge/agents/ceilings.json", ".github/workflows/ci.yml"]) {
      assert.equal((await ask(a, { scopes: [s] })).ok, false, s);
    }
  });
  test("a directory that contains a governed path is refused (ancestry)", async () => {
    const a = open();
    for (const s of [".", "apps/bridge/agents", "apps"]) assert.equal((await ask(a, { scopes: [s] })).ok, false, s);
    assert.equal((await ask(a, { scopes: ["src/deep"] })).ok, true);
  });
  test("a symlink out of the root or into a governed path is refused", async () => {
    const a = open();
    const outside = await mkdtemp(path.join(tmpdir(), "adm-out-"));
    try {
      await symlink(outside, path.join(root, "src", "out"));
      await symlink(path.join(root, ".claude"), path.join(root, "src", "gov"));
      assert.equal((await ask(a, { scopes: ["src/out/file.txt"] })).ok, false);
      assert.equal((await ask(a, { scopes: ["src/gov/x"] })).ok, false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
  test("returned changes outside the scope, governed or through a symlink are named", async () => {
    const a = open();
    await symlink(path.join(root, ".claude"), path.join(root, "src", "gov"));
    const bad = await a.checkReturned({ scopes: ["src"], changed: ["src/a.js", "other/b.js", ".claude/settings.json", "src/gov/x", "../up"] });
    assert.deepEqual(bad.map((b) => b.path), ["other/b.js", ".claude/settings.json", "src/gov/x", "../up"]);
    assert.deepEqual(await a.checkReturned({ scopes: ["src"], changed: ["src/a.js", "src/deep/c.js"] }), []);
  });
});
