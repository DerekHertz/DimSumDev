import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspaces, checkoutManagedWorktree, isManagedWorktreeClean } from "./workspace.mjs";
import { createTreeArtifacts } from "./tree-artifacts.mjs";

const exec = promisify(execFile);
const git = async (dir, ...args) => String((await exec("git", ["-C", dir, ...args], { encoding: "utf8" })).stdout).trim();
const REF = "fx/01-managed";
const ID = "c-1234567800000000";
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "workspace-managed-")));
  t.after(async () => {
    assert.equal(path.dirname(root), await realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("workspace-managed-"));
    await rm(root, { recursive: true, force: true });
  });
  await git(root, "init");
  await git(root, "config", "user.name", "fixture");
  await git(root, "config", "user.email", "fixture@localhost");
  await git(root, "config", "core.autocrlf", "true");
  await mkdir(path.join(root, "src"));
  const files = {
    ".gitignore": ".claude/worktrees/\n.den/\n.scratch/\n",
    ".gitattributes": "src/a.txt text eol=crlf filter=trap\nsrc/encoded.txt working-tree-encoding=UTF-16LE\n",
    "src/a.txt": "A raw LF\n",
    "src/encoded.txt": "literal UTF8 bytes\n",
    "outside.txt": "outside raw LF\n",
  };
  for (const [name, content] of Object.entries(files)) {
    const filename = path.join(root, ...name.split("/"));
    await writeFile(filename, content);
    const object = await git(root, "hash-object", "-w", "--no-filters", filename);
    await git(root, "update-index", "--add", "--cacheinfo", `100644,${object},${name}`);
  }
  const tree = await git(root, "write-tree");
  const base = await git(root, "commit-tree", tree, "-m", "raw fixture");
  await git(root, "update-ref", "HEAD", base);
  return { root, base, files, workspaces: createWorkspaces(root) };
}

test("managed create/reopen preserve exact raw blobs despite CRLF, explicit EOL, encoding, filters and hooks", async (t) => {
  const fx = await fixture(t);
  const marker = path.join(fx.root, "command-marker");
  const script = path.join(fx.root, ".git", "trap.cjs");
  await writeFile(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed');process.stdin.pipe(process.stdout);`);
  const command = `node "${script.replaceAll("\\", "/")}"`;
  for (const key of ["filter.trap.clean", "filter.trap.smudge", "filter.trap.process", "core.fsmonitor"]) await git(fx.root, "config", key, command);
  await git(fx.root, "config", "filter.trap.required", "true");
  const hook = path.join(fx.root, ".git", "hooks", "post-checkout");
  await writeFile(hook, `#!/bin/sh\n${command}\n`);
  await chmod(hook, 0o755);
  const ws = await fx.workspaces.create({ ref: REF, agentId: ID, base: fx.base, managed: true });
  for (const [name, content] of Object.entries(fx.files)) assert.equal(await readFile(path.join(ws.dir, ...name.split("/")), "utf8"), content);
  assert.equal(await isManagedWorktreeClean({ dir: ws.dir, commit: fx.base }), true);
  assert.equal(await git(ws.dir, "rev-parse", "HEAD"), fx.base);
  await fx.workspaces.reopen({ ref: REF, origin: ID, agentId: "c-8765432100000000", managed: true });
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("raw artifact capture and private materialization do not manufacture out-of-scope CRLF changes", async (t) => {
  const fx = await fixture(t);
  const ws = await fx.workspaces.create({ ref: REF, agentId: ID, base: fx.base, managed: true });
  const artifacts = createTreeArtifacts({ root: fx.root, canCapture: async () => true, canMaterialize: async () => true });
  await writeFile(path.join(ws.dir, "src", "a.txt"), "actual change\n");
  const receipt = await artifacts.capture({ workspace: ws, base: fx.base, scopes: ["src/a.txt"], nodeId: "runner", attemptId: "attempt", operationId: "crlf-capture" });
  assert.deepEqual(receipt.changed, ["src/a.txt"]);
  await writeFile(path.join(ws.dir, "src", "a.txt"), fx.files["src/a.txt"]);
  await artifacts.materialize({ workspace: ws, receipt, expectedHead: fx.base, operationId: "crlf-materialize" });
  assert.equal(await artifacts.isClean({ workspace: ws, candidate: receipt.candidate }), true);
  assert.equal(await readFile(path.join(ws.dir, "src", "a.txt"), "utf8"), "actual change\n");
  assert.equal(await readFile(path.join(ws.dir, "outside.txt"), "utf8"), fx.files["outside.txt"]);
  assert.equal(await readFile(path.join(ws.dir, "src", "encoded.txt"), "utf8"), fx.files["src/encoded.txt"]);
});

test("managed checkout refuses path traversal and target links without writing their destinations", async (t) => {
  const fx = await fixture(t);
  const ws = await fx.workspaces.create({ ref: REF, agentId: ID, base: fx.base, managed: true });
  const outside = path.join(fx.root, "outside-directory");
  await mkdir(outside);
  await writeFile(path.join(outside, "a.txt"), "secret\n");
  await rm(path.join(ws.dir, "src"), { recursive: true });
  await symlink(outside, path.join(ws.dir, "src"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(checkoutManagedWorktree({ dir: ws.dir, commit: fx.base, expectedHead: fx.base }), /symbolic[ -]link/);
  assert.equal(await readFile(path.join(outside, "a.txt"), "utf8"), "secret\n");
});

test("artifact and managed workspace initializers reject a linked metadata store without changing its target", async (t) => {
  const fx = await fixture(t);
  const target = path.join(fx.root, "store-target");
  await mkdir(target);
  await writeFile(path.join(target, "sentinel"), "untouched\n");
  await symlink(target, path.join(fx.root, ".git", "den-tree-artifacts"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(createTreeArtifacts({ root: fx.root }).receipt("store-check"), /canonical plain directory/);
  await assert.rejects(fx.workspaces.create({ ref: REF, agentId: ID, base: fx.base, managed: true }), /canonical plain directory/);
  assert.equal(await readFile(path.join(target, "sentinel"), "utf8"), "untouched\n");
  await assert.rejects(readFile(path.join(target, "empty-hooks")), { code: "ENOENT" });
});

test("explicit recovery rolls forward a journaled first-file interruption and preserves unexpected edits", async (t) => {
  const fx = await fixture(t);
  const ws = await fx.workspaces.create({ ref: REF, agentId: ID, base: fx.base, managed: true });
  const options = { root: fx.root, canCapture: async () => true, canMaterialize: async () => true };
  const artifacts = createTreeArtifacts(options);
  await writeFile(path.join(ws.dir, "src", "a.txt"), "accepted A\n");
  await writeFile(path.join(ws.dir, "src", "encoded.txt"), "accepted B\n");
  const receipt = await artifacts.capture({ workspace: ws, base: fx.base, scopes: ["src"], nodeId: "runner", attemptId: "attempt", operationId: "partial-source" });
  for (const name of ["src/a.txt", "src/encoded.txt"]) await writeFile(path.join(ws.dir, ...name.split("/")), fx.files[name]);
  let writes = 0;
  const interrupted = createTreeArtifacts({ ...options, checkout: (input) => checkoutManagedWorktree({ ...input, checkpoint: async () => { if (++writes === 1) throw new Error("interrupted after first atomic write"); } }) });
  const input = { workspace: ws, receipt, expectedHead: fx.base, operationId: "partial-apply" };
  await assert.rejects(interrupted.materialize(input), /first atomic write/);
  assert.equal((await artifacts.receipt(input.operationId)).status, "intent");
  assert.equal(await git(ws.dir, "rev-parse", "HEAD"), fx.base);
  assert.equal(await readFile(path.join(ws.dir, "src", "a.txt"), "utf8"), "accepted A\n");
  assert.equal(await readFile(path.join(ws.dir, "src", "encoded.txt"), "utf8"), fx.files["src/encoded.txt"]);
  await assert.rejects(artifacts.materialize(input), /uncertain/);
  await assert.rejects(artifacts.reconcileMaterialization({ workspace: ws, operationId: input.operationId }), /explicit host recovery/);
  const recovery = createTreeArtifacts({ ...options, canReconcile: async ({ owner }) => owner === null });
  await writeFile(path.join(ws.dir, "src", "encoded.txt"), "unexpected user edit\n");
  await assert.rejects(recovery.reconcileMaterialization({ workspace: ws, operationId: input.operationId }), /unknown content|old\/new binding/);
  assert.equal(await readFile(path.join(ws.dir, "src", "encoded.txt"), "utf8"), "unexpected user edit\n");
  await writeFile(path.join(ws.dir, "src", "encoded.txt"), fx.files["src/encoded.txt"]);
  await writeFile(path.join(ws.dir, "extra.txt"), "unexpected extra\n");
  await assert.rejects(recovery.reconcileMaterialization({ workspace: ws, operationId: input.operationId }), /unexpected extra path/);
  await rm(path.join(ws.dir, "extra.txt"));
  const result = await recovery.reconcileMaterialization({ workspace: ws, operationId: input.operationId });
  assert.equal(result.head, receipt.candidate);
  assert.equal(await artifacts.isClean({ workspace: ws, candidate: receipt.candidate }), true);
  assert.equal((await artifacts.receipt(input.operationId)).status, "complete");
  assert.equal((await recovery.reconcileMaterialization({ workspace: ws, operationId: input.operationId })).alreadyComplete, true);
});

test("existing plain metadata directories are restricted before managed use", async (t) => {
  const fx = await fixture(t);
  const store = path.join(fx.root, ".git", "den-tree-artifacts");
  const hooks = path.join(store, "empty-hooks");
  await mkdir(hooks, { recursive: true });
  for (const dir of [store, hooks]) await chmod(dir, 0o777);
  assert.equal(await createTreeArtifacts({ root: fx.root }).receipt("mode-check"), null);
  if (process.platform !== "win32") assert.equal((await lstat(store)).mode & 0o777, 0o700);
  await fx.workspaces.create({ ref: REF, agentId: ID, base: fx.base, managed: true });
  if (process.platform !== "win32") for (const dir of [store, hooks]) assert.equal((await lstat(dir)).mode & 0o777, 0o700);
});

test("raw directory-to-file and file-to-directory transitions retain exact bytes and recover idempotently", async (t) => {
  const fx = await fixture(t);
  const ws = await fx.workspaces.create({ ref: REF, agentId: ID, base: fx.base, managed: true });
  await rm(path.join(fx.root, "src"), { recursive: true });
  await writeFile(path.join(fx.root, "src"), "replacement regular file\n");
  const object = await git(fx.root, "hash-object", "-w", "--no-filters", path.join(fx.root, "src"));
  await git(fx.root, "update-index", "--force-remove", "--", "src/a.txt", "src/encoded.txt");
  await git(fx.root, "update-index", "--add", "--cacheinfo", `100644,${object},src`);
  const tree = await git(fx.root, "write-tree");
  const candidate = await git(fx.root, "commit-tree", tree, "-p", fx.base, "-m", "directory becomes file");
  await checkoutManagedWorktree({ dir: ws.dir, commit: candidate, expectedHead: fx.base });
  assert.equal(await readFile(path.join(ws.dir, "src"), "utf8"), "replacement regular file\n");
  assert.equal(await isManagedWorktreeClean({ dir: ws.dir, commit: candidate }), true);
  await checkoutManagedWorktree({ dir: ws.dir, commit: candidate, expectedHead: fx.base, resume: true });
  await checkoutManagedWorktree({ dir: ws.dir, commit: fx.base, expectedHead: candidate });
  assert.equal(await readFile(path.join(ws.dir, "src", "a.txt"), "utf8"), fx.files["src/a.txt"]);
  assert.equal(await isManagedWorktreeClean({ dir: ws.dir, commit: fx.base }), true);
});
