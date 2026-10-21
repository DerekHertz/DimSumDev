import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTaskTrees } from "./task-tree.mjs";
import { freshWorkflow } from "./task-tree-workflow.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tree-budget-"));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.match(path.basename(root), /^tree-budget-/);
    await rm(root, { recursive: true, force: true });
  });
  const trees = createTaskTrees(root);
  await trees.ready;
  const owner = (number) => trees.root({ ref: `budget/${number}-task`, project: "den", owner: "bao", epoch: 1, runtime: "claude", scopes: ["src"] });
  const child = (parent, role) => trees.child(parent, { role, task: "Bounded approved work", scopes: ["src"], planned: true });
  return { trees, owner, child };
}

test("waiting, paused and review-queued logical tasks retain the global budget after process exit", async (t) => {
  const { trees, owner, child } = await fixture(t);
  const root = owner(1);
  const nodes = [root];
  for (let manager = 0; manager < 4; manager++) {
    const parent = child(root, "developer");
    nodes.push(parent);
    for (let runner = 0; runner < 4; runner++) nodes.push(child(parent, "runner"));
  }
  assert.equal(nodes.length, 21);
  for (const [index, node] of nodes.entries()) {
    node.workflow = freshWorkflow();
    node.workflow.status = ["waiting", "review-queued", "paused"][index % 3];
    node.state = "done"; // The process ended; the logical task has not been accepted.
  }
  trees.approve(root.treeId);
  const next = owner(2);
  child(next, "developer");
  assert.throws(() => trees.approve(next.treeId), /twenty-one unfinished/);
  assert.equal(trees.tree(next.treeId).approved, false);
  nodes.at(-1).workflow.status = "accepted";
  assert.throws(() => trees.approve(next.treeId), /twenty-one unfinished/);
  nodes.at(-2).workflow.status = "skipped";
  assert.equal(trees.approve(next.treeId).id, next.id);
});

test("unused proposals reserve no execution capacity, while each approved owner consumes one logical slot", async (t) => {
  const { trees, owner } = await fixture(t);
  const proposals = Array.from({ length: 22 }, (_, index) => owner(index + 1));
  for (const node of proposals) node.workflow = freshWorkflow();
  for (const node of proposals.slice(0, 21)) assert.equal(trees.approve(node.treeId).id, node.id);
  assert.throws(() => trees.approve(proposals.at(-1).treeId), /twenty-one unfinished/);
});
