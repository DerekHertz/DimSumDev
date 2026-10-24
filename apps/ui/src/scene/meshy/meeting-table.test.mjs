// den-mvp/64: a meeting at Bao's table. Contract (pure, no three or DOM):
//   tableMeeting(meetings, now) -> the meeting the table shows, or null
//     - a running, paused or briefed meeting that is not retired; the newest by startedAt wins
//     - a decided or closed one stays for FAREWELL_MS after its updatedAt, so Bao can say what you chose
//   seatSpots(n) -> n spots around the table { x, z, yaw }, each facing the table, in role order
//   seatLabel(seat, meeting) -> { text, kind } for one seat; baoLabel(meeting) -> { text, kind }
//   seated(meeting) -> true while the seats stay at the table (running, paused, briefed)
//   routeTo(from, to) -> waypoints: out along the plaza ring when `from` is outside it, then the spot
//   claimOf(takeText) -> the take's Claim line, cut to CLAIM_MAX characters with an ellipsis
import { test } from "node:test";
import assert from "node:assert/strict";
import { TABLE, PLAZA_RING, FAREWELL_MS, CLAIM_MAX, tableMeeting, seatSpots, seatLabel, baoLabel, seated, routeTo, claimOf } from "./meeting-table.mjs";

test('selected meeting owns the scene even when a newer meeting exists; ended records never gather participants', () => {
  const first = { id: 'first', state: 'running', seats: [{ role: 'architect' }], startedAt: '2026-10-20T00:00:00Z' };
  const second = { id: 'second', state: 'running', seats: [{ role: 'qa' }], startedAt: '2026-10-21T00:00:00Z' };
  assert.deepEqual(tableMeeting([first, second], Date.now(), 'first').seats.map(s => s.role), ['architect']);
  assert.deepEqual(tableMeeting([first, second], Date.now(), 'second').seats.map(s => s.role), ['qa']);
  assert.equal(tableMeeting([{ ...first, state: 'ended' }, second], Date.now(), 'first'), null);
});

const meeting = (over = {}) => ({
  id: "m-1", ref: "den-mvp/57-routing", title: "57: Routing", state: "running", retired: false, live: null, brief: null, decisions: [],
  startedAt: "2026-10-16T23:13:49.081Z", updatedAt: "2026-10-16T23:13:49.083Z",
  seats: [{ role: "product", status: "waiting" }, { role: "architect", status: "waiting" }, { role: "developer", status: "waiting" }],
  ...over,
});
const NOW = Date.parse("2026-10-16T23:20:00Z");

test("the table shows the newest live meeting, and nothing once it is decided, closed or retired", () => {
  assert.equal(tableMeeting([], NOW), null);
  assert.equal(tableMeeting(undefined, NOW), null);
  const older = meeting({ id: "m-old", startedAt: "2026-10-16T22:00:00Z" });
  const newer = meeting({ id: "m-new", state: "briefed" });
  assert.equal(tableMeeting([newer, older], NOW).id, "m-new");
  assert.equal(tableMeeting([meeting({ state: "paused" })], NOW).id, "m-1");
  assert.equal(tableMeeting([meeting({ state: "briefed", retired: true })], NOW), null);
  const decided = meeting({ state: "decided", updatedAt: new Date(NOW - FAREWELL_MS - 1).toISOString() });
  assert.equal(tableMeeting([decided], NOW), null, "a choice made a while ago leaves the table empty");
  const justDecided = meeting({ state: "decided", updatedAt: new Date(NOW - 1000).toISOString() });
  assert.equal(tableMeeting([justDecided], NOW).id, "m-1", "Bao says what you chose for a moment");
  assert.equal(seated(justDecided), false, "but the seats are already going home");
  assert.equal(tableMeeting([justDecided, older], NOW).id, "m-old", "a live meeting beats a farewell");
});

test("seats sit around the table facing it, symmetric for three, and never inside the table", () => {
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const spots = seatSpots(n);
    assert.equal(spots.length, n);
    for (const s of spots) {
      const dx = s.x - TABLE.x, dz = s.z - TABLE.z;
      assert.ok((dx / 2.5) ** 2 + (dz / 1.55) ** 2 > 1.3, `seat (${s.x}, ${s.z}) clears the table top`);
      const facing = { x: Math.sin(s.yaw), z: Math.cos(s.yaw) };
      assert.ok(facing.x * -dx + facing.z * -dz > 0, "faces the table");
    }
  }
  const [left, front, right] = seatSpots(3);
  assert.ok(left.x < TABLE.x && right.x > TABLE.x && Math.abs(front.x - TABLE.x) < 1e-9);
  assert.ok(Math.abs(left.x + right.x - 2 * TABLE.x) < 1e-9, "left and right mirror each other");
  assert.ok(front.z > TABLE.z, "the front seat is on the camera side, away from Bao");
});

test("each seat's label follows the bridge: waiting, thinking, said its piece, passed, couldn't finish", () => {
  const m = meeting({ live: { role: "architect", part: "take" } });
  const [product, architect] = m.seats;
  assert.deepEqual(seatLabel(product, m), { text: "Waiting to speak", kind: "waiting" });
  assert.deepEqual(seatLabel(architect, m), { text: "Thinking", kind: "thinking" });
  assert.deepEqual(seatLabel({ role: "qa", status: "taken" }, m), { text: "Said its piece", kind: "done" });
  assert.deepEqual(seatLabel({ role: "qa", status: "declined" }, m), { text: "Passed", kind: "declined" });
  assert.deepEqual(seatLabel({ role: "qa", status: "failed" }, m), { text: "Couldn't finish", kind: "failed" });
  assert.deepEqual(seatLabel({ role: "qa", status: "something new" }, m), { text: "In the meeting", kind: "waiting" });
});

test("Bao's label follows the meeting: listening, drafting, brief ready, waiting, the choice", () => {
  assert.deepEqual(baoLabel(meeting()), { text: "Listening", kind: "waiting" });
  assert.deepEqual(baoLabel(meeting({ live: { role: "orchestrator", part: "brief" } })), { text: "Drafting the brief", kind: "thinking" });
  assert.deepEqual(baoLabel(meeting({ state: "briefed", brief: { options: [{ key: "A" }], recommended: "A" } })), { text: "Brief ready · your choice", kind: "brief" });
  assert.deepEqual(baoLabel(meeting({ state: "paused" })), { text: "Waiting on you", kind: "brief" });
  assert.deepEqual(baoLabel(meeting({ state: "decided", decisions: [{ option: "A" }] })), { text: "You chose A", kind: "done" });
  assert.deepEqual(baoLabel(meeting({ state: "closed", decisions: [] })), { text: "Closed", kind: "done" });
});

test("a route from a far team goes out along the plaza ring first; a near one goes straight", () => {
  const seat = seatSpots(3)[0];
  const far = routeTo({ x: -11.2, z: -4.9 }, seat);
  assert.equal(far.length, 2);
  assert.ok(Math.abs(Math.hypot(far[0].x, far[0].z) - PLAZA_RING) < 1e-9, "the first stop is on the ring");
  assert.deepEqual(far.at(-1), { x: seat.x, z: seat.z });
  const near = routeTo({ x: -3.6, z: -6.1 + 2 }, seat);
  assert.deepEqual(near, [{ x: seat.x, z: seat.z }]);
});

test("the claim is the take's Claim line, cut with an ellipsis", () => {
  const take = "# Take: architect\n\nSaved by the den's bridge.\n\n---\n\nClaim: Run Valhalla for routing.\nEvidence: docs";
  assert.equal(claimOf(take), "Run Valhalla for routing.");
  const long = `Claim: ${"x".repeat(200)}`;
  assert.equal(claimOf(long).length, CLAIM_MAX);
  assert.ok(claimOf(long).endsWith("…"));
  assert.equal(claimOf("no claim here"), null);
  assert.equal(claimOf(null), null);
  assert.equal(claimOf("**Claim:** bold one"), "bold one");
});
