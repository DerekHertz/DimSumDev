// queue/05: decay, `board pick` and the unplanned cap.
// Design: ADR 0015 Amendment 3 (C, Consequences), .scratch/queue/spec.md decisions 8, 9, 10,
// .scratch/queue/handoffs/01-architect.md (Q4).
//
// Seams under test (the public interface, nothing inside):
//   1. buildQueue(snapshot)              -> { ordered, gated, expired, unplanned }   pure, literal snapshots
//   2. checkAdmission / gateRefusals     -> { ok, reasons[] } / [{ ref, reasons[] }] pure, literal snapshots
//   3. `board pick`, `board queue`, `board gate [--apply]` -> stdout, usage.jsonl, ticket files   temp board CLI
//
// Shapes pinned by these tests (extending queue/02 and queue/03):
//   snapshot.resolved: [{ ts }]            one per kind:"resolved" row of usage.jsonl
//   snapshot.picks:    [{ ts, picked }]    one per kind:"queue-pick" row
//   ticket.readySince: "<ts>"              set by loadSnapshot for a ready ticket
//   queue.expired:     [ref]               ready tickets whose decay count is used up (decayLeft 0), a plain string array
//   usage row written by `board pick`:     {"kind":"queue-pick","ts","top","picked","deviation"}
//     top = the Queue's top ticket when the pick was made; picked = the full ref picked; deviation only with --deviation
//   decay reason: a park by decay carries a reason that names decay (/decay/i), in the ticket comment and the park event.
//
// Interpretation pinned (ADR 0015 Amendment 3 A, spec decision 10): the unplanned cap applies to a feature with at
// least 3 planned tickets, and refuses an Origin-added ticket once the added tickets already filed pass a third of the
// planned ones. Tests use counts that are clear under any reading of the boundary (a count of exactly planned/3 is
// not pinned either way). Every ticket of the feature counts, whatever its status, as in queue.unplanned. A security
// finding (Serves finding:<ref>) is never refused by the cap but is counted by it.
//
// Criterion map (acceptance criteria of queue/05):
//   1 decay-left falls as other tickets resolve and resets on a pick, tested with literal rows
//        .... "decay left falls ...", "a pick resets ...", "a pick of another ticket ...", "an active-feature ticket never decays",
//             "board queue shows decay falling and a board pick resetting it"
//   2 `board pick <ref>` writes one queue-pick row; --deviation records the reason
//        .... "board pick writes one queue-pick row ...", "board pick --deviation records ...", "board pick refuses an unknown ticket ..."
//   3 `board gate` lists expired tickets in its dry run and parks them only with --apply
//        .... "buildQueue expired ...", "board gate dry run lists expired ...", "board gate --apply parks expired ..."
//   4 over the unplanned cap is refused with a reason; a security finding over the cap is counted and admitted
//        .... "the unplanned cap ..." tests, "board gate lists a ticket over the unplanned cap ..."
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as frontierQueue from "./frontier-queue.mjs";
// Called through the namespace so a missing export fails each test, not the whole file at link time.
const buildQueue = (...a) => frontierQueue.buildQueue(...a);
const checkAdmission = (...a) => frontierQueue.checkAdmission(...a);
const gateRefusals = (...a) => frontierQueue.gateRefusals(...a);
import { getStatus } from "./board-service.mjs";
import { makeBoardFixture, runBoard } from "./board-fixture.mjs";

// --- 1. buildQueue, decay and expiry, literal rows ------------------------------------------------------------

let n = 0;
function tk(feature, num, extra = {}) {
  n += 1;
  return {
    ref: `${feature}/${String(num).padStart(2, "0")}-d${n}`,
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
const resolvedAt = (...days) => days.map((d) => ({ ts: `2026-10-${String(d).padStart(2, "0")}T12:00:00Z` }));
const READY = "2026-10-01T00:00:00Z";
const item = (q, ref) => q.ordered.find((x) => x.ref === ref);

test("decay left falls as other tickets resolve, counting only resolved rows after the ticket was ready", () => {
  const outside = tk("other", 1, { readySince: READY });
  const none = buildQueue({ active: "den-v1", tickets: [outside], resolved: [] });
  assert.equal(item(none, outside.ref).decayLeft, 5);
  // one row before readySince does not count; the three after it do
  const some = buildQueue({
    active: "den-v1",
    tickets: [outside],
    resolved: [{ ts: "2026-09-30T12:00:00Z" }, ...resolvedAt(2, 3, 4)],
  });
  assert.equal(item(some, outside.ref).decayLeft, 2);
  assert.match(item(some, outside.ref).why, /decay\D{0,12}2\b/i, "the reason line carries the count");
  const four = buildQueue({ active: "den-v1", tickets: [outside], resolved: resolvedAt(2, 3, 4, 5) });
  assert.equal(item(four, outside.ref).decayLeft, 1);
});

test("a pick resets the ticket's decay: only resolved rows after the pick count", () => {
  const outside = tk("other", 1, { readySince: READY });
  const q = buildQueue({
    active: "den-v1",
    tickets: [outside],
    resolved: resolvedAt(2, 3, 5), // two before the pick, one after
    picks: [{ ts: "2026-10-04T00:00:00Z", picked: outside.ref }],
  });
  assert.equal(item(q, outside.ref).decayLeft, 4);
  const justPicked = buildQueue({
    active: "den-v1",
    tickets: [outside],
    resolved: resolvedAt(2, 3, 4),
    picks: [{ ts: "2026-10-09T00:00:00Z", picked: outside.ref }],
  });
  assert.equal(item(justPicked, outside.ref).decayLeft, 5);
});

test("a pick of another ticket does not reset this one", () => {
  const a = tk("other", 1, { readySince: READY });
  const b = tk("other", 2, { readySince: READY });
  const q = buildQueue({
    active: "den-v1",
    tickets: [a, b],
    resolved: resolvedAt(2, 3),
    picks: [{ ts: "2026-10-09T00:00:00Z", picked: b.ref }],
  });
  assert.equal(item(q, a.ref).decayLeft, 3);
  assert.equal(item(q, b.ref).decayLeft, 5);
});

test("an active-feature ticket never decays, however many tickets resolve", () => {
  const inActive = tk("den-v1", 1, { readySince: READY });
  const q = buildQueue({ active: "den-v1", tickets: [inActive], resolved: resolvedAt(2, 3, 4, 5, 6, 7, 8, 9) });
  assert.ok(item(q, inActive.ref), "still on the Queue");
  assert.notEqual(item(q, inActive.ref).decayLeft, 0);
  assert.deepEqual(q.expired, []);
});

test("buildQueue expired lists a ticket outside the active feature once 5 tickets resolved without a pick", () => {
  const stale = tk("other", 1, { readySince: READY });
  const fresh = tk("other", 2, { readySince: "2026-10-06T00:00:00Z" });
  const picked = tk("other", 3, { readySince: READY });
  const active = tk("den-v1", 4, { readySince: READY });
  const snapshot = {
    active: "den-v1",
    tickets: [stale, fresh, picked, active],
    resolved: resolvedAt(2, 3, 4, 5, 6, 7),
    // picked after the last resolved row (day 7, 12:00), so nothing counts since the pick
    picks: [{ ts: "2026-10-08T00:00:00Z", picked: picked.ref }],
  };
  const q = buildQueue(snapshot);
  // stale: 6 resolved since ready. fresh: ready on day 6, so only days 6 and 7 count -> 2 used, 3 left.
  assert.deepEqual(q.expired, [stale.ref]);
  assert.equal(item(q, stale.ref).decayLeft, 0, "decay left never goes below 0");
  assert.equal(item(q, picked.ref).decayLeft, 5);
  assert.ok(item(q, fresh.ref).decayLeft > 0);
});

test("buildQueue expired is empty while every ticket has decay left, and at exactly 4 resolved", () => {
  const outside = tk("other", 1, { readySince: READY });
  assert.deepEqual(buildQueue({ active: "den-v1", tickets: [outside], resolved: resolvedAt(2, 3, 4, 5) }).expired, []);
  assert.deepEqual(buildQueue({ active: "den-v1", tickets: [outside], resolved: resolvedAt(2, 3, 4, 5, 6) }).expired, [outside.ref]);
});

// --- 2. the unplanned cap, literal snapshots ------------------------------------------------------------------

const SPEC_SERVES = 'spec:den-v1 "Step 3"';
function capSnap(tickets, extra = {}) {
  return { active: "den-v1", tickets, specs: { "den-v1": ["Overview", "Step 3: Feed the agent"] }, incidents: [], ...extra };
}
const base = (num, extra = {}) =>
  tk("den-v1", num, { status: "resolved", class: "product", serves: SPEC_SERVES, ...extra });
function plannedTickets(count) {
  return Array.from({ length: count }, (_, i) => base(i + 1, { origin: i % 2 ? "spec" : null }));
}
function addedTickets(count, firstNum = 30) {
  return Array.from({ length: count }, (_, i) => base(firstNum + i, { origin: "added" }));
}
const candidate = (extra = {}) =>
  tk("den-v1", 90, { origin: "added", class: "product", serves: SPEC_SERVES, ...extra });

test("the unplanned cap refuses an added ticket once the added tickets pass a third of the planned ones, with a reason", () => {
  const c = candidate();
  const r = checkAdmission(c, capSnap([...plannedTickets(6), ...addedTickets(4), c]));
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(r.reasons.length >= 1);
  assert.ok(r.reasons.some((x) => /unplanned|cap/i.test(x)), `a reason names the cap: ${JSON.stringify(r.reasons)}`);
  for (const reason of r.reasons) assert.doesNotMatch(reason, /\n/, "a reason is one line");
});

test("the unplanned cap admits an added ticket while the added tickets are under a third of the planned ones", () => {
  const c = candidate();
  const r = checkAdmission(c, capSnap([...plannedTickets(6), ...addedTickets(1), c]));
  assert.deepEqual(r, { ok: true, reasons: [] });
});

test("the unplanned cap does not apply to a feature with fewer than 3 planned tickets", () => {
  const c = candidate();
  const r = checkAdmission(c, capSnap([...plannedTickets(2), ...addedTickets(5), c]));
  assert.deepEqual(r, { ok: true, reasons: [] });
});

test("the unplanned cap never refuses a planned ticket (Origin spec, or no Origin line)", () => {
  for (const origin of ["spec", null]) {
    const c = candidate({ origin });
    const r = checkAdmission(c, capSnap([...plannedTickets(6), ...addedTickets(6), c]));
    assert.deepEqual(r, { ok: true, reasons: [] }, `origin ${origin}`);
  }
});

test("the unplanned cap counts only the ticket's own feature", () => {
  const c = candidate();
  const elsewhere = Array.from({ length: 6 }, (_, i) => tk("other", 40 + i, { status: "resolved", origin: "added" }));
  const r = checkAdmission(c, capSnap([...plannedTickets(6), ...elsewhere, c]));
  assert.deepEqual(r, { ok: true, reasons: [] });
});

test("a security finding over the cap is admitted and is counted", () => {
  const found = base(5, { origin: "spec" }); // the ticket the finding names
  const planned = [...plannedTickets(6)];
  const finding = (num) => tk("den-v1", num, { origin: "added", class: "product", serves: `finding:${found.ref}` });
  const f = finding(90);
  // over the cap by a wide margin, yet the finding is admitted
  const over = checkAdmission(f, capSnap([...planned, found, ...addedTickets(4), f]));
  assert.deepEqual(over, { ok: true, reasons: [] });

  // counted: one ordinary added ticket and three findings put a following ordinary ticket over the cap,
  // where one ordinary added ticket alone does not
  const earlierFindings = [31, 32, 33].map((num) => ({ ...finding(num), status: "resolved" }));
  const earlierOrdinary = base(30, { origin: "added" });
  const next = candidate();
  const withFindings = checkAdmission(next, capSnap([...planned, found, earlierOrdinary, ...earlierFindings, next]));
  assert.equal(withFindings.ok, false, JSON.stringify(withFindings));
  assert.ok(withFindings.reasons.some((x) => /unplanned|cap/i.test(x)), JSON.stringify(withFindings.reasons));
  const withoutFindings = checkAdmission(next, capSnap([...planned, found, earlierOrdinary, next]));
  assert.deepEqual(withoutFindings, { ok: true, reasons: [] });

  const q = buildQueue(capSnap([...planned, found, earlierOrdinary, ...earlierFindings, next]));
  assert.equal(q.unplanned["den-v1"].added, 5, "findings are counted among the added tickets");
});

test("gateRefusals lists a ticket over the unplanned cap and not a security finding over it", () => {
  const found = base(5, { origin: "spec" });
  const over = candidate({ num: 90 });
  const finding = tk("den-v1", 91, { origin: "added", class: "product", serves: `finding:${found.ref}` });
  const refused = gateRefusals(capSnap([...plannedTickets(6), found, ...addedTickets(4), over, finding]));
  assert.deepEqual(refused.map((r) => r.ref), [over.ref]);
  assert.ok(refused[0].reasons.some((x) => /unplanned|cap/i.test(x)));
});

// --- 3. the CLI against a temp board ---------------------------------------------------------------------------

const run = (fx, args) => runBoard(args, { cwd: fx.worktree, env: { DEN_ROOT: fx.root } });
const SEED = { feature: "den-v1", ticket: "09-seed", status: "resolved" };
const scratch = (fx, ...p) => path.join(fx.root, ".scratch", ...p);

const ticketText = ({ status = "ready-for-agent", priority = "P2", header = [] }) =>
  [
    "# a ticket",
    "",
    "**Type:** code",
    `**Priority:** ${priority}`,
    "**Blocked by:** none",
    `**Status:** ${status}`,
    ...header,
    "",
    "## What to build",
    "",
    "- [ ] criterion",
    "",
    "## Comments",
    "",
  ].join("\n");

async function putTicket(fx, feature, slug, opts = {}) {
  const dir = scratch(fx, feature, "issues");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${slug}.md`), ticketText(opts), "utf8");
}
async function putSpec(fx, feature, lines) {
  await mkdir(scratch(fx, feature), { recursive: true });
  await writeFile(scratch(fx, feature, "spec.md"), lines.join("\n") + "\n", "utf8");
}
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
async function putUsage(fx, rows) {
  await writeFile(scratch(fx, "usage.jsonl"), jsonl(rows), "utf8");
}
async function appendEvents(fx, rows) {
  const file = scratch(fx, "events.jsonl");
  const before = await readFile(file, "utf8").catch(() => "");
  await writeFile(file, before + jsonl(rows), "utf8");
}
async function readRows(file) {
  const raw = await readFile(file, "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const activeRow = (feature) => ({ kind: "config", ts: "2020-01-01T00:00:00Z", queue_active: feature, by: "user" });
const resolvedRow = (day) => ({ kind: "resolved", ts: `2020-01-${String(day).padStart(2, "0")}T12:00:00Z`, ticket: "x/01-y", pr: 1, bounces: 0 });
const readyEvent = (feature, ticket, ts) => ({ ts, feature, ticket, op: "create", from_status: null, to_status: "ready-for-agent" });
const GOOD = ["**Class:** product", "**Serves:** finding:den-v1/09-seed"]; // passes the admission gate on its own

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
const decayOf = (stdout, ref) => {
  const line = stdout.split("\n").find((l) => l.includes(ref));
  assert.ok(line, `${ref} is on the Queue:\n${stdout}`);
  const m = /decay\D{0,12}(\d+)/i.exec(line);
  assert.ok(m, `${ref} line shows a decay count: ${line}`);
  return Number(m[1]);
};

// A small Queue: den-v1 is active, two tickets outside it, both ready since the start of 2020, three tickets resolved since.
async function seedPickBoard(fx) {
  await putTicket(fx, "den-v1", "01-active", { priority: "P2" });
  await putTicket(fx, "other", "01-old", { priority: "P2" });
  await putTicket(fx, "other", "02-also-old", { priority: "P2" });
  await putUsage(fx, [activeRow("den-v1"), resolvedRow(2), resolvedRow(3), resolvedRow(4)]);
  await appendEvents(fx, [
    readyEvent("den-v1", "01-active", "2020-01-01T00:00:00Z"),
    readyEvent("other", "01-old", "2020-01-01T00:00:00Z"),
    readyEvent("other", "02-also-old", "2020-01-01T00:00:00Z"),
  ]);
}

test("board pick writes one queue-pick row naming the ticket picked and the Queue's top ticket", async () => {
  const fx = await makeBoardFixture(SEED);
  try {
    await seedPickBoard(fx);
    const before = await readRows(scratch(fx, "usage.jsonl"));
    const r = await run(fx, ["pick", "den-v1/01-active"]);
    assert.equal(r.code, 0, r.stderr);
    const after = await readRows(scratch(fx, "usage.jsonl"));
    assert.equal(after.length, before.length + 1, "exactly one row appended");
    assert.deepEqual(after.slice(0, before.length), before, "earlier rows untouched");
    const row = after.at(-1);
    assert.equal(row.kind, "queue-pick");
    assert.equal(row.picked, "den-v1/01-active");
    assert.equal(row.top, "den-v1/01-active", "the top of the Queue when the pick was made (the active feature leads)");
    assert.ok(!Number.isNaN(Date.parse(row.ts)), `ts is a timestamp: ${row.ts}`);
    assert.ok(!row.deviation, "no deviation without --deviation");
    assert.equal(await getStatus(fx.root, "den-v1/01-active"), "ready-for-agent", "a pick does not change the ticket");
  } finally {
    await fx.cleanup();
  }
});

test("board pick --deviation records the reason in the row", async () => {
  const fx = await makeBoardFixture(SEED);
  try {
    await seedPickBoard(fx);
    const r = await run(fx, ["pick", "other/01-old", "--deviation", "it unblocks the relay"]);
    assert.equal(r.code, 0, r.stderr);
    const rows = (await readRows(scratch(fx, "usage.jsonl"))).filter((x) => x.kind === "queue-pick");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].picked, "other/01-old");
    assert.equal(rows[0].top, "den-v1/01-active", "top is the Queue's top, not the ticket picked");
    assert.equal(rows[0].deviation, "it unblocks the relay");
  } finally {
    await fx.cleanup();
  }
});

test("board pick refuses an unknown ticket and writes nothing", async () => {
  const fx = await makeBoardFixture(SEED);
  try {
    await seedPickBoard(fx);
    const before = await treeSnapshot(scratch(fx));
    const r = await run(fx, ["pick", "other/77-nope"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /77-nope|not found/i, "the error names the missing ticket, not the command");
    assert.deepEqual(await treeSnapshot(scratch(fx)), before);
  } finally {
    await fx.cleanup();
  }
});

test("board queue shows decay falling as tickets resolve, and a board pick resetting only the picked ticket", async () => {
  const fx = await makeBoardFixture(SEED);
  try {
    await seedPickBoard(fx);
    const first = await run(fx, ["queue"]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(decayOf(first.stdout, "other/01-old"), 2, "3 resolved since ready leaves 2");
    assert.equal(decayOf(first.stdout, "other/02-also-old"), 2);

    // one more ticket resolves
    const rows = await readRows(scratch(fx, "usage.jsonl"));
    await putUsage(fx, [...rows, resolvedRow(5)]);
    const fell = await run(fx, ["queue"]);
    assert.equal(decayOf(fell.stdout, "other/01-old"), 1);

    const pick = await run(fx, ["pick", "other/01-old"]);
    assert.equal(pick.code, 0, pick.stderr);
    const reset = await run(fx, ["queue"]);
    assert.equal(decayOf(reset.stdout, "other/01-old"), 5, "the pick resets the count");
    assert.equal(decayOf(reset.stdout, "other/02-also-old"), 1, "the other ticket keeps counting down");
  } finally {
    await fx.cleanup();
  }
});

// Gate board: five tickets resolved since the start of 2020. Ready tickets, all passing the admission gate:
//   other/01-stale   ready since 2020-01-01, never picked        -> expired
//   other/02-fresh   ready since 2020-01-10 (after the resolves) -> not expired
//   other/03-picked  ready since 2020-01-01, picked 2020-01-08   -> not expired
//   den-v1/01-active in the active feature                       -> never expires
async function seedDecayBoard(fx) {
  await putTicket(fx, "other", "01-stale", { header: GOOD });
  await putTicket(fx, "other", "02-fresh", { header: GOOD });
  await putTicket(fx, "other", "03-picked", { header: GOOD });
  await putTicket(fx, "den-v1", "01-active", { header: GOOD });
  await putUsage(fx, [
    activeRow("den-v1"),
    ...[2, 3, 4, 5, 6].map(resolvedRow),
    { kind: "queue-pick", ts: "2020-01-08T00:00:00Z", top: "den-v1/01-active", picked: "other/03-picked" },
  ]);
  await appendEvents(fx, [
    readyEvent("other", "01-stale", "2020-01-01T00:00:00Z"),
    readyEvent("other", "02-fresh", "2020-01-10T00:00:00Z"),
    readyEvent("other", "03-picked", "2020-01-01T00:00:00Z"),
    readyEvent("den-v1", "01-active", "2020-01-01T00:00:00Z"),
  ]);
}

test("board gate dry run lists the expired ticket with a decay reason and writes nothing", async () => {
  const fx = await makeBoardFixture(SEED);
  try {
    await seedDecayBoard(fx);
    const before = await treeSnapshot(scratch(fx));
    const r = await run(fx, ["gate"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(await treeSnapshot(scratch(fx)), before, "no file under .scratch changed, was added or removed");
    const lines = r.stdout.split("\n");
    const stale = lines.find((l) => l.includes("other/01-stale"));
    assert.ok(stale, `the expired ticket is listed:\n${r.stdout}`);
    assert.match(stale, /decay/i, "its reason names decay");
    assert.doesNotMatch(r.stdout, /Nothing to park/);
    for (const ref of ["other/02-fresh", "other/03-picked", "den-v1/01-active"]) {
      assert.equal(lines.find((l) => l.includes(ref)), undefined, `${ref} is not listed:\n${r.stdout}`);
    }
  } finally {
    await fx.cleanup();
  }
});

test("board gate --apply parks the expired ticket with a decay reason, and only that one", async () => {
  const fx = await makeBoardFixture(SEED);
  try {
    await seedDecayBoard(fx);
    const r = await run(fx, ["gate", "--apply"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await getStatus(fx.root, "other/01-stale"), "parked");
    for (const ref of ["other/02-fresh", "other/03-picked", "den-v1/01-active"]) {
      assert.equal(await getStatus(fx.root, ref), "ready-for-agent", `${ref} stays ready`);
    }
    const ticket = await readFile(scratch(fx, "other", "issues", "01-stale.md"), "utf8");
    assert.match(ticket, /parked[\s\S]*decay/i, "the reason is on the ticket");
    const parks = (await readRows(scratch(fx, "events.jsonl"))).filter((e) => e.op === "park");
    assert.deepEqual(parks.map((e) => `${e.feature}/${e.ticket}`), ["other/01-stale"]);
    assert.match(parks[0].reason, /decay/i);

    // a second run finds nothing more and writes nothing
    const before = await treeSnapshot(scratch(fx));
    const again = await run(fx, ["gate", "--apply"]);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(await treeSnapshot(scratch(fx)), before);
  } finally {
    await fx.cleanup();
  }
});

test("an unparked ticket restarts its decay count", async () => {
  const fx = await makeBoardFixture(SEED);
  try {
    await seedDecayBoard(fx);
    assert.equal((await run(fx, ["gate", "--apply"])).code, 0);
    const un = await run(fx, ["unpark", "other/01-stale", "--reason", "wanted after all"]);
    assert.equal(un.code, 0, un.stderr);
    const q = await run(fx, ["queue"]);
    assert.equal(decayOf(q.stdout, "other/01-stale"), 5);
    // and the gate no longer lists it
    const dry = await run(fx, ["gate"]);
    assert.equal(dry.stdout.split("\n").find((l) => l.includes("other/01-stale")), undefined, dry.stdout);
  } finally {
    await fx.cleanup();
  }
});

test("board gate lists a ticket over the unplanned cap and parks it only with --apply; a security finding over it stays", async () => {
  const fx = await makeBoardFixture(SEED); // den-v1/09-seed: resolved, no Origin line, so planned
  try {
    await putSpec(fx, "den-v1", ["# Den", "", "## Step 3: Feed the agent", ""]);
    await putUsage(fx, [activeRow("den-v1")]);
    for (const i of [1, 2, 3, 4, 5]) await putTicket(fx, "den-v1", `0${i}-planned`, { status: "resolved" }); // 6 planned with the seed
    for (const i of [10, 11, 12, 13]) await putTicket(fx, "den-v1", `${i}-added`, { status: "resolved", header: ["**Origin:** added"] });
    await putTicket(fx, "den-v1", "20-over", {
      header: ["**Class:** product", "**Origin:** added", '**Serves:** spec:den-v1 "Step 3"'],
    });
    await putTicket(fx, "den-v1", "21-finding", {
      header: ["**Class:** product", "**Origin:** added", "**Serves:** finding:den-v1/09-seed"],
    });
    const before = await treeSnapshot(scratch(fx));
    const dry = await run(fx, ["gate"]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(await treeSnapshot(scratch(fx)), before, "the dry run writes nothing");
    const lines = dry.stdout.split("\n");
    const over = lines.find((l) => l.includes("den-v1/20-over"));
    assert.ok(over, `the ticket over the cap is listed:\n${dry.stdout}`);
    assert.match(over, /unplanned|cap/i, "with the rule that refused it");
    assert.equal(lines.find((l) => l.includes("21-finding")), undefined, `the finding is admitted:\n${dry.stdout}`);

    const apply = await run(fx, ["gate", "--apply"]);
    assert.equal(apply.code, 0, apply.stderr);
    assert.equal(await getStatus(fx.root, "den-v1/20-over"), "parked");
    assert.equal(await getStatus(fx.root, "den-v1/21-finding"), "ready-for-agent");
  } finally {
    await fx.cleanup();
  }
});
