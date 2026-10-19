// dimsumden-ui-v0/10: gate cards and Gate request submission. Designer spec 07 section 4; ADR 0011 decisions 3, 6.
// Interface pinned by these tests (pure .mjs under node --test, ADR 0011 decision 8):
//   gatesModel(snapshot) -> { visible: boolean, count: number,
//     cards: [{ ref, title, eyebrow: "MERGE"|"DISPATCH", approveLabel, rejectLabel, approveKind, rejectKind,
//               pending: null | { verdict: "approve"|"reject", text } }] }
//   noteCounter(length) -> { show: boolean, text: string }      (max 500; shown from 450)
//   submitGate({ fetch, ref, kind, note? }) -> Promise<{ ok: true } | { ok: false, status, message, retryable }>
//     issues exactly one `fetch("/requests", { method: "POST", headers: {"Content-Type": "application/json"}, body })`
import { test } from "node:test";
import assert from "node:assert/strict";
import { gatesModel, noteCounter, submitGate } from "./gates-model.mjs";
import { applyEvent } from "../state/apply-event.mjs";

const t = (over) => ({
  ref: "fx/00-x", feature: "fx", title: "T", type: "feature", status: "ready-for-agent", ready: true,
  priority: "P2", effectivePriority: "P2", bumps: 0, bumped: false, readySince: null,
  blockedBy: [], blockedReason: null, holder: null, lastRole: null, gate: null, request: null, handoff: null,
  ...over,
});
const snap = (tickets, extra = {}) => ({
  schema: 1, seq: 1, generatedAt: "2026-09-29T06:00:00.000Z", sessions: 9, tickets, frontier: [],
  usage: null, requests: [], ...extra,
});
const REQ = { id: "6f1c1b7e-0d55-4c3a-9b52-1f5d7e0a9a10", kind: "merge-approve", ts: "2026-09-29T05:58:00.000Z" };

test("no gated tickets: section hidden, no cards", () => {
  const g = gatesModel(snap([t({ ref: "fx/01-a" }), t({ ref: "fx/02-b" })]));
  assert.equal(g.visible, false);
  assert.equal(g.count, 0);
  assert.deepEqual(g.cards, []);
});

test("one card per ticket with a gate, with count", () => {
  const g = gatesModel(snap([
    t({ ref: "fx/01-a", title: "Alpha", gate: "merge", status: "in-review" }),
    t({ ref: "fx/02-b", gate: null }),
    t({ ref: "fx/03-c", title: "Gamma", gate: "dispatch" }),
  ]));
  assert.equal(g.visible, true);
  assert.equal(g.count, 2);
  assert.deepEqual(g.cards.map((c) => c.ref), ["fx/01-a", "fx/03-c"]);
  assert.equal(g.cards[0].title, "Alpha");
});

test("merge card: eyebrow, verb labels, request kinds", () => {
  const [c] = gatesModel(snap([t({ gate: "merge" })])).cards;
  assert.equal(c.eyebrow, "MERGE");
  assert.equal(c.approveLabel, "Approve merge");
  assert.equal(c.rejectLabel, "Reject");
  assert.equal(c.approveKind, "merge-approve");
  assert.equal(c.rejectKind, "merge-reject");
  assert.equal(c.pending, null);
});

test("dispatch card: eyebrow, verb labels, request kinds", () => {
  const [c] = gatesModel(snap([t({ gate: "dispatch" })])).cards;
  assert.equal(c.eyebrow, "DISPATCH");
  assert.equal(c.approveLabel, "Approve dispatch");
  assert.equal(c.approveKind, "dispatch-approve");
  assert.equal(c.rejectKind, "dispatch-reject");
});

test("a ticket with a pending approve request shows the approval-sent line", () => {
  const [c] = gatesModel(snap([t({ gate: "merge", request: REQ })])).cards;
  assert.deepEqual(c.pending, { verdict: "approve", text: "Approval sent, waiting for the orchestrator" });
});

test("a pending reject request shows the rejection-sent line", () => {
  const [c] = gatesModel(snap([t({ gate: "dispatch", request: { ...REQ, kind: "dispatch-reject" } })])).cards;
  assert.deepEqual(c.pending, { verdict: "reject", text: "Rejection sent, waiting for the orchestrator" });
});

test("a handled request clears its pending mark (ticket event with request null)", () => {
  const before = snap([t({ ref: "fx/01-a", gate: "merge", request: REQ })]);
  assert.notEqual(gatesModel(before).cards[0].pending, null);
  const handled = applyEvent(before, {
    seq: 2, type: "ticket", ref: "fx/01-a", ticket: t({ ref: "fx/01-a", gate: "merge", request: null }),
  });
  assert.equal(gatesModel(handled).cards[0].pending, null);
});

test("a handled merge whose ticket loses its gate drops the card and hides the section", () => {
  const before = snap([t({ ref: "fx/01-a", gate: "merge", request: REQ })]);
  const after = applyEvent(before, {
    seq: 2, type: "ticket", ref: "fx/01-a", ticket: t({ ref: "fx/01-a", status: "resolved", gate: null, request: null }),
  });
  const g = gatesModel(after);
  assert.equal(g.visible, false);
  assert.equal(g.count, 0);
});

test("gatesModel does not mutate the snapshot", () => {
  const s = snap([t({ gate: "merge", request: REQ })]);
  const copy = JSON.stringify(s);
  gatesModel(s);
  assert.equal(JSON.stringify(s), copy);
});

test("note counter appears from 450 characters of 500", () => {
  assert.equal(noteCounter(449).show, false);
  assert.equal(noteCounter(450).show, true);
  assert.equal(noteCounter(450).text, "450/500");
  assert.equal(noteCounter(500).text, "500/500");
});

// --- submitGate ---
const fakeFetch = (respond) => {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return respond(url, init); };
  fn.calls = calls;
  return fn;
};
const json = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("submitGate POSTs exactly one JSON request line body to /requests", async () => {
  const f = fakeFetch(() => json(201, { request: { id: "x" } }));
  const r = await submitGate({ fetch: f, ref: "fx/01-a", kind: "merge-approve", note: "ship it" });
  assert.deepEqual(r, { ok: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "/requests");
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { kind: "merge-approve", ref: "fx/01-a", note: "ship it" });
});

test("submitGate omits an empty or whitespace note", async () => {
  for (const note of [undefined, "", "   "]) {
    const f = fakeFetch(() => json(201));
    await submitGate({ fetch: f, ref: "fx/01-a", kind: "dispatch-reject", note });
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { kind: "dispatch-reject", ref: "fx/01-a" });
  }
});

test("409 reports 'already pending' and is not retryable", async () => {
  const f = fakeFetch(() => json(409, { error: "pending" }));
  const r = await submitGate({ fetch: f, ref: "fx/01-a", kind: "merge-approve" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.message, "Couldn't send: already pending (409)");
  assert.equal(r.retryable, false);
});

// organism-infra/139: the fetch handed to submitGate is the session's (it adds the Bearer token). A 401 or 403 means
// the session is gone or the gate refused it; pressing the button again cannot help, so it is not retryable.
test("401 reports the lost session in one line and is not retryable (organism-infra/139)", async () => {
  const f = fakeFetch(() => json(401, { error: "unauthorized" }));
  const r = await submitGate({ fetch: f, ref: "fx/01-a", kind: "merge-approve" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.message, /^Couldn't send: /);
  assert.match(r.message, /401/);
  assert.doesNotMatch(r.message, /[\r\n]/);
  assert.equal(r.retryable, false);
  assert.equal(f.calls.length, 1, "no automatic retry");
});

test("403 (the gate refused the Origin) is not retryable either", async () => {
  const r = await submitGate({ fetch: fakeFetch(() => json(403, { error: "foreign origin" })), ref: "fx/01-a", kind: "merge-approve" });
  assert.equal(r.status, 403);
  assert.match(r.message, /^Couldn't send: /);
  assert.equal(r.retryable, false);
});

test("submitGate never adds a credential itself: the caller's fetch carries the token, not the payload", async () => {
  const f = fakeFetch(() => json(201));
  await submitGate({ fetch: f, ref: "fx/01-a", kind: "merge-approve", note: "ok" });
  assert.deepEqual(Object.keys(JSON.parse(f.calls[0].init.body)).sort(), ["kind", "note", "ref"]);
  assert.equal(f.calls[0].url, "/requests", "no token in the url");
});

test("other 4xx errors are retryable and carry the status", async () => {
  const f = fakeFetch(() => json(404, { error: "no such ticket" }));
  const r = await submitGate({ fetch: f, ref: "fx/01-a", kind: "merge-approve" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.match(r.message, /^Couldn't send: /);
  assert.match(r.message, /404/);
  assert.equal(r.retryable, true);
});

test("a network failure is a retryable error, not a throw", async () => {
  const f = fakeFetch(() => { throw new TypeError("fetch failed"); });
  const r = await submitGate({ fetch: f, ref: "fx/01-a", kind: "merge-approve" });
  assert.equal(r.ok, false);
  assert.match(r.message, /^Couldn't send: /);
  assert.equal(r.retryable, true);
});
