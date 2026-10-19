// showcase-v1/04: handoff derivation, susan basket layout, turn timing and lantern/bell state. Pure.
// Expected values are hand-worked literals from the ticket and ADR 0013.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DUR_SLOW_MS, deriveHandoffs, lanternState, lerpAngle, stationBearing, susanLayout, trackedTickets, turnAngle,
} from "./handoffs.mjs";
import { BAO, TABLE } from "./banquet-layout.mjs";

const ticket = (n, over = {}) => ({
  ref: `f/${String(n).padStart(2, "0")}-t`, type: "feature", status: "ready-for-agent", holder: null, lastRole: null, gate: null, ...over,
});
const held = (cell) => ({ role: cell, since: "2026-09-29T05:00:00.000Z" });
const snap = (tickets, frontier = []) => ({ tickets, frontier });

test("station change: qa specify then developer claims, ticket moves tea -> steamers", () => {
  const before = snap([ticket(1, { status: "in-review", lastRole: "qa" })], []);
  const after = snap([ticket(1, { status: "claimed", holder: held("developer") })], []);
  assert.deepEqual(deriveHandoffs(before, after), [
    { ref: "f/01-t", fromCell: "qa", toCell: "developer", from: "tea", to: "steamers", sameStation: false },
  ]);
});

test("same-station change: developer to scout is a handoff within steamers", () => {
  const before = snap([ticket(1, { status: "claimed", holder: held("developer") })]);
  const after = snap([ticket(1, { status: "claimed", holder: held("scout") })]);
  assert.deepEqual(deriveHandoffs(before, after), [
    { ref: "f/01-t", fromCell: "developer", toCell: "scout", from: "steamers", to: "steamers", sameStation: true },
  ]);
});

test("same cell type is not a handoff (status change only)", () => {
  const before = snap([ticket(1, { status: "claimed", holder: held("qa") })]);
  const after = snap([ticket(1, { status: "in-review", lastRole: "qa" })]);
  assert.deepEqual(deriveHandoffs(before, after), []);
});

test("a new ticket is not a handoff", () => {
  const after = snap([ticket(1, { status: "claimed", holder: held("developer") })]);
  assert.deepEqual(deriveHandoffs(snap([]), after), []);
});

test("a resolved ticket is not a handoff", () => {
  const before = snap([ticket(1, { status: "in-review", lastRole: "security" })]);
  const after = snap([ticket(1, { status: "resolved", lastRole: "orchestrator" })]);
  assert.deepEqual(deriveHandoffs(before, after), []);
});

test("no previous snapshot (first load) gives no handoffs", () => {
  assert.deepEqual(deriveHandoffs(null, snap([ticket(1, { status: "claimed", holder: held("qa") })])), []);
});

test("queued tickets are tracked too: a frontier ticket whose last cell changes hands over", () => {
  const before = snap([ticket(1, { lastRole: "qa" })], ["f/01-t"]);
  const after = snap([ticket(1, { lastRole: "developer" })], ["f/01-t"]);
  const [h] = deriveHandoffs(before, after);
  assert.equal(h.from, "tea");
  assert.equal(h.to, "steamers");
});

test("several handoffs come out in ref order", () => {
  const before = snap([
    ticket(2, { status: "claimed", holder: held("qa") }),
    ticket(1, { status: "claimed", holder: held("developer") }),
  ]);
  const after = snap([
    ticket(2, { status: "claimed", holder: held("security") }),
    ticket(1, { status: "claimed", holder: held("qa") }),
  ]);
  assert.deepEqual(deriveHandoffs(before, after).map((h) => h.ref), ["f/01-t", "f/02-t"]);
});

test("trackedTickets: active plus frontier, with station", () => {
  const t = trackedTickets(snap([
    ticket(1, { status: "claimed", holder: held("security") }),
    ticket(2, { lastRole: "qa" }),
    ticket(3),
    ticket(4, { status: "resolved" }),
  ], ["f/02-t"]));
  assert.deepEqual([...t.entries()], [
    ["f/01-t", { cellType: "security", station: "pantry" }],
    ["f/02-t", { cellType: "qa", station: "tea" }],
  ]);
});

test("stationBearing: angle from the table toward each stall, +z is 0, +x is positive", () => {
  assert.ok(Math.abs(stationBearing("cubs") + 0.5404195002705842) < 1e-9);
  assert.ok(Math.abs(stationBearing("front-of-house") - Math.atan2(3.6, -1.4)) < 1e-9); // den-scene-v1/11: the Front of House kiosk stands at x 3.6
  assert.ok(Math.abs(Math.abs(stationBearing("orchestrator")) - Math.PI) < 1e-9, "Bao's bearing follows BAO.position z -3.3, straight back from the table");
  assert.ok(stationBearing("steamers") < 0 && stationBearing("tea") < 0);
  assert.ok(stationBearing("pantry") > 0);
  // Bao's own station (Pass cells) sits at the back of the table.
  assert.ok(Math.abs(Math.abs(stationBearing("orchestrator")) - Math.PI) < 1e-9);
});

test("susanLayout: baskets in one station never overlap and stay on the susan", () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ ref: `r${i}`, station: "steamers" }));
  const out = susanLayout(items);
  assert.equal(out.length, 8);
  for (const b of out) assert.ok(b.radius <= 0.95 && b.radius >= 0.3, `radius ${b.radius}`);
  const xy = out.map((b) => [Math.sin(b.angle) * b.radius, Math.cos(b.angle) * b.radius]);
  for (let i = 0; i < xy.length; i++) {
    for (let j = i + 1; j < xy.length; j++) {
      assert.ok(Math.hypot(xy[i][0] - xy[j][0], xy[i][1] - xy[j][1]) >= 0.4, `${i} and ${j} overlap`);
    }
  }
});

test("susanLayout: a lone basket sits on its station's bearing at the outer ring", () => {
  const [b] = susanLayout([{ ref: "r", station: "pantry" }]);
  assert.equal(b.ref, "r");
  assert.ok(Math.abs(b.angle - stationBearing("pantry")) < 1e-9);
  assert.equal(b.radius, 0.85);
});

test("susanLayout is deterministic and keeps input order", () => {
  const items = [{ ref: "a", station: "tea" }, { ref: "b", station: "tea" }, { ref: "c", station: "pantry" }];
  assert.deepEqual(susanLayout(items), susanLayout(items));
  assert.deepEqual(susanLayout(items).map((b) => b.ref), ["a", "b", "c"]);
});

test("susanLayout caps at 12 baskets", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ ref: `r${i}`, station: "tea" }));
  assert.equal(susanLayout(items).length, 12);
});

test("lerpAngle takes the short way round", () => {
  assert.ok(Math.abs(lerpAngle(3, -3, 0.5) - ((3 + (-3 + 2 * Math.PI)) / 2)) < 1e-9);
  assert.equal(lerpAngle(0, 1, 0), 0);
  assert.equal(lerpAngle(0, 1, 1), 1);
});

test("turnAngle: eases over dur-slow, and reduced motion jumps straight to the target", () => {
  assert.equal(DUR_SLOW_MS, 700);
  assert.equal(turnAngle(0, 1, 0, false), 0);
  assert.equal(turnAngle(0, 1, DUR_SLOW_MS, false), 1);
  assert.equal(turnAngle(0, 1, DUR_SLOW_MS * 5, false), 1);
  const mid = turnAngle(0, 1, DUR_SLOW_MS / 2, false);
  assert.ok(mid > 0.4 && mid < 0.6);
  assert.equal(turnAngle(0, 1, 0, true), 1);
  assert.equal(turnAngle(0, 1, 10, true), 1);
});

test("lanternState: the stall of every waiting cell lights, and the bell lights for any", () => {
  const cells = [
    { cellType: "qa", pose: "waiting_on_user" },
    { cellType: "developer", pose: "working" },
    { cellType: "security", pose: "waiting_on_user" },
    { cellType: "orchestrator", pose: "waiting_on_user" },
  ];
  const s = lanternState(cells);
  assert.deepEqual([...s.stalls].sort(), ["pantry", "tea"]);
  assert.equal(s.bell, true);
});

test("lanternState: nothing waiting lights nothing", () => {
  const s = lanternState([{ cellType: "developer", pose: "working" }, { cellType: "qa", pose: "done" }]);
  assert.deepEqual([...s.stalls], []);
  assert.equal(s.bell, false);
  assert.deepEqual([...lanternState([]).stalls], []);
});

test("the service bell stands on Bao's crown", async () => {
  const { BELL } = await import("./banquet-layout.mjs");
  assert.ok(BELL.y > BAO.position[1] + BAO.scale * 0.8, "above Bao's centre, near the crown");
  assert.ok(Math.abs(BELL.x) < 0.8);
  const { RAIL } = await import("./banquet-layout.mjs");
  assert.ok(Math.abs(BELL.y - (RAIL.y + RAIL.height / 2)) < 1e-9, "the bell is seated on the Pass rail, not floating");
  assert.ok(Math.abs(BELL.x - RAIL.x) <= RAIL.width / 2, "within the rail's length");
  // den-scene-v1/11: the rail is a 2.0-wide fitting 0.05 thick on Bao's crown (designer's measured rest numbers, world), the bell
  // stands 0.75 along it. They ride the head bone at run time (bao-seats.test.mjs); these are the rest values.
  assert.equal(RAIL.width, 2.0);
  assert.equal(RAIL.height, 0.05);
  assert.ok(Math.abs(RAIL.y - 4.2465) <= 0.063, `rail centre y ${RAIL.y} vs 4.2465`);
  assert.ok(Math.abs(RAIL.z - -3.6885) <= 0.063, `rail z ${RAIL.z} vs -3.6885`);
  assert.equal(RAIL.x, 0);
  assert.ok(Math.abs(BELL.x - 0.75) < 1e-9, "the bell stands at x 0.75 on the rail top, the orchestrator slots step away from it");
  assert.equal(TABLE.x, 0);
});

test("wiring: App renders the Meshy den with the frontier, and hearts still reach the chips", async () => {
  // den-v1 (#151): the procedural den replaced the market scene; the handoff delivery
  // choreography was not ported, but handoffs still drive the heart bubbles.
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /import \{ MeshyDen \} from "\.\/scene\/meshy\/MeshyDen\.jsx"/);
  assert.match(app, /useHandoffs\(snapshot\)/);
  assert.match(app, /<MeshyDen [^>]*frontier=\{frontier\}/);
  assert.match(app, /<ChipLayer [^>]*hearts=\{hearts\}/);
  assert.match(readFileSync(new URL("./ChipLayer.jsx", import.meta.url), "utf8"), /chip-heart/);
});

// den-scene-v1/11 T7: Bao's roam footprint comes from his scale, and the rear handoff arc stays outside it.
const baoRect = (obstacles) => obstacles.find((o) => o.kind === "rect" && o.x0 < 0 && o.x1 > 0 && o.z0 < BAO.position[2] && o.z1 > BAO.position[2]);

test("roamObstacles: Bao's rect is half sizes scale*1.0 by scale*0.875 around BAO.position, padded 0.4 (2.1 -> 2.5 by 2.2375)", async () => {
  const { roamObstacles } = await import("./roam.mjs");
  const r = baoRect(roamObstacles());
  assert.ok(r, "a rect around Bao");
  const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m}: ${a} vs ${b}`);
  near(r.x0, -2.5, "x0"); near(r.x1, 2.5, "x1");
  near(r.z0, -3.3 - 1.8375 - 0.4, "z0"); near(r.z1, -3.3 + 1.8375 + 0.4, "z1");
});

test("every handoff arc between two kiosks stays outside Bao's padded roam rect (the rear arc radius is at least 6.1)", async () => {
  const { roamObstacles } = await import("./roam.mjs");
  const { handoffPath } = await import("./handoffs.mjs");
  const { STALL_CENTERS } = await import("./banquet-layout.mjs");
  const r = baoRect(roamObstacles());
  const stations = Object.keys(STALL_CENTERS);
  let arcs = 0;
  for (const from of stations) for (const to of stations) {
    if (from === to) continue;
    arcs++;
    for (const p of handoffPath(from, to)) {
      const inside = p.x > r.x0 && p.x < r.x1 && p.z > r.z0 && p.z < r.z1;
      assert.ok(!inside, `${from} -> ${to}: sample (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) is inside Bao's padded rect`);
    }
  }
  assert.equal(arcs, 12, "every ordered pair of the four kiosks");
  // the rear arc between the two back kiosks rides at least 6.1 out
  const arcPoints = handoffPath("steamers", "front-of-house").slice(1, -1);
  assert.ok(arcPoints.length > 0);
  for (const p of arcPoints) assert.ok(Math.hypot(p.x, p.z) >= 6.1 - 1e-9, `arc radius ${Math.hypot(p.x, p.z)} < 6.1`);
});

test("no layout module hard-codes Bao's old z (-2.4): everything follows BAO.position", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["banquet-layout.mjs", "roam.mjs", "handoffs.mjs", "iso-projection.mjs"]) {
    const code = readFileSync(new URL(f, import.meta.url), "utf8").split("\n").map((l) => l.replace(/\/\/.*$/, "")).filter((l) => !/^\s*\*|^\s*\/\*/.test(l)).join("\n");
    assert.doesNotMatch(code, /-\s?2\.4\b/, `${f} still carries the literal -2.4`);
  }
});
