// queue/02: the order module `apps/board/frontier-queue.mjs` and `board queue`.
// Design: ADR 0015 Amendment 3 (A, C) and .scratch/queue/handoffs/01-architect.md (Q1).
//
// Seams under test (the public interface, nothing inside):
//   1. buildQueue(snapshot) -> { ordered, gated, expired, unplanned }   (pure, literal snapshots)
//   2. loadSnapshot(root)   -> snapshot, checked through buildQueue      (temp directory board)
//   3. `board queue`        -> stdout, read only                         (temp board CLI)
//
// Snapshot shape pinned by these tests (buildQueue reads only these fields):
//   { active: "<feature>" | null,                     // the queue_active config row; absent or null = no active feature
//     tickets: [{ ref: "<feature>/<NN-slug>", feature, num: <int>, status: "<status>",
//                 priority: <0..3>,                   // no Priority line means 2 (loadSnapshot's job)
//                 blockedBy: ["<feature>/<NN-slug>"], // full refs; loadSnapshot resolves the "Blocked by" text
//                 origin: "spec" | "added" | null,    // null = no Origin line = grandfathered as planned
//                 p0Reason: "<text>" | null }] }      // the **P0-reason:** line
// Optional snapshot fields (resolved rows, picks) may be absent; decay then counts no resolved tickets.
//
// Result shape pinned (ADR 0015 Amendment 3, C):
//   ordered: [{ ref, tier: "p0" | "active" | "rest", unblock, p, decayLeft, why }]
//   gated: [] until ticket 03; unplanned: { <feature>: { planned, added } }
// `why` is one line (no newline) naming the tier, the unblock count and the P line.
// Within a tier: unblock count (most first), then P (lowest first), then ticket number (lowest first).
//
// Criterion map (acceptance criteria of queue/02):
//   1 order by tier, unblock, P, number, literals ...... "orders by tier ..." and the three within-tier tests
//   2 no active row: P0 tier + one tier for the rest .... "with no active feature ..." tests
//   3 reason line and decay-left on every ticket ........ "every ordered ticket carries ..." and the CLI test
//   4 planned/added counts, empty parked-by-gate list ... "unplanned counts ..." and the CLI test
//   5 one CLI test against a temp board ................. "board queue prints ..."
//   6 writes nothing to the board or usage.jsonl ........ "board queue writes nothing ..."
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildQueue, loadSnapshot } from "./frontier-queue.mjs";
import { makeBoardFixture, runBoard } from "./board-fixture.mjs";

let n = 0;
function t(feature, num, extra = {}) {
  n += 1;
  return {
    ref: `${feature}/${String(num).padStart(2, "0")}-t${n}`,
    feature,
    num,
    status: "ready-for-agent",
    priority: 2,
    blockedBy: [],
    origin: null,
    p0Reason: null,
    ...extra,
  };
}
const refs = (q) => q.ordered.map((x) => x.ref);

test("orders by tier first: P0 with a reason, then the active feature, then the rest", async () => {
  const urgent = t("pipe", 9, { priority: 0, p0Reason: "main-red" });
  const inActive = t("den-v1", 7, { priority: 3 });
  const outside = t("other", 1, { priority: 1 });
  const q = await buildQueue({ active: "den-v1", tickets: [outside, inActive, urgent] });
  assert.deepEqual(refs(q), [urgent.ref, inActive.ref, outside.ref]);
  assert.deepEqual(q.ordered.map((x) => x.tier), ["p0", "active", "rest"]);
});

test("a P0 without a reason does not jump the active feature", async () => {
  const noReason = t("other", 1, { priority: 0, p0Reason: null });
  const inActive = t("den-v1", 5, { priority: 3 });
  const q = await buildQueue({ active: "den-v1", tickets: [noReason, inActive] });
  assert.deepEqual(refs(q), [inActive.ref, noReason.ref]);
  assert.notEqual(q.ordered.find((x) => x.ref === noReason.ref).tier, "p0");
});

test("within a tier: unblock count first, even over a better P", async () => {
  const blocker = t("den-v1", 3, { priority: 3 });
  const plain = t("den-v1", 1, { priority: 0 });
  const w1 = t("den-v1", 4, { blockedBy: [blocker.ref] });
  const w2 = t("den-v1", 5, { blockedBy: [blocker.ref] });
  const q = await buildQueue({ active: "den-v1", tickets: [plain, blocker, w1, w2] });
  // w1 and w2 are blocked by an unresolved ticket, so only blocker and plain are in the frontier.
  assert.deepEqual(refs(q), [blocker.ref, plain.ref]);
  assert.equal(q.ordered[0].unblock, 2);
  assert.equal(q.ordered[1].unblock, 0);
});

test("within a tier: equal unblock count falls to the P line, then to the lowest ticket number", async () => {
  const p3low = t("den-v1", 1, { priority: 3 });
  const p1high = t("den-v1", 8, { priority: 1 });
  const p1low = t("den-v1", 2, { priority: 1 });
  const q = await buildQueue({ active: "den-v1", tickets: [p3low, p1high, p1low] });
  assert.deepEqual(refs(q), [p1low.ref, p1high.ref, p3low.ref]);
});

test("the rest tier orders across features by the same rules (scope is not used)", async () => {
  const a = t("alpha", 4, { priority: 1 });
  const b = t("beta", 2, { priority: 1, scope: "large" });
  const c = t("gamma", 6, { priority: 2, scope: "small" });
  const q = await buildQueue({ active: "den-v1", tickets: [c, a, b] });
  assert.deepEqual(refs(q), [b.ref, a.ref, c.ref]);
});

test("the frontier holds only ready, unblocked tickets", async () => {
  const ok = t("den-v1", 1);
  const claimed = t("den-v1", 2, { status: "claimed" });
  const parked = t("den-v1", 3, { status: "parked" });
  const resolved = t("den-v1", 4, { status: "resolved" });
  const blockedOn = t("den-v1", 5, { status: "claimed" });
  const waits = t("den-v1", 6, { blockedBy: [blockedOn.ref] });
  const unblocked = t("den-v1", 7, { blockedBy: [resolved.ref] });
  const q = await buildQueue({ active: "den-v1", tickets: [ok, claimed, parked, resolved, blockedOn, waits, unblocked] });
  assert.deepEqual(refs(q).sort(), [ok.ref, unblocked.ref].sort());
});

test("with no active feature: the P0 tier and one tier for the rest", async () => {
  const urgent = t("pipe", 9, { priority: 0, p0Reason: "relay-down" });
  const a = t("den-v1", 7, { priority: 3 });
  const b = t("other", 1, { priority: 1 });
  const c = t("other", 3, { priority: 1 });
  for (const active of [null, undefined]) {
    const snap = { tickets: [c, a, b, urgent] };
    if (active !== undefined) snap.active = active;
    const q = await buildQueue(snap);
    assert.deepEqual(refs(q), [urgent.ref, b.ref, c.ref, a.ref]);
    assert.deepEqual([...new Set(q.ordered.map((x) => x.tier))].sort(), ["p0", "rest"]);
  }
});

test("every ordered ticket carries one reason line and a decay-left count", async () => {
  const urgent = t("pipe", 9, { priority: 0, p0Reason: "security-high" });
  const inActive = t("den-v1", 2, { priority: 1 });
  const unblocker = t("other", 1, { priority: 1 });
  const dependent = t("other", 2, { blockedBy: [unblocker.ref] });
  const q = await buildQueue({ active: "den-v1", tickets: [dependent, unblocker, inActive, urgent] });
  assert.equal(q.ordered.length, 3);
  for (const item of q.ordered) {
    assert.equal(typeof item.why, "string");
    assert.ok(item.why.length > 0, `${item.ref} has a reason`);
    assert.doesNotMatch(item.why, /\n/, `${item.ref} reason is one line`);
    assert.match(item.why, new RegExp(`P${item.p}\\b`), `${item.ref} reason names its P line`);
    assert.match(item.why, new RegExp(item.tier, "i"), `${item.ref} reason names its tier`);
    assert.match(item.why, /unblock/i, `${item.ref} reason names the unblock count`);
    assert.ok("decayLeft" in item, `${item.ref} has decayLeft`);
  }
  // Rest-tier tickets decay: with no tickets resolved yet, all 5 remain (ADR 0015 Amendment 3, decision 9).
  assert.equal(q.ordered.find((x) => x.ref === unblocker.ref).decayLeft, 5);
  assert.equal(q.ordered.find((x) => x.ref === unblocker.ref).unblock, 1);
  assert.equal(q.ordered.find((x) => x.ref === unblocker.ref).p, 1);
});

test("unplanned counts per feature: Origin spec and no Origin are planned, Origin added is added", async () => {
  const q = await buildQueue({
    active: "den-v1",
    tickets: [
      t("den-v1", 1, { origin: "spec" }),
      t("den-v1", 2, { origin: null }),
      t("den-v1", 3, { origin: "added", status: "resolved" }),
      t("den-v1", 4, { origin: "added" }),
      t("other", 1, { origin: "spec" }),
    ],
  });
  assert.deepEqual(q.unplanned["den-v1"], { planned: 2, added: 2 });
  assert.deepEqual(q.unplanned["other"], { planned: 1, added: 0 });
  assert.deepEqual(q.gated, []);
});

// --- loadSnapshot, through buildQueue, on a plain directory board ---------------------------------------

const ticketText = ({ title = "a ticket", status = "ready-for-agent", priority, blockedBy = "none", extra = [] }) =>
  [
    `# ${title}`,
    "",
    "**Type:** code",
    ...(priority === undefined ? [] : [`**Priority:** ${priority}`]),
    `**Blocked by:** ${blockedBy}`,
    `**Status:** ${status}`,
    ...extra,
    "",
    "- [ ] criterion",
    "",
    "## Comments",
    "",
  ].join("\n");

async function putTicket(root, feature, slug, opts) {
  const dir = path.join(root, ".scratch", feature, "issues");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${slug}.md`), ticketText(opts), "utf8");
}

test("loadSnapshot reads tickets, Priority default, Blocked by, Origin, P0-reason and the active row", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "queue-snap-"));
  try {
    await putTicket(root, "den-v1", "01-base", { priority: "P2" });
    await putTicket(root, "den-v1", "02-needs-one", { priority: "P1", blockedBy: "01" });
    await putTicket(root, "den-v1", "03-no-priority", {});
    await putTicket(root, "den-v1", "04-added", { priority: "P2", extra: ["**Origin:** added"] });
    await putTicket(root, "other", "01-urgent", { priority: "P0", extra: ["**P0-reason:** main-red"] });
    await putTicket(root, "other", "02-cross", { priority: "P1", blockedBy: "den-v1/01" });
    await putTicket(root, "other", "03-done", { status: "resolved", priority: "P0", extra: ["**P0-reason:** main-red"] });
    await writeFile(
      path.join(root, ".scratch", "usage.jsonl"),
      [
        JSON.stringify({ kind: "config", ts: "2026-10-01T00:00:00Z", queue_active: "other", by: "user" }),
        "not json at all",
        JSON.stringify({ kind: "incident", ts: "2026-10-02T00:00:00Z", tool: "x" }),
        JSON.stringify({ kind: "config", ts: "2026-10-12T00:00:00Z", queue_active: "den-v1", by: "user" }),
      ].join("\n") + "\n",
      "utf8"
    );
    const q = await buildQueue(await loadSnapshot(root));
    // P0 with a reason first; den-v1 is the active feature (last config row wins).
    // 01-base unblocks 02 and other/02: unblock 2. 03-no-priority is P2 by default, 04-added is P2: number order.
    assert.deepEqual(refs(q), [
      "other/01-urgent",
      "den-v1/01-base",
      "den-v1/03-no-priority",
      "den-v1/04-added",
    ]);
    const byRef = Object.fromEntries(q.ordered.map((x) => [x.ref, x]));
    assert.equal(byRef["den-v1/01-base"].unblock, 2);
    assert.equal(byRef["den-v1/03-no-priority"].p, 2);
    assert.equal(byRef["other/01-urgent"].tier, "p0");
    assert.ok(!("den-v1/02-needs-one" in byRef), "blocked ticket is not on the frontier");
    assert.ok(!("other/03-done" in byRef), "resolved ticket is not on the frontier");
    assert.deepEqual(q.unplanned["den-v1"], { planned: 3, added: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadSnapshot with no usage.jsonl and no active row gives the two-tier order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "queue-snap-"));
  try {
    await putTicket(root, "alpha", "02-b", { priority: "P1" });
    await putTicket(root, "beta", "01-a", { priority: "P1" });
    const q = await buildQueue(await loadSnapshot(root));
    assert.deepEqual(refs(q), ["beta/01-a", "alpha/02-b"]);
    assert.deepEqual([...new Set(q.ordered.map((x) => x.tier))], ["rest"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- the CLI, against a temp board ------------------------------------------------------------------------

const run = (fx, args) => runBoard(args, { cwd: fx.worktree, env: { DEN_ROOT: fx.root } });

async function seedCliBoard(fx) {
  await putTicket(fx.root, "den-v1", "01-a", { priority: "P2", extra: ["**Origin:** spec"] });
  await putTicket(fx.root, "den-v1", "02-b", { priority: "P1" });
  await putTicket(fx.root, "den-v1", "03-c", { priority: "P1", blockedBy: "02", extra: ["**Origin:** added"] });
  await putTicket(fx.root, "other", "01-x", { priority: "P0", extra: ["**P0-reason:** main-red"] });
  await putTicket(fx.root, "other", "02-y", { priority: "P1" });
  await putTicket(fx.root, "other", "03-z", { status: "claimed", priority: "P1" });
  await writeFile(
    path.join(fx.root, ".scratch", "usage.jsonl"),
    JSON.stringify({ kind: "config", ts: "2026-10-12T00:00:00Z", queue_active: "den-v1", by: "user", reason: "test" }) + "\n",
    "utf8"
  );
}

async function treeSnapshot(dir) {
  const out = {};
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out[path.relative(dir, p)] = await readFile(p, "utf8");
    }
  }
  await walk(dir);
  return out;
}

test("board queue prints the order, a reason and decay per ticket, planned/added counts, and an empty parked-by-gate list", async () => {
  const fx = await makeBoardFixture({ feature: "den-v1", ticket: "09-seed", status: "resolved" });
  try {
    await seedCliBoard(fx);
    const r = await run(fx, ["queue"]);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.split("\n");

    // Order: P0 first, then the active feature (02-b unblocks 03-c, so it leads 01-a), then the rest.
    const at = (ref) => lines.findIndex((l) => l.includes(ref));
    const order = ["other/01-x", "den-v1/02-b", "den-v1/01-a", "other/02-y"].map(at);
    assert.ok(order.every((i) => i >= 0), `all four refs printed:\n${r.stdout}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, `refs printed in queue order:\n${r.stdout}`);
    assert.equal(at("den-v1/03-c"), -1, "a ticket blocked by an unresolved ticket is not listed");
    assert.equal(at("other/03-z"), -1, "a claimed ticket is not listed");

    // One reason line and a decay count on every ticket line.
    for (const ref of ["other/01-x", "den-v1/02-b", "den-v1/01-a", "other/02-y"]) {
      const l = lines[at(ref)];
      assert.match(l, /decay/i, `${ref} line shows decay left: ${l}`);
      assert.match(l, /P[0-3]/, `${ref} line shows its P line: ${l}`);
      assert.match(l, /unblock/i, `${ref} line shows unblock count: ${l}`);
    }

    // Planned and added counts: den-v1 has 01-a (Origin spec), 02-b (no Origin), 09-seed (resolved, no Origin)
    // and 03-c (Origin added): 3 planned, 1 added. Resolved tickets count.
    const counts = lines.find((l) => /den-v1/.test(l) && /planned/i.test(l) && /added/i.test(l));
    assert.ok(counts, `a den-v1 planned/added line:\n${r.stdout}`);
    assert.match(counts, /planned\D{0,3}3|3\D{0,3}planned/i);
    assert.match(counts, /added\D{0,3}1|1\D{0,3}added/i);

    // The parked-by-gate list is printed and empty.
    const gateAt = lines.findIndex((l) => /parked.by.gate/i.test(l));
    assert.ok(gateAt >= 0, `a parked-by-gate section:\n${r.stdout}`);
    assert.doesNotMatch(lines.slice(gateAt + 1).join("\n"), /[\w-]+\/\d{2}-/, "no refs listed as parked by gate");
  } finally {
    await fx.cleanup();
  }
});

test("board queue writes nothing to the board or to usage.jsonl", async () => {
  const fx = await makeBoardFixture({ feature: "den-v1", ticket: "09-seed", status: "resolved" });
  try {
    await seedCliBoard(fx);
    const before = await treeSnapshot(fx.root + "/.scratch");
    const r = await run(fx, ["queue"]);
    assert.equal(r.code, 0, r.stderr);
    const after = await treeSnapshot(fx.root + "/.scratch");
    assert.deepEqual(after, before, "no file under .scratch changed, was added or removed");
    assert.ok("usage.jsonl" in after);
    assert.ok(!("events.jsonl" in after), "no event is written");
  } finally {
    await fx.cleanup();
  }
});
