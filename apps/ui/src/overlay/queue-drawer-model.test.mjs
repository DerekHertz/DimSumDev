// den-mvp/62 (spec .scratch/den-mvp/handoffs/62-designer-spec.md): the Queue drawer's view-model.
//
// Contract: queueDrawerModel(snapshot, nowMs) -> {
//   openCount, needs: [{ key, kind, text }], goalErrors: [string], openGoal: key | null,
//   goals: [{ key, name, why, counts: { open, ready, review, you, waiting }, next: [ref], tickets: [{ ref, short, title, type,
//     priority, state, depth, waitsOn: [short] }] }] }
//   - a ticket is `waiting` while a blocker is still open on the board, else `review` (in-review), `you`
//     (ready-for-human, needs-triage, needs-design) or `ready`;
//   - depth counts levels of open blockers that are themselves on the board, capped at 3;
//   - tickets in a goal are ordered by depth, then priority, then ref; `next` is up to two ready refs in that order;
//   - tickets with no goal or an unknown one go in a last "No goal" block; the first goal with a ready ticket opens first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { queueDrawerModel } from "./queue-drawer-model.mjs";

const t = (ref, over = {}) => ({ ref, title: `T ${ref}`, type: "feature", status: "ready-for-agent", priority: "P2", blockedBy: [], goal: "routing", ...over });
const GOALS = [
  { key: "routing", name: "Den on the routing project", why: "The showcase.", doneWhen: "54." },
  { key: "den", name: "Running everything from the den", why: "No terminal.", doneWhen: "All." },
];
const snapshot = (tickets, over = {}) => ({ tickets, goals: GOALS, goalErrors: [], frontier: [], requests: [], ...over });

test("tickets group under their goal, in goals.md order, with counts by state", () => {
  const m = queueDrawerModel(snapshot([
    t("den-mvp/57"),
    t("den-mvp/48", { status: "in-review" }),
    t("den-mvp/52", { blockedBy: [{ ref: "den-mvp/48", status: "in-review" }] }),
    t("den-mvp/62", { goal: "den", status: "ready-for-human" }),
  ]), 0);
  assert.deepEqual(m.goals.map((g) => g.key), ["routing", "den"]);
  assert.deepEqual(m.goals[0].counts, { open: 3, ready: 1, review: 1, you: 0, waiting: 1 });
  assert.deepEqual(m.goals[1].counts, { open: 1, ready: 0, review: 0, you: 1, waiting: 0 });
  assert.equal(m.openCount, 4);
});

test("active and missing blockers hold a ticket; depth follows the chain, capped at 3", () => {
  const m = queueDrawerModel(snapshot([
    t("f/01"),
    t("f/02", { blockedBy: [{ ref: "f/01", status: "ready-for-agent" }] }),
    t("f/03", { blockedBy: [{ ref: "f/02", status: "ready-for-agent" }] }),
    t("f/04", { blockedBy: [{ ref: "f/03", status: "ready-for-agent" }] }),
    t("f/05", { blockedBy: [{ ref: "f/04", status: "ready-for-agent" }] }),
    t("f/06", { blockedBy: [{ ref: "f/99", status: "unknown" }] }),
  ]), 0);
  const by = Object.fromEntries(m.goals[0].tickets.map((x) => [x.ref, x]));
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => by[`f/0${n}`].depth), [0, 1, 2, 3, 3]);
  assert.equal(by["f/02"].state, "waiting");
  assert.deepEqual(by["f/02"].waitsOn, ["01"]);
  assert.equal(by["f/06"].state, "waiting", "a missing dependency remains waiting as reported by the snapshot");
  assert.deepEqual(by["f/06"].waitsOn, ["99"]);
});

test('mixed historical input excludes closed, parked and resolved from counts, goals and next rows',()=>{
 const tickets=[
  t('f/01',{status:'closed'}),t('f/02',{status:'parked'}),t('f/03',{status:'resolved'}),
  t('f/04',{blockedBy:[{ref:'f/01'},{ref:'f/02'},{ref:'f/03'},{ref:'f/98',status:'closed'}]}),
  t('f/05',{status:'in-review'}),t('f/06',{blockedBy:[{ref:'f/05',status:'in-review'}]}),
 ];
 const m=queueDrawerModel(snapshot(tickets));
 assert.equal(m.openCount,3);
 assert.deepEqual(m.goals[0].counts,{open:3,ready:1,review:1,you:0,waiting:1});
 assert.deepEqual(m.goals[0].next,['f/04']);
 assert.deepEqual(m.goals[0].tickets.map(r=>r.ref).sort(),['f/04','f/05','f/06']);
 assert.deepEqual(m.goals[0].tickets.find(r=>r.ref==='f/04').waitsOn,[]);
});

test("tickets are ordered by depth, then priority, then ref; next names up to two ready refs", () => {
  const m = queueDrawerModel(snapshot([
    t("f/09", { priority: "P2" }),
    t("f/03", { priority: "P1" }),
    t("f/05", { priority: "P1" }),
    t("f/04", { blockedBy: [{ ref: "f/03", status: "ready-for-agent" }], priority: "P0" }),
  ]), 0);
  assert.deepEqual(m.goals[0].tickets.map((x) => x.ref), ["f/03", "f/05", "f/09", "f/04"]);
  assert.deepEqual(m.goals[0].next, ["f/03", "f/05"]);
});

test("the you state covers ready-for-human, needs-triage and needs-design", () => {
  const m = queueDrawerModel(snapshot(["ready-for-human", "needs-triage", "needs-design"].map((status, i) => t(`f/0${i + 1}`, { status }))), 0);
  assert.deepEqual(m.goals[0].tickets.map((x) => x.state), ["you", "you", "you"]);
});

test("tickets with no goal or an unknown one land in a last No goal block", () => {
  const m = queueDrawerModel(snapshot([t("f/01"), t("f/02", { goal: null }), t("f/03", { goal: "nope" })]), 0);
  const last = m.goals.at(-1);
  assert.equal(last.key, null);
  assert.equal(last.name, "No goal");
  assert.deepEqual(last.tickets.map((x) => x.ref), ["f/02", "f/03"]);
});

test("a goal with no open tickets is left out, and the first goal with a ready ticket opens first", () => {
  const m = queueDrawerModel(snapshot([t("f/01", { status: "in-review" }), t("f/02", { goal: "den" })]), 0);
  assert.deepEqual(m.goals.map((g) => g.key), ["routing", "den"]);
  assert.equal(m.openGoal, "den");
  assert.equal(queueDrawerModel(snapshot([]), 0).openGoal, null);
  assert.deepEqual(queueDrawerModel(snapshot([]), 0).goals, []);
});

test("needs lists what waits on the user, and goal errors pass through", () => {
  const m = queueDrawerModel(snapshot([t("f/01", { status: "ready-for-human" })], { goalErrors: ["goals.md line 9: bad"] }), 0);
  assert.ok(m.needs.length >= 1);
  for (const n of m.needs) assert.ok(n.key && n.kind && n.text, JSON.stringify(n));
  assert.deepEqual(m.goalErrors, ["goals.md line 9: bad"]);
});

test("a snapshot from a bridge without goals still renders every ticket", () => {
  const m = queueDrawerModel({ tickets: [t("f/01", { goal: undefined })], frontier: [], requests: [] }, 0);
  assert.equal(m.goals.length, 1);
  assert.equal(m.goals[0].name, "No goal");
  assert.deepEqual(m.goalErrors, []);
});

test("den-mvp/106: a guardrail pause shows Waiting on your merge with the PR, and the ticket is not blocked", async () => {
  const { queueDrawerModel } = await import("./queue-drawer-model.mjs");
  const snap = {
    tickets: [{ ref: "fx/01-a", title: "1: A", status: "in-review", goal: "g", blockedBy: [] }, { ref: "fx/02-b", title: "2: B", status: "in-review", goal: "g", blockedBy: [{ ref: "fx/01-a", status: "in-review" }] }],
    goals: [{ key: "g", name: "G", why: "w" }],
    deliveries: [{ ref: "fx/01-a", state: "paused", pause: { kind: "guardrail" }, pr: { number: 357, url: "https://github.com/o/r/pull/357" } }, { ref: "fx/02-b", state: "paused", pause: { kind: "guardrail" }, pr: { number: 9, url: "javascript:x" } }],
  };
  const rows = queueDrawerModel(snap, 0).goals[0].tickets;
  const [a, b] = ["fx/01-a", "fx/02-b"].map((r) => rows.find((t) => t.ref === r));
  assert.deepEqual(a.mergeWait, { number: 357, url: "https://github.com/o/r/pull/357" });
  assert.notEqual(a.state, "waiting");
  assert.equal(b.mergeWait, null, "blocked by an open ticket: it waits on that one");
});
