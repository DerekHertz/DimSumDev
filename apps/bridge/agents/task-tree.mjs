// Structural task bounds are independent of process-slot and resource admission.
// This index holds only bridge-created nodes; its journal is evidence, never replayed authority.
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export const TREE_FANOUT = 4;
export const TREE_DEPTH = 2;
export const TREE_MANAGERS = Object.freeze(["product", "architect", "designer", "developer", "code-reviewer", "qa", "security", "release-manager", "sre", "technical-writer", "herald"]);
export const TREE_TASK_BYTES = 8192;
const id = (prefix) => `${prefix}-${randomBytes(8).toString("hex")}`;

export function createTaskTrees(root) {
  const trees = new Map();
  const nodes = new Map();
  const historical = new Map(); // display/evidence only: never used for admission or capabilities
  const dir = path.join(root, ".scratch", "_run");
  let chain = Promise.resolve();
  const ready = (async () => {
    const text = await readFile(path.join(dir, "task-trees.jsonl"), "utf8").catch((err) => { if (err.code === "ENOENT") return ""; throw err; });
    for (const line of text.split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event.event === "proposed") {
          const tree = event.tree;
          if (!tree || !/^t-[0-9a-f]{16}$/.test(tree.id) || !Array.isArray(tree.nodes) || tree.nodes.length > 21 || JSON.stringify(tree).length > 1_000_000 || !tree.nodes.every((node) => /^c-[0-9a-f]{16}$/.test(node.id) && [0, 1, 2].includes(node.depth))) continue;
          historical.set(tree.id, { ...tree, closed: true, recordOnly: true, nodes: tree.nodes.map((node) => ({ ...node, state: "record-only", historicalState: node.state })) });
        } else if (event.event === "approved" && historical.has(event.revision)) historical.get(event.revision).approved = true;
        else if (event.event === "ended" && historical.has(event.treeId)) {
          const node = historical.get(event.treeId).nodes.find((entry) => entry.id === event.nodeId);
          if (node && ["done", "failed", "terminated"].includes(event.state)) { node.historicalState = event.state; node.candidate = /^[0-9a-f]{40,64}$/.test(event.candidate ?? "") ? event.candidate : null; }
        }
      } catch { /* torn/foreign records never become execution authority */ }
    }
  })();
  const journal = (event) => {
    const run = chain.then(async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await appendFile(path.join(dir, "task-trees.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
    });
    chain = run.catch(() => {});
    return run;
  };
  const describe = (node) => ({ treeId: node.treeId, nodeId: node.id, parentId: node.parentId, depth: node.depth, owner: node.owner, rootRef: node.rootRef, epoch: node.epoch });
  return {
    journal,
    ready,
    describe,
    node: (nodeId) => nodes.get(nodeId),
    root({ ref, project, owner, epoch, runtime, scopes }) {
      for (const tree of trees.values()) {
        if (tree.project !== project || tree.ref !== ref || tree.closed) continue;
        if (tree.approved) throw new Error("this task already has an approved tree");
        tree.closed = true;
        tree.superseded = true;
        for (const previous of nodes.values()) if (previous.treeId === tree.id) previous.cancelled = true;
      }
      const treeId = id("t");
      const node = { id: id("c"), treeId, parentId: null, rootRef: ref, ref, project, owner, epoch, runtime, scopes, role: "orchestrator", depth: 0, children: [], state: "planned", cancelled: false };
      nodes.set(node.id, node);
      trees.set(treeId, { id: treeId, revision: treeId, ref, project, rootId: node.id, closed: false, approved: false });
      return node;
    },
    child(parent, { role, task, scopes, planned = false, contract }) {
      const tree = trees.get(parent.treeId);
      if (!tree || tree.closed || parent.cancelled || (planned ? tree.approved : parent.state !== "working")) throw new Error("the parent task is no longer live");
      if (parent.depth >= TREE_DEPTH) throw new Error("runners start no agents");
      if (parent.children.length >= TREE_FANOUT) throw new Error("the parent already has four children");
      if (parent.depth === 0 ? !TREE_MANAGERS.includes(role) : role !== "runner") throw new Error(parent.depth === 0 ? "an owner delegates only to role managers" : "a manager delegates only to runners");
      const nodeId = id("c");
      const feature = parent.rootRef.split("/")[0];
      const node = { ...parent, id: nodeId, parentId: parent.id, ref: `${feature}/00-tree-${nodeId.slice(2)}`, role, task, contract, scopes, depth: parent.depth + 1, children: [], state: planned ? "planned" : "pending", cancelled: false, agent: undefined };
      nodes.set(node.id, node);
      parent.children.push(node.id);
      return node;
    },
    tree: (treeId) => trees.get(treeId),
    approved(node) { const tree = trees.get(node.treeId); return tree?.approved === true && !tree.closed && !tree.superseded; },
    approve(treeId) {
      const tree = trees.get(treeId);
      if (!tree || tree.closed || tree.superseded || tree.approved) throw new Error("the tree revision is absent, superseded or already started");
      const unfinished = [...nodes.values()].filter((node) => { const owner = trees.get(node.treeId); return owner?.approved && !owner.closed && ["planned", "pending", "working"].includes(node.state); }).length;
      const additional = [...nodes.values()].filter((node) => node.treeId === treeId).length;
      if (unfinished + additional > 21) throw new Error("the global budget of twenty-one unfinished admitted nodes is full");
      tree.approved = true;
      nodes.get(tree.rootId).state = "pending";
      return nodes.get(tree.rootId);
    },
    // Before a process was attempted, a refused reservation consumes no structural slot.
    abort(node) {
      const parent = nodes.get(node.parentId);
      if (parent) parent.children = parent.children.filter((child) => child !== node.id);
      else {
        trees.delete(node.treeId);
        for (const [key, child] of nodes) if (child.treeId === node.treeId) nodes.delete(key);
      }
      nodes.delete(node.id);
    },
    descendants(node) {
      const found = [];
      const visit = (parent) => {
        for (const childId of parent.children) {
          const child = nodes.get(childId);
          if (child) { found.push(child); visit(child); }
        }
      };
      visit(node);
      return found;
    },
    end(node, state) {
      node.state = state;
      if (node.depth === 0 && trees.has(node.treeId)) trees.get(node.treeId).closed = true;
    },
    snapshot() {
      return [...historical.values()].map((tree) => structuredClone(tree)).concat([...trees.values()].map((tree) => ({ ...tree, nodes: [...nodes.values()].filter((node) => node.treeId === tree.id).map((node) => ({ ...describe(node), id: node.id, key: node.key ?? "owner", ref: node.ref, role: node.role, runtime: node.runtime, model: node.model, effort: node.effort, contract: node.contract ? structuredClone(node.contract) : null, state: node.state, scopes: node.scopes.slice(), children: node.children.slice() })) })));
    },
  };
}
