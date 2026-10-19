// den-layout/03 (absorbs den-v1/02): the pure adapter from a live-store snapshot to actor state for
// PR #162's role pandas. Seam: liveActorsFromSnapshot(snapshot, { now }) in ./live-actors.mjs.
//
// Contract these tests pin (the developer may add fields, not drop these):
//   liveActorsFromSnapshot(snapshot, { now? }) -> LiveActor[]
//   LiveActor = { role, ref, split, state, activity, bubble, task }
//     role   one of the 9 cell types; scenery roles never appear (they stay simulated)
//     split  false for the first live agent of a role, true for each further one
//     state  PR #162 actor state: 'working' | 'needs-you' | 'blocked'
//     bubble the latest tool (name and summary) while it is younger than TOOL_BUBBLE_TTL_MS, else ''
//     task   contains the ticket ref
//   A role with no live process has no entry. Holder locks need a matching active
//   snapshot.cells[] entry or snapshot.agents[] run; locks alone are not activity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { liveActorsFromSnapshot, TOOL_BUBBLE_TTL_MS } from "./live-actors.mjs";

const T0 = Date.parse("2026-10-06T10:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

const ticket = (ref, status, cell, extra = {}) => ({
  ref,
  title: `${ref} title`,
  type: "feature",
  status,
  holder: cell ? { cell, since: iso(T0 - 60_000) } : null,
  lastCell: cell,
  gate: null,
  blockedBy: [],
  ...extra,
});
const cellRow = (ref, cellType, tool, extra = {}) => ({
  id: `c-${ref}`,
  ref,
  cellType,
  state: "working",
  startedAt: iso(T0 - 60_000),
  lastEventAt: iso(T0),
  tool,
  ...extra,
});
const snap = (tickets, cells = tickets.filter(t=>t.holder).map(t=>cellRow(t.ref,t.holder.cell,null))) => ({ tickets, cells });
const byRole = (actors, role) => actors.filter((a) => a.role === role);

test("a bound agent maps to an actor of its role, working, with its ticket as the task", () => {
  const s = snap([ticket("fx/01-a", "claimed", "developer")], [cellRow("fx/01-a", "developer", { name: "Read", summary: "docs/adr/0011.md" })]);
  const actors = liveActorsFromSnapshot(s, { now: T0 + 1000 });
  assert.equal(actors.length, 1);
  const [a] = actors;
  assert.equal(a.role, "developer");
  assert.equal(a.ref, "fx/01-a");
  assert.equal(a.split, false);
  assert.equal(a.state, "working");
  assert.ok(a.task.includes("fx/01-a"), "task shows the ticket");
});

test("the bubble shows the agent's latest tool name and summary", () => {
  const s = snap([ticket("fx/01-a", "claimed", "qa")], [cellRow("fx/01-a", "qa", { name: "Bash", summary: "npm test" })]);
  const [a] = liveActorsFromSnapshot(s, { now: T0 + 1000 });
  assert.ok(a.bubble.includes("Bash"));
  assert.ok(a.bubble.includes("npm test"));
});

test("a tool call older than the TTL no longer shows; one just inside it still does", () => {
  const s = snap([ticket("fx/01-a", "claimed", "developer")], [cellRow("fx/01-a", "developer", { name: "Edit", summary: "src/x.mjs" })]);
  const inside = liveActorsFromSnapshot(s, { now: T0 + TOOL_BUBBLE_TTL_MS - 1 })[0];
  const outside = liveActorsFromSnapshot(s, { now: T0 + TOOL_BUBBLE_TTL_MS + 1 })[0];
  assert.ok(inside.bubble.includes("Edit"), "still shown just inside the TTL");
  assert.equal(outside.bubble, "", "gone after the TTL with no newer call");
  assert.equal(outside.state, "working", "the agent is still bound after its bubble fades");
});

test("a newer tool call replaces the bubble immediately", () => {
  const before = snap([ticket("fx/01-a", "claimed", "developer")], [cellRow("fx/01-a", "developer", { name: "Read", summary: "one.md" })]);
  const after = snap(
    [ticket("fx/01-a", "claimed", "developer")],
    [cellRow("fx/01-a", "developer", { name: "Grep", summary: "two" }, { lastEventAt: iso(T0 + 2000) })],
  );
  const a = liveActorsFromSnapshot(before, { now: T0 + 1000 })[0];
  const b = liveActorsFromSnapshot(after, { now: T0 + 2500 })[0];
  assert.ok(a.bubble.includes("Read"));
  assert.ok(b.bubble.includes("Grep"));
  assert.ok(!b.bubble.includes("Read"), "the old call is gone");
});

test("a bound agent with no tool call yet has an empty bubble, not a stale or invented one", () => {
  const s = snap([ticket("fx/01-a", "claimed", "architect")], [cellRow('fx/01-a','architect',null)]);
  const [a] = liveActorsFromSnapshot(s, { now: T0 });
  assert.equal(a.role, "architect");
  assert.equal(a.bubble, "");
});

test("the ticket's pose maps to the actor state: a gate or ready-for-human waits for the user, blocked stays blocked", () => {
  const s = snap([
    ticket("fx/01-a", "claimed", "developer", { gate: "merge" }),
    ticket("fx/02-b", "blocked", "qa"),
    ticket("fx/03-c", "claimed", "scout"),
  ]);
  const actors = liveActorsFromSnapshot(s, { now: T0 });
  assert.equal(byRole(actors, "developer")[0].state, "needs-you");
  assert.equal(byRole(actors, "qa")[0].state, "blocked");
  assert.equal(byRole(actors, "scout")[0].state, "working");
});

test("a second live agent of the same role is a split-off actor; the first stays the primary", () => {
  const s = snap([ticket("fx/01-a", "claimed", "developer"), ticket("fx/02-b", "claimed", "developer")], [
    cellRow("fx/01-a", "developer", { name: "Read", summary: "a" }),
    cellRow("fx/02-b", "developer", { name: "Write", summary: "b" }),
  ]);
  const devs = byRole(liveActorsFromSnapshot(s, { now: T0 + 1 }), "developer");
  assert.equal(devs.length, 2);
  assert.deepEqual(devs.map((d) => d.split), [false, true]);
  assert.deepEqual(devs.map((d) => d.ref), ["fx/01-a", "fx/02-b"]);
  assert.ok(devs[0].bubble.includes("Read") && devs[0].task.includes("fx/01-a"));
  assert.ok(devs[1].bubble.includes("Write") && devs[1].task.includes("fx/02-b"), "each panda carries its own agent's tool and ticket");
});

test("roles with no live agent have no actor, so they keep idle wandering", () => {
  const s = snap([ticket("fx/01-a", "claimed", "developer")]);
  const actors = liveActorsFromSnapshot(s, { now: T0 });
  assert.deepEqual(actors.map((a) => a.role), ["developer"]);
  assert.deepEqual(liveActorsFromSnapshot(snap([]), { now: T0 }), []);
  assert.deepEqual(liveActorsFromSnapshot(null, { now: T0 }), [], "no snapshot yet (bridge not connected) binds nothing");
});

test("a ticket with no lock is not a live agent: in-review and ready-for-human with no holder bind nothing", () => {
  const s = snap([ticket("fx/01-a", "in-review", null, { lastCell: "developer" }), ticket("fx/02-b", "ready-for-human", null, { lastCell: "qa" })]);
  assert.deepEqual(liveActorsFromSnapshot(s, { now: T0 }), []);
});

test("the 4 scenery pandas never come from live state, even if a holder names one", () => {
  const s = snap([
    ticket("fx/01-a", "claimed", "release-manager"),
    ticket("fx/02-b", "claimed", "knowledge-keeper"),
    ticket("fx/03-c", "claimed", "docs-writer"),
    ticket("fx/04-d", "claimed", "stem-cub"),
    ticket("fx/05-e", "claimed", "herald"),
  ]);
  const actors = liveActorsFromSnapshot(s, { now: T0 });
  assert.deepEqual(actors.map((a) => a.role), ["herald"]);
});

test("each of the 9 cell types binds to the matching role", () => {
  const roles = ["orchestrator", "product", "architect", "developer", "scout", "qa", "security", "designer", "herald"];
  const s = snap(roles.map((r, i) => ticket(`fx/${String(i + 1).padStart(2, "0")}-x`, "claimed", r)));
  const actors = liveActorsFromSnapshot(s, { now: T0 });
  assert.deepEqual(actors.map((a) => a.role).sort(), [...roles].sort());
  assert.ok(actors.every((a) => a.split === false));
});

test("when the agent's session ends, its panda is no longer bound", () => {
  const live = snap([ticket("fx/01-a", "claimed", "developer")], [cellRow("fx/01-a", "developer", { name: "Read", summary: "a" })]);
  assert.equal(liveActorsFromSnapshot(live, { now: T0 + 1 }).length, 1);
  // The lock is released: the ticket leaves the active set.
  const released = snap([ticket("fx/01-a", "in-review", null, { lastCell: "developer" })], live.cells);
  assert.deepEqual(liveActorsFromSnapshot(released, { now: T0 + 1 }), []);
  // The bridge reports the session over while the ticket still shows the claim.
  for (const state of ["terminated", "done", "failed"]) {
    const ended = snap([ticket("fx/01-a", "claimed", "developer")], [cellRow("fx/01-a", "developer", { name: "Read", summary: "a" }, { state })]);
    assert.deepEqual(liveActorsFromSnapshot(ended, { now: T0 + 1 }), [], `session state ${state} unbinds the panda`);
  }
});

test("the adapter is pure: same input and clock give the same output, and the snapshot is not mutated", () => {
  const s = snap([ticket("fx/01-a", "claimed", "developer")], [cellRow("fx/01-a", "developer", { name: "Read", summary: "a" })]);
  const frozen = JSON.stringify(s);
  const one = liveActorsFromSnapshot(s, { now: T0 + 1 });
  const two = liveActorsFromSnapshot(s, { now: T0 + 1 });
  assert.deepEqual(one, two);
  assert.equal(JSON.stringify(s), frozen);
});

// den-v1 loop, after the live den run of 2026-10-10: an agent the bridge started (snapshot.agents[]) drives its
// role's panda from the moment it runs, not only once the board shows its claim. That run's agent waited on the
// user before it could claim, and the panda showed nothing.
const agentRow = (ref, role, extra = {}) => ({
  id: `c-${ref}-${role}`, ref, role, mode: "direct", state: "working", startedAt: iso(T0 - 5000), lastEventAt: iso(T0), tool: null, ...extra,
});
const live = (tickets, agents, cells = []) => ({ tickets, cells, agents });

test("a bridge agent on a ticket nobody has claimed binds its role's panda, working, with the ticket as its task", () => {
  const actors = liveActorsFromSnapshot(live([ticket("den/01-scout", "ready-for-agent", null)], [agentRow("den/01-scout", "scout")]), { now: T0 + 1000 });
  assert.deepEqual(actors.map(({ role, ref, split, state, activity }) => ({ role, ref, split, state, activity })), [
    { role: "scout", ref: "den/01-scout", split: false, state: "working", activity: "Working" },
  ]);
  assert.equal(actors[0].task, "den/01-scout · den/01-scout title");
});

test("while that agent waits on the user (a held permission request) its panda needs you", () => {
  const [a] = liveActorsFromSnapshot(live([ticket("den/01-scout", "ready-for-agent", null)], [agentRow("den/01-scout", "scout", { state: "waiting_on_user" })]), { now: T0 });
  assert.equal(a.state, "needs-you");
  assert.equal(a.activity, "Needs your answer");
});

test("a claimed ticket whose bridge agent waits on the user needs you too, as one actor", () => {
  const s = live([ticket("den/01-scout", "claimed", "scout")], [agentRow("den/01-scout", "scout", { state: "waiting_on_user" })]);
  const actors = liveActorsFromSnapshot(s, { now: T0 });
  assert.equal(actors.length, 1);
  assert.equal(actors[0].state, "needs-you");
  const working = liveActorsFromSnapshot(live([ticket("den/01-scout", "claimed", "scout")], [agentRow("den/01-scout", "scout")]), { now: T0 });
  assert.deepEqual(working.map((a) => a.state), ["working"]);
});

test("the bridge agent's latest tool is the bubble, under the same TTL", () => {
  const s = live([ticket("den/01-scout", "ready-for-agent", null)], [agentRow("den/01-scout", "scout", { tool: { name: "Bash", summary: "node --version" } })]);
  assert.equal(liveActorsFromSnapshot(s, { now: T0 + 1000 })[0].bubble, "Bash: node --version");
  assert.equal(liveActorsFromSnapshot(s, { now: T0 + TOOL_BUBBLE_TTL_MS + 1 })[0].bubble, "");
  const claimed = live([ticket("den/01-scout", "claimed", "scout")], [agentRow("den/01-scout", "scout", { tool: { name: "Grep", summary: "TODO" } })]);
  assert.equal(liveActorsFromSnapshot(claimed, { now: T0 + 1000 })[0].bubble, "Grep: TODO", "a claimed ticket with no session row reads the bridge agent's tool");
});

test("an ended bridge agent binds nothing, and neither does one with no id, no ref or an unknown role", () => {
  const rows = [
    ...["done", "failed", "terminated"].map((state, i) => agentRow(`den/0${i + 1}-scout`, "scout", { state })),
    agentRow("den/05-x", "release-manager"),
    { ...agentRow("den/06-qa", "qa"), id: undefined },
    { ...agentRow("den/07-qa", "qa"), ref: undefined },
    null,
  ];
  assert.deepEqual(liveActorsFromSnapshot(live([], rows), { now: T0 }), []);
});

test("a bridge agent whose ticket is not in the snapshot yet still binds, with the ref as its task", () => {
  const [a] = liveActorsFromSnapshot(live([], [agentRow("den/02-qa", "qa")]), { now: T0 });
  assert.equal(a.role, "qa");
  assert.equal(a.task, "den/02-qa");
});

test("two bridge agents of one role: the first by ref takes the role's panda, the second splits off", () => {
  const s = live(
    [ticket("den/02-developer", "ready-for-agent", null), ticket("den/01-developer", "claimed", "developer")],
    [agentRow("den/02-developer", "developer"), agentRow("den/01-developer", "developer")],
  );
  assert.deepEqual(liveActorsFromSnapshot(s, { now: T0 }).map(({ ref, split }) => ({ ref, split })), [
    { ref: "den/01-developer", split: false },
    { ref: "den/02-developer", split: true },
  ]);
});

test("a ticket held by one role with a bridge agent of another role on it shows both", () => {
  const s = live([ticket("fx/01-a", "in-review", "qa")], [agentRow("fx/01-a", "security")], [cellRow('fx/01-a','qa',null)]);
  assert.deepEqual(liveActorsFromSnapshot(s, { now: T0 }).map((a) => a.role).sort(), ["qa", "security"]);
});

test("a snapshot with no agents list reads as before", () => {
  const s = snap([ticket("fx/01-a", "claimed", "developer")]);
  assert.deepEqual(liveActorsFromSnapshot({ ...s, agents: undefined }, { now: T0 }), liveActorsFromSnapshot(s, { now: T0 }));
});
