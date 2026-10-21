import { test } from "node:test";
import assert from "node:assert/strict";
import { fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { canonicalWriteScopes, prepareWriteScope, scopedWriteBindArgs } from "./scoped-writes.mjs";
import { buildScopeArgv, createResourceLauncher, LIMITS } from "./resource-group.mjs";
import { treePrivateDirectories } from "./claude-runtime.mjs";

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "den-scoped-writes-"));
  const worktree = path.join(root, "worktree");
  mkdirSync(path.join(worktree, "src"), { recursive: true });
  const approved = path.join(worktree, "src", "approved.mjs");
  const outside = path.join(worktree, "outside.mjs");
  writeFileSync(approved, "approved-before");
  writeFileSync(outside, "outside-before");
  return { root, worktree, approved, outside, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

test("scoped writes reject worktree roots, missing paths, protected state and hard-linked scope files", () => {
  const f = fixture();
  try {
    for (const name of [".git", ".claude", ".codex", ".agents", ".scratch", ".den", ".github"]) {
      mkdirSync(path.join(f.worktree, name));
      assert.throws(() => canonicalWriteScopes({ worktree: f.worktree, paths: [path.join(f.worktree, name)] }), /protected/);
    }
    assert.throws(() => canonicalWriteScopes({ worktree: f.worktree, paths: [f.worktree] }), /strictly inside/);
    assert.throws(() => canonicalWriteScopes({ worktree: f.worktree, paths: [path.join(f.worktree, "missing.mjs")] }), /must exist/);
    assert.throws(() => canonicalWriteScopes({ worktree: f.worktree, paths: [f.root] }), /strictly inside/);
    const linked = path.join(f.worktree, "src", "hardlink.mjs");
    linkSync(f.outside, linked);
    assert.throws(() => canonicalWriteScopes({ worktree: f.worktree, paths: [linked] }), /hard link/);
    assert.throws(() => canonicalWriteScopes({ worktree: f.worktree, paths: [path.join(f.worktree, "src")] }), /hard link/);
  } finally { f.cleanup(); }
});

test("scoped mount capabilities pin opened source inodes and do not reopen replacement paths", () => {
  const f = fixture();
  let scope;
  try {
    scope = prepareWriteScope({ worktree: f.worktree, paths: [f.approved] });
    const original = fstatSync(scope.stdio[1]);
    const saved = path.join(f.worktree, "src", "original.mjs");
    renameSync(f.approved, saved);
    writeFileSync(f.approved, "replacement");
    assert.equal(fstatSync(scope.stdio[1]).ino, original.ino);
    assert.notEqual(lstatSync(f.approved).ino, original.ino);
    assert.deepEqual(scopedWriteBindArgs(scope), ["--ro-bind-fd", "4", f.worktree, "--bind-fd", "5", f.approved]);
    assert.throws(() => scope.binds.push({ descriptor: 6, destination: f.outside }), /extensible|read only|object/);
    const argv = buildScopeArgv({ unit: "den-run-scoped-proof.scope", slice: "den-agents-codex-task2", limit: LIMITS.classes.worker, fileBytes: 4096 * 1024 * 1024, bin: "node", args: ["proof.mjs"], writeScope: scope, cwd: "/scratch" });
    assert.ok(argv.indexOf("--ro-bind-fd") < argv.indexOf("--bind-fd"));
    assert.equal(argv[argv.indexOf("--chdir") + 1], "/scratch", "re-enter the cwd after mounts instead of retaining an unwrapped cwd inode");
    assert.throws(() => scopedWriteBindArgs({ binds: scope.binds }), /capability/);
    scope.close();
    assert.throws(() => scopedWriteBindArgs(scope), /closed/);
  } finally { scope?.close(); f.cleanup(); }
});

test("scoped writes refuse symlinked scopes and symlinks inside a writable directory", (t) => {
  if (process.platform !== "linux") return t.skip("Linux symlink and physical mount proof runs in the explicitly selected task slice");
  const f = fixture();
  try {
    const alias = path.join(f.worktree, "src", "alias.mjs");
    symlinkSync(f.outside, alias);
    assert.throws(() => canonicalWriteScopes({ worktree: f.worktree, paths: [alias] }), /symbolic link/);
    assert.throws(() => canonicalWriteScopes({ worktree: f.worktree, paths: [path.join(f.worktree, "src")] }), /symbolic link/);
  } finally { f.cleanup(); }
});

test("the production resource launcher confines candidate-worktree writes, symlinks, hard links and proc aliases", async (t) => {
  if (process.platform !== "linux" || process.env.DEN_SCOPED_TEST_SLICE !== "den-agents-codex-task2") return t.skip("set DEN_SCOPED_TEST_SLICE=den-agents-codex-task2 in the authorized Linux task environment");
  const f = fixture();
  const launcher = createResourceLauncher({ env: process.env, slice: process.env.DEN_SCOPED_TEST_SLICE });
  let launched;
  try {
    const additions = path.join(f.worktree, "additions");
    const scratch = path.join(f.root, "scratch");
    const mainGit = path.join(f.root, "common.git");
    mkdirSync(additions);
    mkdirSync(scratch);
    mkdirSync(mainGit);
    assert.equal(lstatSync(mainGit).isDirectory(), true);
    const privateDirs = treePrivateDirectories(mainGit);
    const receipt = path.join(privateDirs[0], "receipt.json");
    assert.throws(() => lstatSync(receipt), /ENOENT/, "the first launch prepares protection before its first receipt exists");
    const script = `const fs=require('node:fs');const path=require('node:path');const [approved,outside,additions,receipt]=process.argv.slice(1);const errors=[];fs.writeFileSync(approved,'approved-after');for(const target of [outside,'/proc/self/root'+outside])try{fs.writeFileSync(target,'ESCAPED');errors.push('outside-write')}catch{};fs.writeFileSync(path.join(additions,'new.mjs'),'new-file');fs.symlinkSync(outside,path.join(additions,'alias'));try{fs.writeFileSync(path.join(additions,'alias'),'ESCAPED');errors.push('symlink-write')}catch{};try{fs.linkSync(outside,path.join(additions,'hardlink'));errors.push('hardlink-created')}catch{};for(let n=4;n<8;n++)try{const target=fs.readlinkSync('/proc/self/fd/'+n);if([path.dirname(outside),approved,additions].includes(target))errors.push('source-fd-leaked')}catch{};for(const target of [receipt,'/proc/self/root'+receipt]){try{fs.readFileSync(target);errors.push('receipt-read')}catch{};try{fs.writeFileSync(target,'FORGED');errors.push('receipt-write')}catch{}}if(errors.length){console.error(errors.join(','));process.exitCode=2}else console.log('scoped-write-proof: pass');`;
    launched = await launcher.launch({ slotClass: "worker", id: `task2-scoped-${process.pid}-${randomBytes(4).toString("hex")}`, bin: process.execPath, args: ["-e", script, f.approved, f.outside, additions, receipt], cwd: scratch, env: { PATH: process.env.PATH, HOME: process.env.HOME }, writeScope: { worktree: f.worktree, paths: [f.approved, additions] }, privateDirs });
    writeFileSync(receipt, "BRIDGE-OWNED", { mode: 0o600 });
    const { child } = launched;
    child.stdin.on("error", () => {});
    child.stdin.end();
    let out = "";
    let error = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { error += chunk; });
    const code = await new Promise((resolve, reject) => {
      const bound = setTimeout(() => { launched.group.kill(); reject(new Error("scoped write proof exceeded 15 seconds")); }, 15_000);
      child.once("exit", (status) => { clearTimeout(bound); resolve(status); });
    });
    assert.equal(code, 0, error);
    assert.match(out, /scoped-write-proof: pass/);
    assert.equal(readFileSync(f.approved, "utf8"), "approved-after");
    assert.equal(readFileSync(f.outside, "utf8"), "outside-before");
    assert.equal(readFileSync(path.join(additions, "new.mjs"), "utf8"), "new-file");
    assert.equal(readFileSync(receipt, "utf8"), "BRIDGE-OWNED");
  } finally {
    launched?.group.kill();
    await launched?.group.settled(2000);
    f.cleanup();
  }
});
