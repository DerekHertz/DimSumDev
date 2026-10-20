// Updated by den-scene-v1/01: approved centres and yaw supersede showcase coordinates.
// den-iso-v1/04: Steamers and Front of House move 0.3 inward to x +-3.0 (digest section 2); their literals below are
// the old ones shifted by 0.3.
// den-scene-v1/11 (option B, Soft bun): Bao is [0, 2.1, -3.3] at scale 2.1, the back kiosks stand at x +-3.6 (0.6 farther
// out; every literal below that moved was moved by exactly 0.6, not recomputed), Tea and Pantry stand at x +-5.2 (0.3
// farther out; their literals moved by exactly 0.3), the dormant pads at (+-3.4, -7.65), the ring centre follows Bao
// to z -3.3. Spec: handoffs/11-designer-spec.md and -2.md (the -2 file wins).
// Ticket showcase-v1/01, ADR 0013: the pure placement module for the banquet market. Role and
// slot index in, world position out. Expected values are hand-worked literals from the anchor model
// in the ADR (stall centres, spacing 0.75, Bao at [0,1.4,-2.4] scale 1.4), not recomputed.
import { test } from "node:test";
import assert from "node:assert/strict";

const load = () => import("./banquet-layout.mjs");
const near = (actual, expected, msg) => {
  assert.equal(actual.length, expected.length, msg);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-9, `${msg ?? ""} [${i}] ${v} != ${expected[i]}`));
};
const at = async (role, slot, count) => {
  const p = (await load()).placeRole(role, slot, count);
  return [p.x, p.y, p.z];
};

test("teamOf maps every placement type to its team", async () => {
  const { teamOf } = await load();
  const table = {
    orchestrator: "orchestrator", product: "product", architect: "architect",
    developer: "steamers", scout: "steamers",
    qa: "tea", security: "pantry", designer: "front-of-house",
    mystery: "cubs",
  };
  for (const [placement, team] of Object.entries(table)) assert.equal(teamOf(placement), team, placement);
});

test("parsePerch splits team and slot", async () => {
  const { parsePerch } = await load();
  assert.deepEqual(parsePerch("front-of-house#2"), { team: "front-of-house", slot: 2 });
});

// den-scene-v1/11 T9 (rest seats). The literals are the designer's measurements of the posed mesh (handoffs/11-designer-spec.md
// section 3: world numbers at scale 2.1, feet at y -1 in model units), not derived from BAO. Tolerance 0.03 model units = 0.063 world.
// Slots follow parsePerch: the orchestrator's extra placements step -0.4 world x along the rail (away from the bell), product and
// architect step -0.4 world z along the arm top. Their y comes from the posed mesh (a ray at that column), so the pure layout is
// checked only in x and z there; the mesh test in bao-seats.test.mjs pins the height.
const SEAT_TOL = 0.063;
const seatNear = (actual, expected, msg, axes = [0, 1, 2]) => {
  for (const i of axes) assert.ok(Math.abs(actual[i] - expected[i]) <= SEAT_TOL, `${msg} [${i}] ${actual[i]} vs ${expected[i]} (+-${SEAT_TOL})`);
};

test("Pass perches at rest: orchestrator on the crown, product and architect on the shoulders (designer's measured seats)", async () => {
  seatNear(await at("orchestrator", 0), [0, 4.2714, -3.6885], "orchestrator");
  seatNear(await at("product", 0), [-1.722, 2.289, -3.384], "product (Bao's left on screen, world -x)");
  seatNear(await at("architect", 0), [1.722, 2.289, -3.384], "architect (world +x)");
});

test("Pass perches: extra orchestrators step -0.4 x along the rail, extra product and architect placements step -0.4 z along the arm", async () => {
  seatNear(await at("orchestrator", 1), [-0.4, 4.2714, -3.6885], "orchestrator#1");
  seatNear(await at("orchestrator", 2), [-0.8, 4.2714, -3.6885], "orchestrator#2");
  seatNear(await at("product", 1), [-1.722, 0, -3.784], "product#1", [0, 2]);
  seatNear(await at("product", 2), [-1.722, 0, -4.184], "product#2", [0, 2]);
  seatNear(await at("architect", 1), [1.722, 0, -3.784], "architect#1", [0, 2]);
  seatNear(await at("architect", 2), [1.722, 0, -4.184], "architect#2", [0, 2]);
});

test("Pass perches: an extra orchestrator keeps the rail top's height, the three of them fit the 2.0 rail", async () => {
  const [, y0] = await at("orchestrator", 0);
  for (const slot of [1, 2]) assert.ok(Math.abs((await at("orchestrator", slot))[1] - y0) < 1e-9, `slot ${slot} is at the rail top`);
  const xs = await Promise.all([0, 1, 2].map(async (slot) => (await at("orchestrator", slot))[0]));
  for (const x of xs) assert.ok(Math.abs(x) + 0.22 <= 1.0 + 1e-9, `a 0.44-wide panda at x ${x} stays on the 2.0 rail`);
});

test("stalls: Steamers back-left, Front of House back-right, Tea front-left, Pantry front-right", async () => {
  near(await at("developer", 1), [-3.6, 1.1, -1.4], "steamers centre slot");
  near(await at("designer", 1), [3.6, 1.1, -1.4], "front of house");
  near(await at("qa", 1), [-5.2, 0.6, 2.0], "tea");
  near(await at("security", 1), [5.2, 0.6, 2.0], "pantry");
});

test("developer and scout share the Steamers slots", async () => {
  for (const c of ["developer", "scout"]) near(await at(c, 0), [-4.250864384758237, 1.1, -1.0273398966171974], c);
});

test("a stall's three slots are fixed anchors whatever the head count up to three", async () => {
  for (const count of [1, 2, 3, undefined]) {
    near(await at("qa", 0, count), [-5.850864384758237, 0.6, 2.3726601033828026], `slot 0 of ${count}`);
    near(await at("qa", 2, count), [-4.549135615241763, 0.6, 1.6273398966171974], `slot 2 of ${count}`);
  }
});

test("overflow: a stall with five placements widens outward along the front", async () => {
  near(await at("security", 0, 5), [4.648271230483526, 0.6, 1.2546797932343948]);
  near(await at("security", 2, 5), [5.95, 0.6, 2]);
  near(await at("security", 4, 5), [7.251728769516474, 0.6, 2.745320206765605]);
});

test("stallWidth is 2.25 up to three placements, then 0.75 per placement", async () => {
  const { stallWidth } = await load();
  assert.equal(stallWidth(0), 2.25);
  assert.equal(stallWidth(3), 2.25);
  assert.equal(stallWidth(6), 4.5);
});

test("cubs (unknown placement types) queue in a row at the cub basket, front centre", async () => {
  near(await at("mystery", 1), [0, 0, 4.6]);
  near(await at("mystery", 0), [-0.75, 0, 4.6]);
});

test("landmarks: table at the centre, cub basket front centre", async () => {
  const { TABLE, CUB_BASKET, BAO } = await load();
  assert.deepEqual(TABLE, { x: 0, z: 0, radius: 1.3, height: 0.7 });
  assert.deepEqual(CUB_BASKET, { x: -1.8, z: 3.0 });
  assert.deepEqual(BAO, { position: [0, 2.1, -3.3], scale: 2.1 }); // T1 (y is also read off the posed mesh by T2)
});

test("lazy susan: one basket per frontier ticket, first at the front of the table top", async () => {
  const { susanBaskets } = await load();
  const one = susanBaskets(1);
  assert.equal(one.length, 1);
  near([one[0].x, one[0].y, one[0].z], [0, 0.75, 0.85]);
  const four = susanBaskets(4);
  assert.equal(four.length, 4);
  near([four[1].x, four[1].y, four[1].z], [0.85, 0.75, 0], "quarter turn");
  near([four[2].x, four[2].y, four[2].z], [0, 0.75, -0.85], "half turn");
});

test("lazy susan: none for an empty frontier, capped at eight", async () => {
  const { susanBaskets, MAX_BASKETS } = await load();
  assert.deepEqual(susanBaskets(0), []);
  assert.equal(MAX_BASKETS, 8);
  assert.equal(susanBaskets(11).length, 8);
});

// den-scene-v1/01 supersedes the old unrotated 1.0 shoulder-gap rule with the
// unchanged default-camera projection acceptance in horseshoe-layout.test.mjs.
test("cub row stands clear of the cub basket (radius 0.55) by a placement's half width", async () => {
  const { CUB_BASKET, CUB_BASKET_RADIUS } = await load();
  const cub = await at("mystery", 1);
  assert.equal(CUB_BASKET_RADIUS, 0.55);
  assert.ok(cub[2] - CUB_BASKET.z >= CUB_BASKET_RADIUS + 0.35);
});

test("overflow widens outward: every stall's inner edge stays fixed, on both sides", async () => {
  const { STALL_CENTERS, stallCenterX, stallWidth } = await load();
  for (const team of Object.keys(STALL_CENTERS)) {
    const sign = Math.sign(STALL_CENTERS[team].x);
    const inner = (count) => stallCenterX(team, count) - sign * stallWidth(count) / 2;
    for (const count of [3, 5, 8]) assert.ok(Math.abs(inner(count) - inner(3)) < 1e-9, `${team} ${count}`);
  }
});

test("overflow, worked: Steamers with five placements grows left with rotated slots", async () => {
  near([(await at("developer", 0, 5))[0]], [-5.651728769516475]);
  near([(await at("developer", 4, 5))[0]], [-3.048271230483525]);
});

// showcase-v1/04 (user browser check): the front stalls must not hide the back row from the default
// camera at (0, 4.2, 11.5). The sight line to each back placement's feet has to clear the front roof.
test("front-row roofs stay below the sight line from the default camera to every back-row placement", async () => {
  const { STALL_CENTERS, stallCenterX, stallWidth, counterTop, stallRoof } = await load();
  const cam = { x: 0, y: 4.2, z: 11.5 };
  const roof = stallRoof("tea");
  const apex = roof.eave + roof.rise;
  for (const [back, front] of [["steamers", "tea"], ["front-of-house", "pantry"]]) {
    const fz = STALL_CENTERS[front].z;
    const fx = stallCenterX(front, 3);
    const half = stallWidth(3) / 2;
    for (const slot of [0, 1, 2]) {
      const tx = (await at(back === "steamers" ? "developer" : "designer", slot))[0];
      const ty = counterTop(back) + 0.15;
      const tz = STALL_CENTERS[back].z;
      for (let z = fz - 0.5; z <= fz + 0.5; z += 0.05) {
        const f = (cam.z - z) / (cam.z - tz);
        const x = cam.x + f * (tx - cam.x);
        const y = cam.y + f * (ty - cam.y);
        if (Math.abs(x - fx) <= half) assert.ok(y >= apex + 0.1, `${back} slot ${slot}: sight line y ${y.toFixed(2)} at z ${z.toFixed(2)} is under the ${front} roof apex ${apex}`);
      }
    }
  }
});

test("the front stalls stand farther outward than the back kiosks, forming the horseshoe", async () => {
  const { STALL_CENTERS } = await load();
  assert.ok(Math.abs(STALL_CENTERS.tea.x) > Math.abs(STALL_CENTERS.steamers.x));
  assert.ok(Math.abs(STALL_CENTERS.pantry.x) > Math.abs(STALL_CENTERS["front-of-house"].x));
});

test("a front stall's placements still fit under its low roof eave", async () => {
  const { stallRoof, counterTop } = await load();
  const plushHeight = 0.6; // plush scale 0.3 on a 2-unit panda
  assert.ok(stallRoof("tea").eave - counterTop("tea") >= plushHeight + 0.15);
  assert.equal(stallRoof("steamers"), undefined);
});

// ---- den-iso-v1/04: scene dressing. Numbers are those of docs/design/2026-10-01-iso-den.md section 2 (literals,
// not recomputed from the module). Interface fixed here (the ticket leaves names open):
//   STONE_RING = { center: {x, z}, semiX, semiZ, count, stone: {diameter, thickness} }
//   stepStones() -> [{ index, x, z }]  the ring's stones that survive the footprint rule, index 0..47 in angle order
//   DORMANT_PADS = [{ id, name, x, z, radius, dashed, dormant, label, ariaLabel }]  (Library, then Drum)
//   BAMBOO_CLUSTERS = [{ id, x, z, stalks, height }]  and  bambooStalks() -> [{ cluster, x, z, height, width }]
const ELLIPSE = (x, z, c, a, b) => ((x - c.x) / a) ** 2 + ((z - c.z) / b) ** 2;

test("Steamers and Front of House stand at x +-3.6 (den-scene-v1/11 T3, a 0.6 move out); every other anchor keeps its place", async () => {
  const { STALL_CENTERS, stallYaw, TALLY, CUB_BASKET } = await load();
  assert.deepEqual(STALL_CENTERS, {
    steamers: { x: -3.6, z: -1.4 }, "front-of-house": { x: 3.6, z: -1.4 },
    tea: { x: -5.2, z: 2.0 }, pantry: { x: 5.2, z: 2.0 },
  });
  assert.equal(stallYaw("steamers"), 0.52);
  assert.equal(stallYaw("front-of-house"), -0.52);
  assert.deepEqual([TALLY.x, TALLY.z, CUB_BASKET.x, CUB_BASKET.z], [1.8, 3.0, -1.8, 3.0]);
});

test("the stone ring: 48 stones of 0.34 x 0.04, centred on Bao's feet, semi-axes 7.3 (x) by 6.3 (z)", async () => {
  const { STONE_RING, BAO } = await load();
  assert.equal(STONE_RING.count, 48);
  assert.equal(STONE_RING.semiX, 7.3);
  assert.equal(STONE_RING.semiZ, 6.3);
  assert.deepEqual(STONE_RING.center, { x: BAO.position[0], z: BAO.position[2] });
  assert.deepEqual(STONE_RING.center, { x: 0, z: -3.3 }); // T14
  assert.deepEqual(STONE_RING.stone, { diameter: 0.34, thickness: 0.04 });
});

test("every placed stone lies on the ellipse at one of 48 even steps of 7.5 degrees, with no step used twice", async () => {
  const { stepStones, STONE_RING } = await load();
  const stones = stepStones();
  const seen = new Set();
  for (const s of stones) {
    assert.ok(Number.isInteger(s.index) && s.index >= 0 && s.index < 48, `index ${s.index}`);
    assert.ok(!seen.has(s.index), `step ${s.index} used twice`);
    seen.add(s.index);
    const t = (2 * Math.PI * s.index) / 48; // parametric angle: x = cx + a cos t, z = cz + b sin t
    assert.ok(Math.abs(s.x - (0 + 7.3 * Math.cos(t))) < 1e-9, `stone ${s.index} x`);
    assert.ok(Math.abs(s.z - (-3.3 + 6.3 * Math.sin(t))) < 1e-9, `stone ${s.index} z`);
    assert.ok(Math.abs(ELLIPSE(s.x, s.z, STONE_RING.center, 7.3, 6.3) - 1) < 1e-9);
  }
  assert.deepEqual(stones.map((s) => s.index), [...stones.map((s) => s.index)].sort((a, b) => a - b), "angle order");
});

// Footprints on the ground, built here from the layout's props (not from the module under test): the four kiosks'
// platforms (counter width + 0.15 each side, 0.65 deep, turned by stallYaw), the table, the hamper and the Tally.
const footprintTests = async (margin = 0) => {
  const L = await load();
  const rects = Object.keys(L.STALL_CENTERS).map((team) => ({
    cx: L.stallCenterX(team, 3), cz: L.STALL_CENTERS[team].z, yaw: L.stallYaw(team),
    hx: (L.stallWidth(3) + 0.3) / 2 + margin, hz: 0.65 + margin,
  }));
  rects.push({ cx: L.TALLY.x, cz: L.TALLY.z, yaw: 0, hx: L.TALLY.frame.width / 2 + margin, hz: L.TALLY.frame.depth / 2 + margin });
  const circles = [
    { cx: L.TABLE.x, cz: L.TABLE.z, r: L.TABLE.radius + margin },
    { cx: L.CUB_BASKET.x, cz: L.CUB_BASKET.z, r: L.CUB_BASKET_RADIUS + margin },
  ];
  return ({ x, z }) => circles.some((c) => Math.hypot(x - c.cx, z - c.cz) < c.r)
    || rects.some((r) => {
      const dx = x - r.cx, dz = z - r.cz; // into the kiosk's local frame (local x = (cos yaw, -sin yaw), local z = (sin yaw, cos yaw))
      const lx = dx * Math.cos(r.yaw) - dz * Math.sin(r.yaw), lz = dx * Math.sin(r.yaw) + dz * Math.cos(r.yaw);
      return Math.abs(lx) < r.hx && Math.abs(lz) < r.hz;
    });
};

test("the ring keeps at least 36 of its 48 stones and no stone's centre is inside a kiosk, table, hamper or Tally footprint", async () => {
  const { stepStones } = await load();
  const inside = await footprintTests(0);
  const stones = stepStones();
  assert.ok(stones.length >= 36, `${stones.length} stones`);
  assert.ok(stones.length < 48, "the ring crosses at least one footprint, so some stones are omitted");
  for (const s of stones) assert.ok(!inside(s), `stone ${s.index} at ${s.x.toFixed(2)}, ${s.z.toFixed(2)} stands inside a footprint`);
});

test("a stone is omitted only when it is near a footprint: any step more than a stone's width clear of every footprint is placed", async () => {
  const { stepStones } = await load();
  const nearFootprint = await footprintTests(0.34);
  const placed = new Set(stepStones().map((s) => s.index));
  for (let i = 0; i < 48; i++) {
    const t = (2 * Math.PI * i) / 48;
    const p = { x: 7.3 * Math.cos(t), z: -3.3 + 6.3 * Math.sin(t) };
    if (!nearFootprint(p)) assert.ok(placed.has(i), `step ${i} at ${p.x.toFixed(2)}, ${p.z.toFixed(2)} is clear of every footprint but was dropped`);
  }
});

test("the ring is left-right symmetric where the layout is: the back, front, left and right extremes are all present", async () => {
  const { stepStones } = await load();
  const placed = new Set(stepStones().map((s) => s.index));
  for (const i of [0, 12, 24, 36]) assert.ok(placed.has(i), `compass stone ${i}`); // right, front, left (z = -3.3), back
});

test("Library and Drum are dashed dormant pads at (-3.4, -7.65) and (3.4, -7.65): flat discs of radius 0.65", async () => {
  const { DORMANT_PADS } = await load();
  assert.deepEqual(DORMANT_PADS.map((p) => p.id), ["library", "drum"]);
  assert.deepEqual(DORMANT_PADS.map((p) => p.name), ["Library", "Drum"]);
  assert.deepEqual(DORMANT_PADS.map((p) => [p.x, p.z, p.radius]), [[-3.4, -7.65, 0.65], [3.4, -7.65, 0.65]]);
  for (const p of DORMANT_PADS) {
    assert.equal(p.dashed, true, `${p.id} is dashed`);
    assert.equal(p.dormant, true, `${p.id} is dormant`);
  }
});

test("each pad is labelled 'coming online' next to its own name, in a visible label and in an aria-label", async () => {
  const { DORMANT_PADS } = await load();
  for (const p of DORMANT_PADS) {
    assert.match(p.label, /coming online/i, `${p.id} label`);
    assert.ok(p.label.includes(p.name), `${p.id} label names the role`);
    assert.match(p.ariaLabel, /coming online/i, `${p.id} aria-label`);
    assert.ok(p.ariaLabel.includes(p.name), `${p.id} aria-label names the role`);
  }
});

test("the pads carry no biology word in any label or aria-label (den-map check 7; digest section 7)", async () => {
  const { DORMANT_PADS } = await load();
  const BIOLOGY_WORDS = ["org" + "anism", "or" + "gan", "ce" + "ll", "gen" + "ome", "apopt" + "osis", "endo" + "crine"]; // spelt in pieces so the repo-wide word scan passes
  const biology = new RegExp(`\\b(${BIOLOGY_WORDS.join("|")})s?\\b`, "i");
  for (const p of DORMANT_PADS) for (const text of [p.label, p.ariaLabel, p.name]) assert.doesNotMatch(text, biology, `${p.id}: "${text}"`);
});

test("the pads sit inside the ring, about 1.0 unit in, clear of every stone and mirror each other", async () => {
  const { DORMANT_PADS, STONE_RING, stepStones } = await load();
  const [library, drum] = DORMANT_PADS;
  assert.equal(library.x, -drum.x);
  assert.equal(library.z, drum.z);
  for (const p of DORMANT_PADS) {
    assert.ok(ELLIPSE(p.x, p.z, STONE_RING.center, 7.3, 6.3) < 1, `${p.id} is inside the ring`);
    let nearest = Infinity;
    for (let i = 0; i < 4800; i++) {
      const t = (2 * Math.PI * i) / 4800;
      nearest = Math.min(nearest, Math.hypot(p.x - 7.3 * Math.cos(t), p.z - (-3.3 + 6.3 * Math.sin(t))));
    }
    assert.ok(nearest > 0.85 && nearest < 1.15, `${p.id} is ${nearest.toFixed(2)} in from the ring (about 1.0)`);
    for (const s of stepStones()) assert.ok(Math.hypot(s.x - p.x, s.z - p.z) >= p.radius + 0.17, `${p.id} touches stone ${s.index}`);
  }
});

test("every pad disc is at least 0.1 world clear of every bamboo stalk (A2: the back-left cluster stands 0.85 behind the Library pad)", async () => {
  const { DORMANT_PADS, bambooStalks } = await load();
  for (const p of DORMANT_PADS) {
    for (const s of bambooStalks()) {
      const clear = Math.hypot(s.x - p.x, s.z - p.z) - p.radius - s.width / 2;
      assert.ok(clear >= 0.1, `${p.id} is ${clear.toFixed(3)} from the ${s.cluster} stalk at ${s.x.toFixed(2)}, ${s.z}`);
    }
  }
});

test("bamboo: three clusters at the digest's places, 3 + 3 + 2 stalks, 3.0 / 3.0 / 2.6 tall", async () => {
  const { BAMBOO_CLUSTERS } = await load();
  assert.deepEqual(BAMBOO_CLUSTERS.map((c) => [c.id, c.x, c.z, c.stalks, c.height]), [
    ["back-left", -3.4, -8.5, 3, 3.0],
    ["back-right", 3.6, -8.7, 3, 3.0],
    ["right-edge", 7.8, 0.8, 2, 2.6],
  ]);
});

test("bamboo stalks are 0.13 across and 0.27 apart, centred on their cluster, and stand on the ground", async () => {
  const { BAMBOO_CLUSTERS, bambooStalks } = await load();
  const stalks = bambooStalks();
  assert.equal(stalks.length, 8);
  for (const c of BAMBOO_CLUSTERS) {
    const mine = stalks.filter((s) => s.cluster === c.id).sort((a, b) => a.x - b.x);
    assert.equal(mine.length, c.stalks, c.id);
    const mean = mine.reduce((sum, s) => sum + s.x, 0) / mine.length;
    assert.ok(Math.abs(mean - c.x) < 1e-9, `${c.id} centred on ${c.x}`);
    for (let i = 1; i < mine.length; i++) assert.ok(Math.abs(mine[i].x - mine[i - 1].x - 0.27) < 1e-9, `${c.id} spacing`);
    for (const s of mine) {
      assert.equal(s.width, 0.13);
      assert.equal(s.height, c.height);
      assert.equal(s.z, c.z);
    }
  }
});

test("pandas still never stand on open grass: no placement perch lands on a dormant pad or in a bamboo cluster", async () => {
  const { placeRole, DORMANT_PADS, bambooStalks } = await load();
  const roles = ["orchestrator", "product", "architect", "developer", "scout", "qa", "security", "designer", "mystery"];
  for (const type of roles) for (let slot = 0; slot < 13; slot++) {
    const p = await placeRole(type, slot, 13);
    for (const pad of DORMANT_PADS) assert.ok(Math.hypot(p.x - pad.x, p.z - pad.z) > pad.radius, `${type}#${slot} on the ${pad.id} pad`);
    for (const s of bambooStalks()) assert.ok(Math.hypot(p.x - s.x, p.z - s.z) > s.width, `${type}#${slot} in bamboo`);
  }
});
