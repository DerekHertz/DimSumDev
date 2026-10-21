// organism-infra/143 (ADR 0016 decisions 2, 6.5, 6.6, 6.8; amendment 6): the process half of the Claude adapter.
//
// PINNED INTERFACE (what these tests hold the developer to):
//   apps/bridge/agents/claude-runtime.mjs   export createClaudeRuntime({ controlRoot: "/", launcher: unconfinedLauncher(), env = process.env }) -> CellRuntime
//     - the binary is env.DEN_CLAUDE_BIN, else "claude"; it never comes from a spawn argument
//     - spawn(args) runs  spawn(bin, buildClaudeArgs({ sessionId, agent: role, model? }), { shell: false, detached: true,
//       cwd: args.cwd, env: buildClaudeEnv(env) })  and writes the prompt as ONE stdin line
//       {"type":"user","message":{"role":"user","content":<prompt>}}
//     - capabilities { spawn: true, stop: true, approve: true, send: false, handover: true } (S8 is outcome (c): inbox on)
//     - CellProcess: { handle, events, closeInput(), signal(sig), decide(requestId, { allow, reason? }), exited }
//     - signal(sig) goes to the child's process group (the child is a group leader) and never throws, even after exit
//     - decide answers through encodeControlResponse, echoing the held request's input on allow; an unknown id writes nothing
//     - control_request lines: a can_use_tool request becomes a permission-request event; a repeated id or any other
//       subtype is answered deny on stdin with no event (decodeControlRequest)
//     - spawn rejects when the binary cannot start; stderr is drained (never blocks the child); stdout is decoded
//       through createLineSplitter and parseClaudeLine
//     - resumeCommand(id) contains `--resume <id>`
// The child is a stub script (claude-stub.mjs) behind DEN_CLAUDE_BIN, over real pipes and a real process group.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { until, sleep } from "./host-test-helpers.mjs";
import { makeStub, collect, alive, UTF8_COMMAND } from "./claude-stub.mjs";
import { buildClaudeArgs } from "./claude-adapter.mjs";
import { unconfinedLauncher } from "./launcher-test-helpers.mjs";

async function loadRuntimeModule() {
  try {
    return await import("./claude-runtime.mjs");
  } catch (err) {
    assert.fail(`apps/bridge/agents/claude-runtime.mjs does not exist yet (missing feature): ${err.message}`);
  }
}

const SESSION = "0b8f1c1e-5c1a-4c0e-9a55-3f2d9e7a4b10";
const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

// A stub, a runtime over it, and a spawned process. Everything still alive is killed in afterEach.
async function launch(stubOpts, { args = {}, env = {} } = {}) {
  const { createClaudeRuntime } = await loadRuntimeModule();
  assert.equal(typeof createClaudeRuntime, "function", "claude-runtime.mjs must export createClaudeRuntime");
  const stub = await makeStub(stubOpts);
  const cwd = await mkdtemp(path.join(tmpdir(), "den-claude-cwd-"));
  const runtime = createClaudeRuntime({ controlRoot: "/", launcher: unconfinedLauncher(), env: { PATH: process.env.PATH, HOME: process.env.HOME, DEN_CLAUDE_BIN: stub.bin, ...env } });
  const proc = await runtime.spawn({ role: "architect", ref: "fx/02-ready-p0", cwd, prompt: "do the thing", sessionId: SESSION, ...args });
  const run = collect(proc);
  cleanups.push(async () => {
    try {
      proc.signal("SIGKILL");
    } catch {}
    const gc = await stub.grandchildPid();
    if (gc && alive(gc)) process.kill(gc, "SIGKILL");
  });
  return { stub, cwd, runtime, proc, run };
}

describe("the runtime's declared shape", () => {
  test("capabilities: approve and send on, and a resume command naming the session", async () => {
    const { createClaudeRuntime } = await loadRuntimeModule();
    const rt = createClaudeRuntime({ controlRoot: "/", launcher: unconfinedLauncher(), env: {} });
    assert.deepEqual(rt.capabilities, { spawn: true, stop: true, approve: true, send: true, handover: true, resume: true, treeDelegation: true });
    assert.equal(typeof rt.id, "string");
    assert.match(rt.resumeCommand(SESSION), new RegExp(`--resume ${SESSION}`));
  });
});

// den-mvp outcome 1: every role starts behind the wall, so the --settings value depends on the cwd and the host's home.
// The rest of the argv is the fixed template; the settings are checked for what each test is about.
const settingsOf = (argv) => JSON.parse(argv[argv.indexOf("--settings") + 1]);
const template = (argv) => argv.filter((_, i) => i !== argv.indexOf("--settings") + 1);

describe("what the child is launched with", () => {
  test("argv is exactly buildClaudeArgs, cwd is the given directory, and the prompt is the first stdin line", async () => {
    const { stub, cwd, proc } = await launch({ mode: "hang" });
    await until(async () => (await stub.stdinLines()).length >= 1, { what: "the prompt line" });
    const start = await stub.start();
    assert.deepEqual(template(start.argv), template(buildClaudeArgs({ sessionId: SESSION, agent: "architect" })));
    assert.equal(settingsOf(start.argv).sandbox?.enabled, true, "the wall is on");
    assert.equal(await realpath(start.cwd), await realpath(cwd));
    const [first] = await stub.stdinLines();
    assert.deepEqual(first, { type: "user", message: { role: "user", content: "do the thing" } });
    assert.ok(proc.handle && typeof proc.handle === "string");
  });

  test("a ticket file reaches the argv as the adapter's allow rule; one the adapter cannot express is left out (den-v1 loop: the ticket read)", async () => {
    const file = "/repo/.scratch/den/issues/01-architect.md";
    const a = await launch({ mode: "hang" }, { args: { ticketFile: file } });
    await until(async () => (await a.stub.start()) !== undefined, { what: "the child to start" });
    assert.ok(settingsOf((await a.stub.start()).argv).permissions.allow.includes(`Read(/${file})`));
    const b = await launch({ mode: "hang" }, { args: { ticketFile: "/my repo/.scratch/den/issues/01-architect.md" } });
    await until(async () => (await b.stub.start()) !== undefined, { what: "the second child to start" });
    assert.ok(!(settingsOf((await b.stub.start()).argv).permissions.allow ?? []).some((rule) => rule.startsWith("Read(")), "the read stays a permission request");
  });

  test("a model reaches --model only from the fixed list", async () => {
    const { stub } = await launch({ mode: "hang" }, { args: { model: "sonnet" } });
    await until(async () => (await stub.start()) !== undefined, { what: "the child to start" });
    assert.deepEqual(template((await stub.start()).argv), template(buildClaudeArgs({ sessionId: SESSION, agent: "architect", model: "sonnet" })));
  });

  test("the child's environment is an allowlist: a secret in the bridge's env never reaches it", async () => {
    const { stub } = await launch({ mode: "hang" }, { env: { CANARY_SECRET: "s3cret", ANTHROPIC_API_KEY: "k", GITHUB_TOKEN: "t" } });
    await until(async () => (await stub.start()) !== undefined, { what: "the child to start" });
    const { envKeys } = await stub.start();
    for (const bad of ["CANARY_SECRET", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"]) assert.ok(!envKeys.includes(bad), `${bad} leaked into the child`);
    assert.ok(envKeys.includes("DEN_CLAUDE_BIN"));
    assert.ok(envKeys.includes("PATH"));
  });

  test("a binary named in the spawn arguments is ignored; only DEN_CLAUDE_BIN chooses it", async () => {
    const decoy = await makeStub({ mode: "hang" });
    const { stub } = await launch({ mode: "hang" }, { args: { bin: decoy.bin, command: decoy.bin, claudeBin: decoy.bin, binary: decoy.bin } });
    await until(async () => (await stub.start()) !== undefined, { what: "the real stub to start" });
    await sleep(150);
    assert.equal(await decoy.start(), undefined, "the decoy named in the spawn arguments was run");
  });

  test("a binary that cannot start makes spawn reject (the host then answers 502)", async () => {
    const { createClaudeRuntime } = await loadRuntimeModule();
    const missing = path.join(await mkdtemp(path.join(tmpdir(), "den-claude-none-")), "no-such-claude");
    const rt = createClaudeRuntime({ controlRoot: "/", launcher: unconfinedLauncher(), env: { PATH: process.env.PATH, DEN_CLAUDE_BIN: missing } });
    await assert.rejects(rt.spawn({ role: "architect", ref: "fx/02-ready-p0", cwd: tmpdir(), prompt: "p", sessionId: SESSION }));
  });
});

describe("what the child says", () => {
  test("stdout decodes to events; a permission request is held, an allow echoes the input, and the child finishes", async () => {
    const { stub, proc, run } = await launch({ mode: "approve" });
    await until(() => run.events.some((e) => e.type === "permission-request"), { what: "the permission-request event" });
    const req = run.events.find((e) => e.type === "permission-request");
    assert.deepEqual(req, { type: "permission-request", requestId: "req-1", tool: "Bash", input: { command: "npm test" } });
    assert.ok(run.events.some((e) => e.type === "tool-start" && e.name === "Bash" && e.summary === "npm test"));
    assert.ok(run.events.some((e) => e.type === "usage" && e.input === 10 && e.output === 20));
    await sleep(150);
    assert.ok(!(await stub.stdinLines()).some((l) => l.type === "control_response"), "nothing is answered until the owner decides");

    await proc.decide("req-1", { allow: true });
    const { code, signal } = await proc.exited;
    assert.deepEqual({ code, signal }, { code: 0, signal: null });
    await run.done;
    const resp = (await stub.stdinLines()).find((l) => l.type === "control_response");
    assert.equal(resp.response.request_id, "req-1");
    assert.equal(resp.response.response.behavior, "allow");
    assert.deepEqual(resp.response.response.updatedInput, { command: "npm test" });
    assert.ok(run.events.some((e) => e.type === "tool-end"));
    assert.deepEqual(run.events.at(-1), { type: "done", ok: true, costUsd: 0.0012 }); // the stub's result line names that cost
  });

  test("a deny carries the owner's reason and the child still finishes", async () => {
    const { stub, proc, run } = await launch({ mode: "approve" });
    await until(() => run.events.some((e) => e.type === "permission-request"), { what: "the permission-request event" });
    await proc.decide("req-1", { allow: false, reason: "no thanks" });
    await proc.exited;
    const resp = (await stub.stdinLines()).find((l) => l.type === "control_response");
    assert.equal(resp.response.response.behavior, "deny");
    assert.equal(resp.response.response.message, "no thanks");
    assert.equal(resp.response.response.updatedInput, undefined);
  });

  test("a repeated request id and a non-can_use_tool subtype are answered deny with no event; an unknown id writes nothing", async () => {
    const { stub, proc, run } = await launch({ mode: "dup" });
    await until(async () => (await stub.stdinLines()).filter((l) => l.type === "control_response").length >= 2, { what: "two automatic denies" });
    const resps = (await stub.stdinLines()).filter((l) => l.type === "control_response");
    assert.deepEqual(resps.map((r) => [r.response.request_id, r.response.response.behavior]).sort(), [["req-1", "deny"], ["req-2", "deny"]]);
    assert.deepEqual(run.events.filter((e) => e.type === "permission-request").map((e) => e.requestId), ["req-1"], "only the first req-1 is held");
    const before = (await stub.stdinLines()).length;
    await Promise.resolve(proc.decide("never-asked", { allow: true })).catch(() => {});
    await sleep(200);
    assert.equal((await stub.stdinLines()).length, before, "deciding an id the child never asked wrote to its stdin");
  });

  test("a crash: exited reports the code and the event stream ends without a done event", async () => {
    const { proc, run } = await launch({ mode: "crash" });
    const { code, signal } = await proc.exited;
    assert.deepEqual({ code, signal }, { code: 3, signal: null });
    await run.done;
    assert.ok(run.events.some((e) => e.type === "tool-start"));
    assert.ok(!run.events.some((e) => e.type === "done"));
  });

  test("a 1 MB stderr flood is drained: the child is not blocked and finishes", async () => {
    const { proc, run } = await launch({ mode: "flood" });
    const r = await Promise.race([proc.exited, sleep(8000).then(() => "hung")]);
    assert.notEqual(r, "hung", "the child blocked on a full stderr pipe");
    assert.equal(r.code, 0);
    await run.done;
    assert.deepEqual(run.events.at(-1), { type: "done", ok: true, costUsd: 0.0012 }); // the stub's result line names that cost
  });

  test("multibyte characters split across stdout chunks arrive intact", async () => {
    const { proc, run } = await launch({ mode: "utf8" });
    await proc.exited;
    await run.done;
    const tool = run.events.find((e) => e.type === "tool-start");
    assert.equal(tool?.summary, UTF8_COMMAND);
  });

  test("an over-long stdout line is dropped and the stream carries on", async () => {
    const { proc, run } = await launch({ mode: "oversize" });
    await proc.exited;
    await run.done;
    assert.ok(run.events.some((e) => e.type === "tool-start" && e.summary === "after the big line"));
    assert.deepEqual(run.events.at(-1), { type: "done", ok: true, costUsd: 0.0012 }); // the stub's result line names that cost
  });
});

describe("stopping the child reaches its whole process group", () => {
  test("SIGTERM ends the child and its child", async () => {
    const { stub, proc } = await launch({ mode: "hang", grandchild: "plain" });
    const gc = await until(() => stub.grandchildPid(), { what: "the grandchild pid" });
    assert.ok(alive(gc));
    proc.signal("SIGTERM");
    const r = await Promise.race([proc.exited, sleep(5000).then(() => "hung")]);
    assert.notEqual(r, "hung");
    assert.equal(r.signal, "SIGTERM");
    await until(() => !alive(gc), { ms: 3000, what: "the grandchild to die with the group" });
  });

  test("SIGKILL ends a child that ignores SIGTERM, and a grandchild that ignores it too", async () => {
    const { stub, proc } = await launch({ mode: "hang", grandchild: "ignoreTerm", ignoreTerm: true });
    const gc = await until(() => stub.grandchildPid(), { what: "the grandchild pid" });
    proc.signal("SIGTERM");
    await sleep(300);
    assert.ok(alive(gc), "the grandchild ignores SIGTERM, so it is still here");
    proc.signal("SIGKILL");
    const r = await Promise.race([proc.exited, sleep(5000).then(() => "hung")]);
    assert.notEqual(r, "hung");
    assert.equal(r.signal, "SIGKILL");
    await until(() => !alive(gc), { ms: 3000, what: "the grandchild to die with the group" });
  });

  test("closeInput ends stdin without throwing, and signal after exit is a no-op that never throws", async () => {
    const { proc } = await launch({ mode: "crash" });
    await proc.exited;
    assert.doesNotThrow(() => proc.closeInput());
    assert.doesNotThrow(() => proc.signal("SIGTERM"));
    assert.doesNotThrow(() => proc.signal("SIGKILL"));
  });
});

// den-v1 loop S5: a message to the running child. proc.send(messageId, text) writes one user line carrying the id;
// the child's replay of that line (--replay-user-messages) comes back as { type: "message-applied", id }.
describe("a message to the running child (den-v1 loop S5)", () => {
  const MID = "7b0c2f1e-3a4d-4e5f-8a6b-9c0d1e2f3a4b";

  // den-mvp outcome 2: a follow-up's first message has an id of its own, so its replay is a receipt like any other.
  test("a follow-up resumes the session, and its prompt's replay reads as message-applied", async () => {
    const { stub, run } = await launch({ mode: "message" }, { args: { resume: true, promptId: MID, runId: "c-0123456789abcdef", prompt: "and one more thing" } });
    await until(() => run.events.some((e) => e.type === "message-applied"), { what: "the prompt's receipt" });
    assert.deepEqual(run.events.filter((e) => e.type === "message-applied"), [{ type: "message-applied", id: MID }]);
    const [first] = await stub.stdinLines();
    assert.deepEqual(first, { type: "user", message: { role: "user", content: "and one more thing" }, uuid: MID });
    const argv = (await stub.log()).find((l) => l.kind === "start").argv;
    assert.deepEqual([argv.includes("--session-id"), argv[argv.indexOf("--resume") + 1]], [false, SESSION]);
  });

  test("send writes one user line with the message's id, and the child's replay reads as message-applied", async () => {
    const { stub, proc, run } = await launch({ mode: "message" });
    await until(() => run.events.some((e) => e.type === "tool-start"), { what: "the child to be mid-turn" });
    const text = `also say second${String.fromCharCode(0x2028)}please`;
    await proc.send(MID, text);
    await until(() => run.events.some((e) => e.type === "done"), { what: "the turn to end" });
    const lines = await stub.stdinLines();
    assert.equal(lines.length, 2, "the prompt, then the message: one line each");
    assert.deepEqual(lines[1], { type: "user", message: { role: "user", content: text }, uuid: MID });
    assert.deepEqual(run.events.filter((e) => e.type === "message-applied"), [{ type: "message-applied", id: MID }], "the prompt's own replay is not an acknowledgement");
    const order = run.events.map((e) => e.type);
    assert.equal(order.indexOf("message-applied") < order.indexOf("done"), true);
    assert.match(run.events.find((e) => e.type === "reply").text, /also say second/);
    proc.closeInput();
    assert.equal((await proc.exited).code, 0);
  });

  test("a replay naming an id this process never sent yields no event", async () => {
    const { proc, run } = await launch({ mode: "message", forgeReplay: "00000000-0000-4000-8000-00000000dead" });
    await until(() => run.events.some((e) => e.type === "tool-start"), { what: "the child to be mid-turn" });
    await proc.send(MID, "hello");
    await until(() => run.events.some((e) => e.type === "done"), { what: "the turn to end" });
    assert.deepEqual(run.events.filter((e) => e.type === "message-applied"), [{ type: "message-applied", id: MID }]);
  });

  test("send refuses a bad id or text, and rejects once the child's stdin is closed", async () => {
    const { stub, proc, run } = await launch({ mode: "message" });
    await until(() => run.events.some((e) => e.type === "tool-start"), { what: "the child to be mid-turn" });
    await assert.rejects(proc.send("m-1", "hello"), TypeError);
    await assert.rejects(proc.send(MID, 7), TypeError);
    await assert.rejects(proc.send(MID), TypeError);
    assert.equal((await stub.stdinLines()).length, 1, "nothing but the prompt was written");
    proc.closeInput();
    await proc.exited;
    await assert.rejects(proc.send(MID, "too late"));
  });
});
