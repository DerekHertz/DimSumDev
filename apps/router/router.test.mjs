// den-mvp/88: the thin runner around decide(). Everything it touches is injected, so no process, clock or network runs here.
//   createRouter({ bridge, readOrder, readBoard, readUsage, stops, push, now }) -> { tick() }
//   bridge     { state() -> Promise<GET /state> (rejects when the bridge does not answer),
//                startDelivery(ref) -> { ok, status, error?, draining? }, resumeDelivery(id) -> same }
//   readOrder  () -> the order file's text      readBoard () -> [{ ref, text, locked }]      readUsage () -> usage.mjs --live's JSON, or { error }
//   stops      { known() -> Promise<string[]> (keys on the board), record(stop) -> Promise }   push (stop) -> Promise
//   now        () -> ms. The only state the router holds is when the bridge first failed to answer, in memory.
//   tick()     one reconcile: read, decide, act. A stop is recorded on the board first, then pushed, once.
//   A refused start is not retried within the tick; one with draining:true is a wait: no stop, no push.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "./router.mjs";
import { BRIDGE_DOWN_MS } from "./decide.mjs";

const text = (n, paths = ["apps/a/x.mjs"]) => `# ${n}\n\n**Type:** feature\n\n**Status:** ready-for-agent\n\n**Blocked by:** None\n\n## What to build\n${paths.map((p) => `\`${p}\``).join(" ")}\n`;
const REF = "fx/01-slug";
const st = (deliveries = [], room = 2) => ({ capacity: { max: 2, cap: 4, load: 0, live: 0, room, refs: [] }, deliveries });
const paused = (kind, id = "d-9") => ({ id, ref: "fx/09-other", state: "paused", pause: { kind }, updatedAt: "t1" });

function rig(over = {}) {
  const calls = { start: [], resume: [], recorded: [], pushed: [] };
  const known = [];
  const clock = { t: 1_000_000 };
  const parts = {
    bridge: {
      state: async () => parts.stateNow,
      startDelivery: async (ref) => (calls.start.push(ref), parts.startReply ?? { ok: true, status: 201 }),
      resumeDelivery: async (id) => (calls.resume.push(id), { ok: true, status: 202 }),
    },
    stateNow: st(),
    readOrder: async () => "## Order\n- fx/01\n",
    readBoard: async () => [{ ref: REF, text: text(1), locked: false }],
    readUsage: async () => ({ "5-hour": { percent: 10 }, source: "live", age_s: 0 }),
    stops: { known: async () => [...known], record: async (s) => (calls.recorded.push(s), known.push(s.key)) },
    push: async (s) => void calls.pushed.push(s),
    now: () => clock.t,
    ...over,
  };
  return { parts, calls, clock, known, router: () => createRouter(parts) };
}

describe("one tick", () => {
  test("starts the first ready ticket in the order through the bridge", async () => {
    const r = rig();
    await r.router().tick();
    assert.deepEqual(r.calls.start, [REF]);
  });
  test("resumes a bridge-restart pause through the bridge", async () => {
    const r = rig({ stateNow: undefined });
    r.parts.stateNow = st([paused("bridge-restart")]);
    await r.router().tick();
    assert.deepEqual(r.calls.resume, ["d-9"]);
  });
  test("killing and restarting the router changes nothing it decides: a fresh router acts exactly as the old one would", async () => {
    const a = rig();
    const b = rig();
    for (const r of [a, b]) r.parts.stateNow = st([paused("bridge-restart"), paused("usage", "d-8")]);
    const old = a.router();
    await old.tick();
    await b.router().tick();
    assert.deepEqual([a.calls.start, a.calls.resume], [b.calls.start, b.calls.resume]);
  });
  test("a failed live usage reading starts nothing, records one stop and pushes it once, however many ticks follow", async () => {
    const r = rig({ readUsage: async () => ({ error: "HTTP 401" }) });
    const router = r.router();
    await router.tick();
    await router.tick();
    await r.router().tick(); // a restarted router too: the board remembers
    assert.deepEqual(r.calls.start, []);
    assert.equal(r.calls.recorded.length, 1);
    assert.equal(r.calls.pushed.length, 1);
    assert.equal(r.calls.pushed[0].key, r.calls.recorded[0].key);
  });
  test("a pause the user owns is recorded on the board and pushed once, and is never resumed", async () => {
    const r = rig();
    r.parts.stateNow = st([paused("visual-verdict")]);
    const router = r.router();
    await router.tick();
    await router.tick();
    assert.deepEqual(r.calls.resume, []);
    assert.deepEqual([r.calls.recorded.length, r.calls.pushed.length], [1, 1]);
    assert.equal(r.calls.recorded[0].kind, "visual-verdict");
  });
  test("a bad order file starts nothing and is one stop", async () => {
    const r = rig({ readOrder: async () => "## Order\n- not a ref\n" });
    await r.router().tick();
    await r.router().tick();
    assert.deepEqual(r.calls.start, []);
    assert.deepEqual([r.calls.recorded.length, r.calls.pushed.length], [1, 1]);
  });
});

describe("the bridge down", () => {
  test("reported once after about 10 minutes, not before, never twice", async () => {
    const r = rig();
    r.parts.bridge.state = async () => {
      throw new Error("ECONNREFUSED");
    };
    const router = r.router();
    await router.tick(); // first failure: the clock starts
    r.clock.t += BRIDGE_DOWN_MS - 1000;
    await router.tick();
    assert.equal(r.calls.pushed.length, 0);
    r.clock.t += 2000;
    await router.tick();
    assert.equal(r.calls.pushed.length, 1);
    assert.equal(r.calls.pushed[0].kind, "bridge-down");
    r.clock.t += 5 * BRIDGE_DOWN_MS;
    await router.tick();
    assert.equal(r.calls.pushed.length, 1);
    assert.deepEqual(r.calls.start, []);
  });
});

describe("a refused start while the bridge drains for an update (den-mvp/86)", () => {
  test("is a wait: no stop, no push, no failure; the next tick starts once the bridge accepts again", async () => {
    const r = rig();
    r.parts.startReply = { ok: false, status: 503, error: "the den is updating; it takes no new run until it restarts", draining: true };
    const router = r.router();
    const report = await router.tick();
    assert.deepEqual([r.calls.recorded, r.calls.pushed], [[], []]);
    assert.notEqual(report?.failed, true);
    r.parts.startReply = { ok: true, status: 201 };
    await router.tick();
    assert.deepEqual(r.calls.start, [REF, REF]);
  });
  test("after the update, the bridge-restart pauses it left are resumed as usual", async () => {
    const r = rig();
    r.parts.stateNow = st([paused("bridge-restart")]);
    await r.router().tick();
    assert.deepEqual(r.calls.resume, ["d-9"]);
  });
  test("a stop whose text looks like a secret is neither pushed nor recorded with that text", async () => {
    const r = rig();
    r.parts.startReply = { ok: false, status: 409, error: 'bad config: password = "hunter2222"' };
    await r.router().tick();
    assert.deepEqual([r.calls.recorded.length, r.calls.pushed.length], [1, 1]);
    for (const s of [r.calls.recorded[0], r.calls.pushed[0]]) assert.doesNotMatch(s.text, /hunter2222/);
  });
  // Security L2: the bridge answers 400 to a key over 300 or a text over 500 characters, so an uncut one is never recorded and is retried every tick.
  test("a stop's key and text are cut to the bridge's bounds before they are recorded or pushed, and it is then recorded once", async () => {
    const r = rig({ readOrder: async () => `## Order\n- ${"not a ref ".repeat(80)}\n` });
    await r.router().tick();
    await r.router().tick();
    assert.equal(r.calls.recorded.length, 1);
    const long = rig();
    long.parts.startReply = { ok: false, status: 409, error: "e".repeat(900) };
    await long.router().tick();
    await long.router().tick();
    for (const stop of [...r.calls.recorded, ...r.calls.pushed, ...long.calls.recorded, ...long.calls.pushed]) {
      assert.ok(stop.key.length <= 300, `key ${stop.key.length}`);
      assert.ok(stop.text.length <= 500, `text ${stop.text.length}`);
    }
    assert.deepEqual([long.calls.recorded.length, long.calls.pushed.length], [1, 1]);
  });
  test("a refused start that is not a drain is not silent: it is recorded and pushed once", async () => {
    const r = rig();
    r.parts.startReply = { ok: false, status: 409, error: "the ticket is not in the frontier" };
    const router = r.router();
    await router.tick();
    await router.tick();
    assert.deepEqual([r.calls.recorded.length, r.calls.pushed.length], [1, 1]);
  });
});

describe("a stop that could not be recorded (den-mvp/88 qa bounce)", () => {
  test("is pushed once, recorded on a later tick when the record works again, and not pushed again", async () => {
    const r = rig();
    let up = false;
    r.parts.stops.record = async (s) => {
      if (!up) throw new Error("POST /router-stops answered 500");
      r.calls.recorded.push(s);
      r.known.push(s.key);
    };
    r.parts.readUsage = async () => ({ error: "HTTP 401" });
    const router = r.router();
    await router.tick();
    await router.tick();
    assert.deepEqual([r.calls.recorded.length, r.calls.pushed.length], [0, 1]);
    up = true;
    await router.tick();
    await router.tick();
    assert.deepEqual([r.calls.recorded.length, r.calls.pushed.length], [1, 1]);
    assert.equal(r.calls.recorded[0].key, r.calls.pushed[0].key);
  });
  test("a stop raised while the bridge is down is recorded once the bridge answers", async () => {
    const r = rig({ readOrder: async () => "## Order\n- not a ref\n" });
    let up = false;
    r.parts.bridge.state = async () => {
      if (!up) throw new Error("ECONNREFUSED");
      return st();
    };
    r.parts.stops.record = async (s) => {
      if (!up) throw new Error("the bridge is down");
      r.calls.recorded.push(s);
      r.known.push(s.key);
    };
    const router = r.router();
    await router.tick();
    up = true;
    await router.tick();
    await router.tick();
    assert.deepEqual([r.calls.recorded.length, r.calls.pushed.length], [1, 1]);
  });
});

describe("the bridge down is push-only, then recorded once it answers", () => {
  const down = () => {
    const r = rig();
    let up = false;
    r.parts.bridge.state = async () => {
      if (!up) throw new Error("ECONNREFUSED");
      return st([], 0);
    };
    return { r, answer: () => (up = true) };
  };
  test("no record is attempted through the down bridge; one 'was down for N minutes' stop is recorded when it answers, not pushed again", async () => {
    const { r, answer } = down();
    const router = r.router();
    await router.tick();
    r.clock.t += BRIDGE_DOWN_MS + 60_000;
    await router.tick();
    await router.tick();
    assert.deepEqual([r.calls.recorded.length, r.calls.pushed.length], [0, 1]);
    answer();
    await router.tick();
    await router.tick();
    assert.equal(r.calls.pushed.length, 1);
    assert.equal(r.calls.recorded.length, 1);
    assert.equal(r.calls.recorded[0].kind, "bridge-down");
    assert.match(r.calls.recorded[0].text, /was down for 1\d minutes/);
  });
  test("an outage under the threshold records nothing", async () => {
    const { r, answer } = down();
    const router = r.router();
    await router.tick();
    r.clock.t += 60_000;
    answer();
    await router.tick();
    assert.deepEqual([r.calls.recorded.length, r.calls.pushed.length], [0, 0]);
  });
  test("a second outage is reported again", async () => {
    const r = rig();
    let up = false;
    r.parts.bridge.state = async () => {
      if (!up) throw new Error("ECONNREFUSED");
      return st([], 0);
    };
    const router = r.router();
    for (let i = 0; i < 2; i++) {
      up = false;
      await router.tick();
      r.clock.t += BRIDGE_DOWN_MS + 1000;
      await router.tick();
      up = true;
      r.clock.t += 1000;
      await router.tick();
    }
    assert.deepEqual([r.calls.recorded.length, r.calls.pushed.length], [2, 2]);
  });
});

describe("the live usage reading is read only when a start or resume is due", () => {
  test("with nothing to start or resume, usage is not read and no stop is raised", async () => {
    let reads = 0;
    const r = rig({ readBoard: async () => [], readUsage: async () => (reads++, { error: "HTTP 429" }) });
    await r.router().tick();
    assert.equal(reads, 0);
    assert.deepEqual([r.calls.recorded, r.calls.pushed], [[], []]);
  });
  test("with a ticket due it is read, once per tick", async () => {
    let reads = 0;
    const r = rig({ readUsage: async () => (reads++, { "5-hour": { percent: 10 }, source: "live", age_s: 0 }) });
    await r.router().tick();
    assert.equal(reads, 1);
    assert.deepEqual(r.calls.start, [REF]);
  });
  test("a user-owned pause is still reported with no usage reading", async () => {
    let reads = 0;
    const r = rig({ readBoard: async () => [], readUsage: async () => (reads++, { error: "x" }) });
    r.parts.stateNow = st([paused("visual-verdict")]);
    await r.router().tick();
    assert.deepEqual([reads, r.calls.pushed.length], [0, 1]);
  });
});
