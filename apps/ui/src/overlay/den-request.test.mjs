// den-v1 loop, live den run 3 (2026-10-10): the scout's permission request was on the stream but nothing in the den
// let the user find or answer it. A request the bridge holds now shows in the Needs you card (overview and walk mode)
// and in the transcript's waiting row, and a panda picked in the overview gets the card walk mode shows.
// Every answer still goes through the permission review, which shows the full tool input before Allow turns on.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { needsYouModel, stepRequest, answerCardFor } from "./overlay-model.mjs";
import { transcriptView } from "./transcript-view.mjs";
import { cardFor, pickedCard } from "./proximity-card.mjs";
import { createApprovalReview } from "./approval-review.mjs";
import { appendTranscript } from "../state/transcript-buffer.mjs";

const NOW = Date.parse("2026-10-10T23:28:00Z");
const agent = (extra = {}) => ({
  id: "c-scout", ref: "den/02-scout", role: "scout", mode: "direct", runtime: "claude", state: "waiting_on_user",
  tool: { name: "Read", summary: "/home/u/den/package.json" }, capabilities: { stop: true, approve: true, send: true, handover: false }, ...extra,
});
const approval = (extra = {}) => ({
  id: "a-1", agentId: "c-scout", tool: "Read", summary: "/home/u/den/package.json", inputLength: 54, truncated: false,
  ts: "2026-10-10T23:27:55.051Z", expiresAt: "2026-10-10T23:35:55.051Z", state: "pending", ...extra,
});
const snap = (extra = {}) => ({ tickets: [], agents: [agent()], approvals: [approval()], ...extra });

describe("Needs you: a permission request the bridge holds", () => {
  test("it is a request: who asks, for which ticket, the tool, the target and the time left", () => {
    const { count, requests } = needsYouModel(snap(), NOW);
    assert.equal(count, 1);
    const [r] = requests;
    assert.equal(r.kind, "permission");
    assert.equal(r.key, "approval:a-1");
    assert.equal(r.ref, "den/02-scout");
    assert.equal(r.role, "scout");
    assert.equal(r.team, "steamers");
    assert.equal(r.eyebrow, "Scout · den/02-scout");
    assert.equal(r.title, "Wants to read a file"); // organism-infra/230: what is asked, in plain words
    assert.deepEqual(r.preview, ["/home/u/den/package.json"]);
    assert.equal(r.expires, "expires in 7 min"); // 7:55 left: whole minutes, never more than is left
    assert.equal(r.rowText, "02-scout · Read");
  });

  test("it carries the card the permission review opens from, with Allow and Deny on", () => {
    const [r] = needsYouModel(snap(), NOW).requests;
    assert.equal(r.card.agentId, "c-scout");
    assert.equal(r.card.name, "Scout");
    assert.equal(r.card.role, "scout");
    assert.equal(r.card.ref, "den/02-scout");
    assert.equal(r.card.approval.id, "a-1");
    assert.deepEqual(r.card.actions, { Q: { enabled: true, reason: null }, E: { enabled: true, reason: null } });
    const calls = [];
    const review = createApprovalReview({ client: { getApproval: (id) => { calls.push(id); return new Promise(() => {}); }, decide: () => {} }, now: () => NOW });
    assert.deepEqual(review.open(r.card, { mode: "card" }), { opened: true, reason: null });
    assert.deepEqual(calls, ["a-1"], "the review loads the full input; the card itself sends no answer");
    assert.equal(review.getState().heading, "Run Read");
    assert.equal(review.getState().meta, "Scout · scout · den/02-scout");
  });

  test("the last minute reads as under a minute; a request with no expiry shows none", () => {
    assert.equal(needsYouModel(snap({ approvals: [approval({ expiresAt: "2026-10-10T23:28:40Z" })] }), NOW).requests[0].expires, "expires in under a minute");
    assert.equal(needsYouModel(snap({ approvals: [approval({ expiresAt: "2026-10-10T23:29:00Z" })] }), NOW).requests[0].expires, "expires in 1 min");
    assert.equal(needsYouModel(snap({ approvals: [approval({ expiresAt: undefined })] }), NOW).requests[0].expires, null);
  });

  test("only a pending request of a live agent that can be answered is listed", () => {
    const none = (extra) => assert.equal(needsYouModel(snap(extra), NOW).count, 0);
    for (const state of ["allowed", "denied", "expired"]) none({ approvals: [approval({ state })] });
    none({ approvals: [approval({ status: "allowed", state: undefined })] });
    none({ approvals: [approval({ expiresAt: "2026-10-10T23:27:59Z" })] }); // past its time: the bridge is about to expire it
    none({ agents: [] });
    for (const state of ["done", "failed", "terminated"]) none({ agents: [agent({ state })] });
    none({ agents: [agent({ capabilities: { approve: false } })] });
    none({ approvals: null, agents: null });
  });

  test("it comes before the board's gates, and the count covers both", () => {
    const tickets = [{ ref: "den-v1/09-thing", title: "A thing", status: "in-progress", gate: "merge", holder: { role: "orchestrator", since: "2026-10-10T23:00:00Z" } }];
    const gatesOnly = needsYouModel({ tickets }, NOW);
    const both = needsYouModel(snap({ tickets }), NOW);
    assert.equal(both.count, gatesOnly.count + 1);
    assert.equal(both.requests[0].kind, "permission");
    for (const r of gatesOnly.requests) {
      assert.equal(r.kind, "gate");
      assert.equal(r.key, r.ref);
    }
  });

  test("an untrusted tool name or summary stays plain text in the model", () => {
    const [r] = needsYouModel(snap({ approvals: [approval({ tool: "<b>Bash</b>", summary: "rm -rf <img>" })] }), NOW).requests;
    assert.equal(r.title, "Wants to use <b>Bash</b>");
    assert.deepEqual(r.preview, ["rm -rf <img>"]);
  });

  test("stepRequest steps by key, so a request and a gate on the same ticket stay apart", () => {
    const reqs = [{ key: "approval:a-1", ref: "den/02-scout" }, { key: "den/02-scout", ref: "den/02-scout" }, { ref: "old/01" }];
    assert.equal(stepRequest(reqs, "approval:a-1", 1), "den/02-scout");
    assert.equal(stepRequest(reqs, "den/02-scout", 1), "old/01");
    assert.equal(stepRequest(reqs, "old/01", 1), "approval:a-1");
    assert.equal(stepRequest(reqs, "approval:a-1", -1), "old/01");
  });
});

describe("which card E and Q answer", () => {
  const requests = needsYouModel(snap(), NOW).requests;
  const idle = { id: "qa", role: "qa", approval: null, actions: { Q: { enabled: false, reason: "no agent running" }, E: { enabled: false, reason: "no agent running" } } };
  const asking = { id: "scout", role: "scout", approval: { id: "a-9" }, actions: { Q: { enabled: true, reason: null }, E: { enabled: true, reason: null } } };

  test("the panda card in front of you when it holds a request", () => {
    assert.equal(answerCardFor(asking, requests), asking);
  });
  test("otherwise the first waiting request, so no panda has to be found first", () => {
    assert.equal(answerCardFor(null, requests), requests[0].card);
    assert.equal(answerCardFor(idle, requests), requests[0].card);
  });
  test("a board gate is not answered by E or Q", () => {
    assert.equal(answerCardFor(null, [{ key: "x/1", kind: "gate", ref: "x/1" }]), null);
    assert.equal(answerCardFor(idle, []), idle);
    assert.equal(answerCardFor(null, []), null);
  });
});

describe("permission review keys outside walk mode", () => {
  const card = needsYouModel(snap(), NOW).requests[0].card;
  const make = () => createApprovalReview({ client: { getApproval: () => new Promise(() => {}), decide: () => {} }, now: () => NOW });

  test("E or Q opens the request from the overview", () => {
    for (const key of ["e", "Q"]) {
      const review = make();
      assert.deepEqual(review.key({ key }, { card, mode: "diorama" }), { handled: true, walk: false });
      assert.equal(review.getState().open, true);
    }
  });
  test("with the cursor free in walk mode the keys still do nothing: the buttons are clicked", () => {
    const review = make();
    assert.equal(review.key({ key: "e" }, { card, mode: "free" }).handled, false);
    assert.equal(review.getState().open, false);
  });
  test("the full input is shown on its own lines; a line break inside a value stays escaped", async () => {
    const review = createApprovalReview({ client: { getApproval: async () => ({ state: "pending", input: { command: "npm test\nrm -rf x", cwd: "/w" } }), decide: () => {} }, now: () => NOW });
    review.open({ ...card, approval: { ...card.approval, inputLength: JSON.stringify({ command: "npm test\nrm -rf x", cwd: "/w" }).length } }, { mode: "card" });
    await new Promise((r) => setImmediate(r));
    assert.equal(review.getState().inputText, '{\n  "command": "npm test\\nrm -rf x",\n  "cwd": "/w"\n}');
    assert.equal(review.getState().allowEnabled, true);
  });
  test("with no card, in a text field or in demo mode nothing opens", () => {
    const review = make();
    assert.equal(review.key({ key: "e" }, { card: null, mode: "diorama" }).handled, false);
    assert.equal(review.key({ key: "e", inNote: true }, { card, mode: "diorama" }).handled, false);
    assert.equal(review.key({ key: "e" }, { card, mode: "diorama", demo: true }).handled, false);
    assert.equal(review.getState().open, false);
  });
});

describe("transcript: the waiting row says what is asked and can be answered", () => {
  const fill = (...entries) => entries.reduce((b, e) => appendTranscript(b, "c-scout", e), {})["c-scout"];
  const ui = (extra = {}) => ({ expanded: [], atBottom: true, seenThrough: 0, connection: { phase: "live" }, ...extra });
  const running = { kind: "tool", id: 3, name: "Read", summary: "/home/u/den/package.json", status: "running" };
  const waiting = { kind: "permission", id: 4, name: "Read", status: "pending" };
  const later = { kind: "tool", id: 5, name: "Bash", summary: "rg -n claim", status: "done" };
  const pending = { tool: "Read", summary: "/home/u/den/package.json" };

  test("the agent's pending request gives the row its target and turns the answer on", () => {
    const rows = transcriptView(fill(running, waiting, later), ui({ pending })).rows;
    assert.deepEqual(rows[1], { kind: "permission", n: 4, name: "Read", label: "Waiting on you", waiting: true, detail: "Read /home/u/den/package.json", answerable: true });
  });
  test("with no pending request the row is as before: a label and nothing to press", () => {
    const [row] = transcriptView(fill(waiting), ui()).rows;
    assert.deepEqual(row, { kind: "permission", n: 4, name: "Read", label: "Waiting on you", waiting: true, detail: null, answerable: false });
  });
  test("only the newest waiting row of that tool is answerable; an answered row never is", () => {
    const rows = transcriptView(fill(waiting, { ...waiting, id: 6, name: "Write" }, { ...waiting, id: 7 }, { ...waiting, id: 8, status: "allowed" }), ui({ pending })).rows;
    assert.deepEqual(rows.map((r) => r.answerable), [false, false, true, false]);
    assert.equal(rows[3].label, "Allowed by you");
    assert.equal(rows[3].detail, null);
  });
  test("a request with no summary names the tool alone, and a bad pending value is ignored", () => {
    assert.equal(transcriptView(fill(waiting), ui({ pending: { tool: "Read" } })).rows[0].detail, "Read");
    for (const bad of [null, 7, "Read", {}, { tool: 3 }]) assert.equal(transcriptView(fill(waiting), ui({ pending: bad })).rows[0].answerable, false);
  });
});

describe("overview: a picked panda gets the card walk mode shows", () => {
  const pandas = [
    { id: "scout", name: "Scout", role: "scout", team: "Steamers", position: { x: -7.5, z: -4.5 }, agent: agent() },
    { id: "qa", name: "Taster", role: "qa", team: "Tea & Pantry", position: { x: 6, z: 2 } },
  ];

  test("the card is the one walking up to that panda gives, whatever the distance", () => {
    const near = cardFor(pandas, [approval()], { x: -7.5, z: -3, yaw: 0 });
    delete near.distance;
    const picked = pickedCard(pandas, [approval()], "scout");
    assert.deepEqual(picked, near);
    assert.equal(picked.approval.id, "a-1");
    assert.equal(picked.actions.E.enabled, true);
    assert.equal(picked.actions.R.enabled, true);
  });
  test("a resident panda's card offers Start task", () => {
    const card = pickedCard(pandas, [], "qa");
    assert.equal(card.start, true);
    assert.equal(card.actions.T.enabled, true);
    assert.equal(card.actions.E.enabled, false);
  });
  test("no pick, or a panda that left, is no card", () => {
    assert.equal(pickedCard(pandas, [], null), null);
    assert.equal(pickedCard(pandas, [], "gone"), null);
    assert.equal(pickedCard(null, [], "qa"), null);
  });
});
