import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTreeArtifacts } from "./tree-artifacts.mjs";
import { createWorkspaces } from "./workspace.mjs";

const exec = promisify(execFile);
const git = async (dir, ...args) => String((await exec("git", ["-C", dir, ...args], { encoding: "utf8" })).stdout).trim();
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "tree-artifacts-")));
  t.after(async () => {
    const temporary = await realpath(os.tmpdir());
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith("tree-artifacts-"));
    await rm(root, { recursive: true, force: true });
  });
  await git(root, "init", ...(options.sha256 ? ["--object-format=sha256"] : []));
  await git(root, "config", "user.name", "fixture");
  await git(root, "config", "user.email", "fixture@localhost");
  await git(root, "config", "core.autocrlf", "false");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, ".gitignore"), ".claude/worktrees/\n.scratch/\n.den/\n");
  for (const name of ["a", "b", "delete"]) await writeFile(path.join(root, "src", `${name}.txt`), name === "a" && options.initialA ? options.initialA : `${name} base\n`);
  if (options.attributes) await writeFile(path.join(root, ".gitattributes"), options.attributes);
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "fixture base");
  const base = await git(root, "rev-parse", "HEAD");
  let number = 0;
  // workspaceNames takes the first eight random digits, so vary those.
  const distinctWorkspace = async () => createWorkspaces(root).create({ ref: "fx/01-artifact", agentId: `c-${(++number).toString(16).padStart(8, "0")}00000000`, base });
  const artifacts = (more = {}) => createTreeArtifacts({ root, canCapture: async () => true, ...more });
  const input = (ws, operationId, nodeId = operationId) => ({ workspace: ws, base, scopes: ["src"], nodeId, attemptId: "attempt-1", operationId });
  return { root, base, workspace: distinctWorkspace, artifacts, input };
}

test("capture snapshots modified, new, deleted and binary files without changing HEAD, either index or refs", async (t) => {
  const fx = await fixture(t);
  const ws = await fx.workspace();
  const rootIndex = await readFile(path.join(fx.root, ".git", "index"));
  const indexPath = await git(ws.dir, "rev-parse", "--path-format=absolute", "--git-path", "index");
  const index = await readFile(indexPath);
  const refs = await git(fx.root, "show-ref");
  await writeFile(path.join(ws.dir, "src", "a.txt"), "changed\n");
  await writeFile(path.join(ws.dir, "src", "new.txt"), "new\n");
  await rename(path.join(ws.dir, "src", "b.txt"), path.join(ws.dir, "src", "renamed.txt"));
  const binary = Buffer.from([0, 255, 0, 42]);
  await writeFile(path.join(ws.dir, "src", "binary.bin"), binary);
  await rm(path.join(ws.dir, "src", "delete.txt"));
  const receipt = await fx.artifacts().capture(fx.input(ws, "capture-code"));
  assert.deepEqual(receipt.changed, ["src/a.txt", "src/b.txt", "src/binary.bin", "src/delete.txt", "src/new.txt", "src/renamed.txt"]);
  assert.equal(await git(fx.root, "show", `${receipt.candidate}:src/a.txt`), "changed");
  const blob = await exec("git", ["-C", fx.root, "show", `${receipt.candidate}:src/binary.bin`], { encoding: "buffer" });
  assert.deepEqual(blob.stdout, binary);
  await assert.rejects(git(fx.root, "show", `${receipt.candidate}:src/delete.txt`));
  assert.equal(await git(ws.dir, "rev-parse", "HEAD"), fx.base);
  assert.equal(await git(fx.root, "rev-parse", "HEAD"), fx.base);
  assert.deepEqual(await readFile(indexPath), index);
  assert.deepEqual(await readFile(path.join(fx.root, ".git", "index")), rootIndex);
  assert.equal(await git(fx.root, "show-ref"), refs);
});

test("no-change capture uses the base; retries recover the same receipt and changed input cannot reuse its operation ID", async (t) => {
  const fx = await fixture(t);
  const ws = await fx.workspace();
  const input = fx.input(ws, "no-change");
  await assert.rejects(fx.artifacts({ canCapture: async () => false }).capture(input), /resource group is stopped/);
  const receipt = await fx.artifacts().capture(input);
  assert.equal(receipt.candidate, fx.base);
  assert.deepEqual(receipt.changed, []);
  assert.deepEqual(await fx.artifacts().capture(input), receipt);
  await writeFile(path.join(ws.dir, "src", "a.txt"), "later\n");
  await assert.rejects(fx.artifacts().capture(input), /already bound/);
  await assert.rejects(fx.artifacts().validateReceipt({ ...receipt, candidate: "f".repeat(40) }), /differs/);
});

test("capture rejects out-of-scope, governed and symlink paths before accepting artifacts", async (t) => {
  const fx = await fixture(t);
  const ws = await fx.workspace();
  await writeFile(path.join(ws.dir, "outside.txt"), "outside\n");
  await assert.rejects(fx.artifacts().capture(fx.input(ws, "outside")), /outside/);
  await rm(path.join(ws.dir, "outside.txt"));
  await mkdir(path.join(ws.dir, "apps", "bridge", "agents"), { recursive: true });
  await writeFile(path.join(ws.dir, "apps", "bridge", "agents", "ceilings.json"), "governed\n");
  await assert.rejects(fx.artifacts().capture({ ...fx.input(ws, "governed"), scopes: ["apps/bridge/agents"] }), /governance/);
  await rm(path.join(ws.dir, "apps"), { recursive: true });
  const outside = path.join(fx.root, "secret");
  await mkdir(outside);
  await writeFile(path.join(outside, "a.txt"), "secret\n");
  await rm(path.join(ws.dir, "src"), { recursive: true });
  await symlink(outside, path.join(ws.dir, "src"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(fx.artifacts().capture(fx.input(ws, "linked")), /symbolic links/);
  assert.equal(await readFile(path.join(outside, "a.txt"), "utf8"), "secret\n");
  await assert.rejects(fx.artifacts().capture(fx.input({ dir: fx.root }, "main")), /private den worktrees/);
});

test("adoption validates clean exact manager history, including out-of-scope changes later reverted", async (t) => {
  const fx = await fixture(t);
  const ws = await fx.workspace();
  await writeFile(path.join(ws.dir, "src", "a.txt"), "manager\n");
  await git(ws.dir, "add", "src/a.txt");
  await git(ws.dir, "commit", "-qm", "manager change");
  const candidate = await git(ws.dir, "rev-parse", "HEAD");
  const receipt = await fx.artifacts().adoptCandidate({ ...fx.input(ws, "adopt"), candidate });
  assert.equal(receipt.candidate, candidate);
  await writeFile(path.join(ws.dir, "src", "a.txt"), "dirty\n");
  await assert.rejects(fx.artifacts().adoptCandidate({ ...fx.input(ws, "dirty"), candidate }), /clean/);
  const other = await fx.workspace();
  await writeFile(path.join(other.dir, "outside.txt"), "bad\n");
  await git(other.dir, "add", ".");
  await git(other.dir, "commit", "-qm", "outside scope");
  await git(other.dir, "revert", "--no-edit", "HEAD");
  const reverted = await git(other.dir, "rev-parse", "HEAD");
  await assert.rejects(fx.artifacts().adoptCandidate({ ...fx.input(other, "reverted"), candidate: reverted }), /outside/);
});

async function children(fx, descriptions) {
  const artifacts = fx.artifacts();
  const result = [];
  for (const [node, file, content] of descriptions) {
    const ws = await fx.workspace();
    await writeFile(path.join(ws.dir, "src", file), content);
    result.push(await artifacts.capture(fx.input(ws, `capture-${node}`, node)));
  }
  return result;
}

test("stable accepted-child integration stays private; stopped parent materializes once and preserves root", async (t) => {
  const fx = await fixture(t);
  const ws = await fx.workspace();
  const receipts = await children(fx, [["b", "b.txt", "B\n"], ["a", "a.txt", "A\n"]]);
  const accepted = new Set(receipts.map((r) => r.candidate));
  const artifacts = fx.artifacts({ verifyAccepted: async (r) => accepted.has(r.candidate), canMaterialize: async () => true });
  const input = { workspace: ws, base: fx.base, scopes: ["src"], parentId: "manager", attemptId: "manager-attempt", operationId: "integration", children: receipts };
  await assert.rejects(fx.artifacts().integrate(input), /independent acceptance/);
  await assert.rejects(fx.artifacts().integrate({ ...input, children: receipts.map((r) => ({ ...r, accepted: true })) }), /independent acceptance/);
  const receipt = await artifacts.integrate(input);
  assert.deepEqual(receipt.input.children.map((r) => r.nodeId), ["a", "b"]);
  assert.equal(await git(ws.dir, "rev-parse", "HEAD"), fx.base);
  assert.equal(await git(ws.dir, "status", "--porcelain"), "");
  assert.deepEqual(await artifacts.integrate({ ...input, children: [...receipts].reverse() }), receipt);
  await assert.rejects(fx.artifacts().materialize({ workspace: ws, receipt, expectedHead: fx.base, operationId: "not-stopped" }), /stopped/);
  const applied = await artifacts.materialize({ workspace: ws, receipt, expectedHead: fx.base, operationId: "apply" });
  assert.equal(applied.candidate, receipt.candidate);
  assert.equal(await readFile(path.join(ws.dir, "src", "a.txt"), "utf8"), "A\n");
  assert.equal(await readFile(path.join(ws.dir, "src", "b.txt"), "utf8"), "B\n");
  assert.equal(await git(ws.dir, "status", "--porcelain"), "");
  assert.deepEqual(await artifacts.materialize({ workspace: ws, receipt, expectedHead: fx.base, operationId: "apply" }), applied);
  assert.equal(await git(fx.root, "rev-parse", "HEAD"), fx.base);
  assert.equal(await readFile(path.join(fx.root, "src", "a.txt"), "utf8"), "a base\n");
  accepted.delete(receipts[0].candidate);
  await assert.rejects(artifacts.integrate(input), /independent acceptance/);
});

test("conflicting children block without changing the parent; dirty or changed private parents are preserved", async (t) => {
  const fx = await fixture(t);
  const ws = await fx.workspace();
  const receipts = await children(fx, [["a", "a.txt", "A\n"], ["b", "a.txt", "B\n"]]);
  const artifacts = fx.artifacts({ verifyAccepted: async () => true, canMaterialize: async () => true });
  const input = { workspace: ws, base: fx.base, scopes: ["src"], parentId: "manager", attemptId: "attempt", operationId: "conflict", children: receipts };
  await assert.rejects(artifacts.integrate(input), /private integration blocked/);
  assert.equal((await artifacts.receipt("conflict")).status, "blocked");
  await assert.rejects(artifacts.integrate(input), /operation is blocked/);
  assert.equal(await git(ws.dir, "rev-parse", "HEAD"), fx.base);
  assert.equal(await git(ws.dir, "status", "--porcelain"), "");
  const good = await artifacts.integrate({ ...input, operationId: "one-child", children: [receipts[0]] });
  await writeFile(path.join(ws.dir, "src", "b.txt"), "parent dirty\n");
  await assert.rejects(artifacts.materialize({ workspace: ws, receipt: good, expectedHead: fx.base, operationId: "dirty-parent" }), /uncertain or HEAD changed/);
  assert.equal(await readFile(path.join(ws.dir, "src", "b.txt"), "utf8"), "parent dirty\n");
});

test("capture recovers lost commit-tree acknowledgement with the same immutable candidate", async (t) => {
  const fx = await fixture(t);
  const ws = await fx.workspace();
  await writeFile(path.join(ws.dir, "src", "a.txt"), "recovery\n");
  let produced;
  const crashing = fx.artifacts({ exec: async (file, args, options) => {
    const result = await exec(file, args, options);
    if (args.includes("commit-tree")) { produced = result.stdout.trim(); throw new Error("lost acknowledgement"); }
    return result;
  } });
  const input = fx.input(ws, "recover-capture");
  await assert.rejects(crashing.capture(input), /lost acknowledgement/);
  assert.equal((await crashing.receipt(input.operationId)).status, "intent");
  const recovered = await fx.artifacts().capture(input);
  assert.equal(recovered.candidate, produced);
  assert.equal(await git(ws.dir, "rev-parse", "HEAD"), fx.base);
});

test("lost checkout acknowledgement reconciles exact clean private HEAD without another checkout", async (t) => {
  const fx = await fixture(t);
  const ws = await fx.workspace();
  const receipts = await children(fx, [["child", "a.txt", "recover checkout\n"]]);
  const options = { verifyAccepted: async () => true, canMaterialize: async () => true };
  const receipt = await fx.artifacts(options).integrate({ workspace: ws, base: fx.base, scopes: ["src"], parentId: "manager", attemptId: "attempt", operationId: "integrate-recovery", children: receipts });
  let checkouts = 0;
  const crashing = fx.artifacts({ ...options, exec: async (file, args, config) => {
    const result = await exec(file, args, config);
    if (args.includes("update-ref")) { checkouts++; throw new Error("lost checkout acknowledgement"); }
    return result;
  } });
  const input = { workspace: ws, receipt, expectedHead: fx.base, operationId: "apply-recovery" };
  await assert.rejects(crashing.materialize(input), /lost checkout/);
  assert.equal(await git(ws.dir, "rev-parse", "HEAD"), receipt.candidate);
  const recovered = await crashing.materialize(input);
  assert.equal(recovered.status, "complete");
  assert.equal(checkouts, 1);
});

test("capture and materialization cannot run repository-selected clean, smudge or process filters", async (t) => {
  const fx = await fixture(t, { attributes: "src/*.txt filter=trap.with.dots\n" });
  const marker = path.join(fx.root, "filter-marker");
  const script = path.join(fx.root, ".git", "trap.cjs");
  await writeFile(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed');process.stdin.pipe(process.stdout);`);
  const command = `node "${script.replaceAll("\\", "/")}"`;
  const ws = await fx.workspace();
  await git(fx.root, "config", "filter.trap.with.dots.clean", command);
  await git(fx.root, "config", "filter.trap.with.dots.smudge", command);
  await git(fx.root, "config", "filter.trap.with.dots.process", command);
  await git(fx.root, "config", "filter.trap.with.dots.required", "true");
  await writeFile(path.join(ws.dir, "src", "a.txt"), "filter-free\n");
  const artifact = fx.artifacts().capture(fx.input(ws, "filter-capture"));
  const captured = await artifact;
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  // Clear dirty runner bytes without Git filters, then materialize its own receipt.
  await writeFile(path.join(ws.dir, "src", "a.txt"), "a base\n");
  await fx.artifacts({ canMaterialize: async () => true }).materialize({ workspace: ws, receipt: captured, expectedHead: fx.base, operationId: "filter-apply" });
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.equal(await readFile(path.join(ws.dir, "src", "a.txt"), "utf8"), "filter-free\n");
});

test("repository attributes cannot execute configured external merge drivers", async (t) => {
  const fx = await fixture(t, { attributes: "src/a.txt merge=trap.with.dots\n" });
  const marker = path.join(fx.root, "merge-marker");
  const script = path.join(fx.root, ".git", "merge-trap.cjs");
  await writeFile(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
  await git(fx.root, "config", "merge.trap.with.dots.driver", `node "${script.replaceAll("\\", "/")}"`);
  const ws = await fx.workspace();
  const receipts = await children(fx, [["a", "a.txt", "A\n"], ["b", "a.txt", "B\n"]]);
  const artifacts = fx.artifacts({ verifyAccepted: async () => true });
  await assert.rejects(artifacts.integrate({ workspace: ws, base: fx.base, scopes: ["src"], parentId: "manager", attemptId: "attempt", operationId: "merge-trap", children: receipts }), /integration blocked/);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.equal(await git(ws.dir, "rev-parse", "HEAD"), fx.base);
});

test("merge integration disables renormalization and configured filters while merging raw disjoint edits", async (t) => {
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
  const fx = await fixture(t, { attributes: "src/a.txt filter=trap.with.dots\n", initialA: `${lines.join("\n")}\n` });
  const ws = await fx.workspace();
  const left = [...lines], right = [...lines], expected = [...lines];
  left[2] = expected[2] = "accepted left";
  right[25] = expected[25] = "accepted right";
  const receipts = await children(fx, [["a", "a.txt", `${left.join("\n")}\n`], ["b", "a.txt", `${right.join("\n")}\n`]]);
  const marker = path.join(fx.root, "renormalize-marker");
  const script = path.join(fx.root, ".git", "renormalize-trap.cjs");
  await writeFile(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed');process.stdin.pipe(process.stdout);`);
  const command = `node "${script.replaceAll("\\", "/")}"`;
  await git(fx.root, "config", "merge.renormalize", "true");
  for (const suffix of ["clean", "smudge", "process"]) await git(fx.root, "config", `filter.trap.with.dots.${suffix}`, command);
  await git(fx.root, "config", "filter.trap.with.dots.required", "true");
  const artifacts = fx.artifacts({ verifyAccepted: async () => true });
  const receipt = await artifacts.integrate({ workspace: ws, base: fx.base, scopes: ["src"], parentId: "manager", attemptId: "attempt", operationId: "renormalize", children: receipts });
  assert.equal(await git(fx.root, "show", `${receipt.candidate}:src/a.txt`), expected.join("\n"));
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.equal(await git(ws.dir, "rev-parse", "HEAD"), fx.base);
});

test("interrupted partial integration reconstructs identical commits before publishing one receipt", async (t) => {
  const fx = await fixture(t);
  const ws = await fx.workspace();
  const receipts = await children(fx, [["a", "a.txt", "A\n"], ["b", "b.txt", "B\n"]]);
  const committed = [];
  const crashing = fx.artifacts({ verifyAccepted: async () => true, exec: async (file, args, options) => {
    const result = await exec(file, args, options);
    if (args.includes("commit-tree")) {
      committed.push(result.stdout.trim());
      if (committed.length === 2) throw new Error("lost second merge acknowledgement");
    }
    return result;
  } });
  const input = { workspace: ws, base: fx.base, scopes: ["src"], parentId: "manager", attemptId: "attempt", operationId: "partial", children: receipts };
  await assert.rejects(crashing.integrate(input), /interrupted/);
  assert.equal((await crashing.receipt("partial")).status, "intent");
  assert.equal(await git(ws.dir, "rev-parse", "HEAD"), fx.base);
  const result = await fx.artifacts({ verifyAccepted: async () => true }).integrate(input);
  assert.equal(result.candidate, committed[1]);
});

test("orphan workspace leases fail closed and require exact authorized dead-owner reconciliation", async (t) => {
  const fx = await fixture(t);
  const ws = await fx.workspace();
  const artifacts = fx.artifacts({ canMaterialize: async () => true });
  const receipt = await artifacts.capture(fx.input(ws, "lease-candidate"));
  const input = { workspace: ws, receipt, expectedHead: fx.base, operationId: "lease-apply" };
  await artifacts.materialize(input);
  const state = path.join(fx.root, ".git", "den-tree-artifacts");
  const lease = path.join(state, `workspace-${createHash("sha256").update(ws.dir).digest("hex")}.lease`);
  const child = exec(process.execPath, ["-e", ""]);
  const pid = child.child.pid;
  await child;
  await writeFile(lease, JSON.stringify({ workspace: ws.dir, operationId: input.operationId, pid, nonce: "a".repeat(32) }));
  await assert.rejects(artifacts.materialize(input), /materialization lease/);
  await assert.rejects(artifacts.reconcileMaterialization({ workspace: ws, operationId: input.operationId }), /explicit host recovery/);
  const recovery = fx.artifacts({ canReconcile: async () => true, canMaterialize: async () => true });
  await assert.rejects(recovery.reconcileMaterialization({ workspace: ws, operationId: "wrong" }), /does not match/);
  assert.equal((await recovery.reconcileMaterialization({ workspace: ws, operationId: input.operationId })).reconciled, true);
  assert.equal((await recovery.materialize(input)).candidate, fx.base);
});

test("SHA-256 repositories preserve exact candidate IDs", async (t) => {
  const fx = await fixture(t, { sha256: true });
  const ws = await fx.workspace();
  await writeFile(path.join(ws.dir, "src", "new.txt"), "sha256\n");
  const receipt = await fx.artifacts().capture(fx.input(ws, "sha256"));
  assert.equal(receipt.candidate.length, 64);
  assert.equal((await fx.artifacts().validateReceipt(receipt)).candidate, receipt.candidate);
});
