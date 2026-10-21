import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHost } from "./host.mjs";
import { createFakeRuntime } from "./runtime.mjs";
import { createTaskTrees } from "./task-tree.mjs";
import { makeStateFixture } from "../bridge-fixture.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REF = "fx/02-ready-p0";
const contract = (id, parent = "owner", scopes = [`src/${id}`], role = parent === "owner" ? "developer" : "runner") => ({ id, parent, role, outcome: `Inspect ${id} and return evidence`, inputs: [], scopes, dependencies: [], acceptanceCriteria: ["Return exact evidence and failures"], verificationCommands: [] });
const wait = async (predicate) => {
  const start = Date.now();
  while (!await predicate()) {
    if (Date.now() - start > 5000) assert.fail("tree condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

async function setup(runtime = "claude", config = {}, extraHost = {}) {
  const fx = await makeStateFixture({ git: true });
  for (const dir of [".claude/agents", ".codex/agents"]) {
    await mkdir(path.join(fx.root, dir), { recursive: true });
    await cp(path.join(ROOT, dir), path.join(fx.root, dir), { recursive: true });
  }
  const fake = createFakeRuntime(config);
  fake.capabilities.treeDelegation = true;
  fake.validateModel = async () => true;
  const spawn = fake.spawn.bind(fake);
  fake.spawn = async (args) => {
    const proc = await spawn(args);
    if (runtime === "codex") proc.runtimeSessionId = args.sessionId;
    return proc;
  };
  const options = { root: fx.root, runtimes: { [runtime]: fake }, policy: { killGraceMs: 20, spawnWaitMs: 50 }, bridgeUrl: () => "http://127.0.0.1:4317", checkGate: async () => "ok", ...extraHost };
  const host = createHost(options);
  await host.ready;
  await host.admission.approve(REF, { owner: runtime === "claude" ? "bao" : "jiao" });
  const plan = (nodes = []) => host.planTree({ ref: REF, runtime, scopes: ["src"], nodes });
  const close = async () => { await host.shutdown(); await fx.cleanup(); };
  return { fx, fake, host, options, plan, close };
}

for (const runtime of ["claude", "codex"]) {
  test(`${runtime} executes only approved parent-bound nodes at the configured manager/runner tiers`, { timeout: 15000 }, async () => {
    const t = await setup(runtime);
    try {
      const proposal = await t.plan([contract("manager"), contract("leaf", "manager", ["src/manager/leaf"])]);
      assert.equal(proposal.status, 201, proposal.error);
      assert.equal(t.fake.spawns.length, 0, "a proposal executes nothing");
      const root = proposal.tree.nodes.find((node) => node.key === "owner");
      const manager = proposal.tree.nodes.find((node) => node.key === "manager");
      const leaf = proposal.tree.nodes.find((node) => node.key === "leaf");
      assert.equal((await t.host.delegate(root.id, { nodeId: manager.id })).status, 409, "unapproved revisions cannot execute");
      assert.equal((await t.host.startTree({ revision: proposal.revision })).status, 201);
      assert.equal(t.fake.spawns.length, 1, "approval starts only the owner, not every planned node");
      assert.equal((await t.host.delegate(root.id, { nodeId: leaf.id })).status, 403, "owners cannot skip the manager layer");
      assert.equal((await t.host.delegate(root.id, { nodeId: manager.id })).status, 201);
      assert.equal((await t.host.delegate(manager.id, { nodeId: leaf.id })).status, 201);
      assert.equal(t.fake.spawns.length, 3);
      assert.deepEqual(t.fake.spawns.map((record) => [record.args.model, record.args.effort]), runtime === "claude" ? [["sonnet", "high"], ["sonnet", "high"], ["haiku", "low"]] : [["gpt-6.1-sol", "high"], ["gpt-6.1-sol", "high"], ["gpt-6-luna", "low"]]);
      assert.equal((await t.host.delegate(leaf.id, { nodeId: manager.id })).status, 403, "a leaf cannot start anything");
      assert.equal(t.host.treeResult(root.id, leaf.id).status, 403, "a grandchild's result belongs only to its manager");
      assert.equal(t.host.treeResult(manager.id, leaf.id).result.accepted, false, "raw completion is never accepted verification");
      assert.notEqual(t.fake.spawns[0].args.cwd, t.fake.spawns[1].args.cwd);
      assert.notEqual(t.fake.spawns[1].args.cwd, t.fake.spawns[2].args.cwd);
      assert.equal(t.fake.spawns[2].args.connections, undefined, "a leaf receives no catalog authority");
      assert.equal(t.fake.spawns[2].args.grants, undefined);
      const token = t.fake.spawns[2].args.treeCredential.token;
      assert.equal(t.host.treeAgent(token).id, leaf.id);
      assert.equal(t.host.runAgent(token), null, "tree tokens confer no den authority");
      await t.host.stop(root.id);
      await wait(() => t.fake.spawns.every((record) => record.exited));
      await wait(() => !t.host.busy());
      assert.equal(t.host.treeAgent(token), null);
      assert.equal(t.host.snapshot().find((node) => node.id === leaf.id).followUp, false);
    } finally { await t.close(); }
  });
}

test("complete revisions enforce depth, fanout, scope, role tools and supersession before any spawn", { timeout: 15000 }, async () => {
  const t = await setup();
  try {
    const malformed = [
      Array.from({ length: 5 }, (_, i) => contract(`m${i}`)),
      [contract("m"), contract("r", "m", ["src/m/r"]), contract("too-deep", "r", ["src/m/r/a"])],
      [contract("m", "missing")],
      [contract("cycle1", "cycle2"), contract("cycle2", "cycle1")],
      [contract("m", "owner", ["../escape"])],
      [contract("m", "owner", ["src/m"], "security"), contract("r", "m", ["src/m/r"])],
    ];
    for (const nodes of malformed) assert.ok((await t.plan(nodes)).status >= 400);
    const a = await t.plan([contract("m")]);
    const b = await t.plan([]);
    assert.equal((await t.host.startTree({ revision: a.revision })).status, 409);
    assert.equal((await t.host.startTree({ revision: b.revision })).status, 201);
    assert.equal(t.fake.spawns.length, 1);
    assert.equal((await t.host.start({ ref: "fx/07-bumpable", role: "runner", tree: { parentId: b.tree.rootId } })).status, 400, "legacy/public roles do not gain runner access");
  } finally { await t.close(); }
});

test("a 1→4→16 structure executes sequentially within the unchanged two-worker process budget", { timeout: 30000 }, async () => {
  const t = await setup();
  try {
    const nodes = [];
    for (let i = 0; i < 4; i += 1) {
      nodes.push(contract(`m${i}`));
      for (let j = 0; j < 4; j += 1) nodes.push(contract(`r${i}${j}`, `m${i}`, [`src/m${i}/r${j}`]));
    }
    const proposal = await t.plan(nodes);
    assert.equal(proposal.status, 201, proposal.error);
    assert.equal(proposal.tree.nodes.length, 21);
    assert.equal((await t.host.startTree({ revision: proposal.revision })).status, 201);
    const root = proposal.tree.rootId;
    const m0 = proposal.tree.nodes.find((node) => node.key === "m0");
    const r00 = proposal.tree.nodes.find((node) => node.key === "r00");
    const m1 = proposal.tree.nodes.find((node) => node.key === "m1");
    assert.equal((await t.host.delegate(root, { nodeId: m0.id })).status, 201);
    assert.equal((await t.host.delegate(m0.id, { nodeId: r00.id })).status, 201);
    assert.equal((await t.host.delegate(root, { nodeId: m1.id })).status, 429);
    assert.equal(t.fake.spawns.length, 3, "no unvalidated concurrency profile is enabled");
    const state = t.host.trees()[0].nodes.find((node) => node.id === m1.id);
    assert.equal(state.state, "planned", "capacity refusal does not create an attempt");
    const finish = async (node, parent) => {
      const record = t.fake.spawns.find((run) => run.args.runId === node.id);
      record.emit({ type: "reply", text: "Inspected the fixed scope; evidence returned for parent review." });
      record.emit({ type: "done", ok: true });
      await wait(() => t.host.treeResult(parent.id, node.id).result?.state === "done");
      assert.equal(t.host.treeResult(parent.id, node.id).result.accepted, false);
    };
    const owner = proposal.tree.nodes.find((node) => node.id === root);
    for (let i = 0; i < 4; i += 1) {
      const manager = proposal.tree.nodes.find((node) => node.key === `m${i}`);
      if (i > 0) assert.equal((await t.host.delegate(root, { nodeId: manager.id })).status, 201);
      for (let j = 0; j < 4; j += 1) {
        const runner = proposal.tree.nodes.find((node) => node.key === `r${i}${j}`);
        if (i > 0 || j > 0) assert.equal((await t.host.delegate(manager.id, { nodeId: runner.id })).status, 201);
        await finish(runner, manager);
      }
      await finish(manager, owner);
    }
    assert.equal(t.fake.spawns.length, 21);
    assert.equal(t.fake.peakLive, 3, "owner plus one manager and one runner fit the current slot classes");
  } finally { await t.close(); }
});

test("stopping an owner cancels a child whose runtime spawn acknowledgement is delayed", { timeout: 15000 }, async () => {
  const t = await setup();
  try {
    const proposal = await t.plan([contract("m")]);
    const root = proposal.tree.rootId;
    const manager = proposal.tree.nodes.find((node) => node.key === "m");
    assert.equal((await t.host.startTree({ revision: proposal.revision })).status, 201);
    t.fake.config.spawnDelayMs = 120;
    const delegated = t.host.delegate(root, { nodeId: manager.id });
    await wait(() => t.fake.spawns.length === 2);
    assert.equal((await t.host.stop(root)).status, 202);
    const result = await delegated;
    assert.equal(result.status, 409);
    await wait(() => t.fake.spawns.every((record) => record.exited));
    await wait(() => !t.host.busy());
    assert.equal(t.fake.spawns[1].calls[0].call, "closeInput");
  } finally { await t.close(); }
});

test("approved plans fail closed on disabled runtimes, unavailable models and changed trusted role routing", { timeout: 15000 }, async () => {
  const t = await setup();
  try {
    t.fake.validateModel = async () => false;
    assert.ok((await t.plan([])).status >= 400);
    assert.equal(t.fake.spawns.length, 0);
    t.fake.validateModel = async () => true;
    const proposal = await t.plan([]);
    await t.host.admission.setAllowlist("codex");
    assert.equal((await t.host.startTree({ revision: proposal.revision })).status, 409);
    assert.equal(t.fake.spawns.length, 0);
    await t.host.admission.setAllowlist("both");
    const next = await t.plan([]);
    const sourceFile = path.join(t.fx.root, ".claude/agents/orchestrator.md");
    const mirrorFile = path.join(t.fx.root, ".codex/agents/orchestrator.toml");
    await writeFile(sourceFile, (await readFile(sourceFile, "utf8")).replace("model: sonnet", "model: opus"));
    await writeFile(mirrorFile, (await readFile(mirrorFile, "utf8")).replace('model = "gpt-6.1-sol"', 'model = "gpt-6-astra"'));
    const refused = await t.host.startTree({ revision: next.revision });
    assert.equal(refused.status, 409);
    assert.match(refused.error, /trusted role changed/);
    assert.equal(t.fake.spawns.length, 0, "an approved model selection cannot be silently rewritten");
  } finally { await t.close(); }
});

test("a tree candidate fails closed when its returned file scope cannot be established", { timeout: 15000 }, async () => {
  let enumerated = 0;
  const t = await setup("claude", {}, { changedFiles: async () => { enumerated += 1; throw new Error("fixture: changed files unavailable"); } });
  try {
    const proposal = await t.plan([contract("manager")]);
    const root = proposal.tree.rootId;
    const manager = proposal.tree.nodes.find((node) => node.key === "manager");
    assert.equal((await t.host.startTree({ revision: proposal.revision })).status, 201);
    assert.equal((await t.host.delegate(root, { nodeId: manager.id })).status, 201);
    const run = t.fake.spawns.find((record) => record.args.runId === manager.id);
    const dir = run.args.cwd;
    await mkdir(path.join(dir, "src/manager"), { recursive: true });
    await writeFile(path.join(dir, "src/manager/result.txt"), "scoped candidate\n");
    execFileSync("git", ["-C", dir, "add", "--", "src/manager/result.txt"], { stdio: "pipe" });
    execFileSync("git", ["-C", dir, "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "fixture scoped candidate"], { stdio: "pipe" });
    run.emit({ type: "done", ok: true });
    await wait(() => ["done", "failed"].includes(t.host.treeResult(root, manager.id).result?.state));
    const result = t.host.treeResult(root, manager.id).result;
    assert.equal(enumerated, 1, "the actual committed candidate reached scope verification");
    assert.equal(result.state, "failed");
    assert.equal(result.reason, "returned-scope-unverified");
    assert.equal(result.accepted, false);
  } finally { await t.close(); }
});

test("a tree candidate fails closed when its internal candidate publication is unknown", { timeout: 15000 }, async () => {
  const t = await setup();
  try {
    const proposal = await t.plan([contract("manager")]);
    const root = proposal.tree.rootId;
    const manager = proposal.tree.nodes.find((node) => node.key === "manager");
    assert.equal((await t.host.startTree({ revision: proposal.revision })).status, 201);
    assert.equal((await t.host.delegate(root, { nodeId: manager.id })).status, 201);
    const run = t.fake.spawns.find((record) => record.args.runId === manager.id);
    const branch = t.host.snapshot().find((agent) => agent.id === manager.id).branch;
    execFileSync("git", ["-C", run.args.cwd, "branch", branch, "HEAD"], { stdio: "pipe" });
    run.emit({ type: "done", ok: true });
    await wait(() => ["done", "failed"].includes(t.host.treeResult(root, manager.id).result?.state));
    const result = t.host.treeResult(root, manager.id).result;
    assert.equal(result.state, "failed");
    assert.equal(result.reason, "returned-candidate-unverified");
    assert.equal(result.candidate, null);
    assert.equal(result.accepted, false);
    assert.equal(t.host.snapshot().find((agent) => agent.id === manager.id).followUp, false);
  } finally { await t.close(); }
});

test("replayed tree records preserve IDs as evidence without reviving execution or follow-up authority", { timeout: 15000 }, async () => {
  const t = await setup();
  let restarted;
  try {
    const proposal = await t.plan([]);
    assert.equal((await t.host.startTree({ revision: proposal.revision })).status, 201);
    const root = proposal.tree.rootId;
    const token = t.fake.spawns[0].args.treeCredential.token;
    await t.host.stop(root);
    await wait(() => !t.host.busy());
    await t.host.shutdown();
    restarted = createHost(t.options);
    await restarted.ready;
    assert.equal(restarted.treeAgent(token), null);
    assert.equal((await restarted.startTree({ revision: proposal.revision })).status, 409);
    assert.equal(restarted.trees()[0].nodes[0].id, root);
    assert.equal(restarted.trees()[0].recordOnly, true);
    assert.equal(restarted.snapshot().find((node) => node.id === root).followUp, false);
    const journal = await readFile(path.join(t.fx.root, ".scratch/_run/task-trees.jsonl"), "utf8");
    assert.match(journal, /"event":"proposed"/);
    assert.match(journal, /"event":"approved"/);
    assert.doesNotMatch(journal, new RegExp(token));
  } finally { await restarted?.shutdown(); await t.close(); }
});

test("tree structural admission caps unfinished approved nodes at twenty-one globally", async () => {
  const fx = await makeStateFixture({ empty: true });
  try {
    const trees = createTaskTrees(fx.root);
    await trees.ready;
    const a = trees.root({ ref: REF, project: "den", owner: "bao", epoch: 1, runtime: "claude", scopes: ["src"] });
    for (let i = 0; i < 4; i += 1) {
      const manager = trees.child(a, { role: "developer", task: "work", scopes: ["src"], planned: true });
      for (let j = 0; j < 4; j += 1) trees.child(manager, { role: "runner", task: "work", scopes: ["src"], planned: true });
    }
    trees.approve(a.treeId);
    const b = trees.root({ ref: "fx/07-bumpable", project: "den", owner: "bao", epoch: 1, runtime: "claude", scopes: ["src"] });
    assert.throws(() => trees.approve(b.treeId), /twenty-one unfinished/);
    trees.end(a, "terminated");
    assert.equal(trees.approve(b.treeId).id, b.id);
  } finally { await fx.cleanup(); }
});
