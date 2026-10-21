// Public HTTP and per-run credential contract with injected adapters only.
// The Codex identity here proves routing, never live production conformance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir } from "node:fs/promises";
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
const toolBody = (response) => JSON.parse(response.body.text);

function adapter(runtime) {
  const fake = createFakeRuntime();
  fake.capabilities.treeDelegation = true;
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
  const bridge = await startBridge({ root: fx.root, port: 0,
    auth: { launchCode: CODE, serviceToken: SERVICE }, runtimes: { claude, codex }, policy: { killGraceMs: 30 },
    // The compiled catalog seam avoids Linux-only script-path validation on Windows.
    // Injected runtimes execute no catalog script; token minting and auth remain real.
    library: createLibrary({ catalog: { connections: [DEN] }, denRoot: fx.root }),
  });
  t.after(async () => {
    for (const fake of [claude, codex]) for (const record of fake.spawns) record.exit();
    await bridge.close();
    await fx.cleanup();
  });
  const session = await login(bridge);
  const headers = authed(bridge, session);
  const post = (url, body, auth = headers) => send(bridge, { method: "POST", path: url, body, headers: auth });
  const get = (url, auth = headers) => send(bridge, { path: url, headers: auth });
  const runHeaders = (token) => authed(bridge, token);
  const tool = (name, body, token) => post(`/tree-tools/${name}`, body, runHeaders(token));
  await bridge.host.admission.approve(DISPATCH_REF, { owner: runtime === "claude" ? "bao" : "jiao" });
  const proposal = () => ({ ref: DISPATCH_REF, runtime, scopes: ["src"], nodes: contracts() });
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
  return { fx, bridge, claude, codex, session, headers, post, get, runHeaders, tool, proposal, plan, start };
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
