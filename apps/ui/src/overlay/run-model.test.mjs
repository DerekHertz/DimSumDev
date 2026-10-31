// organism-infra/228 (UI spec .scratch/organism-infra/handoffs/228-designer-spec.md, "Acceptance for qa"): the pure
// pieces behind the Run control. Contract, in apps/ui/src/overlay/run-model.mjs:
//   ROLE_OPTIONS                       ["orchestrator","architect","product","designer","scout","herald"], in that order
//   defaultRole(ticket)                ticket.type: feature|bug -> orchestrator, design-question -> architect,
//                                      spec -> product, ui|asset -> designer, anything else (or no ticket) -> orchestrator
//   slotRows(capacity, agents)         capacity is the snapshot's key { max, cap, load, live, room, refs:[{ ref, kind }] };
//                                      agents is snapshot.agents. -> one row per ref, running first then locks, each by ref:
//                                      { ref, kind: "live"|"lock", role (live only, else null), tag, label }
//                                      No capacity -> [].
//   runState({ capacity, ticket, inflight, steer })
//                                      capacity as above (undefined or null for an older bridge); ticket { ref };
//                                      inflight: boolean, a start for this ref is in flight;
//                                      steer: { state: "ready"|"starting"|"none", demo?: boolean } (state is the session's)
//                                      -> { enabled, reason } where reason is the visible text under the row or null
//   capacityFromSnapshot(snapshot)     recompute with the shared capacity() from apps/bridge/agents/capacity.mjs: live refs are
//                                      snapshot.agents whose state is not done|failed|terminated; locked refs are the tickets
//                                      with a holder; max and cap come from snapshot.capacity. No snapshot.capacity -> null.
//   dispatchPrompt(capacity)           -> { show, line }: the Needs you dispatch prompt (note, Approve, Deny)
// Every test calls the real exports; a missing one fails that test with "run-model.mjs must export <name>".
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { capacity as capacityOf } from "../../../bridge/agents/capacity.mjs";
import { teamsModel } from "./overlay-model.mjs";

const model = await import("./run-model.mjs").catch(() => ({}));
const need = (name) => {
  assert.notEqual(model[name], undefined, `apps/ui/src/overlay/run-model.mjs must export ${name}`);
  return model[name];
};

const cap = (liveRefs, lockedRefs = []) => capacityOf({ liveRefs, lockedRefs });
const READY = { state: "ready" };
const TICKET = { ref: "f/05-target" };
const run = (over) => need("runState")({ capacity: cap([]), ticket: TICKET, inflight: false, steer: READY, ...over });

describe("ROLE_OPTIONS", () => {
  test("lists the seven den roles, scout and herald retired (team-and-den-ux/57)", () => {
    assert.deepEqual(need("ROLE_OPTIONS"), ["orchestrator", "architect", "product", "designer", "developer", "qa", "security"]);
  });

  test("offers developer, qa and security: a direct start no longer needs the orchestrator (den-mvp outcome 1)", () => {
    for (const role of ["developer", "qa", "security"]) assert.ok(need("ROLE_OPTIONS").includes(role), `${role} must be offered`);
  });
});

describe("defaultRole", () => {
  test("feature and bug tickets default to the orchestrator", () => {
    assert.equal(need("defaultRole")({ type: "feature" }), "orchestrator");
    assert.equal(need("defaultRole")({ type: "bug" }), "orchestrator");
  });

  test("a design-question defaults to the architect, spec work to product", () => {
    assert.equal(need("defaultRole")({ type: "design-question" }), "architect");
    assert.equal(need("defaultRole")({ type: "spec" }), "product");
  });

  test("a type written with spaces, capitals or a note in brackets is read as its plain name (F32)", () => {
    assert.equal(need("defaultRole")({ type: "design question" }), "architect");
    assert.equal(need("defaultRole")({ type: "design" }), "architect", "the den's /state sends a design question as design");
    assert.equal(need("defaultRole")({ type: "Design question (architect)" }), "architect");
    assert.equal(need("defaultRole")({ type: " UI " }), "designer");
  });

  test("UI and asset work default to the designer", () => {
    assert.equal(need("defaultRole")({ type: "ui" }), "designer");
    assert.equal(need("defaultRole")({ type: "asset" }), "designer");
  });

  test("an unrecognised or missing type, or no ticket at all, defaults to the orchestrator", () => {
    for (const ticket of [{ type: "chore" }, { type: "" }, { type: null }, {}, null, undefined]) {
      assert.equal(need("defaultRole")(ticket), "orchestrator", JSON.stringify(ticket));
    }
  });

  test("every default is one of the offered roles", () => {
    for (const type of ["feature", "bug", "design-question", "spec", "ui", "asset", "chore", undefined]) {
      assert.ok(need("ROLE_OPTIONS").includes(need("defaultRole")({ type })), String(type));
    }
  });
});

describe("slotRows", () => {
  const agents = [
    { id: "c-1", ref: "f/09-zeta", role: "architect", state: "working" },
    { id: "c-2", ref: "f/03-gamma", role: "scout", state: "working" },
  ];

  test("running rows come first, then locks, each group ordered by ref, whatever order refs arrives in", () => {
    const capacity = {
      max: 8, cap: 8, load: 4, live: 2, room: 4,
      refs: [{ ref: "f/01-alpha", kind: "lock" }, { ref: "f/09-zeta", kind: "live" }, { ref: "f/02-beta", kind: "lock" }, { ref: "f/03-gamma", kind: "live" }],
    };
    const rows = need("slotRows")(capacity, agents);
    assert.deepEqual(rows.map((r) => [r.ref, r.kind]), [["f/03-gamma", "live"], ["f/09-zeta", "live"], ["f/01-alpha", "lock"], ["f/02-beta", "lock"]]);
  });

  test("a live row carries the agent's role and the spec's tag and label; a lock row has no role", () => {
    const rows = need("slotRows")(cap(["f/09-zeta"], ["f/02-beta"]), agents);
    assert.deepEqual(rows[0], { ref: "f/09-zeta", kind: "live", role: "architect", tag: "architect · running", label: "f/09-zeta, running as architect" });
    assert.deepEqual(rows[1], { ref: "f/02-beta", kind: "lock", role: null, tag: "lock, no agent", label: "f/02-beta, lock held, no running agent" });
  });

  test("a ref that is both a live agent and holds the lock is one running row", () => {
    const real = need("slotRows")(cap(["f/09-zeta"], ["f/09-zeta"]), agents);
    assert.deepEqual(real.map((r) => [r.ref, r.kind]), [["f/09-zeta", "live"]]);
    const doubled = { max: 8, cap: 8, load: 1, live: 1, room: 7, refs: [{ ref: "f/09-zeta", kind: "lock" }, { ref: "f/09-zeta", kind: "live" }] };
    assert.deepEqual(need("slotRows")(doubled, agents).map((r) => [r.ref, r.kind]), [["f/09-zeta", "live"]]);
  });

  test("the role comes from the live agent, not an ended run of the same ticket", () => {
    const history = [
      { id: "c-0", ref: "f/09-zeta", role: "scout", state: "done" },
      { id: "c-1", ref: "f/09-zeta", role: "architect", state: "working" },
    ];
    assert.equal(need("slotRows")(cap(["f/09-zeta"]), history)[0].role, "architect");
  });

  test("no refs gives no rows, and a snapshot without capacity gives no rows", () => {
    assert.deepEqual(need("slotRows")(cap([]), agents), []);
    assert.deepEqual(need("slotRows")(undefined, agents), []);
    assert.deepEqual(need("slotRows")(null, []), []);
  });
});

describe("runState", () => {
  test("room, no live agent on the ticket, nothing in flight, signed in: enabled with no reason", () => {
    assert.deepEqual(run({}), { enabled: true, reason: null });
  });

  test("it works for any frontier ticket, not only the first", () => {
    assert.equal(run({ ticket: { ref: "f/99-last-in-line" } }).enabled, true);
  });

  test("enabled with other refs holding slots: 'Also running:' names every one of them, running first then locks", () => {
    const state = run({ capacity: cap(["f/09-zeta"], ["f/01-alpha"]) });
    assert.deepEqual(state, { enabled: true, reason: "Also running: f/09-zeta, f/01-alpha" });
  });

  test("portable-den/10: many agents running never disable Run on another ticket; the reason names the others", () => {
    const refs = Array.from({ length: 12 }, (_, i) => `f/${String(i + 10)}-x`);
    const state = run({ capacity: cap(refs, ["f/01-alpha"]) });
    assert.equal(state.enabled, true);
    assert.match(state.reason, /^Also running: f\/10-x/);
  });

  test("a snapshot with no capacity key is never enabled blind", () => {
    assert.deepEqual(run({ capacity: undefined }), { enabled: false, reason: "Capacity unknown" });
    assert.deepEqual(run({ capacity: null }), { enabled: false, reason: "Capacity unknown" });
  });

  test("no steering session: disabled with the gate cards' wording", () => {
    assert.deepEqual(run({ steer: { state: "none" } }), { enabled: false, reason: "Couldn't send: not signed in to steer" });
  });

  test("demo mode: disabled with 'Demo mode: actions are off'", () => {
    assert.deepEqual(run({ steer: { state: "ready", demo: true } }), { enabled: false, reason: "Demo mode: actions are off" });
  });

  test("a start already in flight for this ref disables Run, and says why", () => {
    const state = run({ inflight: true });
    assert.equal(state.enabled, false);
    assert.ok(typeof state.reason === "string" && state.reason !== "", "a disabled Run always has a visible reason");
  });

  test("a ticket that already has a live agent cannot be run again, even with room, and says why", () => {
    const state = run({ capacity: cap([TICKET.ref]) });
    assert.equal(state.enabled, false);
    assert.ok(typeof state.reason === "string" && state.reason !== "", "a disabled Run always has a visible reason");
  });
});

describe("capacityFromSnapshot (the UI recomputes between snapshots)", () => {
  const working = (ref, id) => ({ id, ref, role: "architect", state: "working" });
  const snapshot = (agents, tickets = []) => ({ capacity: { load: 0, live: 0, refs: [] }, agents, tickets });

  test("live agents and ticket holders make the capacity", () => {
    const c = need("capacityFromSnapshot")(snapshot(
      [working("f/01-a", "c-1")],
      [{ ref: "f/07-locked", holder: { role: "developer", since: "2026-10-12T09:00:00Z" } }, { ref: "f/08-free", holder: null }],
    ));
    const { load, live } = c;
    assert.deepEqual({ load, live }, { load: 2, live: 1 });
    assert.equal(c.room, undefined);
    assert.deepEqual(c.refs, [{ ref: "f/01-a", kind: "live" }, { ref: "f/07-locked", kind: "lock" }]);
  });

  test("an agent that ended no longer counts, with no new capacity frame", () => {
    const before = need("capacityFromSnapshot")(snapshot([working("f/01-a", "c-1"), working("f/02-b", "c-2")]));
    assert.equal(before.live, 2);
    for (const state of ["done", "failed", "terminated"]) {
      const ended = need("capacityFromSnapshot")(snapshot([working("f/01-a", "c-1"), { ...working("f/02-b", "c-2"), state }]));
      assert.equal(ended.live, 1, state);
    }
  });

  test("Run stays enabled on another ticket whatever is running", () => {
    const ticket = { ref: "f/05-target" };
    const running = snapshot([working("f/01-a", "c-1"), working("f/02-b", "c-2")]);
    const state = need("runState")({ capacity: need("capacityFromSnapshot")(running), ticket, inflight: false, steer: READY });
    assert.equal(state.enabled, true);
    assert.equal(state.reason, "Also running: f/01-a, f/02-b");
  });

  test("an agent that ended while its ticket still holds the lock leaves a lock, not a running agent", () => {
    const c = need("capacityFromSnapshot")(snapshot(
      [{ ...working("f/01-a", "c-1"), state: "failed" }],
      [{ ref: "f/01-a", holder: { role: "scout", since: "2026-10-12T09:00:00Z" } }],
    ));
    assert.deepEqual(c.refs, [{ ref: "f/01-a", kind: "lock" }]);
    assert.equal(c.live, 0);
    assert.equal(c.load, 1);
  });

  test("a live agent that also holds its ticket's lock is one slot", () => {
    const c = need("capacityFromSnapshot")(snapshot([working("f/01-a", "c-1")], [{ ref: "f/01-a", holder: { role: "scout", since: "2026-10-12T09:00:00Z" } }]));
    assert.deepEqual(c.refs, [{ ref: "f/01-a", kind: "live" }]);
    assert.equal(c.load, 1);
  });

  test("a snapshot with no capacity key (older bridge) stays unknown instead of guessing", () => {
    const c = need("capacityFromSnapshot")({ agents: [], tickets: [] });
    assert.ok(c == null, "must be null or undefined");
    assert.deepEqual(need("runState")({ capacity: c, ticket: TICKET, inflight: false, steer: READY }), { enabled: false, reason: "Capacity unknown" });
  });
});

describe("the ready list shows every frontier ticket", () => {
  test("teamsModel's next list is not cut to three rows", () => {
    const tickets = ["01", "02", "03", "04", "05"].map((n) => ({ ref: `f/${n}-x`, title: `T${n}`, status: "ready-for-agent", priority: "P1", effectivePriority: "P1", type: "feature" }));
    const m = teamsModel({ tickets, frontier: tickets.map((t) => t.ref), agents: [] });
    assert.deepEqual(m.next.map((r) => r.ref), tickets.map((t) => t.ref));
    assert.equal(m.summary, "5 open · 5 ready");
  });
});

// team-and-den-ux/57: two worker slots, plus one reserved for Bao; the scout slot is retired.
