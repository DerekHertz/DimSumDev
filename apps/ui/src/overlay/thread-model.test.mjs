// den-mvp outcome 2 and the signed-off organism-infra/230 spec ("Acceptance for qa"): the pure models of the thread.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toolVerb, detailLabel, reasonText, threadEntries, threadView, footModel, stopModel, NO_REASON, NO_REPLY_MS, STILL_STOPPING_MS } from "./thread-model.mjs";

const RUN = "c-00000000000000aa";
const OLD = "c-00000000000000bb";
const REF = "den/12-fix-the-steamer";
const T0 = Date.parse("2026-10-12T11:00:00.000Z");
const at = (s) => new Date(T0 + s * 1000).toISOString();
const live = (entries) => threadEntries({ buffer: { entries: entries.map((e, i) => ({ id: i + 1, ...e })), dropped: 0 }, agentId: RUN });
const view = (entries, ui = {}) => threadView(live(entries), { now: T0, agents: [{ id: RUN, state: "working" }], ...ui });
const texts = (row) => row.chips.map((c) => `${c.state}:${c.text}`);

describe("toolVerb and reasonText", () => {
  test("each tool reads as what it asks to do", () => {
    assert.deepEqual(["Bash", "Write", "Edit", "Read", "Glob", "Grep", "WebFetch", "WebSearch"].map(toolVerb),
      ["run a command", "change a file", "change a file", "read a file", "search files", "search files", "open a web page", "search the web"]);
    assert.equal(toolVerb("mcp__thing__do"), "use mcp__thing__do");
    assert.equal(toolVerb(undefined), "use a tool");
    assert.equal(toolVerb("constructor"), "use constructor", "an inherited name is not a tool");
    assert.deepEqual(["Bash", "Edit", "Grep", "Other"].map(detailLabel), ["Command", "File", "Query", "Request"]);
  });

  test("the agent's words win, then the tool's description, then the fallback; long text is cut", () => {
    assert.deepEqual(reasonText({ says: "  I need the tests.  ", intent: "Run tests" }), { text: "I need the tests.", fallback: false });
    assert.deepEqual(reasonText({ says: null, intent: "Run tests" }), { text: "Run tests", fallback: false });
    assert.deepEqual(reasonText({ says: "   ", intent: null }), { text: NO_REASON, fallback: true });
    assert.deepEqual(reasonText(), { text: NO_REASON, fallback: true });
    assert.equal(reasonText({ says: "w".repeat(900) }).text.length, 501);
    assert.equal(reasonText({ intent: "d".repeat(900) }).text.length, 201);
  });
});

describe("threadEntries: history above the live run", () => {
  const history = [
    { runId: OLD, ref: REF, id: 0, kind: "run", at: at(-600) },
    { runId: OLD, ref: REF, id: 1, kind: "message", role: "agent", text: "earlier", at: at(-590) },
    { runId: RUN, ref: REF, id: 1, kind: "message", role: "agent", text: "stale copy", at: at(0) },
  ];

  test("other runs come from history, this run from its live buffer, and numbers do not shift when a page is added", () => {
    const buffer = { entries: [{ id: 1, kind: "message", role: "agent", text: "fresh", at: at(0) }], dropped: 0 };
    const one = threadEntries({ history, buffer, agentId: RUN });
    assert.deepEqual(one.entries.map((e) => [e.runId, e.text ?? e.kind, e.n]), [[OLD, "run", -2], [OLD, "earlier", -1], [RUN, "fresh", 1]]);
    const more = threadEntries({ history: [{ runId: OLD, ref: REF, id: 9, kind: "ended", state: "done", at: at(-900) }, ...history], buffer, agentId: RUN });
    assert.deepEqual(more.entries.map((e) => e.n), [-3, -2, -1, 1]);
  });

  test("with no live buffer (a restarted bridge) this run's entries come from history too", () => {
    const { entries } = threadEntries({ history, buffer: undefined, agentId: RUN });
    assert.deepEqual(entries.map((e) => e.text ?? e.kind), ["run", "earlier", "stale copy"]);
    assert.deepEqual(threadEntries().entries, []);
  });
});

describe("threadView: asks", () => {
  const approval = { id: "a-1", agentId: RUN, tool: "Bash", state: "pending", summary: "npm test -- --watch=false", says: "I need to run the tests.", intent: "Run the test suite", expiresAt: at(290) };

  test("a waiting ask leads with the reason, then the tool's own description, then the command", () => {
    const [row] = view([{ kind: "permission", name: "Bash", status: "pending", approvalId: "a-1", at: at(0) }], { approvals: [approval] }).rows;
    assert.equal(row.kind, "ask");
    assert.equal(row.head, "Asking to run a command · waiting on you · expires in 5 min");
    assert.deepEqual([row.reason, row.reasonFallback, row.intent, row.detailLabel, row.command, row.answerable],
      ["I need to run the tests.", false, "Run the test suite", "Command", "npm test -- --watch=false", true]);
  });

  test("the description is not repeated when it is the reason, and silence gets the fallback line", () => {
    const entry = { kind: "permission", name: "Bash", status: "pending", approvalId: "a-1", at: at(0) };
    const same = view([entry], { approvals: [{ ...approval, says: null }] }).rows[0];
    assert.deepEqual([same.reason, same.intent], ["Run the test suite", null]);
    const silent = view([entry], { approvals: [{ ...approval, says: null, intent: null }] }).rows[0];
    assert.deepEqual([silent.reason, silent.reasonFallback], [NO_REASON, true]);
  });

  test("an ask of a run that has ended, or with no approval left, cannot be answered from the thread", () => {
    const entry = { kind: "permission", name: "Bash", status: "pending", approvalId: "a-1", at: at(0) };
    assert.equal(view([entry], { approvals: [approval], agents: [{ id: RUN, state: "terminated" }] }).rows[0].answerable, false);
    const unnamed = view([{ ...entry, approvalId: undefined }], { approvals: [approval] }).rows[0];
    assert.deepEqual([unnamed.kind, unnamed.approvalId], ["ask", "a-1"], "an entry with no approval id finds the run's pending request for its tool");
    const lost = view([entry], { approvals: [] }).rows[0];
    assert.deepEqual([lost.kind, lost.label], ["asked", "Asked to run a command · waiting on you"]);
    const expired = view([{ ...entry, status: "expired" }], { approvals: [{ ...approval, state: "expired" }] }).rows[0];
    assert.deepEqual([expired.kind, expired.label, expired.waiting], ["asked", "Asked to run a command · expired: denied", false]);
  });

  test("an answered ask becomes the user's answer with its note and a receipt of what the agent did next", () => {
    const denied = { kind: "permission", name: "Bash", status: "denied", approvalId: "a-1", note: "Keep dist for now.", at: at(0), answeredAt: at(5) };
    const tool = view([denied, { kind: "tool", name: "Read", summary: "a.md", status: "done", at: at(6) }]).rows[0];
    assert.deepEqual([tool.kind, tool.asked, tool.text, tool.note], ["answer", "Asked to run a command · answered", "Denied.", "Keep dist for now."]);
    assert.deepEqual(texts(tool), ["done:Sent with your denial and note", "done:Agent next: ran Read"]);
    const said = view([{ ...denied, note: undefined }, { kind: "message", role: "agent", text: `Understood,\n${"x".repeat(100)}`, at: at(6) }]).rows[0];
    assert.equal(said.note, null);
    assert.deepEqual(texts(said), ["done:Sent with your denial", `done:Agent next: said Understood, ${"x".repeat(48)}…`]);
    const ended = view([{ ...denied, status: "allowed", note: undefined }, { kind: "ended", state: "done", at: at(6) }]).rows[0];
    assert.deepEqual([ended.text, ...texts(ended)], ["Allowed.", "done:Sent with your answer", "done:Agent ended: done"]);
  });

  test("with nothing from the agent the receipt stops at sent, then says no reply yet after 30 s", () => {
    const denied = { kind: "permission", name: "Bash", status: "denied", approvalId: "a-1", at: at(0), answeredAt: at(5) };
    assert.deepEqual(texts(view([denied], { now: T0 + 5000 + NO_REPLY_MS }).rows[0]), ["done:Sent with your denial"]);
    assert.deepEqual(texts(view([denied], { now: T0 + 5001 + NO_REPLY_MS }).rows[0]), ["done:Sent with your denial", "muted:No reply yet"]);
    // The user's own later message is not the agent's next step.
    assert.deepEqual(texts(view([denied, { kind: "message", role: "user", text: "hello?", status: "queued", at: at(6) }], { now: T0 + 6000 }).rows[0]), ["done:Sent with your denial"]);
  });
});

describe("threadView: messages, stop and run markers", () => {
  test("a typed message carries its delivery as a chip, and the agent's words carry none", () => {
    const rows = view([
      { kind: "message", role: "agent", text: "On it.", at: at(0) },
      { kind: "message", role: "user", text: "use port 5173", status: "queued", at: at(1) },
      { kind: "message", role: "user", text: "and 5174", status: "applied", at: at(2) },
      { kind: "message", role: "user", text: "lost", status: "undelivered", at: at(3) },
      { kind: "message", role: "user", text: "no status", at: at(4) },
    ]).rows;
    assert.deepEqual(rows.map((r) => r.kind), ["message", "you", "you", "you", "you"]);
    assert.deepEqual(rows.slice(1).map(texts), [["pending:Queued"], ["done:Received"], ["failed:Not delivered"], []]);
  });

  test("a stop is the user's entry: sent, then still stopping after 10 s, then ended, and the end says who stopped it", () => {
    const stop = { kind: "stop", status: "requested", at: at(0) };
    assert.deepEqual(texts(view([stop], { now: T0 + STILL_STOPPING_MS }).rows[0]), ["done:Stop sent"]);
    assert.deepEqual(texts(view([stop], { now: T0 + STILL_STOPPING_MS + 1 }).rows[0]), ["done:Stop sent", "muted:Still stopping…"]);
    const done = view([stop, { kind: "ended", state: "terminated", at: at(3) }], { now: T0 + 60_000 }).rows;
    assert.deepEqual([done[0].kind, done[0].text, ...texts(done[0])], ["you", "Stop", "done:Stop sent", "done:Agent ended"]);
    assert.equal(done[1].label, "Agent stopped by you");
    assert.equal(view([{ kind: "ended", state: "terminated", at: at(3) }]).rows[0].label, "Agent ended: terminated", "a shutdown is not the user's stop");
  });

  test("a run opens with its ticket, a follow-up says so, and an unknown entry stays unreadable", () => {
    const list = threadEntries({ history: [
      { runId: OLD, ref: REF, id: 0, kind: "run", resumeOf: null, at: at(-9) },
      { runId: RUN, ref: REF, id: 0, kind: "run", resumeOf: OLD, at: at(-1) },
      { runId: RUN, ref: REF, id: 1, kind: "mystery", at: at(0) },
    ], agentId: RUN });
    assert.deepEqual(threadView(list, { now: T0 }).rows.map((r) => r.label), ["Run started · 12-fix-the-steamer", "Follow-up · 12-fix-the-steamer", "Unreadable event"]);
  });

  test("no receipt wording says the agent read or saw anything", () => {
    const all = JSON.stringify(view([
      { kind: "permission", name: "Bash", status: "denied", approvalId: "a-1", note: "n", at: at(0), answeredAt: at(1) },
      { kind: "message", role: "user", text: "hello", status: "applied", at: at(2) },
      { kind: "stop", status: "requested", at: at(3) },
      { kind: "ended", state: "terminated", at: at(4) },
    ], { now: T0 + 120_000 }).rows.flatMap((r) => r.chips ?? []));
    assert.doesNotMatch(all, /\b(read|saw|seen)\b/i);
  });
});

describe("footModel and stopModel", () => {
  const agent = { id: RUN, role: "runner", state: "working", capabilities: { send: true, stop: true } };

  test("a live run takes a message and can be stopped", () => {
    assert.deepEqual(footModel({ agent }), { mode: "message", canSend: true, canStop: true, stopShown: true, placeholder: "Message Runner", sendLabel: "Send", reason: null, readOnly: false });
    const mute = footModel({ agent: { ...agent, capabilities: { send: false, stop: true } } });
    assert.deepEqual([mute.canSend, mute.canStop, mute.reason], [false, true, "This agent's runtime cannot take a message."]);
  });

  test("an ended run is followed up when its session can be continued, and is read-only when it cannot", () => {
    const follow = footModel({ agent: { ...agent, state: "done", followUp: true } });
    assert.deepEqual([follow.mode, follow.canSend, follow.canStop, follow.sendLabel, follow.placeholder], ["follow-up", true, false, "Follow up", "Follow up with Runner"]);
    assert.deepEqual([footModel({ agent: { ...agent, state: "failed", followUp: false } }).mode, footModel({ agent: null }).reason], ["ended", "The agent ended."]);
  });

  test("offline, signed out and Demo mode switch the foot off with a visible reason", () => {
    assert.equal(footModel({ agent, connection: { phase: "offline" } }).reason, "Bridge offline: run npm run ui");
    assert.equal(footModel({ agent, signedIn: false }).reason, "Couldn't send: not signed in to steer");
    const demo = footModel({ agent, demo: true });
    assert.deepEqual([demo.canSend, demo.canStop, demo.stopShown, demo.reason], [false, false, true, "Demo mode: actions are off"]);
    assert.equal(footModel({ agent: { ...agent, state: "done" }, demo: true }).stopShown, false, "an ended run has no Stop to show");
  });

  test("the stop control: confirm, stopping, sent, already ended, and an error with the bridge's words", () => {
    assert.equal(stopModel({ phase: "confirm" }).confirm, true);
    assert.deepEqual(stopModel({ phase: "sending" }).chip, { state: "pending", text: "Stopping…" });
    assert.equal(stopModel({ phase: "sent", agent }).announce, "Stop sent");
    assert.equal(stopModel({ phase: "sent", agent: { ...agent, state: "terminated" } }).announce, "Agent ended");
    assert.deepEqual(stopModel({ phase: "failed", error: { status: 409, reason: "the agent has already ended" }, agent: { ...agent, state: "done" } }).chip, { state: "muted", text: "Already ended: done" });
    assert.equal(stopModel({ phase: "failed", error: { status: 404, reason: "no such agent" } }).alert, "Couldn't stop: 404 no such agent");
  });
});

// den-mvp/30: the foot of Bao's desk thread before Bao has a run there.
test("the desk thread with no run takes a first message; demo, offline and signed-out still say why not", () => {
  assert.deepEqual(footModel({ agent: null, desk: true }), { mode: "desk", canSend: true, canStop: false, stopShown: false, placeholder: "Message Bao", sendLabel: "Send", reason: null, readOnly: false });
  assert.equal(footModel({ agent: null, desk: true, demo: true }).canSend, false);
  assert.equal(footModel({ agent: null, desk: true, connection: { phase: "offline" } }).canSend, false);
  assert.equal(footModel({ agent: null, desk: true, signedIn: false }).canSend, false);
  assert.equal(footModel({ agent: null }).canSend, false, "any other thread with no run stays closed");
});

test('historical retired-role conversations stay readable without offering a restart',()=>{
 for(const role of ['scout','herald','debugger','knowledge-keeper','docs-writer','stem-cub']){
  const agent={id:'historical',role,state:'done',followUp:true};
  const foot=footModel({agent});
  assert.equal(foot.canSend,false,role);
  assert.equal(foot.readOnly,true,role);
  assert.match(foot.reason,/retired/i);
 }
});
