// organism-infra/212: scripts/queue.mjs, the board's queue as buckets and as a text kanban.
//
// Seam pinned by qa: the CLI. `node scripts/queue.mjs [--json]` with ORGANISM_ROOT as the board root
// (run from an unrelated cwd, so the env var is what picks the board). Exit 0, even on a bare or odd board.
//   --json prints one object { inFlight, ready, waitingOnUser, blocked, proposed }, each an array of rows.
//   Row fields (pinned):
//     every row   ref ("feature/NN-slug"), title (heading text after "NN: ", at most 60 chars; longer
//                 ones are cut and end in "…"), priority (number: "P1" -> 1; a ticket with no Priority
//                 line counts as 2)
//     inFlight    cell (first token of the lock; null when there is no lock), mode (third token of the
//                 lock when it is specify/verify, else null). A ticket is in flight when it has a lock
//                 file or its status is claimed or in-review, so a qa-specify lock on a
//                 ready-for-agent ticket is in flight and not ready.
//     blocked     blockedBy: array of the unresolved blocker refs (full refs). Status `blocked` with no
//                 unresolved blocker listed gives [].
//     ready       rank: the 1-based position in the ready list. The ready list is in the Queue's order
//                 (queue/06: buildQueue from apps/organism-infra/frontier-queue.mjs: P0-with-reason tier,
//                 then the active feature, then the rest; inside a tier unblock count, then P, then number).
//                 Locked tickets are in flight, so they take no rank and do not count in it.
//     proposed    [{ ref, title, rank }]: the ready tickets in that same order, with the same ranks.
//                 Empty when nothing is ready.
//   usage.jsonl is read only for the active-feature row (kind "config", queue_active). A jev-order row
//   changes nothing, and junk lines are skipped.
//   Resolved, closed and parked tickets appear in no bucket.
//   Plain output prints four columns headed READY, IN FLIGHT, WAITING ON YOU, BLOCKED (in that order),
//   with proposed tickets marked ①②③… by rank.
//   package.json has an `queue` script that runs it (`npm run queue`).
//
// Criterion map: AC1 buckets          -> "AC1 ..."
//                queue/06 ready list in buildQueue order -> "Q6 ..."
//                AC3 titles           -> "AC3 ..."
//                AC5 npm run queue    -> "AC5 ..."
//                AC4 band             -> scripts/mods-queue.test.mjs
//                /queue slash command (.claude/commands/ file) -> human-verified (gated patch)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT } from "../apps/organism-infra/board-fixture.mjs";
import { boardRoot, ticket, usage } from "./queue-fixture.mjs";

const SCRIPT = path.join(REPO_ROOT, "scripts", "queue.mjs");
const run = (root, ...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ORGANISM_ROOT: root }, cwd: tmpdir(), encoding: "utf8", timeout: 20000 });
const readJson = (root) => {
  const r = run(root, "--json");
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const refs = (rows) => rows.map((r) => r.ref);

function mixedBoard() {
  const root = boardRoot();
  ticket(root, "alpha/301-done", { status: "resolved", title: "Already shipped" });
  ticket(root, "alpha/302-second", { priority: "P2", title: "Second priority work" });
  ticket(root, "alpha/303-urgent", { priority: "P1", title: "Urgent work" });
  ticket(root, "beta/301-urgent-too", { priority: "P1", title: "Urgent in beta" });
  ticket(root, "alpha/304-critical", { priority: "P0", title: "Critical work" });
  ticket(root, "alpha/305-specifying", { title: "Being specified", lock: "qa 2026-10-09T01:25:07.351Z specify ready-for-agent" });
  ticket(root, "alpha/306-building", { status: "claimed", title: "Being built", lock: "developer 2026-10-09T02:00:00.000Z" });
  ticket(root, "alpha/307-reviewing", { status: "in-review", title: "In review, no lock" });
  ticket(root, "alpha/308-needs-you", { status: "ready-for-human", title: "Needs the user" });
  ticket(root, "alpha/309-stuck", { status: "blocked", title: "Stuck for a reason" });
  ticket(root, "alpha/310-waits", { blockedBy: "302", title: "Waits on the second", priority: "P1" });
  ticket(root, "alpha/311-unblocked", { blockedBy: "301 (shipped)", title: "Free since 301 shipped" });
  ticket(root, "alpha/312-cross", { blockedBy: "beta/301, alpha/301", title: "Waits on beta", priority: "P1" });
  ticket(root, "alpha/313-parked", { status: "parked", title: "Parked" });
  ticket(root, "alpha/314-closed", { status: "closed", title: "Closed" });
  return root;
}

// mixedBoard, no active feature, no P0 reason: one tier. Unblock count first: 302 and beta/301 each hold one open
// ticket (310 and 312), so they lead; beta/301 is P1 against 302's P2. Then the unblock-0 tickets by P, then number.
const MIXED_QUEUE_ORDER = [
  "beta/301-urgent-too", // unblocks 312, P1
  "alpha/302-second", // unblocks 310, P2
  "alpha/304-critical", // unblocks nothing, P0
  "alpha/303-urgent", // P1
  "alpha/311-unblocked", // no Priority counts as P2
];

test("Q6 ready holds the frontier in the Queue's order: unblock count, then P, then number", () => {
  const q = readJson(mixedBoard());
  assert.deepEqual(refs(q.ready), MIXED_QUEUE_ORDER);
  assert.deepEqual(q.ready.map((r) => r.priority), [1, 2, 0, 1, 2]);
});

test("Q6 ready rows carry a 1-based rank, and proposed lists the same tickets in the same order", () => {
  const q = readJson(mixedBoard());
  assert.deepEqual(q.ready.map((r) => r.rank), [1, 2, 3, 4, 5]);
  assert.deepEqual(q.proposed.map((p) => [p.ref, p.rank]), MIXED_QUEUE_ORDER.map((ref, i) => [ref, i + 1]));
  assert.equal(q.proposed[0].title, "Urgent in beta");
});

test("Q6 a locked ticket is in flight, so it takes no rank and does not shift the others", () => {
  const q = readJson(mixedBoard());
  assert.ok(!refs(q.proposed).includes("alpha/305-specifying"));
  assert.ok(q.ready.every((r) => r.ref !== "alpha/305-specifying"));
  assert.equal(q.ready.length, 5);
});

test("Q6 the active feature comes before the rest, wherever its tickets sit on P and unblock count", () => {
  const root = mixedBoard();
  usage(root, [{ kind: "config", ts: "2026-10-12T00:00:00.000Z", queue_active: "alpha", by: "user" }]);
  const q = readJson(root);
  assert.deepEqual(refs(q.ready), [
    "alpha/302-second",
    "alpha/304-critical",
    "alpha/303-urgent",
    "alpha/311-unblocked",
    "beta/301-urgent-too", // outside the active feature: last
  ]);
  assert.deepEqual(q.proposed.map((p) => p.rank), [1, 2, 3, 4, 5]);
});

test("Q6 a P0 with a P0-reason leads even outside the active feature; a bare P0 does not", () => {
  const root = mixedBoard();
  ticket(root, "beta/302-outage", { priority: "P0", title: "Outage", headers: ["**P0-reason:** production is down"] });
  usage(root, [{ kind: "config", ts: "2026-10-12T00:00:00.000Z", queue_active: "alpha", by: "user" }]);
  const q = readJson(root);
  assert.equal(q.ready[0].ref, "beta/302-outage");
  assert.deepEqual(refs(q.ready).slice(1), [
    "alpha/302-second",
    "alpha/304-critical", // P0 without a reason is only an ordinary active-feature ticket
    "alpha/303-urgent",
    "alpha/311-unblocked",
    "beta/301-urgent-too",
  ]);
});

test("AC1 in flight holds locked and claimed or in-review tickets, with the holding cell and mode", () => {
  const q = readJson(mixedBoard());
  const byRef = Object.fromEntries(q.inFlight.map((r) => [r.ref, r]));
  assert.deepEqual(refs(q.inFlight).sort(), ["alpha/305-specifying", "alpha/306-building", "alpha/307-reviewing"]);
  assert.equal(byRef["alpha/305-specifying"].cell, "qa");
  assert.equal(byRef["alpha/305-specifying"].mode, "specify");
  assert.equal(byRef["alpha/306-building"].cell, "developer");
  assert.equal(byRef["alpha/306-building"].mode ?? null, null);
  assert.equal(byRef["alpha/307-reviewing"].cell ?? null, null, "no lock means no holding cell");
});

test("AC1 waiting on user holds ready-for-human tickets", () => {
  const q = readJson(mixedBoard());
  assert.deepEqual(refs(q.waitingOnUser), ["alpha/308-needs-you"]);
});

test("AC1 blocked holds status blocked, and ready-for-agent tickets with an unresolved blocker, naming it", () => {
  const q = readJson(mixedBoard());
  const byRef = Object.fromEntries(q.blocked.map((r) => [r.ref, r]));
  assert.deepEqual(refs(q.blocked).sort(), ["alpha/309-stuck", "alpha/310-waits", "alpha/312-cross"]);
  assert.deepEqual(byRef["alpha/310-waits"].blockedBy, ["alpha/302-second"]);
  assert.deepEqual(byRef["alpha/312-cross"].blockedBy, ["beta/301-urgent-too"], "the resolved blocker is not named");
  assert.deepEqual(byRef["alpha/309-stuck"].blockedBy, []);
});

test("AC1 resolved, closed and parked tickets are in no bucket", () => {
  const q = readJson(mixedBoard());
  const all = [...q.ready, ...q.inFlight, ...q.waitingOnUser, ...q.blocked].map((r) => r.ref);
  for (const gone of ["alpha/301-done", "alpha/313-parked", "alpha/314-closed"]) assert.ok(!all.includes(gone), gone);
  assert.equal(new Set(all).size, all.length, "a ticket sits in one bucket");
});

test("AC1 a board with no .scratch tickets prints empty buckets and exits 0", () => {
  const q = readJson(boardRoot());
  assert.deepEqual(q, { inFlight: [], ready: [], waitingOnUser: [], blocked: [], proposed: [] });
});

test("Q6 a jev-order row in usage.jsonl no longer changes the order, and junk lines are skipped", () => {
  const root = mixedBoard();
  usage(root, [
    { kind: "jev-order", ts: "2026-10-09T01:00:00.000Z", actual: ["alpha/311-unblocked", "alpha/303-urgent", "alpha/302-second"] },
    "this line is not json",
    { kind: "incident", ts: "2026-10-09T02:00:00.000Z", tool: "Bash" },
    "{ broken json",
  ]);
  const q = readJson(root);
  assert.deepEqual(refs(q.ready), MIXED_QUEUE_ORDER);
  assert.deepEqual(refs(q.proposed), MIXED_QUEUE_ORDER);
});

test("Q6 no usage.jsonl still gives the Queue's order, not a crash and not an unranked list", () => {
  const q = readJson(mixedBoard());
  assert.deepEqual(refs(q.proposed), MIXED_QUEUE_ORDER);
});

test("Q6 an active-feature row naming a feature with no ready ticket changes nothing", () => {
  const root = mixedBoard();
  usage(root, [{ kind: "config", ts: "2026-10-12T00:00:00.000Z", queue_active: "nowhere", by: "user" }]);
  assert.deepEqual(refs(readJson(root).ready), MIXED_QUEUE_ORDER);
});

test("AC3 titles come from the ticket heading, not the slug", () => {
  const root = boardRoot();
  ticket(root, "alpha/320-some-slug", { title: "A readable heading" });
  const q = readJson(root);
  assert.equal(q.ready[0].title, "A readable heading");
});

test("AC3 a long heading is truncated to 60 characters with an ellipsis; a short one is left alone", () => {
  const root = boardRoot();
  const long = "Word ".repeat(40).trim();
  ticket(root, "alpha/321-long", { title: long });
  ticket(root, "alpha/322-short", { title: "Short one" });
  const q = readJson(root);
  const byRef = Object.fromEntries(q.ready.map((r) => [r.ref, r]));
  assert.ok(byRef["alpha/321-long"].title.length <= 60, byRef["alpha/321-long"].title);
  assert.ok(byRef["alpha/321-long"].title.endsWith("…"));
  assert.ok(byRef["alpha/321-long"].title.startsWith("Word Word"));
  assert.equal(byRef["alpha/322-short"].title, "Short one");
});

test("AC5 plain output prints the four columns in order, with every bucket's tickets", () => {
  const out = run(mixedBoard());
  assert.equal(out.status, 0, out.stderr);
  const text = out.stdout;
  const at = ["READY", "IN FLIGHT", "WAITING ON YOU", "BLOCKED"].map((h) => text.indexOf(h));
  assert.ok(at.every((i) => i >= 0), `all four headings present in:\n${text}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, "headings in order READY, IN FLIGHT, WAITING ON YOU, BLOCKED");
  for (const needle of ["Critical work", "Being specified", "Being built", "Needs the user", "Stuck for a reason", "Waits on the second"]) {
    assert.ok(text.includes(needle), `${needle} is printed`);
  }
});

test("Q6 plain output lists READY in the Queue's order and marks each ticket with its rank", () => {
  const text = run(mixedBoard()).stdout;
  const readyBlock = text.slice(text.indexOf("READY"), text.indexOf("IN FLIGHT"));
  const titles = ["Urgent in beta", "Second priority work", "Critical work", "Urgent work", "Free since 301 shipped"];
  const at = titles.map((needle) => readyBlock.indexOf(needle));
  assert.ok(at.every((i) => i >= 0), `all five ready titles in:\n${readyBlock}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, "READY prints in the Queue's order");
  const line = (needle) => readyBlock.split("\n").find((l) => l.includes(needle)) ?? "";
  titles.forEach((needle, i) => assert.match(line(needle), new RegExp("①②③④⑤"[i])));
});

test("Q6 plain output marks only ready tickets with a rank", () => {
  const text = run(mixedBoard()).stdout;
  const after = text.slice(text.indexOf("IN FLIGHT"));
  assert.doesNotMatch(after, /[①②③④⑤⑥⑦⑧⑨⑩]/);
});

test("AC5 an empty board still prints the four headings", () => {
  const out = run(boardRoot());
  assert.equal(out.status, 0, out.stderr);
  for (const h of ["READY", "IN FLIGHT", "WAITING ON YOU", "BLOCKED"]) assert.ok(out.stdout.includes(h), h);
});

test("AC5 npm run queue is wired to scripts/queue.mjs", () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.match(pkg.scripts.queue ?? "", /scripts\/queue\.mjs/);
});

test("den-mvp/105 a user acts ticket at ready-for-agent waits on the user, is not ready, proposed or ranked", () => {
  const root = boardRoot();
  ticket(root, "alpha/401-user", { type: "user acts", title: "User does it" });
  ticket(root, "alpha/402-agent", { title: "Agent does it" });
  const q = readJson(root);
  assert.deepEqual(refs(q.waitingOnUser), ["alpha/401-user"]);
  assert.deepEqual(refs(q.ready), ["alpha/402-agent"]);
  assert.deepEqual(q.ready.map((r) => r.rank), [1]);
  assert.deepEqual(refs(q.proposed), ["alpha/402-agent"]);
});
