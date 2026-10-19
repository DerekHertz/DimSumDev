// Ticket dimsumden-ui-v0/08, seam 3 (ADR 0011 decision 7): sceneFromState(snapshot) -> Placement[].
// Table tests over snapshots. Expected values are literals from the ADR rules, not recomputed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STATES } from "../../../../packages/character-director/src/director.mjs";

// Dynamic import so each test fails on its own while the module is missing.
const load = () => import("./scene-from-state.mjs");
const scene = async (snap) => (await load()).sceneFromState(snap);

const ticket = (n, over = {}) => ({
  ref: `f/${String(n).padStart(2, "0")}-t`,
  feature: "f",
  title: `t${n}`,
  type: "feature",
  status: "claimed",
  ready: false,
  holder: null,
  lastRole: null,
  gate: null,
  blockedBy: [],
  ...over,
});
const snap = (tickets, frontier = []) => ({ schema: 1, seq: 1, tickets, frontier, usage: null, requests: [] });
const claimedBy = (placement) => ({ role: placement, since: "2026-09-29T05:00:00.000Z" });
const brief = (placements) => placements.map(({ ref, role, status, perch, pose }) => ({ ref, role, status, perch, pose }));

test("exports MAX_PLUSH = 12", async () => {
  assert.equal((await load()).MAX_PLUSH, 12);
});

test("empty snapshot yields []", async () => {
  assert.deepEqual(await scene(snap([])), []);
});

test("resolved-only or unknown-status tickets are excluded", async () => {
  const out = await scene(snap([ticket(1, { status: "resolved" }), ticket(2, { status: "ready-for-agent" })]));
  assert.deepEqual(out, []);
});

test("ready-for-agent ticket blocked by an unresolved dependency and not in frontier is absent", async () => {
  const t = ticket(1, { status: "ready-for-agent", blockedBy: [{ ref: "f/00-x", status: "claimed" }] });
  assert.deepEqual(await scene(snap([t], [])), []);
});

test("each active status appears with status copied through unchanged", async () => {
  const out = await scene(snap([
    ticket(1, { status: "claimed", holder: claimedBy("developer") }),
    ticket(2, { status: "in-review", lastRole: "qa" }),
    ticket(3, { status: "blocked", lastRole: "developer" }),
    ticket(4, { status: "ready-for-human", lastRole: "orchestrator" }),
  ]));
  assert.deepEqual(out.map((c) => [c.ref, c.status]), [
    ["f/01-t", "claimed"], ["f/02-t", "in-review"], ["f/03-t", "blocked"], ["f/04-t", "ready-for-human"],
  ]);
});

test("output shape: exactly ref, role, status, perch, pose", async () => {
  const [placement] = await scene(snap([ticket(1, { holder: claimedBy("developer") })]));
  assert.deepEqual(Object.keys(placement).sort(), ["perch", "pose", "ref", "role", "status"]);
});

// pose rule order table
const poseCases = [
  ["gate merge beats everything", { status: "in-review", gate: "merge", lastRole: "security" }, [], "waiting_on_user"],
  ["gate beats claimed", { status: "claimed", holder: claimedBy("developer"), gate: "merge" }, [], "waiting_on_user"],
  ["ready-for-human", { status: "ready-for-human", lastRole: "orchestrator" }, [], "waiting_on_user"],
  ["claimed", { status: "claimed", holder: claimedBy("developer") }, [], "working"],
  ["in-review with a holder (review running)", { status: "in-review", holder: claimedBy("qa") }, [], "working"],
  ["in-review without a holder", { status: "in-review", lastRole: "qa" }, [], "done"],
  ["blocked", { status: "blocked", lastRole: "developer" }, [], "blocked"],
];
for (const [name, over, frontier, pose] of poseCases) {
  test(`pose: ${name} -> ${pose}`, async () => {
    const [placement] = await scene(snap([ticket(1, over)], frontier));
    assert.equal(placement.pose, pose);
    assert.ok(STATES.includes(placement.pose), "pose must be a director STATE");
  });
}

// role rule
const typeCases = [
  ["holder.role wins over lastRole", { holder: claimedBy("qa"), lastRole: "developer" }, "qa"],
  ["lastRole when no holder", { lastRole: "security" }, "security"],
  ["type design -> architect", { type: "design" }, "architect"],
  ["type design-question -> architect", { type: "design-question" }, "architect"],
  ["type design-direction -> architect", { type: "design-direction" }, "architect"],
  ["type decision -> architect", { type: "decision" }, "architect"],
  ["type prototype -> architect", { type: "prototype" }, "architect"],
  ["type research -> scout", { type: "research" }, "scout"],
  ["type feature -> developer", { type: "feature" }, "developer"],
  ["type bug -> developer", { type: "bug" }, "developer"],
  ["null type -> developer", { type: null }, "developer"],
  ["lastRole beats type default", { type: "research", lastRole: "designer" }, "designer"],
];
for (const [name, over, role] of typeCases) {
  test(`role: ${name}`, async () => {
    const [placement] = await scene(snap([ticket(1, { status: "blocked", ...over })]));
    assert.equal(placement.role, role);
  });
}

test("perch: team from placement type (ADR 0013), slot is 0-based index within the team in output order", async () => {
  const placements = [
    ["orchestrator", "orchestrator#0"], ["product", "product#0"], ["architect", "architect#0"],
    ["developer", "steamers#0"], ["scout", "steamers#1"],
    ["qa", "tea#0"], ["security", "pantry#0"],
    ["designer", "front-of-house#0"],
  ];
  const tickets = placements.map(([placement], i) => ticket(i + 1, { status: "claimed", holder: claimedBy(placement) }));
  const out = await scene(snap(tickets));
  assert.deepEqual(out.map((c) => [c.role, c.perch]), placements);
});

test("perch: slot counts per region are independent", async () => {
  const out = await scene(snap([
    ticket(1, { holder: claimedBy("developer") }),
    ticket(2, { holder: claimedBy("qa") }),
    ticket(3, { holder: claimedBy("developer") }),
    ticket(4, { holder: claimedBy("qa") }),
  ]));
  assert.deepEqual(out.map((c) => c.perch), ["steamers#0", "tea#0", "steamers#1", "tea#1"]);
});

test("order: active tickets by ref; queued tickets get no placement (showcase-v1/04: baskets only)", async () => {
  const out = await scene(snap([
    ticket(9, { status: "claimed", holder: claimedBy("developer") }),
    ticket(3, { status: "blocked", lastRole: "developer" }),
    ticket(7, { status: "ready-for-agent", ready: true }),
    ticket(2, { status: "ready-for-agent", ready: true }),
    ticket(5, { status: "in-review", lastRole: "qa" }),
  ], ["f/07-t", "f/02-t"]));
  assert.deepEqual(out.map((c) => c.ref), ["f/03-t", "f/05-t", "f/09-t"]);
});

test("order does not depend on input ticket order", async () => {
  const a = [ticket(2, { holder: claimedBy("developer") }), ticket(1, { holder: claimedBy("developer") })];
  const out = await scene(snap(a));
  assert.deepEqual(out.map((c) => [c.ref, c.perch]), [["f/01-t", "steamers#0"], ["f/02-t", "steamers#1"]]);
});

test("cap: queued tickets add no placements, so 10 active plus 5 queued is 10 placements", async () => {
  const active = Array.from({ length: 10 }, (_, i) => ticket(i + 1, { holder: claimedBy("developer") }));
  const ready = Array.from({ length: 5 }, (_, i) => ticket(20 + i, { status: "ready-for-agent", ready: true }));
  const frontier = ready.map((t) => t.ref);
  const out = await scene(snap([...active, ...ready], frontier));
  assert.equal(out.length, 10);
  assert.deepEqual(out.map((c) => c.ref), active.map((t) => t.ref));
});

test("cap: 15 active tickets are cut to the first 12 by ref", async () => {
  const active = Array.from({ length: 15 }, (_, i) => ticket(i + 1, { holder: claimedBy("developer") }));
  const out = await scene(snap(active));
  assert.deepEqual(out.map((c) => c.ref), active.slice(0, 12).map((t) => t.ref));
});

test("purity: does not mutate the snapshot and is repeatable", async () => {
  const s = snap([ticket(1, { holder: claimedBy("qa") })], []);
  const before = JSON.stringify(s);
  const first = await scene(s);
  const second = await scene(s);
  assert.equal(JSON.stringify(s), before);
  assert.deepEqual(first, second);
});

test("worked example from ADR 0011 decision 7", async () => {
  const out = await scene(snap([
    ticket(28, { ref: "organism-infra/28-review-claims-keep-in-review", status: "in-review", gate: "merge", lastRole: "security" }),
    ticket(4, { ref: "dimsumden-ui-v0/04-bridge-state", status: "ready-for-agent", ready: true, gate: "dispatch", lastRole: "orchestrator", type: "feature" }),
    ticket(7, { ref: "dimsumden-ui-v0/07-ui-shell", status: "ready-for-agent", ready: false, blockedBy: [{ ref: "dimsumden-ui-v0/05-bridge-events", status: "ready-for-agent" }] }),
  ], ["dimsumden-ui-v0/04-bridge-state"]));
  assert.deepEqual(brief(out), [
    { ref: "organism-infra/28-review-claims-keep-in-review", role: "security", status: "in-review", perch: "pantry#0", pose: "waiting_on_user" },
  ]);
});

test("withPassPlacement: an idle orchestrator stands on Bao's crown when none is active, and never twice", async () => {
  const { withPassPlacement } = await load();
  const [pass] = withPassPlacement([]);
  assert.deepEqual(pass, { ref: "__pass", role: "orchestrator", status: "idle", perch: "orchestrator#0", pose: "idle", synthetic: true });
  const real = { ref: "f/01-t", role: "orchestrator", status: "claimed", perch: "orchestrator#0", pose: "working" };
  assert.deepEqual(withPassPlacement([real]), [real]);
  const dev = { ref: "f/02-t", role: "developer", status: "claimed", perch: "steamers#0", pose: "working" };
  assert.deepEqual(withPassPlacement([dev]).map((c) => c.ref), ["f/02-t", "__pass"]);
});
