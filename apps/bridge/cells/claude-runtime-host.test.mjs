// organism-infra/143: the Claude runtime wired into the bridge, end to end over HTTP.
//
// Part 1: startBridge({ runtime: createClaudeRuntime(...stub...) }): POST /agents spawns the child, the snapshot shows its
// tool and tokens, a can_use_tool request becomes an approval, an allow reaches the child, and a stop ends the child and
// everything in its process group.
// Part 2: `node apps/bridge/server.mjs` as a subprocess. The production entry must construct the default Claude runtime,
// or POST /agents is 503 "no runtime is configured" in production (the gap 142 left). DEN_CLAUDE_BIN points at the stub.
import { test, describe, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { startBridge } from "../server.mjs";
import { makeStateFixture } from "../bridge-fixture.mjs";
import { CODE, login, authed, send } from "../bridge-auth-helpers.mjs";
import { DISPATCH_REF, until, sleep } from "./host-test-helpers.mjs";
import { LIVE_STATES } from "./policy.mjs";
import { makeStub, alive } from "./claude-stub.mjs";
import { hostPid, unconfinedLauncher } from "./launcher-test-helpers.mjs";
import { cgroupOf, createResourceLauncher, findUserBus } from "./resource-group.mjs";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function loadCreate() {
  try {
    return (await import("./claude-runtime.mjs")).createClaudeRuntime;
  } catch (err) {
    assert.fail(`apps/bridge/cells/claude-runtime.mjs does not exist yet (missing feature): ${err.message}`);
  }
}

// A bridge over the real Claude runtime, the stub as the binary.
async function boot(stubOpts, { launcher = unconfinedLauncher() } = {}) {
  const createClaudeRuntime = await loadCreate();
  const stub = await makeStub(stubOpts);
  const fx = await makeStateFixture({ git: true });
  const runtime = createClaudeRuntime({ launcher, env: { PATH: process.env.PATH, HOME: process.env.HOME, DEN_CLAUDE_BIN: stub.bin } });
  const bridge = await startBridge({ root: fx.root, port: 0, auth: { launchCode: CODE }, runtime, policy: { killGraceMs: 150 } });
  const token = await login(bridge);
  const headers = authed(bridge, token);
  const post = (p, body = {}) => send(bridge, { method: "POST", path: p, body, headers });
  const agent = async (id) => (await send(bridge, { path: "/state" })).body.agents?.find((a) => a.id === id);
  cleanups.push(async () => {
    const start = await stub.start();
    const gc = await stub.grandchildPid();
    // An enforced run reports namespace pids (den-mvp/35); its own group kill reaches them, and a host kill of that number would hit a stranger.
    if (!launcher.enforced) for (const pid of [start?.pid, gc]) if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    await bridge.close();
    await fx.cleanup();
  });
  return { stub, bridge, headers, post, agent, state: async () => (await send(bridge, { path: "/state" })).body };
}

describe("startBridge over the real Claude runtime", () => {
  test("POST /agents dispatches; the snapshot shows the tool and the tokens; the agent can be approved", async () => {
    const t = await boot({ mode: "approve" });
    const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
    assert.ok([201, 202].includes(res.status), `dispatch answered ${res.status} ${res.text}`);
    const { id, capabilities } = res.body.agent;
    assert.equal(capabilities.approve, true);
    assert.equal(capabilities.send, true); // den-v1 loop S5
    const a = await until(async () => {
      const cur = await t.agent(id);
      return cur?.tool?.name === "Bash" && cur.tokens ? cur : null;
    }, { ms: 5000, what: "the agent to show a tool and tokens" });
    assert.deepEqual(a.tokens, { input: 10, output: 20 });

    const approval = await until(async () => (await t.state()).approvals?.find((x) => x.agentId === id), { ms: 5000, what: "the approval" });
    assert.equal(approval.tool, "Bash");
    const detail = await send(t.bridge, { path: `/approvals/${approval.id}`, headers: t.headers });
    assert.equal(detail.status, 200);
    const decided = await t.post(`/approvals/${approval.id}`, { decision: "allow" });
    assert.equal(decided.status, 200);

    await until(async () => !LIVE_STATES.includes((await t.agent(id)).state), { ms: 5000, what: "the agent to end" });
    assert.equal((await t.agent(id)).state, "done");
    const resp = (await t.stub.stdinLines()).find((l) => l.type === "control_response");
    assert.equal(resp?.response.response.behavior, "allow");
    assert.deepEqual(resp.response.response.updatedInput, { command: "npm test" });
  });

  test("POST /agents/:id/stop ends a stubborn child and its grandchild, and the agent is terminated", async () => {
    const t = await boot({ mode: "hang", grandchild: "ignoreTerm", ignoreTerm: true });
    const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
    assert.ok([201, 202].includes(res.status), `dispatch answered ${res.status} ${res.text}`);
    const { id } = res.body.agent;
    const gc = await until(() => t.stub.grandchildPid(), { ms: 5000, what: "the grandchild pid" });
    const { pid } = await until(() => t.stub.start(), { what: "the child to start" });
    const stopped = await t.post(`/agents/${id}/stop`, {});
    assert.equal(stopped.status, 202, "ADR 0016 status table: the kill sequence has started");
    await until(async () => (await t.agent(id)).state === "terminated", { ms: 6000, what: "the agent to be terminated" });
    await until(() => !alive(pid) && !alive(gc), { ms: 3000, what: "the child and grandchild to be gone" });
  });
});

// den-mvp outcome 1: the same wiring with the enforced launcher, on real control groups. Reduced limits and a slice of
// this test's own, so the probes stay small; skipped, with the launcher's reason, where the host cannot enforce.
const enforceEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
const enforceable = await createResourceLauncher({ env: enforceEnv }).preflight();
const LIVE_LIMITS = { classes: { worker: { memoryMiB: 160, cpuPercent: 50, tasks: 48 }, bao: { memoryMiB: 160, cpuPercent: 50, tasks: 48 }, scout: { memoryMiB: 160, cpuPercent: 50, tasks: 48 } }, aggregate: { memoryMiB: 512, cpuPercent: 100, tasks: 160 }, storage: { jobMiB: 16, outputMiB: 1 }, checks: { memoryMiB: 160, cpuPercent: 50, tasks: 48 }, guard: { memoryMiB: 160, cpuPercent: 50, tasks: 48 } };
const LIVE_SLICE = `den-test-h${process.pid}`;
const processGroup = (pid) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[2]);

describe("the Claude runtime behind the enforced launcher (live)", { skip: enforceable.ok ? false : `this host cannot enforce the limits: ${enforceable.reason}` }, () => {
  const live = () => ({ launcher: createResourceLauncher({ env: enforceEnv, limits: LIVE_LIMITS, slice: LIVE_SLICE }) });
  after(async () => {
    for (const verb of ["revert", "stop"]) await new Promise((resolve) => execFile("systemctl", ["--user", verb, `${LIVE_SLICE}.slice`], { env: findUserBus(enforceEnv).env, timeout: 5000 }, () => resolve()));
  });

  test("a stop reaches a grandchild that left the process group: the whole resource group is gone", { timeout: 30000 }, async () => {
    const t = await boot({ mode: "hang", grandchild: "detached", ignoreTerm: true }, live());
    const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
    assert.equal(res.status, 201, res.text);
    const { id, sessionId } = res.body.agent;
    const gc = await until(() => t.stub.grandchildPid(), { ms: 5000, what: "the grandchild pid" });
    const ns = await until(() => t.stub.start(), { what: "the child to start" });
    const scope = `/${LIVE_SLICE}.slice/den-run-${sessionId}.scope`;
    // The stub reports its pid inside the run's pid namespace; the host knows it by another (den-mvp/35).
    const [pid, gcHost] = [ns.pid, gc].map((n) => hostPid(n, scope) ?? assert.fail(`no host process is pid ${n} in ${scope}`));
    for (const p of [pid, gcHost]) assert.ok((cgroupOf(p) ?? "").endsWith(scope), `pid ${p} is in ${cgroupOf(p)}`);
    assert.notEqual(processGroup(gcHost), processGroup(pid), "the grandchild is outside the child's process group");
    assert.notEqual(cgroupOf(process.pid), cgroupOf(pid), "the bridge is outside the agents' group");
    assert.equal((await t.post(`/agents/${id}/stop`, {})).status, 202);
    await until(async () => (await t.agent(id)).state === "terminated", { ms: 6000, what: "the agent to be terminated" });
    await until(() => !alive(pid) && !alive(gcHost), { ms: 3000, what: "the child and the detached grandchild to be gone" });
    assert.equal((await t.agent(id)).reason, "stopped-by-user");
  });

  test("a child that passes its memory limit is killed by the kernel, and the agent fails with the limit named", { timeout: 30000 }, async () => {
    const t = await boot({ mode: "hog" }, live());
    const res = await t.post("/agents", { ref: DISPATCH_REF, role: "developer" });
    assert.equal(res.status, 201, res.text);
    const { id, sessionId } = res.body.agent;
    await until(async () => (await t.agent(id)).state === "failed", { ms: 20000, what: "the agent to fail" });
    assert.equal((await t.agent(id)).reason, "resource-limit: memory");
    const { pid } = await t.stub.start();
    // pid is the stub's number inside its run's namespace: gone means no process of that number is left in the run's scope (den-mvp/35).
    await until(() => hostPid(pid, `/${LIVE_SLICE}.slice/den-run-${sessionId}.scope`) === null, { ms: 3000, what: "the child to be gone" });
    assert.equal((await t.state()).agents.filter((a) => LIVE_STATES.includes(a.state)).length, 0, "nothing restarted it");
  });
});

describe("the production entry (node apps/bridge/server.mjs)", () => {
  // den-mvp outcome 1: the production entry has no unconfined path. Where the host can enforce the hardware limits the stub
  // starts inside its resource group; where it cannot, the dispatch is refused with the reason and nothing is launched.
  test("wires the default Claude runtime behind the enforced launcher: it starts in a resource group, or is refused and starts nothing", { timeout: 30000 }, async () => {
    const enforceable = await createResourceLauncher({ env: { PATH: process.env.PATH, HOME: process.env.HOME } }).preflight();
    const stub = await makeStub({ mode: "hang" });
    const fx = await makeStateFixture({ git: true });
    const port = await new Promise((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const { port } = s.address();
        s.close(() => resolve(port));
      });
    });
    const child = spawn(process.execPath, [SERVER], {
      cwd: fx.root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), ORGANISM_ROOT: fx.root, DEN_CLAUDE_BIN: stub.bin },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    cleanups.push(async () => {
      if (child.exitCode === null) child.kill("SIGKILL");
      await fx.cleanup();
    });
    await until(() => /#code=\S+/.test(out) || child.exitCode !== null, { ms: 10000, what: "the launch code line" });
    const m = out.match(/#code=(\S+)/);
    assert.ok(m, `the server exited before it printed a code (stderr: ${err.slice(0, 300)})`);
    const bridge = { port };
    const token = await login(bridge, m[1]);
    const res = await send(bridge, { method: "POST", path: "/agents", body: { ref: DISPATCH_REF, role: "architect" }, headers: authed(bridge, token) });
    if (!enforceable.ok) {
      assert.equal(res.status, 503, `an unenforceable host must refuse: ${res.status} ${res.text}`);
      assert.match(res.body.error, /^the run was refused: /);
      assert.ok(res.body.error.includes(enforceable.reason.slice(0, 40)), `the refusal names the blocker: ${res.body.error}`);
      await sleep(300);
      assert.equal(await stub.start(), undefined, "the CLI was never launched");
      const state = await send(bridge, { method: "GET", path: "/state", headers: authed(bridge, token) });
      assert.deepEqual(state.body.agents, [], "no agent was recorded");
      child.kill("SIGTERM");
      return;
    }
    assert.ok([201, 202].includes(res.status), `dispatch answered ${res.status} ${res.text}`);
    await until(async () => (await stub.start()) !== undefined, { ms: 5000, what: "the stub binary named by DEN_CLAUDE_BIN to be launched" });
    const { pid } = await stub.start();
    const scope = /\/den-agents\.slice\/den-run-[0-9a-f-]+\.scope$/;
    const host = hostPid(pid, scope); // the stub's pid is its number inside the run's namespace (den-mvp/35)
    assert.ok(host !== null, "the CLI runs in its own scope under the agents slice");
    assert.match(cgroupOf(host) ?? "", scope);
    cleanups.push(async () => { if (alive(host)) process.kill(host, "SIGKILL"); });
    await sleep(50);
    child.kill("SIGTERM");
  });
});
