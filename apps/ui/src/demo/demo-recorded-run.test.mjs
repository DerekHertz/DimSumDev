// den-v1 loop: the demo's scout storyline is the recorded live run of 2026-10-11 (den/04-scout, Haiku, started from
// the den): its tool calls in order, its seven permission requests, its reply and the cost the CLI reported. Times are
// the run's, halved. The developer and qa agents around it are staged (user decision, 2026-10-10).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { createDemoReplay } from "./demo-replay.mjs";
import { DEMO_FIXTURE } from "./demo-fixture.mjs";
import { clock, cardsOf, STEP } from "./demo-test-helpers.mjs";
import { transcriptView } from "../overlay/transcript-view.mjs";
import { liveActorsFromSnapshot } from "../review/live-actors.mjs";

const SCOUT = "demo-scout", REF = "den/04-scout";
const scoutEvents = DEMO_FIXTURE.events.filter((e) => e.agentId === SCOUT || e.id === SCOUT || e.ref === REF);

function pass() {
  const c = clock();
  const replay = createDemoReplay({ now: c.now });
  replay.start();
  const seen = { asks: 0, waitingRows: new Set(), states: [], bound: false, last: null };
  let pending = false;
  for (let ms = 0; ms < DEMO_FIXTURE.loopMs; ms += STEP) {
    c.at(ms);
    replay.tick();
    const s = replay.getState();
    const agent = s.snapshot.agents.find((a) => a.id === SCOUT);
    if (!agent) continue;
    if (seen.states.at(-1) !== agent.state) seen.states.push(agent.state);
    const now = s.snapshot.approvals.some((a) => a.agentId === SCOUT);
    if (now && !pending) seen.asks += 1;
    pending = now;
    const rows = transcriptView(s.transcripts[SCOUT], {}).rows.filter((r) => r.kind === "permission");
    seen.waitingRows.add(rows.filter((r) => r.waiting).length);
    if (liveActorsFromSnapshot(s.snapshot, { now: c.now() }).some((a) => a.role === "scout" && a.ref === REF)) seen.bound = true;
    seen.last = s;
  }
  return seen;
}
const seen = pass();
const end = seen.last;

describe("the scout's storyline is the recorded run", () => {
  test("its tool calls are the run's, in order", () => {
    const tools = scoutEvents.filter((e) => e.type === "tool").map((e) => [e.name, e.summary.split(" ").slice(0, 4).join(" ")]);
    assert.deepEqual(tools.map(([name]) => name), ["Read", "Read", "Bash", "Read", "Bash", "Bash", "Bash", "Bash", "Bash"]);
    assert.equal(tools[3][1], "/repo/package.json");
    assert.match(tools[4][1], /^node apps\/organism-infra\/board\.mjs claim den\/04$/);
    for (const e of scoutEvents.filter((x) => x.type === "tool")) assert.ok(e.input !== undefined && e.result !== undefined, `${e.summary}: the transcript line needs its input and result`);
  });

  test("it asks seven times, one request at a time, and each is answered", () => {
    assert.equal(scoutEvents.filter((e) => e.type === "ask").length, 7);
    assert.deepEqual(scoutEvents.filter((e) => e.type === "ask").map((e) => e.tool), ["Bash", "Read", "Bash", "Bash", "Bash", "Bash", "Bash"]);
    assert.equal(scoutEvents.filter((e) => e.type === "answer").length, 7);
    assert.equal(seen.asks, 7, "a viewer sees seven separate requests");
    assert.deepEqual([...seen.waitingRows].sort(), [0, 1], "the transcript never shows two waiting rows, and an answered one stops waiting");
  });

  test("an answered request reads Allowed by you in the transcript", () => {
    const rows = transcriptView(end.transcripts[SCOUT], {}).rows.filter((r) => r.kind === "permission");
    assert.equal(rows.length, 7);
    assert.deepEqual([...new Set(rows.map((r) => r.label))], ["Allowed by you"]);
  });

  test("the retired scout stays out of the active cast while its recorded run keeps its attribution, reply and cost", () => {
    assert.equal(seen.bound, false, "historical replay must not bring the retired scout back into the active cast");
    assert.deepEqual([...new Set(seen.states)].sort(), ["done", "needs-you", "working"]);
    assert.deepEqual([seen.states[0], seen.states.at(-1)], ["working", "done"]);
    const agent = end.snapshot.agents.find((a) => a.id === SCOUT);
    assert.equal(agent.role, "scout", "historical authorship is preserved");
    assert.equal(agent.costUsd, 0.00375692);
    assert.match(agent.reply, /^The package name is \*\*`dim-sum-dev`\*\*/);
    const card = cardsOf({ ...end.snapshot, agents: [agent] })[0];
    assert.equal(card.last.label, "Last task: done");
    assert.equal(card.last.cost, "≈0.38¢ API-equiv");
    assert.equal(card.last.reply, agent.reply);
    const ticket = end.snapshot.tickets.find((t) => t.ref === REF);
    assert.deepEqual([ticket.status, ticket.holder], ["in-review", null], "the scout released its ticket, as in the run");
  });

  test("the reply is also the transcript's last message", () => {
    const rows = transcriptView(end.transcripts[SCOUT], {}).rows;
    assert.equal(rows.at(-1).kind, "message");
    assert.equal(rows.at(-1).speaker, "Agent");
    assert.match(rows.at(-1).text, /released to `in-review`/);
  });

  test("times are the run's, halved: 76 seconds becomes about 38, and the loop leaves 8 seconds after the last event", () => {
    const done = scoutEvents.find((e) => e.type === "agent" && e.state === "done");
    assert.ok(done.at >= 37000 && done.at <= 39000, `done at ${done.at}`);
    assert.ok(DEMO_FIXTURE.loopMs >= DEMO_FIXTURE.events.at(-1).at + 8000);
    assert.deepEqual(DEMO_FIXTURE.events.map((e) => e.at), DEMO_FIXTURE.events.map((e) => e.at).sort((a, b) => a - b), "events are sorted by time");
  });
});

describe("what the fixture may hold", () => {
  const source = readFileSync(new URL("./demo-fixture.mjs", import.meta.url), "utf8");
  test("no home directory, user name or session id from the machine it was recorded on", () => {
    assert.doesNotMatch(source, /\/home\/|\/Users\/|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    assert.ok(!source.toLowerCase().includes(userInfo().username.toLowerCase()), "the fixture names this machine's user");
  });
  test("the header and the README say which part is recorded and which is staged", () => {
    assert.match(source, /recorded/i);
    assert.match(source, /staged/i);
    const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
    assert.match(readme, /den\/04-scout/);
    assert.match(readme, /staged/i);
  });
});
