// den-layout/03 (absorbs den-v1/02): live actors fed into PR #162's role pandas.
// Seam: createReviewAgents(...).applyLive(liveActors) in ./agents.mjs, where liveActors is the
// output of liveActorsFromSnapshot (./live-actors.mjs). The controller's snapshot().actors is what
// onChange publishes, so the tests read state through that and through agents.actors (as agents.test.mjs does).
//
//   applyLive(liveActors)  replaces the whole live set: roles present are driven by the real state, roles
//                          absent (including ones that were live before) return to idle wandering.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createBao } from "../scene/procedural/bao.mjs";
import { createDenScene } from "../scene/procedural/den-scene.mjs";
import { canvasDocument } from "../scene/procedural/den-test-helpers.mjs";
import { createReviewAgents } from "./agents.mjs";
import { readFileSync } from "node:fs";

function withAgents(run) {
  const previous = globalThis.document;
  globalThis.document = canvasDocument();
  let den, agents;
  try {
    den = createDenScene(THREE, createBao);
    
    agents = createReviewAgents(den, createBao);
    run(agents, den);
  } finally {
    agents?.dispose();
    den?.dispose();
    globalThis.document = previous;
  }
}

const live = (role, ref, extra = {}) => ({
  role,
  ref,
  split: false,
  state: "working",
  activity: "Working",
  bubble: "Bash: npm test",
  task: ref,
  ...extra,
});
const settle = (agents, seconds) => {
  for (let i = 0; i < seconds * 10; i++) agents.update(0.1);
};
const rows = (agents, role) => agents.snapshot().actors.filter((a) => a.role === role);
const dist = (actor, point) => Math.hypot(actor.panda.model.position.x - point[0], actor.panda.model.position.z - point[1]);

test("a bound panda walks to its team and shows the real state, bubble and ticket", () => {
  withAgents((agents) => {
    const dev = agents.actors.get("developer");
    agents.applyLive([live("developer", "fx/01-a")]);
    settle(agents, 60);
    assert.ok(dist(dev, dev.home) < 1.0, "at its team");
    const [row] = rows(agents, "developer");
    assert.equal(row.state, "working");
    assert.equal(row.bubble, "Bash: npm test");
    assert.ok(row.task.includes("fx/01-a"));
  });
});

test("a bound panda is driven by live state, not the preview simulation: no invented question or completion", () => {
  withAgents((agents) => {
    agents.applyLive([live("qa", "fx/02-b", { state: "working", bubble: "Read: a.md" })]);
    settle(agents, 90);
    const [row] = rows(agents, "qa");
    assert.equal(row.state, "working", "stays working until the agent's state says otherwise (the sim goes needs-you at 3.5 s)");
    assert.equal(row.bubble, "Read: a.md");
  });
});

test("a newer live update changes state and bubble on the same panda without moving it away", () => {
  withAgents((agents) => {
    const dev = agents.actors.get("developer");
    agents.applyLive([live("developer", "fx/01-a")]);
    settle(agents, 60);
    agents.applyLive([live("developer", "fx/01-a", { state: "needs-you", bubble: "Write: x.mjs" })]);
    agents.update(0.1);
    const [row] = rows(agents, "developer");
    assert.equal(row.state, "needs-you");
    assert.equal(row.bubble, "Write: x.mjs");
    assert.ok(dist(dev, dev.home) < 1.0, "still at its team");
  });
});

test("a second live agent of the same role appears as a split-off panda with its own ticket", () => {
  withAgents((agents) => {
    const before = agents.snapshot().actors.length;
    agents.applyLive([live("developer", "fx/01-a"), live("developer", "fx/02-b", { split: true, bubble: "Edit: y.mjs" })]);
    settle(agents, 60);
    const devs = rows(agents, "developer");
    assert.equal(devs.length, 2);
    assert.equal(agents.snapshot().actors.length, before + 1, "exactly one extra panda");
    assert.deepEqual(devs.map((d) => d.task.includes("fx/01-a")), [true, false]);
    assert.ok(devs[1].task.includes("fx/02-b"));
    assert.equal(devs[1].bubble, "Edit: y.mjs");
    assert.equal(devs[1].state, "working");
  });
});

test("the split-off panda goes away when its agent ends, and the primary stays", () => {
  withAgents((agents) => {
    const before = agents.snapshot().actors.length;
    agents.applyLive([live("developer", "fx/01-a"), live("developer", "fx/02-b", { split: true })]);
    settle(agents, 30);
    agents.applyLive([live("developer", "fx/01-a")]);
    settle(agents, 5);
    assert.equal(rows(agents, "developer").length, 1);
    assert.equal(agents.snapshot().actors.length, before);
    assert.ok(rows(agents, "developer")[0].task.includes("fx/01-a"));
  });
});

test("an unbound panda keeps PR #162's idle wandering while others are live", () => {
  withAgents((agents) => {
    agents.applyLive([live("developer", "fx/01-a")]);
    const idle = ["product", "scout", "qa", "designer"].map((r) => agents.actors.get(r));
    const start = idle.map((a) => a.panda.model.position.clone());
    settle(agents, 40);
    for (const a of idle) {
      assert.ok(["leisure", "walking"].includes(a.state), `${a.role} is ${a.state}`);
      assert.equal(a.bubble, "", `${a.role} idle shows no bubble`);
      assert.equal(a.task, "");
    }
    assert.ok(idle.some((a, i) => a.panda.model.position.distanceTo(start[i]) > 0.5), "idle pandas still wander");
  });
});

test("the 4 scenery pandas stay simulated even when live state names them", () => {
  withAgents((agents) => {
    agents.applyLive([live("stem-cub", "fx/01-a"), live("debugger", "fx/02-b"), live("docs-writer", "fx/03-c"), live("knowledge-keeper", "fx/04-d")]);
    settle(agents, 20);
    for (const role of ["stem-cub", "debugger", "docs-writer", "knowledge-keeper"]) {
      const [row] = rows(agents, role);
      assert.equal(rows(agents, role).length, 1, `${role} has no split-off`);
      assert.notEqual(row.task, "fx/01-a");
      assert.ok(["leisure", "walking"].includes(row.state), `${role} is ${row.state}`);
    }
  });
});

test("when the agent's session ends the panda returns to idle wandering: task and bubble cleared, back to leisure", () => {
  withAgents((agents) => {
    const dev = agents.actors.get("developer");
    agents.applyLive([live("developer", "fx/01-a")]);
    settle(agents, 60);
    assert.equal(dev.state, "working");
    agents.applyLive([]);
    agents.update(0.1);
    const [row] = rows(agents, "developer");
    assert.ok(["walking", "leisure"].includes(row.state), `now ${row.state}`);
    assert.equal(row.task, "");
    assert.equal(row.bubble, "");
    // Until it first arrives: a panda that has sat a while moves on to another area, so a fixed wait would depend on the walk's length.
    for (let i = 0; i < 900 && dev.state !== "leisure"; i++) agents.update(0.1);
    assert.equal(dev.state, "leisure", "arrived at a leisure area");
    assert.ok(dist(dev, dev.home) > 1.5, "no longer standing at its team");
    assert.equal(rows(agents, "developer")[0].bubble, "");
  });
});

test("applyLive with nothing live leaves the simulation exactly as it was", () => {
  withAgents((agents) => {
    agents.applyLive([]);
    settle(agents, 5);
    assert.equal(agents.snapshot().actors.length, 14);
    for (const a of agents.snapshot().actors) assert.ok(["leisure", "walking", "blocked"].includes(a.state) || a.role === "orchestrator", `${a.role} ${a.state}`);
  });
});

test("the main app wires live state through the adapter into the agents seam", () => {
  const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  const wiring = read("../App.jsx") + read("../scene/procedural/RestaurantDen.jsx");
  assert.match(wiring, /live-actors\.mjs/, "the adapter is imported by the app or the den");
  assert.match(wiring, /liveActorsFromSnapshot\(/);
  assert.match(wiring, /\.applyLive\(/, "its output reaches createReviewAgents's controller");
});

// Live den run, 2026-10-10: a resident wandered off while the user stood with it typing a task. hold(id) names the
// panda whose card is showing (the actors key); it stands still until hold(null) or another id.
const pos = (a) => [a.panda.model.position.x, a.panda.model.position.z];
const moved = (a, from) => Math.hypot(a.panda.model.position.x - from[0], a.panda.model.position.z - from[1]);

test("a held panda stands where it is, mid-walk or idle, and walks on once released", () => {
  withAgents((agents) => {
    const scout = agents.actors.get("scout");
    settle(agents, 1);
    assert.equal(scout.state, "walking", "it starts out walking to its leisure spot");
    const at = pos(scout);
    agents.hold("scout");
    settle(agents, 40);
    assert.ok(moved(scout, at) < 0.01, "held: it did not move in 40 seconds");
    assert.equal(scout.panda.bones.Hip_L.rotation.x, 0, "held: it is not mid-stride");
    agents.hold(null);
    settle(agents, 5);
    assert.ok(moved(scout, at) > 0.5, "released: it walks on");
  });
});

test("an idle held panda starts no new wander, and the others keep theirs", () => {
  withAgents((agents) => {
    settle(agents, 60);
    const qa = agents.actors.get("qa");
    const at = pos(qa);
    agents.hold("qa");
    const others = ["product", "scout", "designer"].map((r) => agents.actors.get(r));
    const starts = others.map(pos);
    settle(agents, 60);
    assert.ok(moved(qa, at) < 0.01, "the held panda stayed");
    assert.ok(others.some((a, i) => moved(a, starts[i]) > 0.5), "the rest still wander");
  });
});

test("holding does not keep a panda from its team once it has an agent", () => {
  withAgents((agents) => {
    const dev = agents.actors.get("developer");
    agents.hold("developer");
    agents.applyLive([live("developer", "fx/01-a")]);
    settle(agents, 60);
    assert.ok(dist(dev, dev.home) < 1.0, "a panda with a task goes to its team, held or not");
    assert.equal(rows(agents, "developer")[0].state, "working");
  });
});

test("hold takes only a known panda: an unknown id releases", () => {
  withAgents((agents) => {
    const scout = agents.actors.get("scout");
    settle(agents, 1);
    agents.hold("scout");
    agents.hold("nobody");
    const at = pos(scout);
    settle(agents, 5);
    assert.ok(moved(scout, at) > 0.5);
  });
});
