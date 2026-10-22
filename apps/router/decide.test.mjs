// den-mvp/88 (ADR 0027): the router's decision, a pure function. No process, no clock, no network.
//   decide({ order, tickets, state, usage, stops, downForMs, changed }) -> { actions, stops, waiting }
//   order     parseOrder's result: { entries: [{ ref: "fx/1", notBeside: [] }] } (short refs)
//   tickets   the board as scripts/batch-groups.mjs reads it: [{ ref: "fx/01-slug", text, locked }]
//   state     the bridge's GET /state, or null when the bridge does not answer. Read: capacity { room, refs: [{ ref, kind }] },
//             deliveries [{ id, ref, state: running|paused|merged|closed, pause: { kind } | null, updatedAt }], update?: { draining }
//   usage     what `scripts/usage.mjs --live` printed ({ "5-hour": { percent }, source, stale?, unknown? }), or { error } when it failed
//   stops     keys already recorded on the board (an array): a stop whose key is in it is not returned again
//   downForMs how long the bridge has not answered (the runner measures it)
//   changed   Map of delivery id -> the files its branch changed (the runner reads git). A delivery missing from it holds
//             the files its ticket names; a delivery on a resolved or closed ticket holds nothing.
//   actions   [{ type: "start", ref: <full board ref> } | { type: "resume", id }], in the order to run them
//   stops(out) [{ key, kind, ref?, text }]: kind is the pause kind verbatim, or "bridge-down" | "usage-reading"
//   waiting   null, or a string that says why nothing was started (a wait is never a stop)
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decide, STOP_AT_PERCENT, BRIDGE_DOWN_MS, RESUMABLE, LOOK_INTERVAL_MS } from "./decide.mjs";

const full = (n) => `fx/${String(n).padStart(2, "0")}-slug`;
const tk = (n, { status = "ready-for-agent", paths = ["apps/a/default.mjs"], locked = false, blockedBy = "None", type = "feature" } = {}) => ({
  ref: full(n),
  locked,
  text: `# ${n}\n\n**Type:** ${type}\n\n**Status:** ${status}\n\n**Blocked by:** ${blockedBy}\n\n## What to build\n${paths.map((p) => `\`${p}\``).join(" ")}\n\n## Acceptance criteria\n- [ ] x\n`,
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
  test("den-mvp/105 a user acts ticket is never started, and the next eligible ticket starts instead", () => {
    const r = run({ order: order("1", "2"), tickets: [tk(1, { type: "user acts" }), tk(2)], state: bridge({ room: 1 }) });
    assert.deepEqual(starts(r), [full(2)]);
    assert.deepEqual(starts(run({ order: order("1"), tickets: [tk(1, { type: "user acts" })] })), []);
  });
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
  test("a paused delivery holds the files its branch changed, not 'everything', when its ticket names none", () => {
    const tickets = [tk(1, { status: "in-review", paths: [] }), tk(2, { paths: P("y") }), tk(3, { paths: P("x") })];
    const state = bridge({ room: 2, deliveries: [dl(1, "paused", "failed-twice")] });
    assert.deepEqual(starts(run({ order: order("2", "3"), tickets, state })), [], "without the diff it holds everything");
    assert.deepEqual(starts(run({ order: order("2", "3"), tickets, state, changed: new Map([["d-1", P("x")]]) })), [full(2)]);
    assert.deepEqual(starts(run({ order: order("2", "3"), tickets, state, changed: new Map([["d-1", []]]) })), [full(2), full(3)], "an empty diff holds nothing");
  });
  test("a delivery whose ticket is resolved or closed holds nothing", () => {
    for (const status of ["resolved", "closed"]) {
      const r = run({ order: order("2"), tickets: [tk(1, { status, paths: [] }), tk(2, { paths: P("y") })], state: bridge({ room: 1, deliveries: [dl(1, "paused", "no-commit")] }) });
      assert.deepEqual(starts(r), [full(2)], status);
    }
  });
  test("a directory or glob path overlaps the files under it", () => {
    const state = bridge({ room: 1, deliveries: [dl(1)] });
    const holder = tk(1, { status: "claimed", paths: ["apps/b/server.mjs"] });
    for (const p of ["apps/b/", "apps/*.mjs", "apps/b/server.mjs"]) assert.deepEqual(starts(run({ order: order("2"), tickets: [holder, tk(2, { paths: [p] })], state })), [], p);
    assert.deepEqual(starts(run({ order: order("2"), tickets: [holder, tk(2, { paths: ["apps/bb/"] })], state })), [full(2)]);
  });
});

describe("den-mvp/106: a look at a guardrail or ci-pending pause", () => {
  const T0 = 5_000_000;
  test("both kinds are resumed, never more often than the look interval, and a look takes no room", () => {
    for (const kind of ["guardrail", "ci-pending"]) {
      const state = bridge({ room: 0, deliveries: [dl(2, "paused", kind)] });
      assert.deepEqual(resumes(run({ state, nowMs: T0 })), ["d-2"], kind);
      const looked = new Map([["d-2", T0]]);
      assert.deepEqual(resumes(run({ state, looked, nowMs: T0 + LOOK_INTERVAL_MS - 1 })), [], kind);
      assert.deepEqual(resumes(run({ state, looked, nowMs: T0 + LOOK_INTERVAL_MS })), ["d-2"], kind);
    }
  });
  test("a guardrail pause is still a stop (the merge is the user's), once; ci-pending is not", () => {
    const g = run({ state: bridge({ deliveries: [dl(2, "paused", "guardrail")] }), nowMs: T0 });
    assert.equal(g.stops.length, 1);
    assert.deepEqual(run({ state: bridge({ deliveries: [{ ...dl(2, "paused", "guardrail"), updatedAt: "later" }] }), stops: [g.stops[0].key], nowMs: T0 }).stops, [], "a look that pauses again is not a new stop");
    assert.deepEqual(run({ state: bridge({ deliveries: [dl(2, "paused", "ci-pending")] }), nowMs: T0 }).stops, []);
  });
  test("a ticket blocked only by a ticket that just merged starts on the next tick", () => {
    const ctx = { order: order("1", "2"), state: bridge({ room: 1 }) };
    assert.deepEqual(starts(run({ ...ctx, tickets: [tk(1, { status: "in-review" }), tk(2, { blockedBy: "fx/1" })] })), []);
    assert.deepEqual(starts(run({ ...ctx, tickets: [tk(1, { status: "resolved" }), tk(2, { blockedBy: "fx/1" })] })), [full(2)]);
  });
  test("RESUMABLE matches the runner's ROUTER_RESUMES", () => {
    const src = readFileSync(new URL("../bridge/delivery/runner.mjs", import.meta.url), "utf8");
    const list = /const ROUTER_RESUMES = new Set\(\[([^\]]*)\]\)/.exec(src)[1].match(/"([^"]+)"/g).map((x) => x.slice(1, -1));
    assert.deepEqual([...RESUMABLE].sort(), list.sort());
  });
});

describe("den-mvp/107: a parked ticket's delivery holds no files", () => {
  test("a paused or running delivery on a parked ticket does not hold its files, nor keep a not-beside apart", () => {
    for (const state of ["paused", "running"]) {
      const d = dl(1, state, state === "paused" ? "failed-twice" : null);
      const tickets = [tk(1, { status: "parked", paths: ["apps/a/x.mjs"] }), tk(2, { paths: ["apps/a/x.mjs"] })];
      assert.deepEqual(starts(run({ order: order("2"), tickets, state: bridge({ room: 1, deliveries: [d] }) })), [full(2)], state);
      assert.deepEqual(starts(run({ order: order(["2", ["1"]]), tickets, state: bridge({ room: 1, deliveries: [d] }) })), [full(2)], state);
    }
  });
});
