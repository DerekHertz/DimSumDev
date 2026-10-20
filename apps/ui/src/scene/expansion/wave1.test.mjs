// den-mvp/22: v5 wave 1 in the den: the radius-28 site plan, the pond, the repair bench and the archive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { createBao } from "../procedural/bao.mjs";
import { createDenScene } from "../procedural/den-scene.mjs";
import { canvasDocument } from "../procedural/den-test-helpers.mjs";
import { compactPanda, compactEnvironment } from "../procedural/compact.mjs";
import { isDenPositionBlocked, isWalkBlocked, walk, WALK, startWalk } from "../procedural/walk.mjs";
import { createReviewAgents, findReviewPath } from "../../review/agents.mjs";
import { REVIEW_OBSTACLES, REVIEW_PLACES, GARDEN_RADIUS } from "../../review/site-plan.mjs";
import { mountExpansionPond } from "./pond.mjs";
import { mountWorkZones, routeWorkClick, interactionOf, unavailableReason, WORK_ZONE_IDS } from "./work-zones.mjs";
import { ZONES } from "./integration/zone-contract.mjs";
import { viewFromBridge } from "./integration/bridge-adapter.mjs";
import { SCENARIOS } from "./integration/scenario-fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(HERE, ...p), "utf8");
const WAVE = ["repair", "archive", "pond"].map((id) => ZONES.find((z) => z.id === id));

// The den as RestaurantDen builds it, minus React.
function withWaveOneDen(run, { compact = true } = {}) {
  const previous = globalThis.document; globalThis.document = canvasDocument();
  let den, pond, work, agents;
  try {
    den = createDenScene(THREE, createBao);
    for (const p of den.pandas) compactPanda(THREE, p);
    if (compact) compactEnvironment(THREE, den);
    pond = mountExpansionPond(den); work = mountWorkZones(den);
    agents = createReviewAgents(den, createBao);
    run({ den, pond, work, agents });
  } finally {
    agents?.dispose(); pond?.dispose(); work?.dispose(); den?.dispose();
    globalThis.document = previous;
  }
}

// A zone's text planes draw on a canvas; node has none.
function withDocument(run) {
  const previous = globalThis.document; globalThis.document = canvasDocument();
  try { return run(); } finally { globalThis.document = previous; }
}

const overlaps = (a, b, pad = 0) => a.min.x < b.max.x + pad && a.max.x > b.min.x - pad && a.min.z < b.max.z + pad && a.max.z > b.min.z - pad;
const SCENERY = /^(Bamboo clearing|Mountain ridge)/;

function footprintsOf(den, skip) {
  const out = [];
  den.world.updateMatrixWorld(true);
  den.world.traverse((o) => {
    if (SCENERY.test(o.name)) return;
    for (let a = o; a; a = a.parent) if (skip.has(a)) return;
    if (o.isInstancedMesh) {
      o.geometry.computeBoundingBox();
      const m = new THREE.Matrix4();
      for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m); out.push({ name: o.name, box: o.geometry.boundingBox.clone().applyMatrix4(m).applyMatrix4(o.matrixWorld) }); }
    } else if (o.isMesh) {
      const box = new THREE.Box3().setFromObject(o);
      // The village's ground disc, its rim and its lawn lie under everything; they are scenery, not an object to keep clear of.
      if (!box.isEmpty() && box.max.x - box.min.x < 40) out.push({ name: o.name || o.parent?.name || o.type, box });
    }
  });
  return out;
}

test("the garden is radius 28: ground, walk floor and the pandas' routing reach the wave 1 zones", () => {
  assert.equal(GARDEN_RADIUS, 28);
  assert.equal(WALK.floorRadius, 28);
  withWaveOneDen(({ den }) => {
    // The kit's ground disc (radius 28) is the widest thing in the village; environment merging keeps its bounds.
    const box = new THREE.Box3().setFromObject(den.world);
    assert.ok(Math.abs(box.max.x - 28) < 0.1 && Math.abs(box.min.x + 28) < 0.1, `the village ground is radius 28: x ${box.min.x}..${box.max.x}`);
    for (const z of WAVE) {
      const far = Math.hypot(Math.abs(z.position[0]) + z.radius, Math.abs(z.position[2]) + z.radius);
      assert.ok(far < GARDEN_RADIUS, `${z.id} fits the ground`);
    }
  });
});

test("the work zones mount at their contract positions with no residents, and their walk boxes join den.obstacles", () => withDocument(() => {
  const den = { world: new THREE.Group(), obstacles: [{ type: "circle", x: 0, z: 0, radius: 1 }] };
  const work = mountWorkZones(den);
  assert.deepEqual([...work.zones.keys()], WORK_ZONE_IDS);
  for (const id of WORK_ZONE_IDS) {
    const z = ZONES.find((c) => c.id === id);
    assert.deepEqual(work.zones.get(id).position.toArray(), z.position);
    assert.equal(work.zones.get(id).userData.denZone.id, id);
  }
  let pandas = 0; work.root.traverse((o) => { if (o.userData.panda) pandas++; });
  assert.equal(pandas, 0);
  assert.equal(work.obstacles.length, 2);
  assert.equal(den.obstacles.length, 3);
  assert.equal(isDenPositionBlocked(-20, -1, den.obstacles, 0.26), true, "nothing walks through the repair bench");
  assert.equal(isDenPositionBlocked(11, -14, den.obstacles, 0.26), true, "nor the archive");
  work.dispose();
  assert.equal(den.obstacles.length, 1);
  assert.equal(work.root.parent, null);
  work.dispose(); // idempotent
}));

test("from above, no wave 1 zone overlaps another object, and the three zones keep apart", () => {
  withWaveOneDen(({ den, pond, work }) => {
    const mine = new Set([pond.root, work.root]);
    const others = footprintsOf(den, mine);
    for (const z of WAVE) {
      const root = z.id === "pond" ? pond.zone : work.zones.get(z.id);
      const box = new THREE.Box3().setFromObject(root);
      const hit = others.filter((o) => overlaps(box, o.box));
      assert.deepEqual(hit.map((o) => o.name), [], `${z.id} overlaps ${hit.map((o) => o.name).join(", ")}`);
    }
    const boxes = [pond.zone, ...work.zones.values()].map((g) => new THREE.Box3().setFromObject(g));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.equal(overlaps(boxes[i], boxes[j]), false);
  }, { compact: false }); // merged environment meshes have one box for the whole garden: compare the pieces
});

test("no other walk obstacle stands inside a wave 1 zone's footprint", () => {
  withWaveOneDen(({ den, pond, work }) => {
    const own = new Set([...pond.obstacles, ...work.obstacles]);
    const rest = [...den.obstacles.filter((o) => !own.has(o)), ...REVIEW_OBSTACLES];
    for (const z of WAVE) {
      const g = z.id === "pond" ? pond.zone : work.zones.get(z.id);
      const b = new THREE.Box3().setFromObject(g);
      for (let x = b.min.x; x <= b.max.x; x += 0.25) for (let zz = b.min.z; zz <= b.max.z; zz += 0.25) {
        assert.equal(isDenPositionBlocked(x, zz, rest, 0), false, `${z.id} has an obstacle at ${x.toFixed(2)},${zz.toFixed(2)}`);
      }
    }
  });
});

// Can a walker (radius WALK.radius) get from the start to a point? A grid flood over the same blocking rule walk() uses.
function reachable(world, from, to, step = 0.25) {
  const key = (i, j) => i + "," + j, at = (i, j) => [i * step, j * step];
  const start = [Math.round(from[0] / step), Math.round(from[1] / step)], goal = [Math.round(to[0] / step), Math.round(to[1] / step)];
  const seen = new Set([key(...start)]); const queue = [start];
  while (queue.length) {
    const [i, j] = queue.shift();
    if (Math.abs(i - goal[0]) <= 1 && Math.abs(j - goal[1]) <= 1) return true;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = [i + di, j + dj], k = key(...n);
      if (seen.has(k) || isWalkBlocked(...at(...n), world)) continue;
      seen.add(k); queue.push(n);
    }
  }
  return false;
}

test("walking reaches each zone's approach point and nothing walks through a zone", () => {
  withWaveOneDen(({ den }) => {
    const world = { obstacles: [...den.obstacles, ...REVIEW_OBSTACLES] };
    const start = [WALK.start.x, WALK.start.z];
    for (const z of WAVE) {
      const approach = [z.approach[0], z.approach[2]];
      assert.equal(isWalkBlocked(approach[0], approach[1], world), false, `${z.id} approach is open ground`);
      assert.ok(reachable(world, start, approach), `a walk to ${z.id}`);
      assert.equal(isWalkBlocked(z.position[0], z.position[2], world) || z.id === "pond", true, `${z.id} is not walked through`);
    }
    // The pond's bridge corridor is open and its water is not.
    assert.equal(isWalkBlocked(-21, 9, world), false);
    assert.equal(isWalkBlocked(-22.3, 9, world), true);
  });
});

test("with the zones in place the pandas still route to every leisure spot, and refuse a zone's footprint", () => {
  withWaveOneDen(({ agents }) => {
    const bao = [-5, 3]; // open ground near the middle (Bao and the susan stand inside their own obstacles)
    // A spot on a prop is moved to the nearest clear ground when a panda walks there, so count the spots on clear ground.
    for (const [id, place] of Object.entries(REVIEW_PLACES)) {
      const clear = place.spots.filter((spot) => !isDenPositionBlocked(spot[0], spot[1], agents.obstacles, 0.665));
      assert.ok(clear.length >= 2, `${id} keeps clear spots`);
      for (const spot of clear) assert.ok(findReviewPath(bao, spot, agents.obstacles), `${id} stays routable: ${spot}`);
    }
    assert.equal(findReviewPath(bao, [-20, -1], agents.obstacles), null);
    assert.equal(findReviewPath(bao, [11, -14], agents.obstacles), null);
  });
});

test("walking crosses the pond's bridge, from one bank to the other", () => {
  withWaveOneDen(({ den }) => {
    const obstacles = [...den.obstacles, ...REVIEW_OBSTACLES];
    let s = { ...startWalk(), x: -21, z: 5, yaw: Math.PI }; // yaw pi: forward is +z, along the bridge
    for (let i = 0; i < 300 && s.z < 13.2; i++) s = walk(s, { forward: 1 }, 1 / 30, { obstacles });
    assert.ok(s.z >= 13.2, `crossed to the far bank (z ${s.z.toFixed(2)})`);
    assert.ok(Math.abs(s.x + 21) < 0.5, "stayed on the bridge");
    // Off the bridge the water stops the walker.
    let w = { ...startWalk(), x: -22.3, z: 5, yaw: Math.PI };
    for (let i = 0; i < 300; i++) w = walk(w, { forward: 1 }, 1 / 30, { obstacles });
    assert.ok(w.z < 7.2, "the water blocks");
  });
});

test("the repair bench shows a running developer and a held permission request, and is idle with neither", () => withDocument(() => {
  const den = { world: new THREE.Group(), obstacles: [] };
  const work = mountWorkZones(den);
  const stateOf = (zone, view) => { work.apply(view); let s = null; work.zones.get(zone).traverse((o) => { if (o.userData.denStatus === zone) s = o.userData.denState; }); return s; };
  assert.equal(stateOf("repair", viewFromBridge(SCENARIOS.idle)), "idle");
  assert.equal(stateOf("repair", viewFromBridge(SCENARIOS.working)), "working");
  assert.equal(stateOf("repair", viewFromBridge(SCENARIOS.attention)), "needs-you");
  assert.equal(stateOf("repair", viewFromBridge(SCENARIOS.offline)), "unavailable");
  work.dispose();
}));

test("the archive shows the library, and says so when it is not loaded", () => withDocument(() => {
  const den = { world: new THREE.Group(), obstacles: [] };
  const work = mountWorkZones(den);
  const view = viewFromBridge(SCENARIOS.idle);
  assert.match(view.zones.archive.label, /1 RECIPES · 1 LINKS/);
  assert.equal(view.zones.archive.state, "idle");
  assert.equal(viewFromBridge({ ...SCENARIOS.idle, library: null }).zones.archive.state, "unavailable");
  work.apply(view);
  let labelled = false; work.zones.get("archive").traverse((o) => { if (o.userData.denText === "archive" && o.userData.lastLabel === view.zones.archive.label) labelled = true; });
  assert.ok(labelled, "the label is drawn on the archive");
  work.dispose();
}));

test("each click opens the right card or thread, and none sends a request", () => {
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls++; return Promise.reject(new Error("no requests expected")); };
  try {
    const view = viewFromBridge(SCENARIOS.working);
    const opened = [];
    const handlers = {
      onOpenTicket: (i) => opened.push(["ticket", i.ref]),
      onOpenRole: (i) => opened.push(["role", i.role]),
      onOpenLibrary: () => opened.push(["library"]),
      onUnavailable: (i) => opened.push(["off", i.id]),
    };
    for (const id of ["repair.inspect", "repair.talk", "archive.library", "archive.notes"]) routeWorkClick(id, view, handlers);
    assert.deepEqual(opened, [["ticket", "mockup/repair-dumpling"], ["role", "developer"], ["library"], ["role", "herald"]]);
    // With no ticket the bench opens the developer's thread instead.
    const quiet = []; routeWorkClick("repair.inspect", viewFromBridge(SCENARIOS.idle), { onOpenRole: (i) => quiet.push(i.role) });
    assert.deepEqual(quiet, ["developer"]);
    assert.equal(routeWorkClick("pond.koi", view, handlers), null, "the pond is not a work zone");
    assert.equal(routeWorkClick("release.delivery", view, handlers), null, "nor is the release landing (wave 2)");
    assert.equal(calls, 0);
  } finally { globalThis.fetch = realFetch; }
});

test("offline, reconnecting or connecting: the work actions are off and say why; the pond stays available", () => {
  for (const phase of ["connecting", "reconnecting", "offline"]) {
    const view = viewFromBridge({ ...SCENARIOS.working, connection: { phase } });
    const opened = [], off = [];
    const handlers = { onOpenTicket: () => opened.push(1), onOpenRole: () => opened.push(1), onOpenLibrary: () => opened.push(1), onUnavailable: (i) => off.push(i.id) };
    for (const id of ["repair.inspect", "repair.talk", "archive.library", "archive.notes"]) routeWorkClick(id, view, handlers);
    assert.deepEqual(opened, [], phase);
    assert.equal(off.length, 4, phase);
    assert.ok(unavailableReason(phase).length > 20);
  }
  assert.match(unavailableReason("offline"), /offline/);
  assert.match(unavailableReason("reconnecting"), /dropped/);
  // The pond's clicks never go through routeWorkClick: they are local, so the bridge phase cannot turn them off.
  const view = viewFromBridge({ ...SCENARIOS.working, connection: { phase: "offline" } });
  assert.equal(routeWorkClick("pond.koi", view, {}), null);
});

test("interactionOf finds the interaction on a hit's ancestors", () => withDocument(() => {
  const den = { world: new THREE.Group(), obstacles: [] };
  const work = mountWorkZones(den);
  let board = null; work.zones.get("repair").traverse((o) => { if (o.userData.denInteraction?.id === "repair.inspect") board = o; });
  assert.ok(board);
  const leaf = board.children[0] ?? board;
  assert.equal(interactionOf(leaf).id, "repair.inspect");
  assert.equal(interactionOf(new THREE.Object3D()), null);
  work.dispose();
}));

test("wiring: zones mount before the actors copy obstacles, state comes from the one live store, clicks only open", () => {
  const den = read("..", "procedural", "RestaurantDen.jsx");
  assert.ok(den.indexOf("mountWorkZones(d)") > 0);
  assert.ok(den.indexOf("mountWorkZones(d)") < den.indexOf("createReviewAgents(d"));
  assert.ok(den.indexOf("mountWorkZones(d)") < den.indexOf("createLiveDenController(d"));
  assert.match(den, /work\.dispose\(\)/);
  assert.match(den, /work\.update\(/);
  assert.match(den, /work\.apply\(zoneView\)/);
  const app = read("..", "..", "App.jsx");
  assert.match(app, /viewFromBridge\(/);
  assert.match(app, /liveActorsFromSnapshot\(snapshot/);
  assert.match(app, /useArchiveLibrary\(\{ rev: snapshot\?\.libraryRev/);
  assert.match(app, /onOpenLibrary: \(\) => openTopic\(['"]library['"]/);
  assert.doesNotMatch(app, /libraryRequest/);
  assert.doesNotMatch(app, /EventSource/);
  const lib = read("archive-library.js");
  assert.match(lib, /getLibrary\(\)/);
  assert.match(lib, /fetch: \(url, init\) => fetch\(url, init\)/, "the public read client: no session credential");
  assert.doesNotMatch(lib, /session|steering/);
  const cards = read("..", "..", "overlay", "Cards.jsx");
  for (const file of ["work-zones.mjs", "archive-library.js"]) assert.doesNotMatch(read(file), /deliver\(|startTask\(|decide\(|steerDelivery\(|converse\(|EventSource|XMLHttpRequest/);
});
