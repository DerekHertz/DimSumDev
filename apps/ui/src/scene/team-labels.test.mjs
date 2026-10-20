// showcase-v1/05: team labels over the stalls. Pure model; worked literals from ADR 0013 and the roofs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { teamLabels } from "./team-labels.mjs";
import { STALL_CENTERS, stallCenterX } from "./banquet-layout.mjs";

test("one label per stall with the team's name", () => {
  const labels = teamLabels({});
  assert.deepEqual(labels.map((l) => [l.team, l.text]), [
    ["steamers", "Steamers"], ["front-of-house", "Front of House"], ["tea", "Tea"], ["pantry", "Pantry"], ["cubs", "Cubs"],
  ]);
  assert.deepEqual(labels.map((l) => l.id), ["team:steamers", "team:front-of-house", "team:tea", "team:pantry", "team:cubs"]);
});

test("labels float above each roof: back stalls sit on the platform, so higher; front roofs are low", () => {
  const byTeam = Object.fromEntries(teamLabels({}).map((l) => [l.team, l]));
  // back: platform 0.5 + eave 1.7 + rise 0.7 = 2.9 apex, label 0.2 above; front: eave 1.77 (raised from 1.4, den-scene-v1/09 round 2) + rise 0.4 = 2.17 apex
  assert.ok(Math.abs(byTeam.steamers.y - 3.1) < 1e-9);
  assert.ok(Math.abs(byTeam.tea.y - 2.37) < 1e-9);
});

test("the Cubs pill floats just above the front-left cub basket, so it is not read as the queue", () => {
  const cubs = teamLabels({}).find((l) => l.team === "cubs");
  assert.equal(cubs.x, -1.8);
  assert.equal(cubs.z, 3.0);
  assert.ok(cubs.y > 0.4 && cubs.y < 1);
});

test("labels follow the stall as it widens outward, and stand at the stall's z", () => {
  const labels = teamLabels({ steamers: 5, pantry: 8 });
  const s = labels.find((l) => l.team === "steamers");
  const p = labels.find((l) => l.team === "pantry");
  assert.equal(s.x, stallCenterX("steamers", 5));
  assert.equal(p.x, stallCenterX("pantry", 8));
  assert.equal(s.z, STALL_CENTERS.steamers.z);
  assert.equal(p.z, STALL_CENTERS.pantry.z);
});
