// dimsumden-ui-v0/09: queue and selected-ticket view-models (ADR 0011 decision 8: pure .mjs, tested under node --test).
// Interface pinned by these tests:
//   queueModel(snapshot) -> { frontier: Row[], inFlight: Row[], empty: boolean }
//   Row: { ref, title, priorityLabel, bumped, bumpLabel, cellType, status, blocked, blockedText, blockedReason }
//   detailModel(snapshot, ref|null) -> { kind: "none"|"missing-handoff"|"handoff", message?, ref?, title?, status?, holder?, handoff? }
import { test } from "node:test";
import assert from "node:assert/strict";
import { queueModel, detailModel } from "./queue-model.mjs";

const t = (over) => ({
  ref: "fx/00-x", feature: "fx", title: "T", type: "feature", status: "ready-for-agent", ready: true,
  priority: "P2", effectivePriority: "P2", bumps: 0, bumped: false, readySince: null,
  blockedBy: [], blockedReason: null, holder: null, lastRole: null, gate: null, request: null, handoff: null,
  ...over,
});

const snap = (tickets, frontier) => ({
  schema: 1, seq: 1, generatedAt: "2026-09-29T06:00:00.000Z", sessions: 9, tickets, frontier,
  usage: null, requests: [],
});

const fixture = snap(
  [
    // deliberately not in frontier order in the array (the array is sorted by ref)
    t({ ref: "fx/01-plain", title: "Plain P2", effectivePriority: "P2" }),
    t({ ref: "fx/02-top", title: "Top P0", priority: "P0", effectivePriority: "P0" }),
    t({ ref: "fx/03-bumped", title: "Bumped", priority: "P2", effectivePriority: "P1", bumps: 3, bumped: true }),
    t({ ref: "fx/04-claimed", title: "Being built", status: "claimed", ready: false, holder: { role: "developer", since: "2026-09-29T05:00:00.000Z" } }),
    t({
      ref: "fx/05-blocked", title: "Stuck", status: "blocked", ready: false, lastRole: "qa",
      blockedBy: [{ ref: "fx/06-dep", status: "ready-for-agent" }], blockedReason: "Waiting on the user for the API key",
    }),
    t({ ref: "fx/07-review", title: "In review", status: "in-review", ready: false, lastRole: "security" }),
  ],
  ["fx/02-top", "fx/03-bumped", "fx/01-plain"],
);

test("frontier rows render in frontier order, not array order", () => {
  const q = queueModel(fixture);
  assert.deepEqual(q.frontier.map((r) => r.ref), ["fx/02-top", "fx/03-bumped", "fx/01-plain"]);
  assert.equal(q.empty, false);
});

test("in-flight tickets follow the frontier, separately, sorted by ref", () => {
  const q = queueModel(fixture);
  assert.deepEqual(q.inFlight.map((r) => r.ref), ["fx/04-claimed", "fx/05-blocked", "fx/07-review"]);
  for (const r of q.inFlight) assert.ok(!q.frontier.some((f) => f.ref === r.ref));
});

test("rows show the effective priority", () => {
  const q = queueModel(fixture);
  assert.equal(q.frontier[0].priorityLabel, "P0");
  assert.equal(q.frontier[2].priorityLabel, "P2");
  assert.equal(q.frontier[0].bumped, false);
});

test("a bumped ticket shows P1 with an arrow and a text explanation, not colour alone", () => {
  const row = queueModel(fixture).frontier[1];
  assert.equal(row.priorityLabel, "P1 ↑");
  assert.equal(row.bumped, true);
  assert.equal(row.bumpLabel, "Bumped from P2 after 3 sessions");
});

test("an unbumped row has no bump label", () => {
  assert.equal(queueModel(fixture).frontier[0].bumpLabel ?? null, null);
});

test("row carries title, ref, status and the cell type (holder, else last cell)", () => {
  const q = queueModel(fixture);
  const claimed = q.inFlight.find((r) => r.ref === "fx/04-claimed");
  assert.equal(claimed.title, "Being built");
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.cellType, "developer");
  assert.equal(q.inFlight.find((r) => r.ref === "fx/05-blocked").cellType, "qa");
});

test("a blocked row names its blocker with status and shows the reason", () => {
  const row = queueModel(fixture).inFlight.find((r) => r.ref === "fx/05-blocked");
  assert.equal(row.blocked, true);
  assert.equal(row.blockedText, "Blocked by 06-dep (ready-for-agent)");
  assert.equal(row.blockedReason, "Waiting on the user for the API key");
});

test("an unblocked row is not marked blocked", () => {
  const row = queueModel(fixture).frontier[0];
  assert.equal(row.blocked, false);
  assert.equal(row.blockedText ?? null, null);
});

test("an empty board is reported empty", () => {
  const q = queueModel(snap([], []));
  assert.equal(q.empty, true);
  assert.deepEqual(q.frontier, []);
  assert.deepEqual(q.inFlight, []);
});

// ---- selecting a ticket shows its latest handoff

const withHandoff = snap(
  [
    t({
      ref: "fx/10-with", title: "Has handoff", status: "in-review", ready: false,
      holder: { role: "security", since: "2026-09-29T05:00:00.000Z" },
      handoff: { path: "fx/handoffs/10-security.md", mtime: "2026-09-29T05:40:00.000Z", truncated: false, text: "## State\nall good\n" },
    }),
    t({
      ref: "fx/11-cut", title: "Long handoff", status: "ready-for-human", ready: false,
      handoff: { path: "fx/handoffs/11-dev.md", mtime: "2026-09-29T05:41:00.000Z", truncated: true, text: "## Start\n" },
    }),
    t({ ref: "fx/12-none", title: "No handoff yet", handoff: null }),
  ],
  ["fx/12-none"],
);

test("selecting a ticket shows its latest handoff text, path and mtime", () => {
  const d = detailModel(withHandoff, "fx/10-with");
  assert.equal(d.kind, "handoff");
  assert.equal(d.ref, "fx/10-with");
  assert.equal(d.title, "Has handoff");
  assert.equal(d.status, "in-review");
  assert.equal(d.handoff.text, "## State\nall good\n");
  assert.equal(d.handoff.path, "fx/handoffs/10-security.md");
  assert.equal(d.handoff.mtime, "2026-09-29T05:40:00.000Z");
  assert.equal(d.handoff.truncated, false);
});

test("the detail names the holder when a cell holds the ticket", () => {
  assert.match(String(detailModel(withHandoff, "fx/10-with").holder), /security/);
});

test("a truncated handoff is flagged so the panel can point at the file", () => {
  assert.equal(detailModel(withHandoff, "fx/11-cut").handoff.truncated, true);
});

test("selecting a ticket with no handoff says so", () => {
  const d = detailModel(withHandoff, "fx/12-none");
  assert.equal(d.kind, "missing-handoff");
  assert.equal(d.message, "No handoff yet.");
  assert.equal(d.title, "No handoff yet");
});

test("no selection prompts the user to pick one", () => {
  const d = detailModel(withHandoff, null);
  assert.equal(d.kind, "none");
  assert.equal(d.message, "Select a ticket in the queue or the scene.");
});

test("a selected ref that left the snapshot (resolved) falls back to the no-selection prompt", () => {
  const d = detailModel(withHandoff, "fx/99-gone");
  assert.equal(d.kind, "none");
  assert.equal(d.message, "Select a ticket in the queue or the scene.");
});

test("the selection follows a fresh snapshot: the handoff text updates for the same ref", () => {
  const next = snap(
    [t({ ref: "fx/10-with", status: "in-review", ready: false, handoff: { path: "fx/handoffs/10-security.md", mtime: "2026-09-29T06:10:00.000Z", truncated: false, text: "newer" } })],
    [],
  );
  assert.equal(detailModel(next, "fx/10-with").handoff.text, "newer");
});

test("in-flight rows order by ticket number, so 99 comes before 100", () => {
  const s = snap(
    [
      t({ ref: "fx/100-b", status: "claimed", ready: false }),
      t({ ref: "fx/99-a", status: "claimed", ready: false }),
    ],
    [],
  );
  assert.deepEqual(queueModel(s).inFlight.map((r) => r.ref), ["fx/99-a", "fx/100-b"]);
});
