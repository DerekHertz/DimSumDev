// organism-infra/140 (criterion 5): .scratch/_run/sessions.jsonl, its modes, and replay validation.
// ADR 0016 decision 4 (registry persistence) and decision 6 items 9 and 10.
//
// LINE SCHEMA (pinned here; each line is one JSON object):
//   spawn: { ts, event: "spawn", agentId, ref, role, sessionId, route }     route is "POST /agents" for the HTTP path, "start()" for the internal entry
//   stop:  { ts, event: "stop",  agentId, ref, route: "POST /agents/:id/stop" }
//   end:   { ts, event: "end",   agentId, ref, state: "terminated" | "done" | "failed", reason? }
// On start the host replays the file. An agent with a spawn line and no end line was live when the last bridge
// stopped: it appears in snapshot `agents` as state "terminated" with reason "bridge-restart-unverified" and a
// resume string. Lines that fail validation are dropped. Nothing read from the file is ever signalled.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE, AGENT_ID_RE, UUID_RE, until, makeBridge, seedSessions } from "./host-test-helpers.mjs";

let t;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const lines = async (b) => (await readFile(b.sessionsFile, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const mode = async (p) => (await stat(p)).mode & 0o777;

describe("sessions.jsonl is written, 0700 dir and 0600 file", () => {
  test("the first dispatch creates .scratch/_run as 0700 and sessions.jsonl as 0600", async () => {
    t = await makeBridge();
    assert.equal((await t.dispatch("architect")).status, 201);
    assert.equal(await mode(path.dirname(t.sessionsFile)), 0o700);
    assert.equal(await mode(t.sessionsFile), 0o600);
  });

  test("a spawn line and, after a stop, a stop line and an end line, each carrying the acting route", async () => {
    t = await makeBridge({ policy: { killGraceMs: 50 } });
    const { agent } = (await t.dispatch("architect")).body;
    const [spawn] = await lines(t);
    assert.equal(spawn.event, "spawn");
    assert.equal(spawn.agentId, agent.id);
    assert.equal(spawn.ref, agent.ref);
    assert.equal(spawn.role, "architect");
    assert.equal(spawn.sessionId, agent.sessionId);
    assert.equal(spawn.route, "POST /agents");
    assert.ok(!Number.isNaN(Date.parse(spawn.ts)));

    assert.equal((await t.post(`/agents/${agent.id}/stop`, {})).status, 202);
    await until(async () => (await lines(t)).some((l) => l.event === "end"), { what: "end line" });
    const all = await lines(t);
    const stop = all.find((l) => l.event === "stop");
    assert.equal(stop.agentId, agent.id);
    assert.equal(stop.route, "POST /agents/:id/stop");
    const end = all.find((l) => l.event === "end");
    assert.equal(end.agentId, agent.id);
    assert.equal(end.state, "terminated");
    assert.ok(all.indexOf(spawn) < all.indexOf(stop) && all.indexOf(stop) < all.indexOf(end), "spawn, stop, end in order");
  });

  test("an agent started through the internal start() is recorded with route \"start()\", not a POST route", async () => {
    t = await makeBridge();
    const { agent } = await t.bridge.host.start({ ref: `${FEATURE}/21-hop`, role: "developer" });
    const [spawn] = await lines(t);
    assert.equal(spawn.event, "spawn");
    assert.equal(spawn.agentId, agent.id);
    assert.equal(spawn.role, "developer");
    assert.equal(spawn.route, "start()");
  });

  test("no secret reaches the file: no token, no launch code", async () => {
    t = await makeBridge();
    await t.dispatch("architect");
    const text = await readFile(t.sessionsFile, "utf8");
    assert.ok(!text.includes(t.token));
  });

  test(".scratch/_run/ is git-ignored", async () => {
    // Either the run folder alone, or the whole board (since the board became its own repo).
    const gitignore = await readFile(path.join(REPO_ROOT, ".gitignore"), "utf8");
    assert.match(gitignore, /^\.scratch\/(_run\/?)?$/m);
  });
});

describe("replay on start", () => {
  const SESSION = "08376463-453a-4135-a7df-4ee921c22e86";
  const spawn = (over = {}) => ({
    ts: "2026-10-01T09:00:00.000Z", event: "spawn", agentId: "c-0123456789abcdef", ref: `${FEATURE}/02-ready-p0`, role: "architect",
    sessionId: SESSION, route: "POST /agents", ...over,
  });

  test("a spawn line with no end line comes back terminated with reason bridge-restart-unverified and a resume string", async () => {
    t = await makeBridge({ preWrite: (root) => seedSessions(root, [spawn()]) });
    const a = (await t.state()).agents.find((x) => x.id === "c-0123456789abcdef");
    assert.ok(a, "the replayed agent is in the snapshot");
    assert.equal(a.state, "terminated");
    assert.equal(a.reason, "bridge-restart-unverified");
    assert.equal(a.resume, t.fake.resumeCommand(SESSION), "the runtime composes the resume string for a replayed agent");
    assert.equal(a.ref, `${FEATURE}/02-ready-p0`);
    assert.equal(a.role, "architect");
    assert.equal(a.sessionId, SESSION);
    assert.equal(t.fake.spawns.length, 0, "replay never starts or signals anything");
  });

  test("an agent with an end line keeps its recorded end state, not the restart reason", async () => {
    t = await makeBridge({
      preWrite: (root) =>
        seedSessions(root, [spawn(), { ts: "2026-10-01T09:05:00.000Z", event: "end", agentId: "c-0123456789abcdef", ref: `${FEATURE}/02-ready-p0`, state: "done" }]),
    });
    const a = (await t.state()).agents.find((x) => x.id === "c-0123456789abcdef");
    assert.equal(a.state, "done");
    assert.notEqual(a.reason, "bridge-restart-unverified");
  });

  test("replayed agents are history: they take no slot and do not block a fresh dispatch of the same ref", async () => {
    const live = (n) => spawn({ agentId: `c-000000000000000${n}`, ref: `${FEATURE}/2${n}-old`, sessionId: `08376463-453a-4135-a7df-4ee921c22e8${n}` });
    t = await makeBridge({ preWrite: (root) => seedSessions(root, [live(1), live(2), live(3), spawn()]) });
    const res = await t.dispatch("architect");
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.agent.state, "working");
  });

  test("every field is validated and a line that fails is dropped (decision 6.9)", async () => {
    const good = spawn();
    const bad = [
      ["a path-shaped agentId", spawn({ agentId: "../../etc/passwd" })],
      ["a short agentId", spawn({ agentId: "c-123" })],
      ["a non-hex agentId", spawn({ agentId: "c-zzzzzzzzzzzzzzzz" })],
      ["a non-UUID sessionId", spawn({ agentId: "c-1111111111111111", sessionId: "../../../etc/passwd" })],
      ["a sessionId with a flag in it", spawn({ agentId: "c-2222222222222222", sessionId: "--dangerously-skip-permissions" })],
      ["a ref that fails the dispatch regex", spawn({ agentId: "c-3333333333333333", ref: "../../x" })],
      ["a ref starting with a dash", spawn({ agentId: "c-4444444444444444", ref: "-a/01-x" })],
      ["an unparseable ts", spawn({ agentId: "c-5555555555555555", ts: "yesterday-ish" })],
      ["a missing ts", (() => { const l = spawn({ agentId: "c-6666666666666666" }); delete l.ts; return l; })()],
      ["a role outside the allowlist", spawn({ agentId: "c-7777777777777777", role: "wizard" })],
      ["a numeric agentId", spawn({ agentId: 12345678 })],
      ["an unknown event", spawn({ agentId: "c-8888888888888888", event: "format-disk" })],
      ["a JSON array", [spawn({ agentId: "c-9999999999999999" })]],
      ["a bare string", "just some text"],
      ["a truncated JSON line", '{"ts":"2026-10-01T09:00:00.000Z","event":"spawn","agentId":"c-aaaaaaaaaaaaaaaa"'],
    ];
    t = await makeBridge({ preWrite: (root) => seedSessions(root, [...bad.map(([, l]) => l), good, ""]) });
    const agents = (await t.state()).agents;
    assert.deepEqual(agents.map((a) => a.id), [good.agentId], `only the valid line survives; got ${JSON.stringify(agents.map((a) => a.id))}`);
    for (const a of agents) {
      assert.match(a.id, AGENT_ID_RE);
      assert.match(a.sessionId, UUID_RE);
    }
  });

  test("a pid or command in a line is never carried into the snapshot", async () => {
    t = await makeBridge({ preWrite: (root) => seedSessions(root, [spawn({ pid: 4242, command: "rm -rf /", cwd: "/etc" })]) });
    const a = (await t.state()).agents.find((x) => x.id === "c-0123456789abcdef");
    assert.ok(a);
    const text = JSON.stringify(a);
    assert.ok(!text.includes("4242") && !text.includes("rm -rf") && !("pid" in a) && !("command" in a), text);
  });

  test("an unreadable mess of a file does not stop the bridge from starting", async () => {
    t = await makeBridge({ preWrite: (root) => seedSessions(root, ["\u0000\u0000\u0000", "{", "}", "null", "12", '"x"']) });
    assert.deepEqual((await t.state()).agents, []);
    assert.equal((await t.dispatch("architect")).status, 201);
  });
});
