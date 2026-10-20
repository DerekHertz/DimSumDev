// den-layout/03 fix round: one live agent is one panda in the den. The role pandas (agents.applyLive) are the
// only live representation; the controller no longer adds a ticket panda per held ticket. What the ticket
// pandas offered (click to inspect, selection glow, a chip anchor above the head) lives on the role pandas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { createBao } from "../scene/procedural/bao.mjs";
import { createDenScene } from "../scene/procedural/den-scene.mjs";
import { createLiveDenController } from "../scene/procedural/controller.mjs";
import { canvasDocument } from "../scene/procedural/den-test-helpers.mjs";
import { createReviewAgents } from "./agents.mjs";

function withLiveDen(run) {
  const previous = globalThis.document;
  globalThis.document = canvasDocument();
  let den, agents, controller;
  try {
    den = createDenScene(THREE, createBao);
    
    agents = createReviewAgents(den, createBao);
    controller = createLiveDenController(den, { manageResidents: false, ticketPandas: false });
    run({ den, agents, controller });
  } finally {
    controller?.dispose();
    agents?.dispose();
    den?.dispose();
    globalThis.document = previous;
  }
}

const live = (role, ref, extra = {}) => ({ role, ref, split: false, state: "working", activity: "Working", bubble: "", task: ref, ...extra });
const placement = (ref, role = "developer") => ({ ref, role, pose: "working" });
// Every object in the den that stands for this agent (carries its ticket ref).
const pandasFor = (den, ref) => {
  const found = [];
  den.world.traverse((o) => { if (o.userData.ticketRef === ref) found.push(o); });
  return found;
};

test("one live agent yields exactly one panda, not a role panda plus a ticket panda", () => {
  withLiveDen(({ den, agents, controller }) => {
    const before = den.pandas.length;
    controller.sync([placement("fx/01-a")], [], []);
    agents.applyLive([live("developer", "fx/01-a")]);
    assert.equal(controller.figures.size, 0, "the controller adds no ticket panda");
    assert.equal(den.pandas.length, before, "the den gained no panda");
    assert.equal(pandasFor(den, "fx/01-a").length, 1);
    assert.equal(agents.liveFigures().size, 1);
    assert.equal(agents.liveFigures().get("fx/01-a").model, pandasFor(den, "fx/01-a")[0]);
  });
});

test("a second live agent of a role is one split-off panda, and each agent has exactly one", () => {
  withLiveDen(({ den, agents, controller }) => {
    controller.sync([placement("fx/01-a"), placement("fx/02-b")], [], []);
    agents.applyLive([live("developer", "fx/01-a"), live("developer", "fx/02-b", { split: true })]);
    assert.equal(pandasFor(den, "fx/01-a").length, 1);
    assert.equal(pandasFor(den, "fx/02-b").length, 1);
    assert.notEqual(pandasFor(den, "fx/01-a")[0], pandasFor(den, "fx/02-b")[0]);
    assert.equal(agents.liveFigures().size, 2);
  });
});

test("clicking a role panda finds its ticket, and the ref goes when the agent ends", () => {
  withLiveDen(({ agents }) => {
    agents.applyLive([live("qa", "fx/03-c")]);
    const model = agents.liveFigures().get("fx/03-c").model;
    let mesh = null;
    model.traverse((o) => { if (!mesh && o.isMesh) mesh = o; });
    let ref = null;
    for (let o = mesh; o && !ref; o = o.parent) ref = o.userData.ticketRef || null;
    assert.equal(ref, "fx/03-c", "a hit on any part of the panda resolves to the ticket");
    agents.applyLive([]);
    assert.equal(agents.liveFigures().size, 0);
    assert.equal(model.userData.ticketRef, undefined);
  });
});

test("selecting a ticket lights its role panda only", () => {
  withLiveDen(({ agents }) => {
    agents.applyLive([live("developer", "fx/01-a"), live("qa", "fx/03-c")]);
    const glow = (ref) => agents.liveFigures().get(ref).panda.materials.cream.emissiveIntensity;
    agents.setSelected("fx/03-c");
    assert.ok(glow("fx/03-c") > 0);
    assert.equal(glow("fx/01-a"), 0);
    agents.setSelected(null);
    assert.equal(glow("fx/03-c"), 0);
  });
});

test("RestaurantDen turns the controller's ticket pandas off", () => {
  const source = readFileSync(new URL("../scene/procedural/RestaurantDen.jsx", import.meta.url), "utf8");
  assert.match(source, /createLiveDenController\([^)]*ticketPandas:\s*false/s);
});
