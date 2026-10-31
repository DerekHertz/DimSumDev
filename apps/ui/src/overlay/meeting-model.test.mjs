// den-mvp outcome 4: the pure model behind the Meetings card.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { canAsk, canDecide, permissionCards, meetingLine, meetingRequests, meetingRows, runsLine, seatLine, setupState, toggleRole, SPECIALISTS } from "./meeting-model.mjs";
import { needsYouModel } from "./overlay-model.mjs";
import { applyEvent } from "../state/apply-event.mjs";

const steer = { state: "ready" };
const brief = { version: 1, options: [{ key: "A", title: "One log" }, { key: "B", title: "Many logs" }], recommended: "A" };
const meeting = (over = {}) => ({
  id: "m-0000000000000001", ref: "den/07-meeting", dir: "01-meeting", title: "Meeting: one log or many?", state: "running", pause: null, chair: "orchestrator",
  seats: [{ role: "architect", status: "taken", takes: 1, reason: null }, { role: "qa", status: "waiting", takes: 0, reason: null }],
  round: "brief", brief: null, decisions: [], thread: 0, live: { runId: "c-1", role: "qa", part: "take" }, retired: false, rejoinUntil: null, updatedAt: "2026-10-13T10:00:00.000Z", ...over,
});

describe("setting a meeting up", () => {
  test("the line under Start says how many runs it is and what usage stands at", () => {
    assert.equal(runsLine(3), "4 runs: 3 takes, one at a time, then Bao's brief.");
    assert.equal(runsLine(1), "2 runs: 1 take, one at a time, then Bao's brief.");
    assert.equal(setupState({ topic: "q", roles: ["qa", "security"], usage: 41, steer }).cost, "3 runs: 2 takes, one at a time, then Bao's brief. Five-hour usage is 41%.");
    assert.match(setupState({ topic: "q", roles: ["qa"], usage: null, steer }).cost, /Usage reading unavailable\.$/);
  });
  test("Start is offered only for a question, one to six roles, a session and usage under the limit", () => {
    assert.deepEqual(setupState({ topic: "q", roles: ["qa"], usage: 10, steer }).enabled, true);
    assert.equal(setupState({ topic: " ", roles: ["qa"], steer }).reason, "Write the question first.");
    assert.equal(setupState({ topic: "q", roles: [], steer }).reason, "Pick at least one role.");
    assert.match(setupState({ topic: "q", roles: ["qa"], usage: 90, steer }).reason, /Five-hour usage is 90%: nothing new starts at 90% or more\./);
    assert.equal(setupState({ topic: "q", roles: ["qa"], steer: { state: "none" } }).reason, "Couldn't send: not signed in to steer");
    assert.equal(setupState({ topic: "q", roles: ["qa"], steer: { demo: true } }).reason, "Demo mode: actions are off");
    assert.match(setupState({ topic: "é".repeat(1100), roles: ["qa"], steer }).reason, /limited to 2048 bytes/);
  });
  test("roles keep the listed order, and a seventh is not added", () => {
    assert.deepEqual(toggleRole(["qa"], "architect"), ["architect", "qa"]);
    assert.deepEqual(toggleRole(["architect", "qa"], "qa"), ["architect"]);
    const six = SPECIALISTS.slice(0, 6);
    assert.deepEqual(toggleRole(six, SPECIALISTS[6]), six);
  });
});

describe("where a meeting stands", () => {
  test("each state has one plain line", () => {
    assert.equal(meetingLine(meeting()), "Qa is giving its take");
    assert.equal(meetingLine(meeting({ live: { role: "orchestrator", part: "chair" } })), "Bao is writing the brief");
    assert.equal(meetingLine(meeting({ live: { role: "orchestrator", part: "answer" } })), "Bao is answering your follow-up");
    assert.equal(meetingLine(meeting({ state: "paused", pause: { kind: "usage", reason: "five-hour usage is 95% (limit 90%)" } })), "Waiting: five-hour usage is 95% (limit 90%)");
    assert.equal(meetingLine(meeting({ state: "briefed", brief, live: null })), "The brief is ready: 2 options, A recommended. The choice is yours.");
    const decisions = [{ option: "B", title: "Many logs", ticket: "den/08-proposed" }];
    assert.equal(meetingLine(meeting({ state: "decided", brief, decisions })), "You chose option B. Proposed work: den/08-proposed.");
    assert.equal(meetingLine(meeting({ state: "closed", brief })), "Closed without a choice.");
    assert.equal(meetingLine(meeting({ state: "decided", brief, decisions, retired: true })), "You chose option B. Proposed work: den/08-proposed. Only the summary and the brief are kept.");
  });
  test("each seat says what it did, and why when it gave no take", () => {
    const m = meeting();
    assert.equal(seatLine(m.seats[0], m), "gave its take");
    assert.equal(seatLine(m.seats[1], m), "giving its take now");
    assert.equal(seatLine({ role: "qa", status: "waiting" }, meeting({ live: null })), "not asked yet");
    assert.equal(seatLine({ role: "security", status: "declined", reason: "no access question here" }, m), "declined: no access question here");
    assert.equal(seatLine({ role: "qa", status: "failed", reason: "the run failed" }, m), "no take: the run failed");
    assert.equal(seatLine({ role: "qa", status: "taken", takes: 2 }, m), "gave 2 takes");
  });
  test("a row offers only what the bridge would accept", () => {
    const [running] = meetingRows({ meetings: [meeting()] });
    assert.deepEqual([running.canStop, running.canResume, running.canClose, running.canAsk, running.canDecide], [true, false, false, false, false]);
    const [briefed] = meetingRows({ meetings: [meeting({ state: "briefed", brief, live: null })] });
    assert.deepEqual([briefed.canStop, briefed.canClose, briefed.canAsk, briefed.canDecide], [false, true, true, true]);
    assert.deepEqual(briefed.options, [{ key: "A", title: "One log", recommended: true }, { key: "B", title: "Many logs", recommended: false }]);
    const old = meeting({ state: "decided", brief, retired: true });
    assert.equal(canAsk(old), false);
    assert.equal(canDecide(meeting({ state: "decided", brief })), false);
    assert.deepEqual(meetingRows({ meetings: null }), []);
  });
  test("open meetings are listed before ended ones, newest ended first", () => {
    const rows = meetingRows({ meetings: [meeting({ id: "m-1", state: "closed" }), meeting({ id: "m-2", state: "decided", brief }), meeting({ id: "m-3" })] });
    assert.deepEqual(rows.map((r) => r.id), ["m-3", "m-2", "m-1"]);
  });
});

describe("what reaches Needs you", () => {
  test("a ready brief and a paused meeting are the user's; a running one and a wait for room are not", () => {
    const snapshot = {
      tickets: [], requests: [], approvals: [], agents: [], deliveries: [],
      meetings: [
        meeting({ id: "m-1" }), meeting({ id: "m-2", state: "paused", pause: { kind: "no-room", reason: "r", next: "n" } }),
        meeting({ id: "m-3", state: "paused", pause: { kind: "no-brief", reason: "the chair ended without a brief", next: "Resume to ask again." } }),
        meeting({ id: "m-4", state: "briefed", brief, live: null }),
      ],
    };
    const requests = meetingRequests(snapshot);
    assert.deepEqual(requests.map((r) => [r.id, r.primary.action]), [["m-3", "resume"], ["m-4", "open"]]);
    assert.equal(requests[0].reason, "the chair ended without a brief");
    assert.equal(requests[1].title, "A meeting's brief is ready");
    assert.equal(needsYouModel(snapshot, Date.now()).count, 2);
  });
  test("a meeting frame adds or replaces the meeting in the state", () => {
    const state = { seq: 1, tickets: [], meetings: [meeting({ id: "m-1" })] };
    const next = applyEvent(state, { type: "meeting", seq: 2, meeting: meeting({ id: "m-1", state: "briefed" }) });
    assert.deepEqual(next.meetings.map((m) => [m.id, m.state]), [["m-1", "briefed"]]);
    const added = applyEvent(next, { type: "meeting", seq: 3, meeting: meeting({ id: "m-2" }) });
    assert.equal(added.meetings.length, 2);
  });
});

describe("permissionCards (den-meetings/01)", () => {
  const ask = { id: "e-1", kind: "permission-request", actor: "architect", approvalId: "a-1", tool: "WebFetch", summary: "https://example.org", expiresAt: "2026-01-01T00:10:00.000Z" };
  const now = Date.parse("2026-01-01T00:04:00.000Z");
  test("an open request is pending with the seconds it has left", () => {
    assert.deepEqual(permissionCards([ask], now).map((c) => [c.id, c.actor, c.state, c.secondsLeft]), [["a-1", "architect", "pending", 360]]);
  });
  test("a settled request shows the state it was settled in, even before its expiry", () => {
    const cards = permissionCards([ask, { id: "e-2", kind: "permission-settled", approvalId: "a-1", state: "denied" }], now);
    assert.deepEqual(cards.map((c) => [c.state, c.secondsLeft]), [["denied", 0]]);
  });
  test("a request past its expiry with no settlement reads as expired", () => {
    assert.equal(permissionCards([ask], Date.parse("2026-01-01T00:11:00.000Z"))[0].state, "expired");
  });
  test("other events are not cards", () => {
    assert.deepEqual(permissionCards([{ id: "e-3", kind: "message" }], now), []);
  });
});
