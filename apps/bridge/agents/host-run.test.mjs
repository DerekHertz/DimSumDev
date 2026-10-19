// den-v1 loop S4 (ADR 0016 amendment 11): result and cost. Contract:
//
//   The agent view (snapshot and agent frames) gains
//       model       the model id the runtime named, or null
//       usage       { input, cacheWrite, cacheRead, output, final } | null: tokens by tier. While the agent runs it is a
//                   running total that counts each message once (final: false, and its output is an undercount); once
//                   the runtime reports done with totals, those totals replace it (final: true)
//       costUsd     the cost the runtime's done event reported, exactly as reported, or null
//       reply       the first REPLY_EXCERPT_MAX characters of the final reply, masked and escaped, or null
//       durationMs  spawn to exit on the bridge's clock, once the agent has ended, else null
//   `tokens` keeps its old meaning (the context and output of the latest message).
//   The `end` line in sessions.jsonl carries model, usage, costUsd, durationMs, cliMs and turns, and a restarted bridge
//   reads the first four back (each validated, a bad one dropped).
//   Every agent the bridge ran leaves one kind:"agent" row in .scratch/usage.jsonl:
//       { kind, ts, ticket, agent, mode?, model?, tokens, ms, outcome, input_tokens, cache_creation_input_tokens,
//         cache_read_input_tokens, output_tokens, cost_usd, cli_ms?, turns?, source: "bridge", agent, tokens_partial? }
//   `tokens` is the four tiers summed; `tokens_partial: true` marks a row whose counts are the running total because
//   the run ended without reporting its own.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, rename, symlink } from "node:fs/promises";
import path from "node:path";
import { startBridge } from "../server.mjs";
import { makeStateFixture } from "../bridge-fixture.mjs";
import { CODE, login, authed, send } from "../bridge-auth-helpers.mjs";
import { makeBridge, seedSessions, until, DISPATCH_REF, FEATURE } from "./host-test-helpers.mjs";
import { LIVE_STATES, REPLY_EXCERPT_MAX } from "./policy.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";
import { makeStub, alive } from "./claude-stub.mjs";
import { cardFor } from "../../ui/src/overlay/proximity-card.mjs";
import { unconfinedLauncher } from "./launcher-test-helpers.mjs";

const AWS_KEY = ["AKIA", "IOSFODNN7", "EXAMPLE"].join(""); // built here so the root secret scan does not flag the file
const BIDI = String.fromCharCode(0x202e);
const LIVE_FIXTURE = new URL("./fixtures/live.jsonl", import.meta.url);
const LIVE_RESULT = JSON.parse((await readFile(LIVE_FIXTURE, "utf8")).split("\n").filter(Boolean).at(-1));

let t;
const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  await t?.close();
  t = undefined;
});

const ended = (id) =>
  until(async () => {
    const a = await t.agent(id);
    return a && !LIVE_STATES.includes(a.state) && a;
  }, { what: "the agent to end" });
const seen = (id, pred, what) =>
  until(async () => {
    const a = await t.agent(id);
    return a && pred(a) && a;
  }, { what });
const jsonl = async (file) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const usageFile = (root) => path.join(root, ".scratch", "usage.jsonl");
const bridgeRows = async (root = t.fx.root) => (await jsonl(usageFile(root))).filter((r) => r.source === "bridge");
const rowFor = (id, root) => until(async () => (await bridgeRows(root)).find((r) => r.agent === id), { what: "the run's ledger row" });
const usage = (message, tiers) => ({ type: "usage", input: tiers.input + tiers.cacheWrite + tiers.cacheRead, output: tiers.output, message, tiers });
const TOTALS = { input: 6, cacheWrite: 1736, cacheRead: 6274, output: 573 };

describe("tokens by tier while the agent runs", () => {
  test("usage events add up per tier, and a message that is reported twice counts once", async () => {
    t = await makeBridge();
    const { agent } = (await t.dispatch("architect")).body;
    assert.deepEqual([agent.model, agent.usage, agent.costUsd, agent.reply, agent.durationMs], [null, null, null, null, null]);
    const rec = t.fake.spawns[0];
    rec.emit({ type: "model", model: "claude-haiku-5-5" });
    rec.emit(usage("m1", { input: 2, cacheWrite: 1168, cacheRead: 1183, output: 6 }));
    rec.emit(usage("m1", { input: 2, cacheWrite: 1168, cacheRead: 1183, output: 9 })); // the same message, further along
    rec.emit(usage("m2", { input: 2, cacheWrite: 389, cacheRead: 2351, output: 16 }));
    const a = await seen(agent.id, (x) => x.usage?.output === 25, "the running totals");
    assert.deepEqual(a.usage, { input: 4, cacheWrite: 1557, cacheRead: 3534, output: 25, final: false });
    assert.equal(a.model, "claude-haiku-5-5");
    assert.deepEqual(a.tokens, { input: 2 + 389 + 2351, output: 16 }, "tokens is still the latest message's context and output");
    assert.equal(a.costUsd, null, "no cost is known until the run reports one");
  });

  test("messages with no id each count; a usage event with no tiers changes tokens only", async () => {
    t = await makeBridge();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    rec.emit({ type: "usage", input: 41200, output: 3100 }); // a runtime that reports no tiers
    await seen(agent.id, (x) => x.tokens?.input === 41200, "tokens");
    assert.equal((await t.agent(agent.id)).usage, null);
    rec.emit(usage("", { input: 1, cacheWrite: 0, cacheRead: 0, output: 5 }));
    rec.emit(usage("", { input: 1, cacheWrite: 0, cacheRead: 0, output: 5 }));
    const a = await seen(agent.id, (x) => x.usage?.output === 10, "two unnamed messages");
    assert.deepEqual(a.usage, { input: 2, cacheWrite: 0, cacheRead: 0, output: 10, final: false });
  });

  test("bad counts are ignored whole: a negative, fractional or oversized tier never reaches the totals", async () => {
    t = await makeBridge();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    rec.emit(usage("ok", { input: 1, cacheWrite: 2, cacheRead: 3, output: 4 }));
    for (const bad of [{ input: -1 }, { output: 1.5 }, { cacheRead: "3" }, { cacheWrite: 2 ** 60 }, { output: null }]) {
      rec.emit({ ...usage("bad", { input: 1, cacheWrite: 2, cacheRead: 3, output: 4 }), tiers: { input: 1, cacheWrite: 2, cacheRead: 3, output: 4, ...bad } });
    }
    rec.emit({ type: "usage", input: 6, output: 4, message: "bad2", tiers: [1, 2, 3, 4] });
    rec.emit({ type: "model", model: "two words" });
    rec.emit({ type: "model", model: `x${BIDI}` });
    rec.emit({ type: "tool-start", name: "Read", summary: "marker" });
    const a = await seen(agent.id, (x) => x.tool?.summary === "marker", "the events to drain");
    assert.deepEqual(a.usage, { input: 1, cacheWrite: 2, cacheRead: 3, output: 4, final: false });
    assert.equal(a.model, null);
  });
});

describe("the result: reply, cost and the run's own totals", () => {
  test("done replaces the running count with the reported totals; cost, reply, model and duration land on the agent", async () => {
    t = await makeBridge();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    rec.emit({ type: "model", model: "claude-haiku-5-5" });
    rec.emit(usage("m1", { input: 2, cacheWrite: 179, cacheRead: 2740, output: 8 }));
    rec.emit({ type: "reply", text: "Both writes succeeded.\n\nNothing else to do." });
    rec.emit({ type: "done", ok: true, costUsd: 0.34, durationMs: 3692, turns: 3, tiers: TOTALS });
    const a = await ended(agent.id);
    assert.equal(a.state, "done");
    assert.deepEqual(a.usage, { ...TOTALS, final: true });
    assert.equal(a.costUsd, 0.34);
    assert.equal(a.model, "claude-haiku-5-5");
    assert.equal(a.reply, "Both writes succeeded. Nothing else to do.", "the excerpt is one line");
    assert.ok(Number.isInteger(a.durationMs) && a.durationMs >= 0 && a.durationMs < 60_000, `durationMs ${a.durationMs}`);
  });

  test("the end line in sessions.jsonl carries the run record", async () => {
    t = await makeBridge();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    rec.emit({ type: "model", model: "claude-haiku-5-5" });
    rec.emit({ type: "done", ok: true, costUsd: 0.34, durationMs: 3692, turns: 3, tiers: TOTALS });
    const a = await ended(agent.id);
    const end = await until(async () => (await jsonl(t.sessionsFile)).find((l) => l.agentId === agent.id && l.event === "end"), { what: "the end line" });
    assert.deepEqual(
      { state: end.state, model: end.model, usage: end.usage, costUsd: end.costUsd, durationMs: end.durationMs, cliMs: end.cliMs, turns: end.turns },
      { state: "done", model: "claude-haiku-5-5", usage: { ...TOTALS, final: true }, costUsd: 0.34, durationMs: a.durationMs, cliMs: 3692, turns: 3 },
    );
    assert.equal("reply" in end, false, "the reply text is not written to the audit file");
  });

  test("the run leaves one kind:agent row in usage.jsonl with model, tokens by tier, cost, duration and outcome", async () => {
    t = await makeBridge();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    rec.emit({ type: "model", model: "claude-haiku-5-5" });
    rec.emit({ type: "done", ok: true, costUsd: 0.34, durationMs: 3692, turns: 3, tiers: TOTALS });
    const a = await ended(agent.id);
    const row = await rowFor(agent.id);
    assert.ok(!Number.isNaN(Date.parse(row.ts)));
    const { ts, ...rest } = row;
    assert.deepEqual(rest, {
      kind: "agent", ticket: DISPATCH_REF, role: "architect", model: "claude-haiku-5-5",
      tokens: 6 + 1736 + 6274 + 573, ms: a.durationMs, outcome: "done",
      input_tokens: 6, cache_creation_input_tokens: 1736, cache_read_input_tokens: 6274, output_tokens: 573,
      cost_usd: 0.34, cli_ms: 3692, turns: 3, source: "bridge", agent: agent.id,
      runtime: "claude", project: "den", runtime_session_id: agent.sessionId,
    });
    assert.equal((await bridgeRows()).length, 1, "one row per run");
  });

  test("a den-started agent's row names its mode", async () => {
    t = await makeBridge();
    const res = await t.post("/tasks", { role: "scout", text: "Count the steamer baskets." });
    assert.equal(res.status, 201, res.text);
    t.fake.spawns[0].emit({ type: "done", ok: true, costUsd: 0.002 });
    await ended(res.body.agent.id);
    const row = await rowFor(res.body.agent.id);
    assert.deepEqual([row.ticket, row.role, row.mode, row.cost_usd], [res.body.ticket.ref, "scout", "direct", 0.002]);
    assert.equal(JSON.stringify(row).includes("steamer"), false, "no task text in the ledger");
  });

  test("a failed run keeps what it reported; its row says failed", async () => {
    t = await makeBridge();
    const { agent } = (await t.dispatch("architect")).body;
    t.fake.spawns[0].emit({ type: "done", ok: false, costUsd: 0.05, tiers: TOTALS });
    const a = await ended(agent.id);
    assert.deepEqual([a.state, a.costUsd, a.usage.final], ["failed", 0.05, true]);
    assert.equal((await rowFor(agent.id)).outcome, "failed");
  });

  test("a stopped agent that never reported leaves a row too: running totals, marked partial, no cost", async () => {
    t = await makeBridge();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    rec.emit(usage("m1", { input: 2, cacheWrite: 10, cacheRead: 20, output: 3 }));
    await seen(agent.id, (x) => x.usage?.output === 3, "the running totals");
    assert.equal((await t.post(`/agents/${agent.id}/stop`)).status, 202);
    const a = await ended(agent.id);
    assert.deepEqual([a.state, a.costUsd, a.reply], ["terminated", null, null]);
    assert.deepEqual(a.usage, { input: 2, cacheWrite: 10, cacheRead: 20, output: 3, final: false });
    const row = await rowFor(agent.id);
    assert.deepEqual(
      { tokens: row.tokens, out: row.output_tokens, cost: row.cost_usd, outcome: row.outcome, partial: row.tokens_partial },
      { tokens: 35, out: 3, cost: null, outcome: "terminated: stopped-by-user", partial: true },
    );
    assert.equal("model" in row, false);
  });

  test("an agent that reported nothing at all still leaves a row, with zero tokens", async () => {
    t = await makeBridge();
    const { agent } = (await t.dispatch("architect")).body;
    t.fake.spawns[0].exit({ code: 1 });
    const a = await ended(agent.id);
    assert.deepEqual([a.state, a.usage], ["failed", null]);
    const row = await rowFor(agent.id);
    assert.deepEqual([row.tokens, row.input_tokens, row.output_tokens, row.cost_usd, row.outcome, row.tokens_partial], [0, 0, 0, null, "failed", true]);
  });
});

describe("what the run reports is agent output", () => {
  test("the reply excerpt is masked, escaped and cut to its limit", async () => {
    t = await makeBridge();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    rec.emit({ type: "reply", text: `key ${AWS_KEY} here ${BIDI}reversed ${"long ".repeat(200)}` });
    rec.emit({ type: "done", ok: true });
    const a = await ended(agent.id);
    assert.equal(a.reply.includes(AWS_KEY), false);
    assert.equal(a.reply.includes(BIDI), false);
    assert.match(a.reply, /\\u202e/, "the override shows as an escape");
    assert.ok(a.reply.length <= REPLY_EXCERPT_MAX + 1, `length ${a.reply.length}`);
    assert.ok(a.reply.endsWith("…"));
    assert.equal(JSON.stringify(await t.state()).includes(AWS_KEY), false);
  });

  test("a bad cost, duration, turn count or tier on done is dropped; the verdict still counts", async () => {
    t = await makeBridge();
    const { agent } = (await t.dispatch("architect")).body;
    t.fake.spawns[0].emit({ type: "done", ok: true, costUsd: -3, durationMs: "soon", turns: 1.5, tiers: { input: 1, cacheWrite: 1, cacheRead: 1, output: -1 } });
    const a = await ended(agent.id);
    assert.deepEqual([a.state, a.costUsd, a.usage], ["done", null, null]);
    const row = await rowFor(agent.id);
    assert.deepEqual([row.cost_usd, row.tokens, "cli_ms" in row, "turns" in row], [null, 0, false, false]);
    for (const cost of ["0.3", 1e12, Number.POSITIVE_INFINITY, Number.NaN]) {
      const next = (await t.dispatch("architect")).body.agent;
      t.fake.spawns.at(-1).emit({ type: "done", ok: true, costUsd: cost });
      assert.equal((await ended(next.id)).costUsd, null, `cost ${cost}`);
    }
  });

  test("a ledger that cannot be written does not stop the agent from ending or being audited", async () => {
    t = await makeBridge({
      preWrite: async (root) => {
        await rename(usageFile(root), path.join(root, "usage-real.jsonl"));
        await symlink(path.join(root, "usage-real.jsonl"), usageFile(root)); // a symlinked ledger is refused
      },
    });
    const { agent } = (await t.dispatch("architect")).body;
    t.fake.spawns[0].emit({ type: "done", ok: true, costUsd: 0.34 });
    const a = await ended(agent.id);
    assert.equal(a.state, "done");
    await until(async () => (await jsonl(t.sessionsFile)).some((l) => l.agentId === agent.id && l.event === "end"), { what: "the end line" });
    assert.deepEqual((await jsonl(path.join(t.fx.root, "usage-real.jsonl"))).filter((r) => r.source === "bridge"), [], "nothing was written through the link");
    assert.equal((await t.dispatch("architect")).status, 201, "the slot is free again");
  });
});

describe("a restarted bridge reads the run record back", () => {
  const SESSION = "08376463-453a-4135-a7df-4ee921c22e86";
  const ID = "c-0123456789abcdef";
  const spawn = { ts: "2026-10-01T09:00:00.000Z", event: "spawn", agentId: ID, ref: `${FEATURE}/02-ready-p0`, role: "architect", sessionId: SESSION, route: "POST /agents" };
  const end = (over = {}) => ({
    ts: "2026-10-01T09:05:00.000Z", event: "end", agentId: ID, ref: `${FEATURE}/02-ready-p0`, state: "done",
    model: "claude-haiku-5-5", usage: { ...TOTALS, final: true }, costUsd: 0.34, durationMs: 300000, cliMs: 3692, turns: 3, ...over,
  });
  const replayed = async (line) => {
    t = await makeBridge({ preWrite: (root) => seedSessions(root, [spawn, line]) });
    return (await t.state()).agents.find((x) => x.id === ID);
  };

  test("model, tokens by tier, cost and duration come back on the history agent; the reply does not", async () => {
    const a = await replayed(end({ reply: "should never be read" }));
    assert.deepEqual(
      { state: a.state, model: a.model, usage: a.usage, costUsd: a.costUsd, durationMs: a.durationMs, reply: a.reply },
      { state: "done", model: "claude-haiku-5-5", usage: { ...TOTALS, final: true }, costUsd: 0.34, durationMs: 300000, reply: null },
    );
    assert.equal((await bridgeRows()).length, 0, "replay writes no ledger row");
  });

  test("each field is validated on its own and a bad one comes back null (decision 6.9)", async () => {
    const a = await replayed(end({ model: "two words\n", usage: { ...TOTALS, output: -1, final: true }, costUsd: "0.34", durationMs: -5 }));
    assert.deepEqual([a.state, a.model, a.usage, a.costUsd, a.durationMs], ["done", null, null, null, null]);
    await t.close();
    const b = await replayed(end({ usage: { ...TOTALS, final: "yes", extra: "x" }, costUsd: 1e12 }));
    assert.deepEqual([b.model, b.usage, b.costUsd, b.durationMs], ["claude-haiku-5-5", { ...TOTALS, final: false }, null, 300000]);
  });

  test("an end line from before this slice has none of it", async () => {
    const a = await replayed({ ts: "2026-10-01T09:05:00.000Z", event: "end", agentId: ID, ref: `${FEATURE}/02-ready-p0`, state: "done" });
    assert.deepEqual([a.state, a.model, a.usage, a.costUsd, a.durationMs], ["done", null, null, null, null]);
  });
});

// The slice's done-when: the recorded live run (fixtures/live.jsonl, S3), replayed by the stub as the claude binary
// through the real runtime, ends with the CLI's own cost on the agent, in the ledger and on the card.
describe("replaying the recorded live run: the card's cost is the CLI's own", () => {
  test("cost, model and totals match the fixture's result line; the card shows the reply and the badge", { timeout: 30000 }, async () => {
    const stub = await makeStub({ mode: "replay", replayFile: LIVE_FIXTURE.pathname });
    const fx = await makeStateFixture({ git: true });
    const runtime = createClaudeRuntime({ launcher: unconfinedLauncher(), env: { PATH: process.env.PATH, HOME: process.env.HOME, DEN_CLAUDE_BIN: stub.bin } });
    const bridge = await startBridge({ root: fx.root, port: 0, auth: { launchCode: CODE }, runtime, policy: { killGraceMs: 150 } });
    const headers = authed(bridge, await login(bridge));
    cleanups.push(async () => {
      const pid = (await stub.start())?.pid;
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      await bridge.close();
      await fx.cleanup();
    });
    const state = async () => (await send(bridge, { path: "/state" })).body;
    const post = (p, body) => send(bridge, { method: "POST", path: p, body, headers });

    const res = await post("/agents", { ref: DISPATCH_REF, role: "architect" });
    assert.equal(res.status, 201, res.text);
    const id = res.body.agent.id;
    const answered = new Set();
    const agent = await until(async () => {
      const s = await state();
      for (const a of s.approvals.filter((x) => x.agentId === id && x.state === "pending" && !answered.has(x.id))) {
        answered.add(a.id);
        await send(bridge, { path: `/approvals/${a.id}`, headers });
        await post(`/approvals/${a.id}`, { decision: "allow" });
      }
      const mine = s.agents.find((x) => x.id === id);
      return !LIVE_STATES.includes(mine.state) && mine;
    }, { ms: 20000, every: 25, what: "the replayed run to end" });

    assert.equal(agent.state, "done");
    assert.equal(agent.costUsd, LIVE_RESULT.total_cost_usd, "the agent's cost is the result line's total_cost_usd");
    assert.equal(agent.model, "claude-haiku-5-5");
    assert.deepEqual(agent.usage, { input: 6, cacheWrite: 1736, cacheRead: 6274, output: 573, final: true });
    assert.match(agent.reply, /^LIVE-CHECK-OK\./);

    const row = await rowFor(id, fx.root);
    assert.deepEqual(
      [row.cost_usd, row.model, row.cli_ms, row.turns, row.outcome, row.tokens],
      [LIVE_RESULT.total_cost_usd, "claude-haiku-5-5", LIVE_RESULT.duration_ms, LIVE_RESULT.num_turns, "done", 6 + 1736 + 6274 + 573],
    );

    // The card of the architect panda, standing in front of it, reads this agent.
    const card = cardFor([{ id: "architect", name: "Lan", role: "architect", station: "Pass", position: { x: 0, z: -2 }, agent }], [], { x: 0, z: 0, yaw: 0 });
    assert.equal(card.last.label, "Last task: done");
    assert.equal(card.last.cost, "≈0.07¢ API-equiv");
    assert.equal(card.last.costExact, `$${LIVE_RESULT.total_cost_usd.toFixed(6)} reported by the CLI`);
    assert.match(card.last.reply, /^LIVE-CHECK-OK\./);
  });
});
