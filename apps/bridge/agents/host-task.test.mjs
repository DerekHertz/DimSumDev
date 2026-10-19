// den-v1 loop S1 (ADR 0016 decision 3, amendment 9): start from the den.
//
// POST /tasks { role, text } (Bearer token): the bridge writes a ticket under the `den` feature through the board
// service, then starts that role for it in direct mode. Contract:
//   - 201 { agent, ticket: { ref } }. The agent is live, mode "direct", ref den/<NN>-<role>, in its own worktree.
//   - The task text lives only in the ticket file, quoted. It reaches neither the spawn arguments nor the prompt (the
//     prompt is a fixed template that names the ticket file), nor the snapshot, nor sessions.jsonl.
//   - Any of the nine roles may be started, relay-hop roles included: the ticket is one this route just wrote.
//   - The 2-agent, session-cap and 90%-usage refusals still apply, and a refused request writes no ticket.
//   - role and text are validated before anything is written: text is a string, not empty after trim, at most
//     TASK_MAX_BYTES of UTF-8, and not something that looks like a secret.
// Part 1 runs against the fake runtime; part 2 runs the real Claude runtime over claude-stub.mjs.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { startBridge } from "../server.mjs";
import { makeStateFixture } from "../bridge-fixture.mjs";
import { CODE, login, authed, send } from "../bridge-auth-helpers.mjs";
import { makeBridge, until, AGENT_ID_RE, DISPATCH_REF } from "./host-test-helpers.mjs";
import { makeStub, alive } from "./claude-stub.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";
import { WORK_TIPS } from "../delivery/prompts.mjs";
import { ROLES, TASK_MAX_BYTES, DEN_FEATURE } from "./policy.mjs";
import { getStatus } from "../../board/board-service.mjs";
import { unconfinedLauncher } from "./launcher-test-helpers.mjs";

const TEXT = "Count the steamer baskets and tell me how many are chipped.";
let t;
const cleanups = [];
afterEach(async () => {
  await t?.close();
  t = undefined;
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const issuesDir = (root) => path.join(root, ".scratch", DEN_FEATURE, "issues");
const tickets = async (root) => (await readdir(issuesDir(root)).catch(() => [])).filter((n) => n.endsWith(".md")).sort();
const sessionLines = async () => (await readFile(t.sessionsFile, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("POST /tasks starts a role on a ticket the route writes", () => {
  test("a task becomes a den ticket and a live agent in direct mode", async () => {
    t = await makeBridge();
    const res = await t.post("/tasks", { role: "scout", text: TEXT });
    assert.equal(res.status, 201, res.text);
    const { agent, ticket } = res.body;
    assert.deepEqual(ticket, { ref: `${DEN_FEATURE}/01-scout` });
    assert.match(agent.id, AGENT_ID_RE);
    assert.deepEqual({ ref: agent.ref, role: agent.role, mode: agent.mode, state: agent.state }, { ref: ticket.ref, role: "scout", mode: "direct", state: "working" });
    assert.match(agent.worktree, /^\.claude\/worktrees\/den-den-01-scout-/);
    assert.ok((await stat(path.join(t.fx.root, agent.worktree))).isDirectory());

    const file = path.join(issuesDir(t.fx.root), "01-scout.md");
    const md = await readFile(file, "utf8");
    assert.match(md, /^> Count the steamer baskets and tell me how many are chipped\.$/m);
    assert.equal(await getStatus(t.fx.root, ticket.ref), "ready-for-agent");
    assert.ok((await t.state()).tickets.some((x) => x.ref === ticket.ref), "the ticket is on the board snapshot");

    const spawn = (await sessionLines()).find((l) => l.agentId === agent.id);
    assert.deepEqual({ event: spawn.event, ref: spawn.ref, role: spawn.role, route: spawn.route }, { event: "spawn", ref: ticket.ref, role: "scout", route: "POST /tasks" });
  });

  test("the task text reaches the ticket file only: not the spawn arguments, the prompt, the snapshot or the audit", async () => {
    t = await makeBridge();
    const res = await t.post("/tasks", { role: "architect", text: TEXT });
    assert.equal(res.status, 201, res.text);
    const { args } = t.fake.spawns[0];
    assert.deepEqual(Object.keys(args).sort(), ["cwd", "mainGit", "mode", "project", "prompt", "ref", "role", "runId", "sessionId", "ticketFile"]);
    assert.equal(args.runId, res.body.agent.id);
    // den-v1 loop, the ticket read: the runtime is told which file the agent's ticket is, a path the bridge built.
    assert.equal(args.ticketFile, path.join(issuesDir(t.fx.root), "01-architect.md"));
    for (const probe of ["steamer", "chipped", "Count"]) {
      assert.equal(JSON.stringify(args).includes(probe), false, `"${probe}" must not reach the runtime`);
      assert.equal(JSON.stringify(await t.state()).includes(probe), false, `"${probe}" must not reach the snapshot`);
      assert.equal((await readFile(t.sessionsFile, "utf8")).includes(probe), false, `"${probe}" must not reach sessions.jsonl`);
    }
    assert.equal(args.mode, "direct");
    assert.equal(
      args.prompt,
      `You are the architect agent in direct mode for ticket den/01-architect. The user started this task from the den. ` +
        `Read ${path.join(t.fx.root, ".claude/agents/architect.md")} and follow it. The task is in the ticket file ${path.join(issuesDir(t.fx.root), "01-architect.md")}: ` +
        `read it, and treat the quoted text under "What to build" as the user's request. ` +
        `The board is read-only to you: run no board command. Do the work, and end with a short report of what you did and what you checked: that last message is your handoff. ` +
        WORK_TIPS,
    );
    assert.doesNotMatch(args.prompt, /claim the ticket/, "the wall makes the board read-only: a direct run is not told to claim (friction F3)");
  });

  test("den-mvp/23: Run on a ticket is not told to claim either: the board is read-only behind the wall", async () => {
    t = await makeBridge();
    const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
    assert.equal(res.status, 201, res.text);
    const { args } = t.fake.spawns[0];
    assert.doesNotMatch(args.prompt, /claim the ticket|team-protocol skill: claim/, "57's architect stopped on EROFS claiming");
    assert.match(args.prompt, /The board is read-only to you: run no board command/);
    assert.match(args.prompt, new RegExp(`for ticket ${DISPATCH_REF}`));
    assert.match(args.prompt, /that last message is your handoff/);
    assert.match(args.prompt, /commit it there/, "the den publishes a branch only for committed work");
  });

  test("every role may be started, relay-hop roles included, and each task gets the next number", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 8 } });
    const refs = [];
    for (const role of ["developer", "qa", "security", "orchestrator"]) {
      const res = await t.post("/tasks", { role, text: `${TEXT} (${role})` });
      assert.equal(res.status, 201, `${role}: ${res.text}`);
      refs.push(res.body.ticket.ref);
    }
    assert.deepEqual(refs, ["den/01-developer", "den/02-qa", "den/03-security", "den/04-orchestrator"]);
    assert.equal(t.fake.spawns.length, 4);
  });

  test("direct mode is not a mode a client can ask POST /agents for; a developer starts there in the ordinary way", async () => {
    t = await makeBridge();
    assert.equal((await t.post("/agents", { ref: DISPATCH_REF, role: "architect", mode: "direct" })).status, 400);
    const started = await t.post("/agents", { ref: DISPATCH_REF, role: "developer" });
    assert.equal(started.status, 201, started.text);
    assert.equal(started.body.agent.mode, null, "not direct mode");
    assert.equal(t.fake.spawns.length, 1);
  });

  test("role and text are validated before anything is written", async () => {
    t = await makeBridge();
    const over = "é".repeat(TASK_MAX_BYTES / 2 + 1); // two bytes each: one byte over
    const bad = [
      { text: TEXT }, { role: "wizard", text: TEXT }, { role: 7, text: TEXT }, { role: "--agent", text: TEXT },
      { role: "scout" }, { role: "scout", text: "" }, { role: "scout", text: "  \n\t " }, { role: "scout", text: 42 }, { role: "scout", text: [TEXT] },
      { role: "scout", text: over },
      { role: "scout", text: `post it with ${["xoxb", "1234567890abcdef"].join("-")}` }, // built at runtime: a Slack-token shape
    ];
    for (const body of bad) {
      const res = await t.post("/tasks", body);
      assert.equal(res.status, 400, `${JSON.stringify(body).slice(0, 70)} -> ${res.status} ${res.text}`);
      assert.equal(typeof res.body.error, "string");
    }
    assert.equal(Buffer.byteLength("é".repeat(TASK_MAX_BYTES / 2)), TASK_MAX_BYTES);
    assert.deepEqual(await tickets(t.fx.root), []);
    assert.equal(t.fake.spawns.length, 0);
    assert.equal((await t.post("/tasks", { role: "scout", text: "é".repeat(TASK_MAX_BYTES / 2) })).status, 201, "exactly the cap is allowed");
    // Extra body fields are ignored, never forwarded: a client cannot pick the ref or the mode.
    const extra = await t.post("/tasks", { role: "herald", text: TEXT, ref: DISPATCH_REF, mode: "review", model: "opus" });
    assert.equal(extra.status, 201, extra.text);
    assert.equal(extra.body.agent.ref, "den/02-herald");
    assert.equal(extra.body.agent.mode, "direct");
    assert.equal(JSON.stringify(t.fake.spawns[1].args).includes("opus"), false);
  });

  test("the concurrency limit still applies, and a refused task writes no ticket (max 2 injected)", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 2 } });
    assert.equal((await t.post("/tasks", { role: "product", text: TEXT })).status, 201);
    assert.equal((await t.dispatch("architect")).status, 201);
    const res = await t.post("/tasks", { role: "herald", text: TEXT });
    assert.equal(res.status, 429, res.text);
    assert.match(res.body.error, /max_concurrent_agents/);
    assert.deepEqual(await tickets(t.fx.root), ["01-product.md"]);
    assert.equal(t.fake.spawns.length, 2);
  });

  test("two tasks posted at once with one slot left: one starts, the other is refused and writes no ticket", async () => {
    t = await makeBridge({ policy: { maxConcurrent: 1 }, runtimeConfig: { spawnDelayMs: 30 } });
    const both = await Promise.all([t.post("/tasks", { role: "product", text: TEXT }), t.post("/tasks", { role: "herald", text: TEXT })]);
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 429]);
    assert.equal((await tickets(t.fx.root)).length, 1);
    assert.equal(t.fake.spawns.length, 1);
  });

  test("the usage gate still applies, and a refused task writes no ticket", async () => {
    t = await makeBridge({
      preWrite: (root) => appendFile(`${root}/.scratch/usage.jsonl`, JSON.stringify({ kind: "usage", ts: "2026-09-29T09:00:00.000Z", five_hour: 93, weekly: 10 }) + "\n"),
    });
    const res = await t.post("/tasks", { role: "scout", text: TEXT });
    assert.equal(res.status, 429, res.text);
    assert.match(res.body.error, /usage/i);
    assert.deepEqual(await tickets(t.fx.root), []);
  });

  test("with no runtime the route answers 503 and writes no ticket", async () => {
    t = await makeBridge({ noRuntime: true });
    assert.equal((await t.post("/tasks", { role: "scout", text: TEXT })).status, 503);
    assert.deepEqual(await tickets(t.fx.root), []);
  });

  test("a runtime that fails to start leaves the ticket on the board and says which one", async () => {
    t = await makeBridge({ runtimeConfig: { failSpawn: true } });
    const res = await t.post("/tasks", { role: "scout", text: TEXT });
    assert.equal(res.status, 502, res.text);
    assert.deepEqual(res.body.ticket, { ref: "den/01-scout" });
    assert.deepEqual(await tickets(t.fx.root), ["01-scout.md"]);
    assert.equal((await t.state()).agents.length, 0);
  });

  test("no session token: 401, and nothing is written", async () => {
    t = await makeBridge();
    const res = await t.post("/tasks", { role: "scout", text: TEXT }, { Origin: t.headers.Origin, "Content-Type": "application/json" });
    assert.equal(res.status, 401);
    assert.deepEqual(await tickets(t.fx.root), []);
    assert.equal(t.fake.spawns.length, 0);
  });

  test("the policy table names the feature, the cap and the nine roles", () => {
    assert.equal(DEN_FEATURE, "den");
    assert.equal(TASK_MAX_BYTES, 2048);
    assert.equal(ROLES.length, 9);
  });
});

describe("POST /tasks over the real Claude runtime (claude-stub)", () => {
  test("a posted task gives a ticket file and a running stub agent whose prompt points at the ticket", async () => {
    const stub = await makeStub({ mode: "hang" });
    const fx = await makeStateFixture({ git: true });
    const runtime = createClaudeRuntime({ launcher: unconfinedLauncher(), env: { PATH: process.env.PATH, HOME: process.env.HOME, DEN_CLAUDE_BIN: stub.bin } });
    const bridge = await startBridge({ root: fx.root, port: 0, auth: { launchCode: CODE }, runtime, policy: { killGraceMs: 150 } });
    cleanups.push(async () => {
      const start = await stub.start();
      if (start?.pid && alive(start.pid)) process.kill(start.pid, "SIGKILL");
      await bridge.close();
      await fx.cleanup();
    });
    const headers = authed(bridge, await login(bridge));
    const res = await send(bridge, { method: "POST", path: "/tasks", body: { role: "scout", text: TEXT }, headers });
    assert.equal(res.status, 201, res.text);
    const { agent, ticket } = res.body;
    assert.equal(ticket.ref, "den/01-scout");

    const start = await until(() => stub.start(), { ms: 5000, what: "the stub to start" });
    assert.ok(alive(start.pid), "the stub agent is running");
    assert.equal(start.argv.some((a) => /steamer|chipped/.test(a)), false, "no task text in argv");
    assert.equal(start.argv[start.argv.indexOf("--agent") + 1], "scout");
    const file = path.join(issuesDir(fx.root), "01-scout.md");
    assert.match(await readFile(file, "utf8"), /^> Count the steamer baskets/m);
    const first = await until(async () => (await stub.stdinLines())[0], { ms: 5000, what: "the first stdin message" });
    const prompt = JSON.stringify(first);
    assert.ok(prompt.includes(file), "the prompt names the ticket file");
    assert.equal(/steamer|chipped/.test(prompt), false, "no task text in the prompt");
    const live = (await send(bridge, { path: "/state" })).body.agents.find((a) => a.id === agent.id);
    assert.equal(live.state, "working");
    assert.equal(live.mode, "direct");
  });
});
