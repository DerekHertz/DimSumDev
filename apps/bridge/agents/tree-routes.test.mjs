// Public HTTP and per-run credential contract with injected adapters only.
// The Codex identity here proves routing, never live production conformance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "../server.mjs";
import { makeStateFixture } from "../bridge-fixture.mjs";
import { CODE, authed, login, send } from "../bridge-auth-helpers.mjs";
import { createFakeRuntime } from "./runtime.mjs";
import { DISPATCH_REF, until } from "./host-test-helpers.mjs";
import { createLibrary } from "../library/library.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SERVICE = "tree-route-service-token".repeat(3);
const DEN = { name: "den", title: "The den", purpose: "Test the separation of den and tree authority.",
  target: { name: "den", script: "/fixture-control/apps/bridge/library/servers/den.mjs", credential: "run" },
  host: null, credential: "run", roles: ["orchestrator"],
  tools: { board_comment: "board" } };
const node = (id, parent = "owner", role = "developer", scope = `src/${id}`) => ({
  id, parent, role, outcome: `Inspect ${scope} and return evidence.`, inputs: [], scopes: [scope],
  dependencies: [], acceptanceCriteria: ["Return file locations and evidence."], verificationCommands: [],
});
const contracts = () => [node("m1", "owner", "developer", "src/a"), node("m2", "owner", "developer", "src/b"), node("r1", "m1", "runner", "src/a")];
const rootContract = () => ({ outcome: "Return the scoped task outcome with evidence.", inputs: [],
  acceptanceCriteria: ["Return file locations and evidence."], verificationCommands: [] });
const toolBody = (response) => JSON.parse(response.body.text);

function adapter(runtime) {
  const fake = createFakeRuntime({ cleanupConfirmed: true }); // no OS descendants in this injected adapter
  fake.capabilities.treeDelegation = true;
  fake.capabilities.artifactStoreProtection = true;
  fake.validateModel = async () => true;
  const spawn = fake.spawn.bind(fake);
  fake.spawn = async (args) => {
    const process = await spawn(args);
    if (runtime === "codex") process.runtimeSessionId = `thread_tree_${fake.spawns.length}`;
    return process;
  };
  return fake;
}

async function fixture(t, { runtime = "claude" } = {}) {
  const fx = await makeStateFixture({ git: true });
  for (const directory of [".claude/agents", ".codex/agents"]) {
    await mkdir(path.join(fx.root, path.dirname(directory)), { recursive: true });
    await cp(path.join(ROOT, directory), path.join(fx.root, directory), { recursive: true });
  }
  const claude = adapter("claude");
  const codex = adapter("codex");
  const options = { root: fx.root, port: 0,
    auth: { launchCode: CODE, serviceToken: SERVICE }, runtimes: { claude, codex }, policy: { killGraceMs: 30 },
    // The compiled catalog seam avoids Linux-only script-path validation on Windows.
    // Injected runtimes execute no catalog script; token minting and auth remain real.
    library: createLibrary({ catalog: { connections: [DEN] }, denRoot: fx.root }),
  };
  let bridge = await startBridge(options);
  t.after(async () => {
    for (const fake of [claude, codex]) for (const record of fake.spawns) record.exit();
    await bridge.close();
    await fx.cleanup();
  });
  let session = await login(bridge);
  let headers = authed(bridge, session);
  const post = (url, body, auth = headers) => send(bridge, { method: "POST", path: url, body, headers: auth });
  const get = (url, auth = headers) => send(bridge, { path: url, headers: auth });
  const runHeaders = (token) => authed(bridge, token);
  const tool = (name, body, token) => post(`/tree-tools/${name}`, body, runHeaders(token));
  await bridge.host.admission.approve(DISPATCH_REF, { owner: runtime === "claude" ? "bao" : "jiao" });
  const proposal = () => ({ ref: DISPATCH_REF, runtime, scopes: ["src"], nodes: contracts(), rootContract: rootContract() });
  const plan = async () => {
    const planned = await post("/trees/plan", proposal());
    assert.equal(planned.status, 201, planned.text);
    assert.match(planned.body.revision, /^t-[a-f0-9]{16}$/);
    return planned.body;
  };
  const start = async (planned) => {
    const started = await post("/trees", { revision: planned.revision });
    assert.equal(started.status, 201, started.text);
    const fake = runtime === "claude" ? claude : codex;
    const root = await until(() => fake.spawns.find((record) => record.args.runId === started.body.agent.id));
    return { started: started.body, root, fake, token: root.args.treeCredential.token };
  };
  const restart = async () => {
    for (const fake of [claude, codex]) fake.stillRunning = async (id) => {
      const runs = fake.spawns.filter((record) => record.args.runId === id);
      assert.ok(runs.length, "unknown native identity is never proof of absence");
      return runs.some((record) => !record.exited);
    };
    await bridge.close();
    bridge = await startBridge(options);
    session = await login(bridge);
    headers = authed(bridge, session);
  };
  return { fx, get bridge() { return bridge; }, claude, codex, get session() { return session; }, get headers() { return headers; },
    post, get, runHeaders, tool, proposal, plan, start, restart };
}

test("tree proposal, approval and inventory require user sessions, never service credentials", { timeout: 20000 }, async (t) => {
  const x = await fixture(t);
  for (const headers of [{ Origin: x.bridge.url }, x.runHeaders(SERVICE), x.runHeaders("x".repeat(43))]) {
    assert.equal((await x.get("/trees", headers)).status, 401);
    assert.equal((await x.post("/trees/plan", x.proposal(), headers)).status, 401);
    assert.equal((await x.post("/trees", { revision: "unapproved" }, headers)).status, 401);
  }
  assert.equal((await x.post("/trees/plan", x.proposal(), { Authorization: `Bearer ${x.session}` })).status, 403, "mutations require same-origin headers");
  const planned = await x.plan();
  assert.equal(x.claude.spawns.length + x.codex.spawns.length, 0, "planning never starts a process");
  assert.equal(planned.tree.approved, false);
  const inventory = await x.get("/trees");
  assert.equal(inventory.status, 200);
  assert.equal(inventory.body.trees.find((tree) => tree.id === planned.revision).nodes.length, 4);
  for (const field of ["parentId", "owner", "model", "grants"]) {
    assert.equal((await x.post("/trees/plan", { ...x.proposal(), [field]: "forged" })).status, 400, field);
    assert.equal((await x.post("/trees", { revision: planned.revision, [field]: "forged" })).status, 400, field);
  }
  const injected = x.proposal();
  injected.nodes[0].model = "gpt-6-luna";
  assert.equal((await x.post("/trees/plan", injected)).status, 400, "a node contract cannot replace its trusted model");
  assert.equal(x.claude.spawns.length + x.codex.spawns.length, 0);
});

test("the approved root contract fixes bounded criteria and cannot carry execution authority", { timeout: 20000 }, async (t) => {
  const x = await fixture(t);
  const planned = await x.plan();
  const owner = planned.tree.nodes.find((entry) => entry.key === "owner");
  assert.deepEqual(owner.contract.acceptanceCriteria, rootContract().acceptanceCriteria);
  assert.deepEqual(owner.contract.verificationCommands, rootContract().verificationCommands);
  for (const field of ["parentId", "role", "owner", "runtime", "model", "grants", "scopes", "phase"]) {
    const proposal = x.proposal();
    proposal.rootContract[field] = "forged";
    const refused = await x.post("/trees/plan", proposal);
    assert.ok([400, 409].includes(refused.status), `root contract rejects ${field}: ${refused.status} ${refused.text}`);
  }
  for (const contract of [{}, { ...rootContract(), outcome: "" }, { ...rootContract(), outcome: "x".repeat(8193) },
    { ...rootContract(), acceptanceCriteria: [] }, { ...rootContract(), verificationCommands: [""] }]) {
    const refused = await x.post("/trees/plan", { ...x.proposal(), rootContract: contract });
    assert.ok([400, 409].includes(refused.status), `a root contract must be complete and bounded: ${refused.status} ${refused.body?.error ?? ""}`);
  }
  const preserved = (await x.get("/trees")).body.trees.find((tree) => tree.id === planned.revision);
  assert.equal(preserved.closed, false, "invalid contracts cannot invalidate a previously reviewable proposal");
  assert.notEqual(preserved.superseded, true);
  assert.equal(x.claude.spawns.length + x.codex.spawns.length, 0);
});

for (const runtime of ["claude", "codex"]) {
  test(`${runtime} injected adapter: credentials enforce direct approved parentage and isolated authority`, { timeout: 30000 }, async (t) => {
    const x = await fixture(t, { runtime });
    const planned = await x.plan();
    const nodes = Object.fromEntries(planned.tree.nodes.map((entry) => [entry.key, entry]));
    const { root, fake, token } = await x.start(planned);
    assert.equal(fake.spawns.length, 1, "approval starts only the owner");
    assert.equal(root.args.tree.nodeId, nodes.owner.id);
    assert.ok(root.args.runCredential?.token, "the den credential exists independently for the cross-use test");
    assert.notEqual(root.args.runCredential.token, token);
    for (const wrong of [x.session, SERVICE, root.args.runCredential.token, "x".repeat(43)]) {
      assert.equal((await x.tool("delegate", { nodeId: nodes.m1.id }, wrong)).status, 401);
    }
    assert.equal((await x.tool("delegate", { nodeId: nodes.m1.id }, undefined)).status, 401);
    assert.equal((await x.get("/trees", x.runHeaders(token))).status, 401);
    assert.equal((await x.post("/trees", { revision: planned.revision }, x.runHeaders(token))).status, 401);
    assert.equal((await x.post("/den-tools/board_comment", { ref: DISPATCH_REF, text: "forged authority" }, x.runHeaders(token))).status, 401);
    for (const field of ["parentId", "role", "owner", "runtime", "model", "grants", "scopes"]) {
      assert.equal((await x.tool("delegate", { nodeId: nodes.m1.id, [field]: "forged" }, token)).status, 400, field);
    }
    assert.equal((await x.tool("delegate", { nodeId: nodes.r1.id }, token)).status, 403, "owner cannot bypass the manager layer");
    assert.equal((await x.tool("escape", {}, token)).status, 404);
    const manager = await x.tool("delegate", { nodeId: nodes.m1.id }, token);
    assert.equal(manager.status, 201, manager.text);
    const managerRun = fake.spawns.find((record) => record.args.runId === nodes.m1.id);
    assert.ok(managerRun);
    const managerToken = managerRun.args.treeCredential.token;
    assert.notEqual(managerToken, token);
    assert.equal((await x.tool("delegate", { nodeId: nodes.m2.id }, managerToken)).status, 403, "a child cannot claim its sibling's parentage");
    assert.equal((await x.tool("result", { childId: nodes.m2.id }, managerToken)).status, 403, "a sibling's result remains private to its own parent");
    assert.equal((await x.tool("result", { childId: nodes.r1.id }, token)).status, 403, "root cannot read a grandchild through a parent-only capability");
    const ownResult = await x.tool("result", { childId: nodes.m1.id }, token);
    assert.equal(ownResult.status, 200);
    assert.equal(toolBody(ownResult).result.accepted, false, "raw runtime status never counts as verified integration");
    const runner = await x.tool("delegate", { nodeId: nodes.r1.id }, managerToken);
    assert.equal(runner.status, 201, runner.text);
    const runnerRun = fake.spawns.find((record) => record.args.runId === nodes.r1.id);
    assert.ok(runnerRun);
    assert.equal(runnerRun.args.runCredential, undefined, "a leaf inherits no den-board credential");
    assert.equal(runnerRun.args.connections, undefined);
    assert.equal((await x.tool("delegate", { nodeId: nodes.m2.id }, runnerRun.args.treeCredential.token)).status, 403);
    assert.equal(fake.spawns.length, 3, "only the explicitly requested owner, manager and runner start");
    assert.equal((runtime === "claude" ? x.codex : x.claude).spawns.length, 0, "runtime identity never silently falls back");
    const stopped = await x.post(`/agents/${root.args.runId}/stop`, {});
    assert.equal(stopped.status, 202, stopped.text);
    await until(() => fake.spawns.every((record) => record.exited), { what: "owner cancellation to end all descendants" });
    assert.equal((await x.tool("result", { childId: nodes.m1.id }, token)).status, 401, "ended credentials are revoked");
    assert.equal((await x.tool("result", { childId: nodes.r1.id }, managerToken)).status, 401);
  });
}

test("only the exact unsuperseded tree revision can start, with no implicit replay", { timeout: 20000 }, async (t) => {
  const x = await fixture(t);
  const first = await x.plan();
  const second = await x.plan();
  assert.notEqual(first.revision, second.revision);
  assert.equal((await x.post("/trees", { revision: first.revision })).status, 409);
  assert.equal(x.claude.spawns.length, 0);
  await x.start(second);
  assert.equal((await x.post("/trees", { revision: second.revision })).status, 409);
  assert.equal(x.claude.spawns.length, 1);
});

test("workflow tools require the live run credential and reject injected execution authority", { timeout: 30000 }, async (t) => {
  const x = await fixture(t);
  const planned = await x.plan();
  const { root, token } = await x.start(planned);
  const nodes = Object.fromEntries(planned.tree.nodes.map((entry) => [entry.key, entry]));
  const evidence = { criteria: [{ criterion: "Return file locations and evidence.", evidence: "Scoped source inspected." }], checks: [] };
  const bodies = {
    status: {}, yield: { children: [nodes.m1.id] }, complete: evidence,
    review: { ...evidence, candidate: "a".repeat(40), verdict: "pass", findings: [], guardVerdicts: [] },
    skip: { nodes: [nodes.m2.id] },
  };
  for (const [name, body] of Object.entries(bodies)) {
    for (const credential of [undefined, x.session, SERVICE, root.args.runCredential.token, "x".repeat(43)]) {
      assert.equal((await x.tool(name, body, credential)).status, 401, `${name}: credentials cannot cross channels`);
    }
    const foreign = await x.post(`/tree-tools/${name}`, body, { ...x.runHeaders(token), Origin: "http://foreign.example" });
    assert.equal(foreign.status, 403, `${name}: same-origin request required`);
    for (const field of ["parentId", "owner", "runtime", "model", "grants", "scopes", "phase"]) {
      assert.equal((await x.tool(name, { ...body, [field]: "forged" }, token)).status, 400, `${name}: rejects ${field}`);
    }
  }
  assert.equal(x.claude.spawns.length, 1, "invalid workflow calls start no process");
  const status = await x.tool("status", {}, token);
  assert.equal(status.status, 200, status.text);
  assert.ok(status.text.includes(planned.revision), "status names the approved revision");
  assert.ok(status.text.includes(nodes.m1.id), "status exposes the fixed child identity needed for delegation");
  assert.doesNotMatch(status.text, new RegExp(token), "status never reveals per-run credentials");
  const ownReview = await x.tool("review", bodies.review, token);
  assert.ok([403, 409].includes(ownReview.status), `authors cannot self-approve: ${ownReview.status} ${ownReview.text}`);
  for (const children of [[], [nodes.m1.id, nodes.m1.id], Array(5).fill(nodes.m1.id), "not-an-array"]) {
    assert.equal((await x.tool("yield", { children }, token)).status, 400, "yield requires one to four distinct child identities");
  }
  assert.equal((await x.tool("yield", { children: [nodes.r1.id] }, token)).status, 403, "a wait barrier cannot bypass the manager layer");
  for (const completion of [{ checks: [] }, { criteria: [], checks: [] }, { ...evidence, criteria: [{ criterion: "invented", evidence: "claim" }] },
    { ...evidence, checks: [{ command: "invented check", passed: true, evidence: "claim" }] }]) {
    assert.equal((await x.tool("complete", completion, token)).status, 400, "completion must map the exact approved criteria and checks");
  }
  assert.equal((await x.tool("skip", { nodes: [nodes.owner.id] }, token)).status, 409, "the owner cannot skip its own outcome");
  assert.equal((await x.tool("skip", { nodes: [nodes.m1.id] }, token)).status, 409, "an omitted subtree must be explicit in full");
  assert.equal((await x.tool("skip", { nodes: [nodes.m2.id, nodes.m2.id] }, token)).status, 400, "unused node identities must be distinct");
  assert.equal((await x.tool("status", {}, token)).status, 200, "refused evidence does not end the implementation attempt");
  assert.equal(x.claude.spawns.length, 1, "invalid report values do not schedule work");
  for (const route of ["/trees/resume", "/trees/verdict", "/trees/verifier"]) {
    const body = route.endsWith("resume") ? { revision: planned.revision } :
      route.endsWith("verdict") ? { revision: planned.revision, nodeId: nodes.owner.id, candidate: "a".repeat(40), verdict: "approve" } :
        { revision: planned.revision, nodeId: nodes.owner.id, candidate: "a".repeat(40), runtime: "claude", reason: "An explicit user choice is required." };
    for (const credential of [token, root.args.runCredential.token]) {
      assert.equal((await x.post(route, body, x.runHeaders(credential))).status, 401, `${route}: agents cannot become the user`);
    }
  }
});

test("session recovery and verdict routes require exact revision and candidate payloads", { timeout: 20000 }, async (t) => {
  const x = await fixture(t);
  const resume = { revision: "t-0000000000000000" };
  const verdict = { revision: resume.revision, nodeId: "c-0000000000000000", candidate: "a".repeat(40), verdict: "approve" };
  const verifier = { revision: resume.revision, nodeId: verdict.nodeId, candidate: verdict.candidate, runtime: "claude", reason: "Explicit isolated test choice." };
  for (const [route, body] of [["/trees/resume", resume], ["/trees/verdict", verdict], ["/trees/verifier", verifier]]) {
    for (const headers of [{ Origin: x.bridge.url }, x.runHeaders(SERVICE), x.runHeaders("x".repeat(43))]) {
      assert.equal((await x.post(route, body, headers)).status, 401, route);
    }
    assert.equal((await x.post(route, body, { Authorization: `Bearer ${x.session}` })).status, 403);
    for (const field of ["owner", "parentId", "model", "grants", "scopes", "phase", ...(route.endsWith("verifier") ? ["verdict"] : ["runtime"])]) {
      assert.equal((await x.post(route, { ...body, [field]: "forged" })).status, 400, `${route}: ${field}`);
    }
    for (const malformed of [{}, [], { ...body, revision: 7 }]) {
      assert.equal((await x.post(route, malformed)).status, 400, `${route}: malformed body`);
    }
    const unknown = await x.post(route, body);
    assert.ok([404, 409].includes(unknown.status), `a well-formed unknown revision fails closed: ${route} ${unknown.status} ${unknown.text}`);
  }
  for (const malformed of [
    { ...verdict, candidate: "short" }, { ...verdict, candidate: "A".repeat(40) },
    { ...verdict, verdict: "pass" }, { ...verdict, verdict: true }, { ...verdict, nodeId: null },
  ]) assert.equal((await x.post("/trees/verdict", malformed)).status, 400);
  for (const malformed of [
    { ...verifier, candidate: "short" }, { ...verifier, candidate: "A".repeat(40) },
    { ...verifier, runtime: "invented" }, { ...verifier, runtime: null },
    { ...verifier, reason: "" }, { ...verifier, reason: " " }, { ...verifier, reason: "x".repeat(2001) },
  ]) assert.equal((await x.post("/trees/verifier", malformed)).status, 400);
  assert.equal(x.claude.spawns.length + x.codex.spawns.length, 0);
});

test("explicit HTTP recovery starts a fresh review of the frozen candidate without adopting old authority", { timeout: 30000 }, async (t) => {
  const x = await fixture(t);
  const planned = await x.post("/trees/plan", { ...x.proposal(), nodes: [] });
  assert.equal(planned.status, 201, planned.text);
  const { root, token, fake } = await x.start(planned.body);
  const revision = planned.body.revision;
  const ownerId = planned.body.tree.rootId;
  const owner = async () => (await x.get("/trees")).body.trees.find((tree) => tree.id === revision)?.nodes.find((node) => node.id === ownerId);
  await mkdir(path.join(root.args.cwd, "src"), { recursive: true });
  await writeFile(path.join(root.args.cwd, "src/recovery-fixture.mjs"), "export const recoveryFixture = true;\n");
  const criteria = rootContract().acceptanceCriteria.map((criterion) => ({ criterion, evidence: "The isolated criterion was independently inspected." }));
  const completion = await x.tool("complete", { criteria, checks: [] }, token);
  assert.equal(completion.status, 202, completion.text);
  const review = await until(() => fake.spawns.find((run) => run.args.role === "code-reviewer" && !run.exited), { ms: 10000, what: "first independent code review" });
  const candidate = (await owner()).workflow.receipt.candidate;
  const report = await x.tool("review", { candidate, verdict: "pass", criteria, checks: [], findings: [], guardVerdicts: [] }, review.args.treeCredential.token);
  assert.equal(report.status, 200, report.text);
  await until(async () => (await owner())?.workflow?.status === "awaiting-verifier", { ms: 10000, what: "explicit verifier decision" });
  assert.equal(fake.spawns.some((run) => run.args.role === "qa"), false, "missing cross-runtime verification cannot silently downgrade");
  assert.ok(fake.spawns.every((run) => run.exited));
  const before = fake.spawns.length;
  await x.restart();
  assert.equal((await x.tool("status", {}, token)).status, 401, "pre-restart agent credentials grant no recovery authority");
  const resumed = await x.post("/trees/resume", { revision });
  assert.equal(resumed.status, 202, resumed.text);
  const fresh = await until(async () => {
    const restored = await owner();
    assert.notEqual(restored.workflow.status, "paused", restored.workflow.error);
    return fake.spawns.slice(before).find((run) => run.args.role === "code-reviewer" && !run.exited);
  }, { ms: 10000, what: "a fresh resumed independent review" });
  assert.notEqual(fresh.args.runId, review.args.runId);
  assert.notEqual(fresh.args.sessionId, review.args.sessionId);
  assert.notEqual(fresh.args.sessionId, root.args.sessionId);
  const restored = await owner();
  assert.equal(restored.workflow.receipt.candidate, candidate);
  assert.deepEqual(restored.workflow.reviews, {}, "historical reviews never become fresh acceptance");
  assert.ok(!restored.workflow.verifierOverride, "a prior verifier choice grants no new review authority");
});
