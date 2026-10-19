// dimsumden-ui-v0/07: the client reducer applyEvent(state, event) -> state (ADR 0011 decision 5).
// `state` is the snapshot (decision 3); `event` is the parsed `data` of an SSE `change` frame
// (decision 5: {seq, type, ...}). Contract chosen by qa where the ADR is silent:
//   - a change whose seq is not state.seq + 1 (missed or duplicate event) returns null:
//     "discard state, refetch GET /state";
//   - a change applied to a null state returns null (no baseline);
//   - unknown types are ignored but still advance seq (else the next event looks like a gap);
//   - `metrics-changed` leaves the data untouched, advances seq;
//   - the input state is never mutated; unknown keys survive (schema is additive-only).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyEvent } from "./apply-event.mjs";

const ticket = (ref, extra = {}) => ({
  ref,
  feature: ref.split("/")[0],
  title: `title of ${ref}`,
  type: "feature",
  status: "ready-for-agent",
  ready: true,
  priority: "P0",
  effectivePriority: "P0",
  bumps: 0,
  bumped: false,
  holder: null,
  lastRole: null,
  gate: null,
  request: null,
  handoff: null,
  ...extra,
});

const A = "dimsumden-ui-v0/04-bridge-state";
const B = "dimsumden-ui-v0/07-ui-shell";
const C = "organism-infra/28-review-claims-keep-in-review";

function base() {
  return {
    schema: 1,
    seq: 42,
    generatedAt: "2026-09-29T06:00:00.000Z",
    sessions: 9,
    tickets: [ticket(A), ticket(C, { status: "in-review", ready: false })],
    frontier: [A],
    usage: { fiveHour: 74, weekly: 72, sampledAt: "2026-09-29T04:36:50.650Z" },
    requests: [],
    futureKey: { keep: "me" },
  };
}

describe("applyEvent: ticket", () => {
  test("replaces an existing ticket by ref and leaves the others alone", () => {
    const next = applyEvent(base(), { seq: 43, type: "ticket", ref: A, ticket: ticket(A, { status: "claimed", ready: false, holder: { role: "developer", since: "2026-09-29T06:01:00.000Z" } }) });
    assert.equal(next.tickets.length, 2);
    const a = next.tickets.find((t) => t.ref === A);
    assert.equal(a.status, "claimed");
    assert.equal(a.holder.role, "developer");
    assert.deepEqual(next.tickets.find((t) => t.ref === C), ticket(C, { status: "in-review", ready: false }));
  });

  test("inserts a new ticket, keeping tickets sorted by ref", () => {
    const next = applyEvent(base(), { seq: 43, type: "ticket", ref: B, ticket: ticket(B) });
    assert.deepEqual(next.tickets.map((t) => t.ref), [A, B, C]);
  });

  test("ticket: null removes it (resolved tickets leave the snapshot)", () => {
    const next = applyEvent(base(), { seq: 43, type: "ticket", ref: C, ticket: null });
    assert.deepEqual(next.tickets.map((t) => t.ref), [A]);
  });

  test("removing a ref that is not present is a no-op on tickets", () => {
    const next = applyEvent(base(), { seq: 43, type: "ticket", ref: B, ticket: null });
    assert.deepEqual(next.tickets.map((t) => t.ref), [A, C]);
    assert.equal(next.seq, 43);
  });
});

describe("applyEvent: replace-style events", () => {
  test("agent changes keep a live card's state and tool current without mutating the snapshot", () => {
    const before = { ...base(), agents: [{ id: 'c-qa', state: 'working' }, { id: 'c-scout', state: 'working' }] };
    const agent = { id: 'c-qa', state: 'needs-you', tool: { name: 'Read', summary: 'ticket' }, capabilities: { approve: true } };
    const next = applyEvent(before, { seq: 43, type: 'agent', agent });
    assert.deepEqual(next.agents.find(a => a.id === 'c-qa'), agent);
    assert.equal(next.agents.length, 2);
    assert.equal(before.agents[0].state, 'working');
    const added = applyEvent(next, { seq: 44, type: 'agent', agent: { id: 'c-dev', state: 'working' } });
    assert.equal(added.agents.length, 3);
  });

  test("frontier replaces frontier", () => {
    const next = applyEvent(base(), { seq: 43, type: "frontier", refs: [B, A] });
    assert.deepEqual(next.frontier, [B, A]);
  });

  test("usage replaces usage, and null clears it", () => {
    const u = { fiveHour: 96, weekly: 80, sampledAt: "2026-09-29T07:00:00.000Z" };
    assert.deepEqual(applyEvent(base(), { seq: 43, type: "usage", usage: u }).usage, u);
    assert.equal(applyEvent(base(), { seq: 43, type: "usage", usage: null }).usage, null);
  });

  test("sessions replaces sessions (0 is a valid value)", () => {
    assert.equal(applyEvent(base(), { seq: 43, type: "sessions", sessions: 10 }).sessions, 10);
    assert.equal(applyEvent(base(), { seq: 43, type: "sessions", sessions: 0 }).sessions, 0);
  });

  test("requests replaces requests", () => {
    const reqs = [{ id: "6f1c1b7e-0d55-4c3a-9b52-1f5d7e0a9a10", ts: "2026-09-29T05:58:00.000Z", kind: "merge-approve", ref: C, note: "ship it", state: "pending" }];
    assert.deepEqual(applyEvent(base(), { seq: 43, type: "requests", requests: reqs }).requests, reqs);
  });
});

describe("applyEvent: seq handling", () => {
  test("every applied event advances state.seq to the event's seq", () => {
    let s = base();
    s = applyEvent(s, { seq: 43, type: "sessions", sessions: 10 });
    s = applyEvent(s, { seq: 44, type: "frontier", refs: [] });
    assert.equal(s.seq, 44);
  });

  test("a skipped seq (missed event) returns null so the client refetches /state", () => {
    assert.equal(applyEvent(base(), { seq: 44, type: "sessions", sessions: 10 }), null);
  });

  test("a repeated or older seq also returns null", () => {
    assert.equal(applyEvent(base(), { seq: 42, type: "sessions", sessions: 10 }), null);
    assert.equal(applyEvent(base(), { seq: 41, type: "sessions", sessions: 10 }), null);
  });

  test("a change on a null state returns null (no baseline to apply to)", () => {
    assert.equal(applyEvent(null, { seq: 1, type: "sessions", sessions: 1 }), null);
  });
});

describe("applyEvent: non-data and unknown events", () => {
  test("metrics-changed leaves the data alone and advances seq", () => {
    const before = base();
    const next = applyEvent(before, { seq: 43, type: "metrics-changed" });
    assert.deepEqual({ ...next, seq: 42 }, before);
    assert.equal(next.seq, 43);
  });

  test("an unknown type is ignored but still advances seq", () => {
    const before = base();
    const next = applyEvent(before, { seq: 43, type: "from-the-future", whatever: 1 });
    assert.deepEqual({ ...next, seq: 42 }, before);
    assert.equal(next.seq, 43);
    // the next event is not mistaken for a gap
    assert.equal(applyEvent(next, { seq: 44, type: "sessions", sessions: 3 }).sessions, 3);
  });
});

describe("applyEvent: purity", () => {
  test("does not mutate the input state or the event", () => {
    const before = base();
    const frozen = structuredClone(before);
    const ev = { seq: 43, type: "ticket", ref: B, ticket: ticket(B) };
    const evFrozen = structuredClone(ev);
    applyEvent(before, ev);
    assert.deepEqual(before, frozen);
    assert.deepEqual(ev, evFrozen);
  });

  test("returns a new object so a renderer can detect the change", () => {
    const before = base();
    assert.notEqual(applyEvent(before, { seq: 43, type: "sessions", sessions: 10 }), before);
  });

  test("keys the reducer does not know survive (additive-only schema)", () => {
    const next = applyEvent(base(), { seq: 43, type: "sessions", sessions: 10 });
    assert.deepEqual(next.futureKey, { keep: "me" });
    assert.equal(next.schema, 1);
  });
});

describe("applyEvent: three-digit tickets", () => {
  test("a pushed ticket sorts by ticket number, so 99 comes before 100", () => {
    const s = { ...base(), tickets: [ticket("fx/100-b")] };
    const next = applyEvent(s, { seq: 43, type: "ticket", ref: "fx/99-a", ticket: ticket("fx/99-a") });
    assert.deepEqual(next.tickets.map((x) => x.ref), ["fx/99-a", "fx/100-b"]);
  });
});

// den-v1 loop (live den runs, 2026-10-10): the reducer dropped `approval` changes, so a permission request raised
// after the page loaded never showed. bridge-stream.test.mjs checks the same thing against a real bridge.
describe("approval changes", () => {
  const base = { schema: 1, seq: 4, tickets: [], frontier: [], agents: [{ id: "c-1" }], approvals: [] };
  const approval = (extra = {}) => ({ id: "a-1", agentId: "c-1", tool: "Read", summary: "/x/package.json", inputLength: 30, state: "pending", ...extra });

  test("a new approval is added, and the input state is not mutated", () => {
    const next = applyEvent(base, { seq: 5, type: "approval", approval: approval() });
    assert.equal(next.seq, 5);
    assert.deepEqual(next.approvals, [approval()]);
    assert.deepEqual(base.approvals, []);
    assert.equal(next.agents, base.agents, "other keys are untouched");
  });

  test("a later change to the same approval replaces it in place; another approval is appended", () => {
    const one = applyEvent(base, { seq: 5, type: "approval", approval: approval() });
    const two = applyEvent(one, { seq: 6, type: "approval", approval: approval({ id: "a-2", tool: "Bash" }) });
    const three = applyEvent(two, { seq: 7, type: "approval", approval: approval({ state: "allowed" }) });
    assert.deepEqual(three.approvals.map((a) => [a.id, a.state]), [["a-1", "allowed"], ["a-2", "pending"]]);
    assert.deepEqual(two.approvals.map((a) => a.state), ["pending", "pending"]);
  });

  test("a snapshot from before approvals existed gains the list", () => {
    const { approvals, ...old } = base;
    assert.deepEqual(applyEvent(old, { seq: 5, type: "approval", approval: approval() }).approvals, [approval()]);
  });

  test("an approval change with no id asks for a fresh snapshot", () => {
    assert.equal(applyEvent(base, { seq: 5, type: "approval" }), null);
    assert.equal(applyEvent(base, { seq: 5, type: "approval", approval: { tool: "Read" } }), null);
  });
});
