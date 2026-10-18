// den-mvp/88 (ADR 0027): the router's decision, a pure function. No process, no clock, no network.
//   decide({ order, tickets, state, usage, stops, downForMs }) -> { actions, stops, waiting }
//   order     parseOrder's result: { entries: [{ ref: "fx/1", notBeside: [] }] } (short refs)
//   tickets   the board as scripts/batch-groups.mjs reads it: [{ ref: "fx/01-slug", text, locked }]
//   state     the bridge's GET /state, or null when the bridge does not answer. Read: capacity { room, refs: [{ ref, kind }] },
//             deliveries [{ id, ref, state: running|paused|merged|closed, pause: { kind } | null, updatedAt }], update?: { draining }
//   usage     what `scripts/usage.mjs --live` printed ({ "5-hour": { percent }, source, stale?, unknown? }), or { error } when it failed
//   stops     keys already recorded on the board (an array): a stop whose key is in it is not returned again
//   downForMs how long the bridge has not answered (the runner measures it)
//   actions   [{ type: "start", ref: <full board ref> } | { type: "resume", id }], in the order to run them
//   stops(out) [{ key, kind, ref?, text }]: kind is the pause kind verbatim, or "bridge-down" | "usage-reading"
//   waiting   null, or a string that says why nothing was started (a wait is never a stop)
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decide, STOP_AT_PERCENT, BRIDGE_DOWN_MS } from "./decide.mjs";

const full = (n) => `fx/${String(n).padStart(2, "0")}-slug`;
const tk = (n, { status = "ready-for-agent", paths = ["apps/a/default.mjs"], locked = false, blockedBy = "None" } = {}) => ({
  ref: full(n),
  locked,
  text: `# ${n}\n\n**Type:** feature\n\n**Status:** ${status}\n\n**Blocked by:** ${blockedBy}\n\n## What to build\n${paths.map((p) => `\`${p}\``).join(" ")}\n\n## Acceptance criteria\n- [ ] x\n`,
});
const order = (...es) => ({ entries: es.map((e) => (typeof e === "string" ? { ref: `fx/${e}`, notBeside: [] } : { ref: `fx/${e[0]}`, notBeside: e[1].map((n) => `fx/${n}`) })) });
const dl = (n, state = "running", pause = null, id = `d-${n}`) => ({ id, ref: full(n), state, pause: pause && { kind: pause }, updatedAt: "2026-10-17T10:00:00Z" });
const bridge = ({ room = 2, deliveries = [], locks = [], update } = {}) => ({
  capacity: { max: 2, cap: 4, load: 2 - room, live: 0, room, refs: locks.map((n) => ({ ref: full(n), kind: "lock" })) },
  deliveries, ...(update ? { update } : {}),
});
const live = (p) => ({ "5-hour": { percent: p }, weekly: { percent: 10 }, source: "live", age_s: 0 });
const run = (o) => decide({ order: order("1"), tickets: [tk(1)], state: bridge(), usage: live(10), stops: [], downForMs: 0, ...o });
const starts = (r) => r.actions.filter((a) => a.type === "start").map((a) => a.ref);
const resumes = (r) => r.actions.filter((a) => a.type === "resume").map((a) => a.id);

describe("starting (den-mvp/88 from 80)", () => {
  test("with a free slot, the first ready ticket in the order is started, by its full board ref", () => {
    assert.deepEqual(starts(run({ order: order("2", "1"), tickets: [tk(1), tk(2)], state: bridge({ room: 1 }) })), [full(2)]);
  });
  test("a ticket not in the order is never started", () => {
    assert.deepEqual(starts(run({ order: order("1"), tickets: [tk(1, { status: "blocked" }), tk(7)] })), []);
  });
  test("a ticket that is not ready-for-agent is never started, nor one whose blocker is unresolved", () => {
    for (const status of ["ready-for-human", "claimed", "in-review", "blocked", "resolved", "merged"]) assert.deepEqual(starts(run({ tickets: [tk(1, { status })] })), [], status);
    assert.deepEqual(starts(run({ order: order("1"), tickets: [tk(1, { blockedBy: "fx/5" }), tk(5, { status: "in-review" })] })), []);
    assert.deepEqual(starts(run({ order: order("1"), tickets: [tk(1, { blockedBy: "fx/5" }), tk(5, { status: "resolved" })] })), [full(1)]);
  });
  test("a ticket with a delivery (any state) or a claim is skipped", () => {
    for (const d of ["running", "paused", "closed", "merged"]) assert.deepEqual(starts(run({ state: bridge({ deliveries: [dl(1, d, d === "paused" ? "visual-verdict" : null)] }) })), [], d);
    assert.deepEqual(starts(run({ tickets: [tk(1, { locked: true })] })), []);
    assert.deepEqual(starts(run({ state: bridge({ locks: [1] }) })), []);
  });
  test("no room, no start; the bridge's room is the limit, a start uses one slot", () => {
    assert.deepEqual(starts(run({ state: bridge({ room: 0 }) })), []);
    const r = run({ order: order("1", "2", "3"), tickets: [tk(1, { paths: ["apps/a/1.mjs"] }), tk(2, { paths: ["apps/a/2.mjs"] }), tk(3, { paths: ["apps/a/3.mjs"] })], state: bridge({ room: 2 }) });
    assert.deepEqual(starts(r), [full(1), full(2)]);
  });
  test("a bridge that does not answer starts nothing", () => {
    assert.deepEqual(run({ state: null, downForMs: 1000 }).actions, []);
  });
  test("deciding twice on the same inputs gives the same answer (no state of its own)", () => {
    const ctx = { order: order("1", "2"), tickets: [tk(1), tk(2, { paths: ["apps/a/2.mjs"] })], state: bridge({ deliveries: [dl(3, "paused", "bridge-restart")] }) };
    assert.deepEqual(run(ctx), run(ctx));
  });
});

describe("usage (from 80 and 234)", () => {
  test("the stop line is 90: 89 starts, 90 and over start nothing", () => {
    assert.equal(STOP_AT_PERCENT, 90);
    assert.deepEqual(starts(run({ usage: live(89) })), [full(1)]);
    for (const p of [90, 91, 100]) assert.deepEqual(run({ usage: live(p) }).actions, [], String(p));
  });
  test("a failed, stale, cached or unknown reading starts nothing and is one stop", () => {
    for (const usage of [{ error: "HTTP 401" }, { ...live(5), stale: true }, { ...live(5), source: "cache" }, { ...live(5), unknown: true }, { "5-hour": { percent: null }, source: "live" }, null]) {
      const r = run({ usage });
      assert.deepEqual(r.actions, [], JSON.stringify(usage));
      assert.deepEqual(r.stops.map((s) => s.kind), ["usage-reading"], JSON.stringify(usage));
    }
  });
  test("a bridge-restart pause is not resumed while the window is over the line", () => {
    assert.deepEqual(resumes(run({ usage: live(95), state: bridge({ deliveries: [dl(2, "paused", "bridge-restart")] }) })), []);
  });
});

describe("resuming (from 80 and 81)", () => {
  test("a bridge-restart pause is resumed once the bridge answers", () => {
    assert.deepEqual(resumes(run({ state: bridge({ deliveries: [dl(2, "paused", "bridge-restart")] }) })), ["d-2"]);
  });
  test("a resume uses a slot before any new start does", () => {
    const r = run({ order: order("1"), tickets: [tk(1)], state: bridge({ room: 1, deliveries: [dl(2, "paused", "bridge-restart")] }) });
    assert.deepEqual([resumes(r), starts(r)], [["d-2"], []]);
  });
  test("a usage pause resumes after a live reading below the stop line, not before", () => {
    const state = bridge({ deliveries: [dl(2, "paused", "usage")] });
    assert.deepEqual(resumes(run({ state, usage: live(89) })), ["d-2"]);
    assert.deepEqual(resumes(run({ state, usage: live(90) })), []);
    assert.deepEqual(resumes(run({ state, usage: live(97) })), []);
    assert.deepEqual(resumes(run({ state, usage: { ...live(10), stale: true } })), [], "a stale reading is not a window reset");
    assert.deepEqual(resumes(run({ state, usage: { error: "x" } })), []);
    assert.deepEqual(run({ state, usage: live(97) }).stops, [], "waiting on the window is a wait, not a stop");
  });
  test("a no-room pause resumes when a slot frees, not before", () => {
    const paused = [dl(2, "paused", "no-room")];
    assert.deepEqual(resumes(run({ state: bridge({ room: 0, deliveries: paused }) })), []);
    assert.deepEqual(resumes(run({ state: bridge({ room: 1, deliveries: paused }) })), ["d-2"]);
    assert.deepEqual(run({ state: bridge({ room: 0, deliveries: paused }) }).stops, []);
  });
  test("a verdict, failed-twice, red, conflicted or environment pause is never resumed, and is a stop", () => {
    for (const kind of ["visual-verdict", "failed-twice", "ci-red", "conflicted", "environment", "step-failed", "stopped", "board", "needs-update", "pr-closed", "changed-commit", "ci-change", "busy"]) {
      const r = run({ state: bridge({ deliveries: [dl(2, "paused", kind)] }) });
      assert.deepEqual(resumes(r), [], kind);
      assert.deepEqual(r.stops.map((s) => [s.kind, s.ref]), [[kind, full(2)]], kind);
    }
  });
  test("the same stop is not returned twice: its key, once recorded, silences it", () => {
    const ctx = { state: bridge({ deliveries: [dl(2, "paused", "visual-verdict")] }) };
    const first = run(ctx);
    assert.equal(first.stops.length, 1);
    assert.deepEqual(run({ ...ctx, stops: first.stops.map((s) => s.key) }).stops, []);
  });
  test("a second, different stop is still returned", () => {
    const a = run({ state: bridge({ deliveries: [dl(2, "paused", "failed-twice")] }) }).stops[0];
    const both = run({ state: bridge({ deliveries: [dl(2, "paused", "failed-twice"), dl(3, "paused", "environment")] }), stops: [a.key] });
    assert.deepEqual(both.stops.map((s) => s.ref), [full(3)]);
  });
});

describe("the bridge down (from 80)", () => {
  test("down under about 10 minutes is no stop; at 10 minutes it is one, and it is not repeated once recorded", () => {
    assert.equal(BRIDGE_DOWN_MS, 600_000);
    assert.deepEqual(run({ state: null, downForMs: BRIDGE_DOWN_MS - 1 }).stops, []);
    const r = run({ state: null, downForMs: BRIDGE_DOWN_MS });
    assert.deepEqual(r.stops.map((s) => s.kind), ["bridge-down"]);
    assert.deepEqual(run({ state: null, downForMs: 3 * BRIDGE_DOWN_MS, stops: r.stops.map((s) => s.key) }).stops, []);
  });
});

describe("draining for an update (from den-mvp/86)", () => {
  test("while the snapshot says the bridge is draining, nothing starts and nothing is a stop: it is a wait", () => {
    const r = run({ state: bridge({ update: { draining: true } }) });
    assert.deepEqual([r.actions, r.stops], [[], []]);
    assert.match(String(r.waiting), /drain|update/i);
  });
  test("a bridge-restart pause is still resumed after the update, as usual", () => {
    assert.deepEqual(resumes(run({ state: bridge({ deliveries: [dl(2, "paused", "bridge-restart")] }) })), ["d-2"]);
  });
});

describe("pairing by files (from 83)", () => {
  const P = (...n) => n.map((x) => `apps/a/${x}.mjs`);
  test("two tickets sharing a path are not run side by side: with one running, the overlapping one is skipped, the next clear one starts", () => {
    const r = run({
      order: order("1", "2", "3"),
      tickets: [tk(1, { status: "claimed", paths: P("x", "y") }), tk(2, { paths: P("y") }), tk(3, { paths: P("z") })],
      state: bridge({ room: 1, deliveries: [dl(1)] }),
    });
    assert.deepEqual(starts(r), [full(3)]);
  });
  test("with two free slots and nothing running, two tickets that share a path start one, not both", () => {
    const r = run({ order: order("1", "2"), tickets: [tk(1, { paths: P("x") }), tk(2, { paths: P("x") })], state: bridge({ room: 2 }) });
    assert.deepEqual(starts(r), [full(1)]);
  });
  test("two tickets with disjoint files start together", () => {
    const r = run({ order: order("1", "2"), tickets: [tk(1, { paths: P("x") }), tk(2, { paths: P("y") })], state: bridge({ room: 2 }) });
    assert.deepEqual(starts(r), [full(1), full(2)]);
  });
  test("a paused delivery still holds its files (its pull request is open)", () => {
    const r = run({ order: order("1", "2"), tickets: [tk(1, { status: "claimed", paths: P("x") }), tk(2, { paths: P("x") })], state: bridge({ room: 1, deliveries: [dl(1, "paused", "visual-verdict")] }) });
    assert.deepEqual(starts(r), []);
  });
  test("a claim made by hand holds its files too", () => {
    const r = run({ order: order("1", "2"), tickets: [tk(1, { status: "claimed", locked: true, paths: P("x") }), tk(2, { paths: P("x") })], state: bridge({ room: 1, locks: [1] }) });
    assert.deepEqual(starts(r), []);
  });
  test("a not-beside note keeps two tickets apart even with no shared path, from either side", () => {
    const disjoint = [tk(1, { status: "claimed", paths: P("x") }), tk(2, { paths: P("y") })];
    const running = bridge({ room: 1, deliveries: [dl(1)] });
    assert.deepEqual(starts(run({ order: order("1", ["2", ["1"]]), tickets: disjoint, state: running })), [], "the note is on the candidate");
    assert.deepEqual(starts(run({ order: order(["1", ["2"]], "2"), tickets: disjoint, state: running })), [], "the note is on the running ticket");
    assert.deepEqual(starts(run({ order: order("1", "2"), tickets: disjoint, state: running })), [full(2)], "without the note they pair");
    const both = run({ order: order("1", ["2", ["1"]]), tickets: [tk(1, { paths: P("x") }), tk(2, { paths: P("y") })], state: bridge({ room: 2 }) });
    assert.deepEqual(starts(both), [full(1)], "nor does one tick start both");
  });
  test("a ticket with unknown files runs alone", () => {
    const none = { paths: [] };
    // first in the order: it starts, and nothing starts beside it in the same tick
    assert.deepEqual(starts(run({ order: order("1", "2"), tickets: [tk(1, none), tk(2, { paths: P("y") })], state: bridge({ room: 2 }) })), [full(1)]);
    // running: nothing starts beside it
    assert.deepEqual(starts(run({ order: order("1", "2"), tickets: [tk(1, { ...none, status: "claimed" }), tk(2, { paths: P("y") })], state: bridge({ room: 1, deliveries: [dl(1)] }) })), []);
    // a candidate with unknown files is not started beside a running ticket
    assert.deepEqual(starts(run({ order: order("1", "2", "3"), tickets: [tk(1, { status: "claimed", paths: P("x") }), tk(2, none), tk(3, { paths: P("z") })], state: bridge({ room: 1, deliveries: [dl(1)] }) })), [full(3)]);
  });
});
