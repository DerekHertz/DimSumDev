// den-mvp outcome 2 (spec section 5, and the bridge part of organism-infra/230): the durable role conversation, the
// follow-up that continues an ended run's session, and what a permission request and a stop leave in the thread. Contract:
//
//   GET /conversations/:role?before=&limit=   (token-gated) -> 200 { entries, more, before } | 404 no such role
//       entries: oldest first, each { runId, ref, id, at, kind, ... }; a run opens with { id: 0, kind: "run", mode, resumeOf }
//   POST /conversations/:role/message { text, runId? }   (token-gated, mutating)
//       -> 202 { ok, runId, messageId, resumed: false }          the live run took it as a message
//       -> 201 { ok, runId, messageId, resumed: true, agent }    a new run continues the ended run's session
//       -> 400 bad text or runId; 404 no such role or run; 409 two live runs and none named, or nothing to continue;
//          429 and 503 as for any start
//   approval view: says (the agent's words before the request, or null), intent (the input's description, or null)
//   transcript: permission entries carry approvalId, then note and answeredAt (never the tool's input); a stop leaves { kind: "stop" }
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { startBridge } from "../server.mjs";
import { CODE, login, authed, send } from "../bridge-auth-helpers.mjs";
import { createFakeRuntime } from "./runtime.mjs";
import { makeBridge, until, seedSessions, DISPATCH_REF, NO_GATE_REF, FEATURE, AGENT_ID_RE, UUID_RE } from "./host-test-helpers.mjs";
import { workspaceNames } from "./workspace.mjs";
import { validateEntry } from "./conversations.mjs";

const AWS_KEY = ["AKIA", "IOSFODNN7", "EXAMPLE"].join(""); // built here so the root secret scan does not flag the file
const BIDI = String.fromCharCode(0x202e);

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setup(options = {}) {
  const t = await makeBridge({ ...options, runtimeConfig: { send: true, ...options.runtimeConfig } });
  cleanups.push(() => t.close());
  const get = (p) => send(t.bridge, { path: p, headers: t.headers });
  const thread = async (role, query = "") => (await get(`/conversations/${role}${query}`)).body;
  const say = (role, body) => t.post(`/conversations/${role}/message`, body);
  const start = async (role = "architect", ref = DISPATCH_REF) => {
    const res = await t.bridge.host.start({ ref, role });
    assert.equal(res.ok, true, res.error);
    return { id: res.agent.id, rec: t.fake.spawns.at(-1), agent: res.agent };
  };
  const ended = (id) => until(async () => ["done", "failed", "terminated"].includes((await t.agent(id))?.state), { what: `${id} to end` });
  // A follow-up's first message is taken before its work is done, as the runtime reports for any message.
  const finish = async (run) => {
    if (run.rec.args.promptId) run.rec.emit({ type: "message-applied", id: run.rec.args.promptId });
    run.rec.emit({ type: "done", ok: true });
    await ended(run.id);
  };
  const kinds = async (role) => (await thread(role)).entries.map((e) => e.kind);
  return { ...t, get, thread, say, start, ended, finish, kinds };
}
const file = (root, role) => path.join(root, ".scratch", "_run", "conversations", `${role}.jsonl`);

describe("the durable conversation of a role", () => {
  test("a run's entries are kept with its id and ticket, behind a run marker, and a changed entry reads as its last state", async () => {
    const t = await setup();
    const run = await t.start();
    run.rec.emit({ type: "text", text: "Reading the ticket." });
    run.rec.emit({ type: "tool-start", id: "t1", name: "Read", summary: "ticket.md" });
    run.rec.emit({ type: "tool-result", id: "t1", ok: true, text: "the ticket text" });
    await t.finish(run);
    const { entries, more } = await t.thread("architect");
    assert.equal(more, false);
    assert.deepEqual(entries.map((e) => e.kind), ["run", "message", "tool", "ended"]);
    for (const e of entries) assert.deepEqual([e.runId, e.ref], [run.id, DISPATCH_REF]);
    assert.deepEqual({ id: entries[0].id, mode: entries[0].mode, resumeOf: entries[0].resumeOf }, { id: 0, mode: null, resumeOf: null });
    assert.equal(entries[1].text, "Reading the ticket.");
    assert.deepEqual({ status: entries[2].status, result: entries[2].result }, { status: "done", result: "the ticket text" });
    assert.equal(entries[3].state, "done");
    assert.deepEqual((await t.thread("developer")).entries, [], "another role's conversation is its own");
  });

  test("the file is private, and an unknown role is a 404", async () => {
    const t = await setup();
    await t.finish(await t.start());
    await t.thread("architect");
    assert.equal((await stat(file(t.fx.root, "architect"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(file(t.fx.root, "architect")))).mode & 0o777, 0o700);
    assert.equal((await t.get("/conversations/root")).status, 404);
    assert.equal((await send(t.bridge, { path: "/conversations/architect" })).status, 401, "history needs the steering session");
  });

  test("history comes a page at a time, newest page first", async () => {
    const t = await setup();
    const run = await t.start();
    for (let i = 1; i <= 7; i += 1) run.rec.emit({ type: "text", text: `line ${i}` });
    await t.finish(run);
    const last = await t.thread("architect", "?limit=3");
    assert.deepEqual(last.entries.map((e) => e.text ?? e.kind), ["line 6", "line 7", "ended"]);
    assert.equal(last.more, true);
    const above = await t.thread("architect", `?limit=3&before=${last.before}`);
    assert.deepEqual(above.entries.map((e) => e.text), ["line 3", "line 4", "line 5"]);
    const top = await t.thread("architect", `?limit=200&before=${above.before}`);
    assert.deepEqual(top.entries.map((e) => e.text ?? e.kind), ["run", "line 1", "line 2"]);
    assert.equal(top.more, false);
  });

  test("it outlives the bridge: a restarted bridge serves the same thread", async () => {
    const t = await setup();
    const run = await t.start();
    run.rec.emit({ type: "text", text: "Before the restart." });
    await t.finish(run);
    const before = (await t.thread("architect")).entries;
    await t.bridge.close();
    const again = await startBridge({ root: t.fx.root, port: 0, auth: { launchCode: CODE }, runtime: createFakeRuntime({ send: true }) });
    cleanups.push(() => again.close());
    const headers = authed(again, await login(again));
    const after = (await send(again, { path: "/conversations/architect", headers })).body.entries;
    assert.deepEqual(after, before);
  });

  test("the file is untrusted: a bad line is dropped, text is cleaned again, and unknown keys are not copied", async () => {
    const t = await setup();
    await mkdir(path.dirname(file(t.fx.root, "sre")), { recursive: true });
    const base = { runId: "c-0123456789abcdef", ref: DISPATCH_REF, at: "2026-10-12T10:00:00.000Z" };
    const lines = [
      { ...base, id: 1, kind: "message", role: "agent", text: `key ${AWS_KEY} ${BIDI}end`, pid: 4242, command: "rm -rf /" },
      { ...base, id: 2, kind: "shell", text: "not a kind" },
      { ...base, id: 3, kind: "message", role: "root", text: "not a speaker" },
      { ...base, runId: "../../etc", id: 4, kind: "message", role: "agent", text: "bad run id" },
      { ...base, id: 5, kind: "tool", name: "Bash", summary: "ls", status: "running" },
      { runId: base.runId, ref: "other/99-ticket", id: 5, status: "done", kind: "ended", at: "2030-01-01T00:00:00.000Z", name: "Forged", summary: "rm -rf /" },
      { runId: base.runId, id: 1, role: "user", text: "words the agent never said" },
      "not json",
    ];
    await writeFile(file(t.fx.root, "sre"), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
    const { entries } = await t.thread("sre");
    assert.equal(entries.length, 2);
    assert.deepEqual(Object.keys(entries[0]).sort(), ["at", "id", "kind", "ref", "role", "runId", "text"]);
    assert.ok(!entries[0].text.includes(AWS_KEY) && !entries[0].text.includes(BIDI), "a secret and a bidirectional override do not come back");
    assert.deepEqual(entries[1], { ...base, id: 5, kind: "tool", name: "Bash", summary: "ls", status: "done" }, "a patch changes how an entry turned out, never its kind, time, ticket, name or summary");
    assert.equal(entries[0].role, "agent", "a patch cannot change who spoke or what was said");
    assert.equal(validateEntry({ ...base, id: -1, kind: "ended", state: "done" }), null);
  });
});

describe("a message into a role's conversation", () => {
  test("an unbound chief-of-staff message reaches its existing task rather than opening a desk", async () => {
    const t = await setup();
    const run = await t.start("chief-of-staff");
    const res = await t.say("chief-of-staff", { text: "Continue this task." });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.runId, run.id);
    assert.deepEqual(run.rec.sent.map(m => m.text), ["Continue this task."]);
    assert.equal(t.fake.spawns.length, 1, "no additional reserved desk run is admitted");
  });

  test("with one live run it is that run's message", async () => {
    const t = await setup();
    const run = await t.start();
    const res = await t.say("architect", { text: "  Also check the tests.  " });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.deepEqual({ runId: res.body.runId, resumed: res.body.resumed }, { runId: run.id, resumed: false });
    assert.match(res.body.messageId, UUID_RE);
    assert.deepEqual(run.rec.sent, [{ id: res.body.messageId, text: "Also check the tests." }]);
    assert.equal(t.fake.spawns.length, 1, "no second run was started");
  });

  test("with two live runs of the role it must name the run, and reaches only that one", async () => {
    const t = await setup();
    const a = await t.start("developer", DISPATCH_REF);
    const b = await t.start("developer", NO_GATE_REF);
    const vague = await t.say("developer", { text: "which of you?" });
    assert.equal(vague.status, 409);
    assert.match(vague.body.error, /2 developer runs are live; say which run/);
    const res = await t.say("developer", { text: "for the second", runId: b.id });
    assert.equal(res.status, 202);
    assert.deepEqual([a.rec.sent.length, b.rec.sent.map((m) => m.text)], [0, ["for the second"]]);
    assert.equal((await t.say("architect", { text: "wrong role", runId: b.id })).status, 404, "a run is reached through its own role only");
  });

  test("bad input is refused before anything is sent", async () => {
    const t = await setup();
    await t.start();
    assert.equal((await t.say("architect", { text: "   " })).status, 400);
    assert.equal((await t.say("architect", { text: "x".repeat(3000) })).status, 400);
    assert.equal((await t.say("architect", { text: `use ${AWS_KEY}` })).status, 400);
    assert.equal((await t.say("architect", { text: "hi", runId: "c-nope" })).status, 400);
    assert.equal((await t.say("nobody", { text: "hi" })).status, 404);
    assert.equal((await t.say("qa", { text: "hi" })).status, 404, "a role with no run has nothing to follow up");
    assert.equal(t.fake.spawns[0].sent.length, 0);
  });
});

describe("a follow-up to a run that has ended", () => {
  test("a new run continues the session in the same worktree, with the message as its prompt and a receipt", async () => {
    const t = await setup();
    const first = await t.start();
    await t.finish(first);
    const was = await t.agent(first.id);
    assert.equal(was.followUp, true);

    const res = await t.say("architect", { text: "One more thing: name the risks." });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.resumed, true);
    const next = res.body.agent;
    assert.match(next.id, AGENT_ID_RE);
    assert.notEqual(next.id, first.id, "the follow-up is a run of its own");
    assert.deepEqual([next.sessionId, next.worktree, next.ref, next.role, next.resumeOf], [was.sessionId, was.worktree, was.ref, "architect", first.id]);
    assert.equal(next.followUp, false, "a live run is messaged, not followed up");

    const { args } = t.fake.spawns.at(-1);
    assert.deepEqual([args.resume, args.runId, args.promptId, args.prompt], [true, next.id, res.body.messageId, "One more thing: name the risks."]);
    assert.equal(args.cwd, t.fake.spawns[0].args.cwd);
    assert.equal(args.sessionId, was.sessionId);

    const mine = async () => (await t.thread("architect")).entries.filter((e) => e.runId === next.id);
    assert.deepEqual((await mine()).map((e) => [e.kind, e.resumeOf ?? e.status]), [["run", first.id], ["message", "queued"]]);
    t.fake.spawns.at(-1).emit({ type: "message-applied", id: res.body.messageId });
    await until(async () => (await mine())[1].status === "applied", { what: "the receipt" });

    const lines = (await readFile(t.sessionsFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const spawn = lines.find((l) => l.event === "spawn" && l.agentId === next.id);
    assert.deepEqual([spawn.resumeOf, spawn.origin, spawn.worktree, spawn.route], [first.id, first.id, was.worktree, "POST /conversations/:role/message"]);
    assert.ok(!JSON.stringify(lines).includes("name the risks"), "the audit holds the message's size, never its text");
  });

  test("a follow-up that commits nothing publishes no branch; one that commits gets its own", async () => {
    const t = await setup();
    const git = (...args) => execFileSync("git", ["-C", t.fx.root, ...args], { encoding: "utf8" });
    const first = await t.start("developer");
    await t.finish(first);
    const quiet = (await t.say("developer", { text: "just explain it" })).body.agent;
    await t.finish({ id: quiet.id, rec: t.fake.spawns.at(-1) });
    assert.equal((await t.agent(quiet.id)).branch, null);
    assert.equal(git("branch", "--list", `den/${DISPATCH_REF}-${quiet.id.slice(2, 10)}`).trim(), "");

    const busy = (await t.say("developer", { text: "now change it" })).body.agent;
    const cwd = t.fake.spawns.at(-1).args.cwd;
    execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-m", "follow-up"]);
    await t.finish({ id: busy.id, rec: t.fake.spawns.at(-1) });
    const branch = `den/${DISPATCH_REF}-${busy.id.slice(2, 10)}`;
    assert.equal((await t.agent(busy.id)).branch, branch);
    assert.equal(git("rev-parse", branch).trim(), execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    assert.equal((await t.agent(busy.id)).resumeOf, quiet.id, "a chain of follow-ups stays in the first run's worktree");
    assert.equal(cwd, t.fake.spawns[0].args.cwd);
  });

  test("it is admitted like any start: usage and enforcement are checked again; there is no count limit", async () => {
    const t = await setup();
    const first = await t.start("developer");
    await t.finish(first);

    // Two other tickets run: that is no reason to refuse (portable-den/10).
    const others = [await t.start("developer", NO_GATE_REF), await t.start("qa", `${FEATURE}/05-blocked`)];
    const busy = await t.say("developer", { text: "again", runId: first.id });
    assert.equal(busy.status, 201, JSON.stringify(busy.body));
    await t.finish(busy.body.agent);
    for (const o of others) await t.finish(o);

    await appendFile(`${t.fx.root}/.scratch/usage.jsonl`, JSON.stringify({ kind: "usage", ts: new Date().toISOString(), five_hour: 95, weekly: 10 }) + "\n");
    const over = await t.say("developer", { text: "again", runId: first.id });
    assert.equal(over.status, 429);
    assert.match(over.body.error, /five-hour usage is 95%/);
    assert.equal(t.fake.spawns.filter((s) => s.args.resume).length, 0, "no refused follow-up reached the runtime");
  });

  test("a host that cannot enforce the limits starts no follow-up", async () => {
    const t = await setup();
    const first = await t.start();
    await t.finish(first);
    t.fake.preflight = async () => ({ ok: false, reason: "no user bus" });
    const res = await t.say("architect", { text: "again" });
    assert.equal(res.status, 503);
    assert.match(res.body.error, /^the run was refused: no user bus/);
    assert.equal(t.fake.spawns.length, 1);
  });

  test("a worktree that is gone refuses the follow-up, and a failed start leaves the earlier worktree alone", async () => {
    const t = await setup();
    const first = await t.start();
    await t.finish(first);
    const dir = t.fake.spawns[0].args.cwd;

    t.fake.config.failSpawn = true;
    assert.equal((await t.say("architect", { text: "again" })).status, 502);
    assert.equal((await stat(dir)).isDirectory(), true, "the earlier run's worktree is not cleaned up by a failed follow-up");
    t.fake.config.failSpawn = false;

    await rm(dir, { recursive: true, force: true });
    const res = await t.say("architect", { text: "again" });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /worktree is gone; start a new task/);
    assert.equal((await t.state()).agents.filter((a) => a.state === "working").length, 0, "nothing was left reserved");
  });

  test("a run with no recorded end is not followed up while its resource group is still there, or cannot be asked", async () => {
    const sessionId = "5d3c9a52-8f0e-4b7c-9a41-0e6f1c2b7d90";
    const lost = "c-00000000000000aa";
    const t = await setup({ preWrite: (root) => seedSessions(root, [{ ts: "2026-10-12T10:00:00.000Z", event: "spawn", agentId: lost, ref: DISPATCH_REF, role: "architect", sessionId, ...workspaceNames({ ref: DISPATCH_REF, agentId: lost }) }]) });
    assert.deepEqual([(await t.agent(lost)).reason, (await t.agent(lost)).followUp], ["bridge-restart-unverified", true]);
    const asked = [];
    t.fake.stillRunning = async (id) => (asked.push(id), true);
    const alive = await t.say("architect", { text: "still there?" });
    assert.equal(alive.status, 409);
    assert.match(alive.body.error, /may still be running since the bridge restarted/);
    t.fake.stillRunning = async () => { throw new Error("no bus"); };
    assert.match((await t.say("architect", { text: "still there?" })).body.error, /may still be running/, "an answer that cannot be read is not a no");
    assert.deepEqual([asked, t.fake.spawns.length], [[sessionId], 0]);
    // Gone: the follow-up goes on to its other checks (here the seeded run never had a worktree on disk).
    t.fake.stillRunning = async () => false;
    assert.match((await t.say("architect", { text: "still there?" })).body.error, /worktree is gone/);
  });

  test("a run that is still starting cannot be followed up", async () => {
    const t = await setup({ runtimeConfig: { spawnDelayMs: 150 } });
    const starting = t.bridge.host.start({ ref: DISPATCH_REF, role: "architect" });
    await until(async () => (await t.state()).capacity?.refs?.length > 0 || t.fake.spawns.length > 0, { what: "the spawn to begin" });
    const { agent } = await starting;
    assert.equal(agent.followUp, false);
  });

  test("after a bridge restart the replayed run can still be followed up", async () => {
    const t = await setup();
    const first = await t.start();
    await t.finish(first);
    const was = await t.agent(first.id);
    await t.bridge.close();
    const fake = createFakeRuntime({ send: true });
    const again = await startBridge({ root: t.fx.root, port: 0, auth: { launchCode: CODE }, runtime: fake });
    cleanups.push(async () => {
      for (const r of fake.spawns) if (!r.exited) r.exit();
      await again.close();
    });
    const headers = authed(again, await login(again));
    const res = await send(again, { method: "POST", path: "/conversations/architect/message", body: { text: "still there?" }, headers });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual([res.body.agent.sessionId, res.body.agent.worktree, res.body.agent.resumeOf], [was.sessionId, was.worktree, first.id]);
    assert.equal(fake.spawns[0].args.resume, true);
    const replayed = (await send(again, { path: "/state" })).body.agents.find((a) => a.id === res.body.agent.id);
    assert.equal(replayed.worktree, was.worktree);
  });
});

describe("what an ask and a stop leave in the thread (organism-infra/230)", () => {
  const ask = (rec, requestId, input, tool = "Bash") => rec.emit({ type: "permission-request", requestId, tool, input });
  const approvalsOf = async (t, id) => (await t.state()).approvals.filter((a) => a.agentId === id);

  test("an approval says why: the agent's words before it, and the tool's own description", async () => {
    const t = await setup();
    const run = await t.start();
    run.rec.emit({ type: "text", text: `I need to run the tests\nto see what fails. ${AWS_KEY}` });
    ask(run.rec, "r1", { command: "npm test", description: "Run the test suite" });
    const [a] = await until(async () => { const list = await approvalsOf(t, run.id); return list.length ? list : null; }, { what: "the approval" });
    assert.match(a.says, /^I need to run the tests to see what fails\. /);
    assert.ok(!a.says.includes(AWS_KEY), "a secret in the agent's words is masked");
    assert.equal(a.intent, "Run the test suite");
    assert.equal(a.summary, "npm test");

    // After a tool result the earlier words explain nothing; a request with no description has no intent.
    run.rec.emit({ type: "tool-result", id: "x", ok: true, text: "ok" });
    ask(run.rec, "r2", { file_path: "/tmp/a.txt" }, "Write");
    const b = await until(async () => (await approvalsOf(t, run.id)).find((x) => x.tool === "Write"), { what: "the second approval" });
    assert.deepEqual([b.says, b.intent], [null, null]);

    run.rec.emit({ type: "text", text: "w".repeat(900) });
    ask(run.rec, "r3", { command: "ls", description: "d".repeat(400) });
    const c = await until(async () => (await approvalsOf(t, run.id)).find((x) => x.summary === "ls"), { what: "the third approval" });
    assert.ok(c.says.length <= 501 && c.intent.length <= 201, "both are cut short");
  });

  test("the permission entry carries the ask, then the answer with its note", async () => {
    const t = await setup();
    const run = await t.start();
    run.rec.emit({ type: "text", text: "Deleting the old build." });
    ask(run.rec, "r1", { command: "rm -rf dist", description: "Remove the build output" });
    const [a] = await until(async () => { const list = await approvalsOf(t, run.id); return list.length ? list : null; }, { what: "the approval" });
    const entry = async () => (await t.thread("architect")).entries.find((e) => e.kind === "permission");
    const permissionEntry = await entry();
    const { at, id, runId, ref, source, ...rest } = permissionEntry;
    assert.deepEqual(rest, {
      kind: "permission", name: "Bash", status: "pending", approvalId: a.id, runtime: "claude", project: "den",
    }, "the entry points at its approval; the command and the reason stay there");
    assert.deepEqual(source, { project: "den", runtime: "claude", role: "architect", runId: run.id, entryId: id });
    assert.ok(!(await readFile(file(t.fx.root, "architect"), "utf8")).includes("rm -rf dist"), "no tool input is written to the conversation file");
    const res = await t.post(`/approvals/${a.id}`, { decision: "deny", note: "Keep dist for now." });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const answered = await until(async () => { const e = await entry(); return e.status === "denied" ? e : null; }, { what: "the answer" });
    assert.equal(answered.note, "Keep dist for now.");
    assert.ok(!Number.isNaN(Date.parse(answered.answeredAt)));
    assert.equal((await t.state()).transcripts[run.id].entries.find((e) => e.kind === "permission").note, "Keep dist for now.", "the live transcript shows it too");
  });

  test("a stop leaves a stop entry, closed by the ended entry", async () => {
    const t = await setup();
    const run = await t.start();
    assert.equal((await t.post(`/agents/${run.id}/stop`)).status, 202);
    await t.ended(run.id);
    const tail = (await t.thread("architect")).entries.slice(-2).map((e) => [e.kind, e.status ?? e.state]);
    assert.deepEqual(tail, [["stop", "requested"], ["ended", "terminated"]]);
  });
});

// den-mvp/30: Bao's desk. Bao's thread with no run named goes to the desk ticket, which the bridge writes when it is missing.
describe("Bao's desk: talking to Bao with no ticket", () => {
  const DESK = path.join(".scratch", "den", "issues", "00-bao.md");

  test("the first message starts a walled orchestrator run on the parked desk ticket; the first user message is present before the model can act", async () => {
    const t = await setup();
    const res = await t.say("orchestrator", { text: "What is red on CI right now?" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.resumed, true);
    const rec = t.fake.spawns.at(-1);
    assert.deepEqual([rec.args.role, rec.args.ref], ["orchestrator", "den/00-bao"]);
    assert.match(rec.args.prompt, /You are Bao, the chief of staff, at your desk/);
    assert.match(rec.args.prompt, /change no file/);
    assert.match(rec.args.prompt, /User request:\nWhat is red on CI right now\?/);
    assert.equal(rec.args.promptId, res.body.messageId);
    assert.deepEqual(rec.sent, [], 'no separate bootstrap turn or second user send');
    assert.equal((await t.thread('orchestrator')).entries.filter(e => e.role === 'user')[0].text, 'What is red on CI right now?');
    const ticket = await readFile(path.join(t.fx.root, DESK), "utf8");
    assert.match(ticket, /^\*\*Status:\*\* parked$/m);
    assert.equal(((await t.state()).frontier ?? []).includes("den/00-bao"), false, "the desk is in no queue");
  });

  test("the next message goes to the live desk run; after it ends, a follow-up continues the same session", async () => {
    const t = await setup();
    const first = await t.say("orchestrator", { text: "first" });
    const rec = t.fake.spawns.at(-1);
    const live = await t.say("orchestrator", { text: "second" });
    assert.equal(live.body.resumed, false);
    assert.match(rec.args.prompt, /User request:\nfirst$/);
    assert.deepEqual(rec.sent.map((m) => m.text), ["second"]);
    assert.equal(t.fake.spawns.length, 1);
    for (const m of rec.sent) rec.emit({ type: "message-applied", id: m.id });
    await t.finish({ id: first.body.runId, rec });
    const next = await t.say("orchestrator", { text: "third" });
    assert.equal(next.body.resumed, true);
    const again = t.fake.spawns.at(-1);
    assert.equal(again.args.resume, true);
    assert.equal(again.args.prompt, "third");
  });

  test("an orchestrator run on another ticket does not take the desk's messages, and the desk ticket is never rewritten", async () => {
    const t = await setup();
    const other = await t.start("orchestrator", NO_GATE_REF);
    await mkdir(path.join(t.fx.root, ".scratch", "den", "issues"), { recursive: true });
    await writeFile(path.join(t.fx.root, DESK), "the board's own copy\n");
    other.rec.emit({ type: "done", ok: true });
    await t.ended(other.id);
    const res = await t.say("orchestrator", { text: "hello" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(t.fake.spawns.at(-1).args.ref, "den/00-bao");
    assert.equal(await readFile(path.join(t.fx.root, DESK), "utf8"), "the board's own copy\n");
  });

  test("another role with no run is still a 404: only Bao has a desk", async () => {
    const t = await setup();
    assert.equal((await t.say("developer", { text: "hi" })).status, 404);
    assert.equal(t.fake.spawns.length, 0);
  });
});

test("a desk session whose worktree is gone starts a fresh desk run instead of a 409 (den-mvp/30)", async () => {
  const t = await setup();
  const first = await t.say("orchestrator", { text: "first" });
  const rec = t.fake.spawns.at(-1);
  await t.finish({ id: first.body.runId, rec });
  await rm(rec.args.cwd, { recursive: true, force: true });
  const res = await t.say("orchestrator", { text: "again", runId: first.body.runId });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const fresh = t.fake.spawns.at(-1);
  assert.deepEqual([fresh.args.ref, fresh.args.resume ?? false], ["den/00-bao", false]);
  assert.match(fresh.args.prompt, /User request:\nagain$/);
  assert.equal(fresh.args.promptId, res.body.messageId);
  assert.deepEqual(fresh.sent, []);
});
