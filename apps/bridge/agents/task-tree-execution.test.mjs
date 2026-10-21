import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createHost } from "./host.mjs";
import { createFakeRuntime } from "./runtime.mjs";
import { createTreeArtifacts } from "./tree-artifacts.mjs";
import { makeStateFixture } from "../bridge-fixture.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REF = "fx/02-ready-p0";
const evidence = { criteria: [{ criterion: "Deliver the scoped outcome", evidence: "Independently inspected exact candidate and scoped outcome." }], checks: [] };
const contract = (id, parent, role, scopes, executionMode = "read") => ({ id, parent, role, scopes, executionMode, outcome: "Deliver the scoped outcome", inputs: [], dependencies: [], acceptanceCriteria: ["Deliver the scoped outcome"], verificationCommands: [] });
const rootContract = { outcome: "Deliver the scoped outcome", inputs: [], acceptanceCriteria: ["Deliver the scoped outcome"], verificationCommands: [] };
const wait = async (predicate, message = "tree workflow timed out") => {
  const start = Date.now();
  while (!await predicate()) { if (Date.now() - start > 15000) assert.fail(typeof message === "function" ? message() : message); await new Promise((resolve) => setTimeout(resolve, 10)); }
};
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
async function fixture(config = {}, extra = {}) {
  const fx = await makeStateFixture({ git: true });
  for (const dir of [".claude/agents", ".codex/agents"]) await cp(path.join(ROOT, dir), path.join(fx.root, dir), { recursive: true });
  const runtime = createFakeRuntime({ cleanupConfirmed: true, ...config });
  Object.assign(runtime.capabilities, { treeDelegation: true, artifactStoreProtection: true });
  runtime.validateModel = async () => true;
  runtime.stillRunning = async (id) => runtime.spawns.some((run) => run.args.runId === id && !run.exited);
  const options = { root: fx.root, runtime, policy: { killGraceMs: 20, spawnWaitMs: 50 }, bridgeUrl: () => "http://127.0.0.1:4317", checkGate: async () => "ok", treeChecks: { risk: async () => ({ clean: true, hits: [] }), guard: async () => ({ hits: ["fixture: inspect test coverage"] }) }, ...extra };
  const host = createHost(options); await host.ready;
  await host.admission.approve(REF, { owner: "bao" });
  const plan = async (nodes = []) => {
    const proposed = await host.planTree({ ref: REF, runtime: "claude", scopes: ["src"], rootContract, nodes });
    assert.equal(proposed.status, 201, proposed.error);
    const started = await host.startTree({ revision: proposed.revision });
    assert.equal(started.status, 201, started.error);
    return proposed;
  };
  return { fx, runtime, options, host, plan, node: (id) => host.trees().flatMap((tree) => tree.nodes).find((node) => node.id === id), close: async () => { await host.shutdown(); await fx.cleanup(); } };
}
async function reviewAll(t, nodeId, revision) {
  while (t.node(nodeId).workflow.status !== "accepted") {
    const node = t.node(nodeId);
    if (node.workflow.status === "awaiting-verifier") {
      assert.equal((await t.host.verifierTree({ revision, nodeId, candidate: node.workflow.receipt.candidate, runtime: "claude", reason: "User explicitly selects a fresh same-runtime verifier while Codex conformance is unavailable." })).status, 202);
    }
    await wait(() => t.node(nodeId).workflow.status === "accepted" || t.runtime.spawns.some((run) => run.args.tree?.nodeId === nodeId && ["code-review", "qa", "security", "writer-review"].includes(run.args.tree.phase) && !run.exited), JSON.stringify(t.node(nodeId).workflow));
    if (t.node(nodeId).workflow.status === "accepted") break;
    const run = t.runtime.spawns.find((run) => run.args.tree?.nodeId === nodeId && ["code-review", "qa", "security", "writer-review"].includes(run.args.tree.phase) && !run.exited);
    const current = t.node(nodeId);
    assert.equal(run.args.model, "sonnet", "review is pinned to the configured stronger tier");
    assert.equal(run.args.resume, undefined, "independent verification is a fresh native session");
    assert.equal((await t.host.delegate(run.args.runId, { nodeId })).status, 409, "a review phase has no author delegation authority");
    assert.equal((await t.host.skipTree(run.args.runId, { nodes: [] })).status, 403, "review phase cannot omit implementation work");
    const result = await t.host.reviewTree(run.args.runId, { ...evidence, candidate: current.workflow.receipt.candidate, verdict: "pass", findings: [], guardVerdicts: run.args.role === "qa" ? current.workflow.guard.hits.map((hit) => ({ hit, verdict: "accept", reason: "Independently checked the guarded test intent and implementation." })) : [] });
    assert.equal(result.status, 200, result.error);
    await wait(() => run.exited && t.node(nodeId).workflow.status !== "reviewing");
  }
}

test("managed code leaf is captured, independently reviewed, integrated, and wakes each stopped parent within current capacity", { timeout: 90000 }, async () => {
  const t = await fixture();
  try {
    const proposed = await t.plan([contract("manager", "owner", "developer", ["src/shared"]), contract("leaf", "manager", "runner", ["src/shared"], "code"), ...[1, 2, 3].map((number) => contract(`unused${number}`, "manager", "runner", [`src/shared/unused${number}`]))]);
    const owner = proposed.tree.rootId;
    const manager = proposed.tree.nodes.find((node) => node.key === "manager").id;
    const leaf = proposed.tree.nodes.find((node) => node.key === "leaf").id;
    assert.equal((await t.host.yieldTree(owner, { children: [manager] })).status, 202);
    await wait(() => t.runtime.spawns.some((run) => run.args.runId === manager));
    assert.equal(t.runtime.spawns[0].exited, true, "waiting owner has released its process");
    assert.equal((await t.host.yieldTree(manager, { children: [leaf] })).status, 202);
    await wait(() => t.runtime.spawns.some((run) => run.args.runId === leaf));
    const run = t.runtime.spawns.find((run) => run.args.runId === leaf);
    await mkdir(path.join(run.args.cwd, "src/shared"), { recursive: true });
    await writeFile(path.join(run.args.cwd, "src/shared/result.txt"), "bounded lower-tier execution\n");
    const base = git(run.args.cwd, "rev-parse", "HEAD");
    assert.equal((await t.host.completeTree(leaf, evidence)).status, 202);
    await wait(() => t.node(leaf).workflow.status === "reviewing" || t.node(leaf).workflow.status === "paused", JSON.stringify(t.node(leaf).workflow));
    assert.notEqual(t.node(leaf).workflow.status, "paused", t.node(leaf).workflow.error);
    assert.equal(git(run.args.cwd, "rev-parse", "HEAD"), base, "bridge capture does not change runner HEAD or publish a ref");
    assert.notEqual(t.node(leaf).workflow.receipt.candidate, base);
    assert.equal(t.host.treeResult(manager, leaf).status, 403, "stopped parent has no live credential or private result access");
    await reviewAll(t, leaf, proposed.revision);
    await wait(() => t.runtime.spawns.some((record) => record.args.tree?.nodeId === manager && record.args.tree.phase === "continuation"), () => JSON.stringify(t.node(manager).workflow));
    const resumedManager = t.runtime.spawns.find((record) => record.args.tree?.nodeId === manager && record.args.tree.phase === "continuation");
    assert.equal(resumedManager.args.resume, true);
    assert.equal(await readFile(path.join(resumedManager.args.cwd, "src/shared/result.txt"), "utf8"), "bounded lower-tier execution\n");
    assert.equal(t.host.treeResult(resumedManager.args.runId, leaf).result.accepted, true);
    const unused = proposed.tree.nodes.filter((node) => node.key.startsWith("unused")).map((node) => node.id);
    assert.equal((await t.host.completeTree(resumedManager.args.runId, { ...evidence, unused })).status, 202);
    assert.ok(unused.every((id) => t.node(id).workflow.status === "skipped"), "a manager can use one of four approved runners and explicitly omit its never-started own runners");
    assert.equal(t.runtime.spawns.some((run) => unused.includes(run.args.tree.nodeId)), false);
    await reviewAll(t, manager, proposed.revision);
    await wait(() => t.runtime.spawns.some((record) => record.args.tree?.nodeId === owner && record.args.tree.phase === "continuation"));
    const resumedOwner = t.runtime.spawns.find((record) => record.args.tree?.nodeId === owner && record.args.tree.phase === "continuation");
    assert.equal((await t.host.completeTree(resumedOwner.args.runId, evidence)).status, 202);
    await reviewAll(t, owner, proposed.revision);
    assert.equal(t.host.trees()[0].accepted, true);
    assert.ok(t.runtime.peakLive <= 3, "current slot policy is never widened to match the structural shape");
    assert.equal(git(t.fx.root, "status", "--porcelain", "--untracked-files=no"), "", "main checkout remains untouched");
    const journal = await readFile(path.join(t.fx.root, ".scratch/_run/task-trees.jsonl"), "utf8");
    assert.match(journal, /"event":"verifier-override"/);
    assert.match(journal, /"kind":"accepted"/);
  } finally { await t.close(); }
});

for (const cleanupConfirmed of [false, undefined]) test(`unconfirmed cleanup (${cleanupConfirmed}) never captures or starts a yielded child`, { timeout: 20000 }, async () => {
  const t = await fixture({ cleanupConfirmed });
  try {
    const proposed = await t.plan([contract("manager", "owner", "developer", ["src/shared"])]);
    const manager = proposed.tree.nodes.find((node) => node.key === "manager").id;
    assert.equal((await t.host.yieldTree(proposed.tree.rootId, { children: [manager] })).status, 202);
    await wait(() => t.node(proposed.tree.rootId).workflow.status === "paused");
    assert.match(t.node(proposed.tree.rootId).workflow.error, /cleanup is unconfirmed/);
    assert.equal(t.runtime.spawns.length, 1);
    assert.equal(t.node(manager).workflow.status, "queued");
    assert.equal(t.node(proposed.tree.rootId).workflow.receipt, null);
  } finally { await t.close(); }
});

test("failed author check, missing criterion and candidate mismatch cannot become accepted or retry", { timeout: 25000 }, async () => {
  const t = await fixture();
  try {
    const proposed = await t.plan();
    const root = proposed.tree.rootId;
    assert.equal((await t.host.completeTree(root, { criteria: [], checks: [] })).status, 400);
    assert.equal((await t.host.completeTree(root, evidence)).status, 202);
    await wait(() => t.runtime.spawns.some((run) => run.args.tree?.phase === "code-review"));
    const reviewer = t.runtime.spawns.find((run) => run.args.tree?.phase === "code-review");
    assert.equal((await t.host.reviewTree(reviewer.args.runId, { ...evidence, candidate: "0".repeat(40), verdict: "pass", findings: [] })).status, 400);
    const candidate = t.node(root).workflow.receipt.candidate;
    assert.equal((await t.host.reviewTree(reviewer.args.runId, { ...evidence, candidate, verdict: "bounce", findings: ["The approved outcome is incomplete."] })).status, 200);
    await wait(() => t.node(root).workflow.status === "paused");
    assert.equal(t.node(root).workflow.acceptance, null);
    assert.equal(t.runtime.spawns.filter((run) => run.args.tree.phase === "implementation").length, 1);
  } finally { await t.close(); }
});

test("accepted sibling dependency is integrated before the dependent runner reads its inputs", { timeout: 90000 }, async () => {
  const t = await fixture();
  try {
    const first = contract("a", "manager", "runner", ["src/shared"], "code");
    const second = { ...contract("b", "manager", "runner", ["src/shared"], "code"), dependencies: ["a"] };
    const proposed = await t.plan([contract("manager", "owner", "developer", ["src/shared"]), first, second]);
    const manager = proposed.tree.nodes.find((node) => node.key === "manager").id;
    const a = proposed.tree.nodes.find((node) => node.key === "a").id;
    const b = proposed.tree.nodes.find((node) => node.key === "b").id;
    assert.equal((await t.host.yieldTree(proposed.tree.rootId, { children: [manager] })).status, 202);
    await wait(() => t.runtime.spawns.some((run) => run.args.runId === manager));
    assert.equal((await t.host.yieldTree(manager, { children: [b] })).status, 409, "dependency barriers cannot omit the required input producer");
    assert.equal((await t.host.yieldTree(manager, { children: [a, b] })).status, 202);
    await wait(() => t.runtime.spawns.some((run) => run.args.runId === a));
    assert.equal(t.runtime.spawns.some((run) => run.args.runId === b), false, "dependent does not start on mere queued or raw completion");
    const authorA = t.runtime.spawns.find((run) => run.args.runId === a);
    await mkdir(path.join(authorA.args.cwd, "src/shared"), { recursive: true });
    await writeFile(path.join(authorA.args.cwd, "src/shared/api.mjs"), "export const answer = () => 42;\n");
    assert.equal((await t.host.completeTree(a, evidence)).status, 202);
    await reviewAll(t, a, proposed.revision);
    await wait(() => t.runtime.spawns.some((run) => run.args.runId === b), () => JSON.stringify(t.node(manager).workflow));
    const authorB = t.runtime.spawns.find((run) => run.args.runId === b);
    assert.equal(await readFile(path.join(authorB.args.cwd, "src/shared/api.mjs"), "utf8"), "export const answer = () => 42;\n", "dependent receives actual accepted API output in its frozen base");
    assert.ok(t.node(manager).workflow.integratedChildren.includes(a));
    assert.equal(t.runtime.spawns.filter((run) => run.args.tree.nodeId === manager && run.args.tree.phase === "continuation").length, 0, "manager stays stopped until the complete barrier is accepted");
    await writeFile(path.join(authorB.args.cwd, "src/shared/use.mjs"), "import { answer } from './api.mjs';\nexport const value = answer();\n");
    assert.equal((await t.host.completeTree(b, evidence)).status, 202);
    await reviewAll(t, b, proposed.revision);
    await wait(() => t.runtime.spawns.some((run) => run.args.tree.nodeId === manager && run.args.tree.phase === "continuation"), () => JSON.stringify(t.node(manager).workflow));
    const continued = t.runtime.spawns.find((run) => run.args.tree.nodeId === manager && run.args.tree.phase === "continuation");
    assert.match(await readFile(path.join(continued.args.cwd, "src/shared/use.mjs"), "utf8"), /answer\(\)/);
    assert.equal((await t.host.stop(proposed.tree.rootId)).status, 202, "waiting logical owner can cancel its active descendant");
    await wait(() => t.runtime.spawns.every((run) => run.exited));
  } finally { await t.close(); }
});

test("capacity queues a fixed child, and yielding its manager releases a slot without cancelling it", { timeout: 25000 }, async () => {
  const t = await fixture();
  try {
    const proposed = await t.plan([contract("m1", "owner", "developer", ["src/one"]), contract("m2", "owner", "developer", ["src/two"]), contract("leaf", "m1", "runner", ["src/one"]), contract("other-leaf", "m2", "runner", ["src/two"])]);
    const m1 = proposed.tree.nodes.find((node) => node.key === "m1").id;
    const m2 = proposed.tree.nodes.find((node) => node.key === "m2").id;
    const leaf = proposed.tree.nodes.find((node) => node.key === "leaf").id;
    assert.equal((await t.host.delegate(proposed.tree.rootId, { nodeId: m1 })).status, 201);
    assert.equal((await t.host.delegate(proposed.tree.rootId, { nodeId: m2 })).status, 201);
    const otherLeaf = proposed.tree.nodes.find((node) => node.key === "other-leaf").id;
    assert.equal((await t.host.skipTree(m1, { nodes: [otherLeaf] })).status, 403, "manager cannot omit a sibling manager's planned runner");
    assert.equal((await t.host.delegate(m1, { nodeId: leaf })).status, 202);
    assert.equal(t.node(leaf).workflow.status, "queued");
    assert.equal(t.node(leaf).workflow.attempts.length, 0, "capacity pressure never creates a phantom attempt");
    assert.equal((await t.host.skipTree(m1, { nodes: [leaf] })).status, 409, "an already-requested runner is not silently omitted");
    assert.equal((await t.host.yieldTree(m1, { children: [leaf] })).status, 202);
    await wait(() => t.runtime.spawns.some((run) => run.args.runId === leaf));
    assert.equal(t.runtime.spawns.find((run) => run.args.runId === m1).exited, true);
    assert.equal(t.node(leaf).workflow.status, "working");
    assert.equal(t.runtime.peakLive, 3, "one owner and two workers are the existing runtime shape");
    assert.equal((await t.host.stop(proposed.tree.rootId)).status, 202);
    await wait(() => t.runtime.spawns.every((run) => run.exited));
  } finally { await t.close(); }
});

test("explicit restart recovery revalidates a captured candidate and creates fresh reviews without repeating implementation", { timeout: 30000 }, async () => {
  const t = await fixture(); let recovered;
  try {
    const proposed = await t.plan();
    const owner = proposed.tree.rootId;
    const token = t.runtime.spawns[0].args.treeCredential.token;
    assert.equal((await t.host.completeTree(owner, evidence)).status, 202);
    await wait(() => t.runtime.spawns.some((run) => run.args.tree.phase === "code-review"));
    const candidate = t.node(owner).workflow.receipt.candidate;
    await t.host.shutdown();
    const before = t.runtime.spawns.length;
    recovered = createHost(t.options); await recovered.ready;
    assert.equal(recovered.treeAgent(token), null);
    assert.equal(t.runtime.spawns.length, before, "journal replay cannot itself launch any process");
    const result = await recovered.resumeTree({ revision: proposed.revision });
    assert.equal(result.status, 202, result.error);
    await wait(() => t.runtime.spawns.length > before);
    const fresh = t.runtime.spawns[before];
    assert.equal(fresh.args.tree.phase, "code-review");
    assert.notEqual(fresh.args.runId, t.runtime.spawns[1].args.runId);
    assert.equal(fresh.args.tree.candidate, candidate);
    assert.equal(fresh.args.resume, undefined);
    assert.equal(t.runtime.spawns.filter((run) => run.args.tree.phase === "implementation").length, 1);
    const workflow = recovered.trees().find((tree) => tree.id === proposed.revision).nodes.find((node) => node.id === owner).workflow;
    assert.equal(workflow.acceptance, null);
    assert.deepEqual(workflow.reviews, {});
  } finally { await recovered?.shutdown(); await t.close(); }
});

test("review mutation and an unavailable resource proof never restore accepted authority", { timeout: 30000 }, async () => {
  const t = await fixture(); let recovered;
  try {
    const proposed = await t.plan(); const owner = proposed.tree.rootId;
    assert.equal((await t.host.completeTree(owner, evidence)).status, 202);
    await wait(() => t.runtime.spawns.some((run) => run.args.tree.phase === "code-review"));
    const reviewer = t.runtime.spawns.find((run) => run.args.tree.phase === "code-review");
    await mkdir(path.join(reviewer.args.cwd, "src"), { recursive: true });
    await writeFile(path.join(reviewer.args.cwd, "src/unreviewed.txt"), "mutation\n");
    assert.equal((await t.host.reviewTree(reviewer.args.runId, { ...evidence, candidate: t.node(owner).workflow.receipt.candidate, verdict: "pass", findings: [] })).status, 200);
    await wait(() => t.node(owner).workflow.status === "paused");
    assert.match(t.node(owner).workflow.error, /changed its frozen candidate/);
    assert.equal(t.node(owner).workflow.acceptance, null);
    await t.host.shutdown();
    t.runtime.stillRunning = async () => { throw new Error("resource query unavailable"); };
    recovered = createHost(t.options); await recovered.ready;
    const before = t.runtime.spawns.length;
    assert.equal((await recovered.resumeTree({ revision: proposed.revision })).status, 409);
    assert.equal(t.runtime.spawns.length, before);
  } finally { await recovered?.shutdown(); await t.close(); }
});

test("a bounced code-leaf review pauses ancestors, stops siblings and preserves its unaccepted candidate", { timeout: 30000 }, async () => {
  const t = await fixture();
  try {
    const proposed = await t.plan([contract("m1", "owner", "developer", ["src/one"]), contract("m2", "owner", "developer", ["src/two"]), contract("leaf", "m1", "runner", ["src/one"], "code")]);
    const m1 = proposed.tree.nodes.find((node) => node.key === "m1").id;
    const m2 = proposed.tree.nodes.find((node) => node.key === "m2").id;
    const leaf = proposed.tree.nodes.find((node) => node.key === "leaf").id;
    assert.equal((await t.host.delegate(proposed.tree.rootId, { nodeId: m1 })).status, 201);
    assert.equal((await t.host.delegate(proposed.tree.rootId, { nodeId: m2 })).status, 201);
    assert.equal((await t.host.yieldTree(m1, { children: [leaf] })).status, 202);
    await wait(() => t.runtime.spawns.some((run) => run.args.runId === leaf));
    const leafRun = t.runtime.spawns.find((run) => run.args.runId === leaf);
    await mkdir(path.join(leafRun.args.cwd, "src/one"), { recursive: true });
    await writeFile(path.join(leafRun.args.cwd, "src/one/result.mjs"), "export const result = 1;\n");
    assert.equal((await t.host.completeTree(leaf, evidence)).status, 202);
    await wait(() => t.runtime.spawns.some((run) => run.args.tree.nodeId === leaf && run.args.tree.phase === "code-review"));
    const review = t.runtime.spawns.find((run) => run.args.tree.nodeId === leaf && run.args.tree.phase === "code-review");
    const candidate = t.node(leaf).workflow.receipt.candidate;
    assert.equal((await t.host.reviewTree(review.args.runId, { ...evidence, candidate, verdict: "bounce", findings: ["Required code outcome does not match the contract."] })).status, 200);
    await wait(() => t.runtime.spawns.every((run) => run.exited));
    await wait(() => t.node(proposed.tree.rootId).workflow.status === "paused");
    assert.equal(t.node(m1).workflow.status, "paused");
    assert.equal(t.node(leaf).workflow.receipt.candidate, candidate);
    assert.equal(t.node(leaf).workflow.acceptance, null);
    assert.equal(t.runtime.spawns.filter((run) => run.args.tree.nodeId === leaf && run.args.tree.phase === "implementation").length, 1);
    assert.equal(t.runtime.spawns.some((run) => run.args.tree.nodeId === leaf && run.args.tree.phase === "qa"), false);
    assert.equal(t.host.treeAgent(t.runtime.spawns[0].args.treeCredential.token), null);
  } finally { await t.close(); }
});

test("a failed approved author verification command pauses without dispatching a reviewer or retry", { timeout: 20000 }, async () => {
  const t = await fixture();
  try {
    const command = "node --check src/expected.mjs";
    const proposal = await t.host.planTree({ ref: REF, runtime: "claude", scopes: ["src"], rootContract: { ...rootContract, verificationCommands: [command] }, nodes: [] });
    assert.equal(proposal.status, 201, proposal.error);
    assert.equal((await t.host.startTree({ revision: proposal.revision })).status, 201);
    assert.equal((await t.host.completeTree(proposal.tree.rootId, { ...evidence, checks: [{ command, passed: false, evidence: "The approved verification command exited nonzero; outcome needs correction." }] })).status, 202);
    await wait(() => t.node(proposal.tree.rootId).workflow.status === "paused");
    assert.match(t.node(proposal.tree.rootId).workflow.error, /required author check failed/);
    assert.equal(t.node(proposal.tree.rootId).workflow.acceptance, null);
    assert.equal(t.runtime.spawns.length, 1);
  } finally { await t.close(); }
});

test("explicit recovery finishes a recorded private integration transition and never repeats the code author", { timeout: 90000 }, async () => {
  let interrupt = true; let recovered;
  const exec = promisify(execFile);
  const t = await fixture({}, { treeArtifactsFactory: (options) => createTreeArtifacts({ ...options, exec: async (file, args, config) => {
    if (interrupt && args.includes("update-ref")) { interrupt = false; throw new Error("fixture: interrupted private HEAD transition"); }
    return exec(file, args, config);
  } }) });
  try {
    const proposed = await t.plan([contract("manager", "owner", "developer", ["src/shared"]), contract("leaf", "manager", "runner", ["src/shared"], "code")]);
    const owner = proposed.tree.rootId;
    const manager = proposed.tree.nodes.find((node) => node.key === "manager").id;
    const leaf = proposed.tree.nodes.find((node) => node.key === "leaf").id;
    assert.equal((await t.host.yieldTree(owner, { children: [manager] })).status, 202);
    await wait(() => t.runtime.spawns.some((run) => run.args.runId === manager));
    assert.equal((await t.host.yieldTree(manager, { children: [leaf] })).status, 202);
    await wait(() => t.runtime.spawns.some((run) => run.args.runId === leaf));
    const run = t.runtime.spawns.find((run) => run.args.runId === leaf);
    await mkdir(path.join(run.args.cwd, "src/shared"), { recursive: true });
    await writeFile(path.join(run.args.cwd, "src/shared/recovered.mjs"), "export const recovered = true;\n");
    assert.equal((await t.host.completeTree(leaf, evidence)).status, 202);
    await reviewAll(t, leaf, proposed.revision);
    await wait(() => t.node(manager).workflow.status === "paused");
    assert.match(t.node(manager).workflow.error, /interrupted private HEAD transition/);
    const operation = t.node(manager).workflow.integrationOperation;
    assert.ok(operation);
    await t.host.shutdown();
    const before = t.runtime.spawns.length;
    recovered = createHost(t.options); await recovered.ready;
    const resumed = await recovered.resumeTree({ revision: proposed.revision });
    assert.equal(resumed.status, 202, resumed.error);
    const rt = { ...t, host: recovered, node: (id) => recovered.trees().flatMap((tree) => tree.nodes).find((node) => node.id === id) };
    assert.ok(rt.node(manager).workflow.integratedChildren.includes(leaf));
    assert.equal(rt.node(manager).workflow.integration.operationId, operation);
    await reviewAll(rt, leaf, proposed.revision);
    await wait(() => t.runtime.spawns.slice(before).some((record) => record.args.tree.nodeId === manager && record.args.tree.phase === "continuation"), () => JSON.stringify(rt.node(manager).workflow));
    const continuation = t.runtime.spawns.slice(before).find((record) => record.args.tree.nodeId === manager && record.args.tree.phase === "continuation");
    assert.equal(await readFile(path.join(continuation.args.cwd, "src/shared/recovered.mjs"), "utf8"), "export const recovered = true;\n");
    assert.equal(t.runtime.spawns.filter((record) => record.args.tree.nodeId === leaf && record.args.tree.phase === "implementation").length, 1);
    assert.equal((await recovered.stop(owner)).status, 202);
    await wait(() => t.runtime.spawns.every((record) => record.exited));
  } finally { await recovered?.shutdown(); await t.close(); }
});

test("tree shutdown remains bounded during delayed spawn and stops the late acknowledgement", { timeout: 15000 }, async () => {
  const t = await fixture({}, { policy: { killGraceMs: 10, spawnWaitMs: 20 } });
  try {
    const proposal = await t.plan([contract("manager", "owner", "developer", ["src/shared"])]);
    const manager = proposal.tree.nodes.find((node) => node.key === "manager").id;
    t.runtime.config.spawnDelayMs = 400;
    const delegated = t.host.delegate(proposal.tree.rootId, { nodeId: manager });
    await wait(() => t.runtime.spawns.length === 2);
    const start = Date.now();
    await t.host.shutdown();
    assert.ok(Date.now() - start < 300, "shutdown must not join an unbounded native spawn acknowledgement");
    assert.equal((await delegated).status, 409);
    await wait(() => t.runtime.spawns.every((run) => run.exited));
    assert.equal(t.host.treeAgent(t.runtime.spawns[1].args.treeCredential.token), null);
  } finally { await t.close(); }
});

test("unconfirmed resource cleanup holds all admission until the runtime proves absence", { timeout: 20000 }, async () => {
  const t = await fixture({ cleanupConfirmed: false });
  try {
    const proposed = await t.plan();
    t.runtime.stillRunning = async () => true;
    assert.equal((await t.host.completeTree(proposed.tree.rootId, evidence)).status, 202);
    await wait(() => t.node(proposed.tree.rootId).workflow.status === "paused");
    const held = await t.host.start({ ref: "fx/07-bumpable", role: "developer" });
    assert.equal(held.status, 503);
    assert.match(held.error, /unconfirmed cleanup/);
    assert.equal(t.runtime.spawns.length, 1);
    t.runtime.stillRunning = async () => false;
    assert.equal((await t.host.start({ ref: "fx/07-bumpable", role: "developer" })).status, 201, "only positive resource absence releases the hold");
  } finally { await t.close(); }
});

test("restart resource uncertainty survives the UI history cap and holds admission across projects", { timeout: 25000 }, async () => {
  const t = await fixture(); let recovered;
  try {
    await t.host.shutdown();
    const lines = []; const oldest = "c-0000000000000001";
    for (let index = 1; index <= 205; index++) {
      const agentId = `c-${index.toString(16).padStart(16, "0")}`;
      const common = { ts: new Date().toISOString(), agentId, ref: REF };
      lines.push({ ...common, event: "spawn", role: "developer", runtime: "claude", project: index === 1 ? "other" : "den", sessionId: randomUUID(), resourceId: agentId });
      if (index > 1) lines.push({ ...common, event: "end", state: "done", cleanupConfirmed: true });
    }
    await mkdir(path.join(t.fx.root, ".scratch/_run"), { recursive: true });
    await writeFile(path.join(t.fx.root, ".scratch/_run/sessions.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    t.runtime.stillRunning = async (id) => id === oldest;
    recovered = createHost(t.options); await recovered.ready;
    assert.equal(recovered.snapshot().some((agent) => agent.id === oldest), false, "UI history is bounded independently of uncertainty");
    const held = await recovered.start({ ref: "fx/07-bumpable", role: "developer" });
    assert.equal(held.status, 503);
    assert.match(held.error, /unconfirmed cleanup/);
    assert.equal(t.runtime.spawns.length, 0);
    t.runtime.stillRunning = async () => false;
    assert.equal((await recovered.start({ ref: "fx/07-bumpable", role: "developer" })).status, 201);
  } finally { await recovered?.shutdown(); await t.close(); }
});

test("false cleanup proof persists in the end journal and prevents artifact storage until reconciled", { timeout: 25000 }, async () => {
  const t = await fixture({ cleanupConfirmed: false }); let recovered;
  try {
    const started = await t.host.start({ ref: REF, role: "developer" });
    assert.equal(started.status, 201);
    t.runtime.spawns[0].emit({ type: "done", ok: true });
    await wait(async () => (await readFile(path.join(t.fx.root, ".scratch/_run/sessions.jsonl"), "utf8")).includes('"cleanupConfirmed":false'));
    await t.host.shutdown();
    t.runtime.stillRunning = async () => true;
    recovered = createHost(t.options); await recovered.ready;
    assert.equal((await recovered.start({ ref: "fx/07-bumpable", role: "developer" })).status, 503, "a recorded end preserves uncertainty when its group did not settle");
    assert.equal((await recovered.converse("developer", { text: "Continue the same approved outcome.", runId: started.agent.id })).status, 409, "legacy continuation preserves its conflict response and cannot bypass the shared resource hold");
    t.runtime.stillRunning = async () => false;
    t.runtime.config.cleanupConfirmed = true;
    const proposal = await recovered.planTree({ ref: REF, runtime: "claude", scopes: ["src"], rootContract, nodes: [] });
    assert.equal(proposal.status, 201, proposal.error);
    t.runtime.stillRunning = async () => true;
    assert.equal((await recovered.startTree({ revision: proposal.revision })).status, 503, "a known unresolved group cannot coexist with a trusted artifact store");
    t.runtime.stillRunning = async () => false;
  } finally { await recovered?.shutdown(); await t.close(); }
});

test("a historical end line never substitutes for fresh proof that an old unprotected project process is gone", { timeout: 25000 }, async () => {
  const t = await fixture(); let recovered;
  try {
    await t.host.shutdown();
    const common = { ts: new Date().toISOString(), agentId: "c-0000000000000010", ref: REF };
    await mkdir(path.join(t.fx.root, ".scratch/_run"), { recursive: true });
    await writeFile(path.join(t.fx.root, ".scratch/_run/sessions.jsonl"), [
      { ...common, event: "spawn", role: "developer", runtime: "claude", project: "den", sessionId: randomUUID(), resourceId: common.agentId },
      { ...common, event: "end", state: "done", cleanupConfirmed: true },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    t.runtime.stillRunning = async () => true;
    recovered = createHost(t.options); await recovered.ready;
    const proposal = await recovered.planTree({ ref: REF, runtime: "claude", scopes: ["src"], rootContract, nodes: [] });
    assert.equal(proposal.status, 201, proposal.error);
    const blocked = await recovered.startTree({ revision: proposal.revision });
    assert.equal(blocked.status, 409);
    assert.match(blocked.error, /recorded project resource group is live or unverified/);
    assert.equal(t.runtime.spawns.length, 0);
    t.runtime.stillRunning = async () => false;
    const safe = await recovered.planTree({ ref: REF, runtime: "claude", scopes: ["src"], rootContract, nodes: [] });
    assert.equal(safe.status, 201, safe.error);
    assert.equal((await recovered.startTree({ revision: safe.revision })).status, 201);
  } finally { await recovered?.shutdown(); await t.close(); }
});

test("a runner cannot substitute its own commit for bridge-owned capture", { timeout: 25000 }, async () => {
  const t = await fixture();
  try {
    const proposed = await t.plan([contract("manager", "owner", "developer", ["src/shared"]), contract("leaf", "manager", "runner", ["src/shared"], "code")]);
    const manager = proposed.tree.nodes.find((node) => node.key === "manager").id;
    const leaf = proposed.tree.nodes.find((node) => node.key === "leaf").id;
    assert.equal((await t.host.yieldTree(proposed.tree.rootId, { children: [manager] })).status, 202);
    await wait(() => t.runtime.spawns.some((run) => run.args.runId === manager));
    assert.equal((await t.host.yieldTree(manager, { children: [leaf] })).status, 202);
    await wait(() => t.runtime.spawns.some((run) => run.args.runId === leaf));
    const run = t.runtime.spawns.find((run) => run.args.runId === leaf);
    await mkdir(path.join(run.args.cwd, "src/shared"), { recursive: true });
    await writeFile(path.join(run.args.cwd, "src/shared/result.mjs"), "export const forbiddenCommit = true;\n");
    git(run.args.cwd, "add", "--", "src/shared/result.mjs");
    git(run.args.cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "commit", "--no-verify", "-m", "unexpected runner commit");
    assert.equal((await t.host.completeTree(leaf, evidence)).status, 202);
    await wait(() => t.node(leaf).workflow.status === "paused");
    assert.match(t.node(leaf).workflow.error, /runner changed HEAD/);
    assert.equal(t.node(leaf).workflow.receipt, null);
    assert.equal(t.node(leaf).workflow.acceptance, null);
    assert.equal(t.runtime.spawns.some((record) => record.args.tree.phase === "code-review"), false);
  } finally { await t.close(); }
});

test("logical owner cancellation stops its fresh review attempt and permanently revokes that revision's tokens", { timeout: 20000 }, async () => {
  const t = await fixture(); let recovered;
  try {
    const proposal = await t.plan();
    assert.equal((await t.host.completeTree(proposal.tree.rootId, evidence)).status, 202);
    await wait(() => t.runtime.spawns.some((run) => run.args.tree.phase === "code-review"));
    const reviewer = t.runtime.spawns.find((run) => run.args.tree.phase === "code-review");
    assert.notEqual(reviewer.args.runId, proposal.tree.rootId);
    assert.equal((await t.host.stop(proposal.tree.rootId)).status, 202, "logical identity resolves the current phase execution");
    await wait(() => reviewer.exited);
    assert.equal(t.host.treeAgent(reviewer.args.treeCredential.token), null);
    await t.host.shutdown();
    recovered = createHost(t.options); await recovered.ready;
    const before = t.runtime.spawns.length;
    const refused = await recovered.resumeTree({ revision: proposal.revision });
    assert.equal(refused.status, 409);
    assert.match(refused.error, /explicitly cancelled/);
    assert.equal(t.runtime.spawns.length, before, "cancel does not grant a fresh implementation or verifier retry");
    t.runtime.capabilities.artifactStoreProtection = false;
    const unsafe = await recovered.start({ ref: "fx/07-bumpable", role: "developer" });
    assert.equal(unsafe.status, 409, "closed tree receipts remain protected from later unprotected adapters");
    assert.match(unsafe.error, /artifact-store protection/);
  } finally { await recovered?.shutdown(); await t.close(); }
});
