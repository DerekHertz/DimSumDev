// den-v1/09: the recorded fixture and the replay driver. Contract (qa specify):
//   apps/ui/src/demo/demo-fixture.mjs  exports DEMO_FIXTURE, with a numeric `loopMs` (one pass of the recording).
//   apps/ui/src/demo/demo-replay.mjs   exports createDemoReplay({ fixture = DEMO_FIXTURE, now = Date.now }) ->
//     { start(), stop(), tick(), getState(), subscribe(fn) -> unsubscribe, statusFor(card) }
//   getState() -> { running, loops, snapshot, transcripts }
//     snapshot    a live-store snapshot (tickets with holders, cells with tool calls, agents, approvals) that the den,
//                 liveActorsFromSnapshot and cardFor already read; stamps (cells[].lastEventAt, approval expiresAt) are
//                 rebased onto now(), so a tool bubble is fresh when the recording says it is.
//     transcripts { [agentId]: { entries, dropped } } (state/transcript-buffer.mjs shape), only lines recorded so far.
//   start() begins at 0 (a fresh run each time); tick() recomputes from now() - origin (so a late tick catches up in
//   one call) and wraps at loopMs, counting `loops`; it keeps the same state object when no event passed (stamps are rebased from the
//   event time, not the tick time) and notifies subscribers only when something changed; stop() halts it (tick is then a no-op).
//   statusFor(card) -> the card's message line from the recorded message-ack, { agentId, kind: "received",
//   label: "Message received", preview } or null, like createMessageComposer().statusFor.
// Criteria: fixture content (AC 1), replay and loop (AC 2). Fixture content is read through the driver, not its raw shape.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { DEMO_FIXTURE } from "./demo-fixture.mjs";
import { createDemoReplay } from "./demo-replay.mjs";
import { liveActorsFromSnapshot } from "../review/live-actors.mjs";
import { pendingLine } from "../overlay/proximity-card.mjs";
import { clock, cardsOf, projection, STEP } from "./demo-test-helpers.mjs";

const LOOP = DEMO_FIXTURE.loopMs;
const KINDS = new Set(["message", "tool", "permission", "ended"]);
const ENDED = new Set(["done", "failed", "terminated"]);

function started() {
  const c = clock();
  const replay = createDemoReplay({ now: c.now });
  replay.start();
  return { c, replay };
}

// One pass over the recording, 100 ms at a time; what a viewer could ever see.
function observe() {
  const { c, replay } = started();
  const seen = {
    roles: new Set(), states: new Set(), split: false, bubble: false, waiting: null, ack: null,
    agentIds: new Set(), withLines: new Set(), kinds: new Set(), linesAt0: 0, linesAtEnd: 0, mismatched: [],
  };
  for (let ms = 0; ms < LOOP; ms += STEP) {
    c.at(ms);
    replay.tick();
    const s = replay.getState();
    for (const a of liveActorsFromSnapshot(s.snapshot, { now: c.now() })) {
      seen.roles.add(a.role);
      seen.states.add(a.state);
      if (a.split) seen.split = true;
      if (a.bubble) seen.bubble = true;
    }
    for (const agent of s.snapshot.agents ?? []) {
      seen.agentIds.add(agent.id);
      const ticket = s.snapshot.tickets.find((t) => t.ref === agent.ref);
      // An agent that has ended has released its ticket (the recorded scout does); only a running one must be held.
      if (!ENDED.has(agent.state) && (!ticket || ticket.holder?.role !== agent.role)) seen.mismatched.push(`${agent.id}@${ms}`);
    }
    for (const card of cardsOf(s.snapshot)) {
      if (card.approval && !seen.waiting) seen.waiting = card;
    }
    for (const id of seen.agentIds) {
      const status = replay.statusFor({ agentId: id });
      if (status && !seen.ack) seen.ack = { id, at: ms, status };
    }
    for (const [id, b] of Object.entries(s.transcripts ?? {})) {
      if (b.entries.length) seen.withLines.add(id);
      for (const e of b.entries) seen.kinds.add(e.kind);
    }
    const total = Object.values(s.transcripts ?? {}).reduce((n, b) => n + b.entries.length, 0);
    if (ms === 0) seen.linesAt0 = total;
    seen.linesAtEnd = total;
  }
  return seen;
}
const seen = observe();

describe("the recorded fixture (read through the driver)", () => {
  test("one pass has a positive length", () => {
    assert.ok(Number.isFinite(LOOP) && LOOP >= 1000, `loopMs: ${LOOP}`);
  });
  test("at least two roles take part", () => {
    assert.ok(seen.roles.size >= 2, [...seen.roles].join(","));
  });
  test("a second agent of one role becomes a split-off panda", () => {
    assert.equal(seen.split, true);
  });
  test("tool calls show as bubbles, fresh against the clock", () => {
    assert.equal(seen.bubble, true);
  });
  test("pandas change state as the events dictate", () => {
    assert.ok(seen.states.size >= 2, [...seen.states].join(","));
  });
  test("one panda waits on the user: its card carries the recorded request", () => {
    assert.ok(seen.waiting, "no card ever held a pending approval");
    assert.match(pendingLine(seen.waiting), /^Waiting on you/);
    assert.equal(seen.waiting.approval.status ?? "pending", "pending");
  });
  test("a message acknowledgement is recorded for one agent", () => {
    assert.ok(seen.ack, "no card ever showed a message status");
    assert.equal(seen.ack.status.kind, "received");
    assert.equal(seen.ack.status.label, "Message received");
    assert.equal(seen.ack.status.agentId, seen.ack.id);
    assert.equal(typeof seen.ack.status.preview, "string");
    assert.ok(seen.ack.at > 0, "the ack comes after the start, not with it");
  });
  test("every running agent is held by a ticket of its role, so a panda and a card bind to it", () => {
    assert.deepEqual(seen.mismatched, []);
  });
  test("transcript lines are recorded for some agents and not others, in the buffer's entry kinds", () => {
    assert.ok(seen.withLines.size >= 1, "no transcript lines");
    assert.ok(seen.agentIds.size > seen.withLines.size, "every agent has lines, so 'no transcript recorded' never shows");
    for (const k of seen.kinds) assert.ok(KINDS.has(k), `entry kind ${k}`);
    assert.ok(seen.linesAtEnd > seen.linesAt0, "lines arrive over the pass");
  });
  test("a note says how to re-record it", () => {
    const note = new URL("./README.md", import.meta.url);
    assert.ok(existsSync(note), "apps/ui/src/demo/README.md is missing");
    const text = readFileSync(note, "utf8");
    assert.match(text, /re-?record/i);
    assert.match(text, /demo-fixture\.mjs/);
  });
});

describe("the replay driver", () => {
  test("state at a time depends only on the clock, not on how often tick ran", () => {
    const at = Math.floor(LOOP * 0.7);
    const stepped = started();
    for (let ms = 0; ms <= at; ms += STEP) { stepped.c.at(ms); stepped.replay.tick(); }
    stepped.c.at(at);
    stepped.replay.tick();
    const jumped = started();
    jumped.c.at(at);
    jumped.replay.tick();
    assert.deepEqual(projection(jumped.replay.getState(), jumped.c.now()), projection(stepped.replay.getState(), stepped.c.now()));
    assert.equal(jumped.replay.getState().loops, 0);
  });
  test("two runs on the same clock are identical", () => {
    const a = started(), b = started();
    for (const ms of [0, 3000, Math.floor(LOOP / 2), LOOP - STEP]) {
      a.c.at(ms); a.replay.tick(); b.c.at(ms); b.replay.tick();
      assert.deepEqual(projection(a.replay.getState(), a.c.now()), projection(b.replay.getState(), b.c.now()), `at ${ms}`);
    }
  });
  test("it starts running at loop 0 with a snapshot to show", () => {
    const { replay } = started();
    const s = replay.getState();
    assert.equal(s.running, true);
    assert.equal(s.loops, 0);
    assert.ok(s.snapshot && Array.isArray(s.snapshot.tickets));
  });
  test("it loops: after one pass it cuts back to the start, and keeps looping", () => {
    const { c, replay } = started();
    const probes = [0, STEP * 7, Math.floor(LOOP / 2)];
    const first = probes.map((ms) => { c.at(ms); replay.tick(); return projection(replay.getState(), c.now()); });
    for (const lap of [1, 2, 5]) {
      probes.forEach((ms, i) => {
        c.at(ms + lap * LOOP);
        replay.tick();
        const s = replay.getState();
        assert.equal(s.loops, lap, `loops at lap ${lap}`);
        assert.deepEqual(projection(s, c.now()), first[i], `state at lap ${lap}, ${ms} ms`);
      });
    }
  });
  test("a restart does not pile transcript lines onto the last pass", () => {
    const { c, replay } = started();
    c.at(LOOP - STEP); replay.tick();
    const before = projection(replay.getState(), c.now()).transcripts;
    c.at(2 * LOOP - STEP); replay.tick();
    assert.deepEqual(projection(replay.getState(), c.now()).transcripts, before);
  });
  test("the ack shows only after its time and clears when the loop restarts", () => {
    assert.ok(seen.ack);
    const { c, replay } = started();
    const card = { agentId: seen.ack.id };
    assert.equal(replay.statusFor(card), null);
    c.at(seen.ack.at); replay.tick();
    assert.equal(replay.statusFor(card)?.label, "Message received");
    assert.equal(replay.statusFor({ agentId: "nobody" }), null);
    assert.equal(replay.statusFor(null), null);
    c.at(LOOP); replay.tick();
    assert.equal(replay.statusFor(card), null);
  });
  test("subscribers hear a change once, hear nothing when the tick changes nothing, and can unsubscribe", () => {
    const { c, replay } = started();
    let heard = 0;
    const off = replay.subscribe(() => { heard += 1; });
    let t = 0;
    while (t < LOOP) { t += STEP; c.at(t); const before = replay.getState(); replay.tick(); if (replay.getState() !== before) break; }
    assert.equal(heard, 1);
    replay.tick();
    assert.equal(heard, 1, "a tick at the same time changes nothing");
    off();
    c.at(t + LOOP / 2); replay.tick();
    assert.equal(heard, 1, "unsubscribed");
  });
  test("stop() halts it; start() begins a fresh pass from 0", () => {
    const { c, replay } = started();
    const first0 = projection(replay.getState(), c.now());
    c.at(Math.floor(LOOP / 2)); replay.tick();
    const frozen = replay.getState();
    replay.stop();
    c.at(LOOP + 5000); replay.tick();
    assert.equal(replay.getState(), frozen);
    assert.equal(replay.getState().running, false);
    replay.start();
    const s = replay.getState();
    assert.equal(s.running, true);
    assert.equal(s.loops, 0);
    assert.deepEqual(projection(s, c.now()), first0);
    assert.equal(replay.statusFor({ agentId: seen.ack.id }), null);
  });
});
