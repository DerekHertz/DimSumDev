// queue/03: the admission gate. `checkAdmission`, the header-line parsers in `loadSnapshot`, `board gate [--apply]`,
// and the Class/Origin/Serves/P0-reason lines of `createTicket` (the code behind `board create`).
// Design: ADR 0015 Amendment 3 (A, C), ADR 0019 decision 8, .scratch/queue/spec.md decisions 4, 6, 7.
//
// Seams under test (the public interface, nothing inside):
//   1. checkAdmission(ticket, snapshot) -> { ok, reasons[] }      pure, literal tickets and snapshots
//   2. loadSnapshot(root)                -> snapshot, checked through checkAdmission and the ticket fields it exposes
//   3. `board gate` / `board gate --apply` and `board queue`     -> stdout and board files, temp board CLI
//   4. createTicket(root, {...})                                  -> the ticket file, temp directory board
//
// Shapes pinned by these tests (extending queue/02's snapshot in frontier-queue.test.mjs):
//   ticket:   { ref, feature, num, status, priority, blockedBy: [full refs], origin, p0Reason,
//               class: "product" | "pipeline" | null,           // the **Class:** line, anything else is null
//               serves: "<raw text after **Serves:**>" | null } // the gate parses the machine form out of this text
//   snapshot: { active, tickets,
//               specs:     { "<feature>": ["<heading text>", ...] },     // headings of .scratch/<feature>/spec.md, '#' marks stripped;
//                                                                         // a feature with no readable spec file has no key
//               incidents: [{ ts, tool }] }                              // the kind:"incident" rows of usage.jsonl
//   result:   ok true gives reasons []; ok false gives one or more one-line reasons, each naming the failed rule:
//             /class/i, /serves/i, /heading|spec/i, /incident/i or /p0/i.
// Machine form of Serves (ADR 0015 Amendment 3, A): spec:<feature> "<heading text>" | incident:<ts>[, incident:<ts>...]
// | finding:<ref>. Prose after the form is free.
//
// Criterion map (acceptance criteria of queue/03):
//   1 checkAdmission admits and refuses per decisions 6 and 7, each refusal with a reason, literal tickets
//        .... the "checkAdmission ..." tests in the first section
//   2 pipeline ticket listed in an active-feature ticket's Blocked by is admitted without three incidents
//        .... "a pipeline ticket that blocks an active-feature ticket ..." tests
//   3 `board gate` with no flag writes nothing; --apply parks each refused ticket with its reason
//        .... "board gate ..." tests (and "board queue lists ..." for the parked-by-gate list)
//   4 `board create` writes Class, Origin and Serves lines and refuses a P0 with no reason
//        .... "createTicket ..." tests (the service function behind `board create`; there is no board create subcommand today)
//   5 a spec:<feature> path in ticket text cannot make the gate read a file outside .scratch/
//        .... "a spec path ..." tests (traversal, absolute path, symlinked feature dir, symlinked spec.md)
//   6 the handoff reports how many organism-infra pipeline tickets pass the three-incidents rule on the real usage.jsonl
//        .... human-verified: it is a number in the developer's handoff, not code behavior
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as frontierQueue from "./frontier-queue.mjs";
// checkAdmission is called through the namespace so a missing export fails each test, not the whole file at link time.
const { loadSnapshot } = frontierQueue;
const checkAdmission = (...args) => frontierQueue.checkAdmission(...args);
import { createTicket, getStatus, BoardError } from "./board-service.mjs";
import { makeBoardFixture, runBoard } from "./board-fixture.mjs";

// --- 1. checkAdmission, literal tickets ---------------------------------------------------------------------

let n = 0;
function tk(feature, num, extra = {}) {
  n += 1;
  return {
    ref: `${feature}/${String(num).padStart(2, "0")}-g${n}`,
    feature,
    num,
    status: "ready-for-agent",
    priority: 2,
    blockedBy: [],
    origin: null,
    p0Reason: null,
    class: "product",
    serves: null,
    ...extra,
  };
}
const SPEC_SERVES = 'spec:den-v1 "Step 3"';
const inc = (ts, tool) => ({ ts, tool });
const INCIDENTS = [
  inc("2026-10-01T10:00:01Z", "board-claim"),
  inc("2026-10-01T10:00:02Z", "board-claim"),
  inc("2026-10-01T10:00:03Z", "board-claim"),
  inc("2026-10-01T10:00:04Z", "git-push"),
  inc("2026-10-01T10:00:05Z", "git-push"),
];
const THREE_SAME = "incident:2026-10-01T10:00:01Z, incident:2026-10-01T10:00:02Z, incident:2026-10-01T10:00:03Z";
function snap(tickets, extra = {}) {
  return {
    active: "den-v1",
    tickets,
    specs: { "den-v1": ["Overview", "Step 3: Feed the agent", "Open questions"], other: ["Other heading"] },
    incidents: INCIDENTS,
    ...extra,
  };
}
const check = (ticket, tickets = [ticket], extra = {}) => checkAdmission(ticket, snap(tickets, extra));
const admitted = (r, why) => {
  assert.equal(r.ok, true, `${why}: ${JSON.stringify(r)}`);
  assert.deepEqual(r.reasons, []);
};
const refused = (r, rule, why) => {
  assert.equal(r.ok, false, `${why}: ${JSON.stringify(r)}`);
  assert.ok(r.reasons.length >= 1, `${why}: at least one reason`);
  for (const reason of r.reasons) {
    assert.equal(typeof reason, "string");
    assert.doesNotMatch(reason, /\n/, "a reason is one line");
  }
  assert.ok(r.reasons.some((x) => rule.test(x)), `${why}: a reason matches ${rule}: ${JSON.stringify(r.reasons)}`);
};

test("checkAdmission admits a product ticket whose Serves names a heading of the active feature's spec", () => {
  admitted(check(tk("den-v1", 1, { serves: SPEC_SERVES })), "heading found");
  // case-insensitive, substring of the heading line, prose after the form is free
  admitted(check(tk("den-v1", 2, { serves: 'spec:den-v1 "FEED THE AGENT" the loop needs this' })), "case-insensitive");
});

test("checkAdmission refuses a spec heading that is not in the spec, naming the rule", () => {
  refused(check(tk("den-v1", 1, { serves: 'spec:den-v1 "Step 9"' })), /heading|spec/i, "no such heading");
});

test("checkAdmission refuses a product ticket whose spec is not the active feature's", () => {
  refused(check(tk("den-v1", 1, { serves: 'spec:other "Other heading"' })), /spec|active/i, "not the active feature");
  refused(check(tk("den-v1", 2, { serves: SPEC_SERVES }), undefined, { active: null }), /spec|active/i, "no active feature");
});

test("checkAdmission refuses a spec feature that has no spec file", () => {
  refused(check(tk("den-v1", 1, { serves: 'spec:den-v1 "Step 3"' }), undefined, { specs: {} }), /spec/i, "no spec file");
});

test("checkAdmission refuses a missing or free-text Serves line", () => {
  refused(check(tk("den-v1", 1, { serves: null })), /serves/i, "no Serves");
  refused(check(tk("den-v1", 2, { serves: "the den loop, step 3, roughly" })), /serves/i, "free text");
  refused(check(tk("den-v1", 3, { serves: "`.scratch/queue/spec.md` decisions 4, 6" })), /serves/i, "path prose");
});

test("checkAdmission refuses a missing or invalid class, and reports every failed rule", () => {
  refused(check(tk("den-v1", 1, { class: null, serves: SPEC_SERVES })), /class/i, "no class");
  refused(check(tk("den-v1", 2, { class: "banana", serves: SPEC_SERVES })), /class/i, "bad class");
  const both = check(tk("den-v1", 3, { class: null, serves: null }));
  refused(both, /class/i, "no class and no Serves");
  assert.ok(both.reasons.some((x) => /serves/i.test(x)), `the Serves failure is reported too: ${JSON.stringify(both.reasons)}`);
});

test("checkAdmission admits a product ticket that names an incident that exists, and refuses one that does not", () => {
  admitted(check(tk("den-v1", 1, { serves: "incident:2026-10-01T10:00:04Z" })), "existing incident");
  refused(check(tk("den-v1", 2, { serves: "incident:2026-10-01T23:59:59Z" })), /incident/i, "no such incident");
});

test("checkAdmission admits a pipeline ticket with three incidents that share a tool", () => {
  admitted(check(tk("pipe", 1, { class: "pipeline", serves: THREE_SAME })), "three of one tool");
});

test("checkAdmission refuses a pipeline ticket without three incidents of one tool", () => {
  const two = "incident:2026-10-01T10:00:01Z, incident:2026-10-01T10:00:02Z";
  refused(check(tk("pipe", 1, { class: "pipeline", serves: two })), /incident/i, "two incidents");
  const mixed = "incident:2026-10-01T10:00:01Z, incident:2026-10-01T10:00:02Z, incident:2026-10-01T10:00:04Z";
  refused(check(tk("pipe", 2, { class: "pipeline", serves: mixed })), /incident/i, "three incidents, two tools");
  const repeated = "incident:2026-10-01T10:00:01Z, incident:2026-10-01T10:00:01Z, incident:2026-10-01T10:00:01Z";
  refused(check(tk("pipe", 3, { class: "pipeline", serves: repeated })), /incident/i, "one incident named three times");
  const missing = "incident:2026-10-01T10:00:01Z, incident:2026-10-01T10:00:02Z, incident:2026-10-01T23:59:59Z";
  refused(check(tk("pipe", 4, { class: "pipeline", serves: missing })), /incident/i, "one named incident does not exist");
});

test("checkAdmission refuses a pipeline ticket that names a spec step but has no incidents and blocks nothing", () => {
  refused(check(tk("pipe", 1, { class: "pipeline", serves: SPEC_SERVES })), /incident/i, "pipeline needs incidents");
});

test("a pipeline ticket that blocks an active-feature ticket is admitted without three incidents (ADR 0019 decision 8)", () => {
  const pipe = tk("pipe", 1, { class: "pipeline", serves: "incident:2026-10-01T10:00:01Z" });
  const blocked = tk("den-v1", 4, { blockedBy: [pipe.ref] });
  admitted(check(pipe, [pipe, blocked]), "blocks the active feature");
  // the same ticket with no active-feature ticket behind it is refused
  refused(check(pipe, [pipe]), /incident/i, "blocks nothing");
});

test("a pipeline ticket that blocks only a ticket outside the active feature does not get the exemption", () => {
  const pipe = tk("pipe", 1, { class: "pipeline", serves: "incident:2026-10-01T10:00:01Z" });
  const elsewhere = tk("other", 4, { blockedBy: [pipe.ref] });
  refused(check(pipe, [pipe, elsewhere]), /incident/i, "blocked ticket is not in the active feature");
});

test("checkAdmission refuses P0 without a reason and admits it with one", () => {
  refused(check(tk("den-v1", 1, { priority: 0, p0Reason: null, serves: SPEC_SERVES })), /p0/i, "P0 with no reason");
  admitted(check(tk("den-v1", 2, { priority: 0, p0Reason: "main-red", serves: SPEC_SERVES })), "P0 with a reason");
  admitted(check(tk("den-v1", 3, { priority: 1, p0Reason: null, serves: SPEC_SERVES })), "P1 needs no reason");
});

test("checkAdmission admits finding:<ref> only when that ticket exists", () => {
  const found = tk("den-v1", 7, { status: "resolved" });
  admitted(check(tk("den-v1", 1, { serves: `finding:${found.ref}` }), [found]), "existing finding ticket");
  refused(check(tk("den-v1", 2, { serves: "finding:den-v1/99-nothing" }), [found]), /serves|finding/i, "no such ticket");
});

// --- 2. loadSnapshot: header lines and spec headings, through the public result ------------------------------

const ticketText = ({ title = "a ticket", status = "ready-for-agent", priority, blockedBy = "none", header = [], body = [] }) =>
  [
    `# ${title}`,
    "",
    "**Type:** code",
    ...(priority === undefined ? [] : [`**Priority:** ${priority}`]),
    `**Blocked by:** ${blockedBy}`,
    `**Status:** ${status}`,
    ...header,
    "",
    "## What to build",
    "",
    ...body,
    "- [ ] criterion",
    "",
    "## Comments",
    "",
  ].join("\n");

async function putTicket(root, feature, slug, opts = {}) {
  const dir = path.join(root, ".scratch", feature, "issues");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${slug}.md`), ticketText(opts), "utf8");
}
async function putSpec(root, feature, lines) {
  await mkdir(path.join(root, ".scratch", feature), { recursive: true });
  await writeFile(path.join(root, ".scratch", feature, "spec.md"), lines.join("\n") + "\n", "utf8");
}
const incidentRow = (ts, tool) => JSON.stringify({ kind: "incident", ts, ticket: "x/01-y", role: "developer", tool, what: "w" });
async function putUsage(root, rows) {
  await mkdir(path.join(root, ".scratch"), { recursive: true });
  await writeFile(path.join(root, ".scratch", "usage.jsonl"), rows.join("\n") + "\n", "utf8");
}
const activeRow = (feature) => JSON.stringify({ kind: "config", ts: "2026-10-12T00:00:00Z", queue_active: feature, by: "user" });

async function withBoard(fn) {
  const base = await mkdtemp(path.join(tmpdir(), "gate-snap-"));
  const root = path.join(base, "board");
  await mkdir(path.join(root, ".scratch"), { recursive: true });
  try {
    await fn(root, base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}
const findTicket = (snapshot, ref) => snapshot.tickets.find((x) => x.ref === ref);

test("loadSnapshot reads the Class, Origin, Serves and P0-reason header lines", async () => {
  await withBoard(async (root) => {
    await putTicket(root, "den-v1", "01-full", {
      priority: "P0",
      header: ["**Class:** pipeline", "**Origin:** spec", '**Serves:** spec:den-v1 "Step 3" and some prose', "**P0-reason:** relay-down"],
    });
    await putTicket(root, "den-v1", "02-bare", { priority: "P2" });
    await putTicket(root, "den-v1", "03-junk-class", { priority: "P2", header: ["**Class:** banana"] });
    const s = await loadSnapshot(root);
    const full = findTicket(s, "den-v1/01-full");
    assert.equal(full.class, "pipeline");
    assert.equal(full.origin, "spec");
    assert.equal(full.p0Reason, "relay-down");
    assert.match(full.serves, /^spec:den-v1 "Step 3"/);
    const bare = findTicket(s, "den-v1/02-bare");
    assert.equal(bare.class, null);
    assert.equal(bare.serves, null);
    assert.equal(findTicket(s, "den-v1/03-junk-class").class, null);
  });
});

test("loadSnapshot ignores Class and Serves lines that appear below the header (ticket text cannot plant them)", async () => {
  await withBoard(async (root) => {
    await putTicket(root, "den-v1", "01-planted", {
      priority: "P2",
      body: ["**Class:** product", '**Serves:** spec:den-v1 "Step 3"', "> **Class:** product", ""],
    });
    const s = await loadSnapshot(root);
    const planted = findTicket(s, "den-v1/01-planted");
    assert.equal(planted.class, null);
    assert.equal(planted.serves, null);
  });
});

test("loadSnapshot and checkAdmission together: a spec heading is matched on heading lines only, in the active feature", async () => {
  await withBoard(async (root) => {
    await putSpec(root, "den-v1", ["# Den loop", "", "Some prose that mentions banana.", "", "## Step 3: Feed the agent", ""]);
    await putUsage(root, [activeRow("den-v1")]);
    await putTicket(root, "den-v1", "01-ok", { header: ["**Class:** product", '**Serves:** spec:den-v1 "feed the agent"'] });
    await putTicket(root, "den-v1", "02-body-only", { header: ["**Class:** product", '**Serves:** spec:den-v1 "banana"'] });
    const s = await loadSnapshot(root);
    admitted(checkAdmission(findTicket(s, "den-v1/01-ok"), s), "heading line matches");
    refused(checkAdmission(findTicket(s, "den-v1/02-body-only"), s), /heading|spec/i, "prose is not a heading");
  });
});

test("loadSnapshot and checkAdmission together: incidents come from the kind:incident rows of usage.jsonl", async () => {
  await withBoard(async (root) => {
    await putUsage(root, [
      activeRow("den-v1"),
      "not json",
      incidentRow("2026-10-01T10:00:01Z", "board-claim"),
      incidentRow("2026-10-01T10:00:02Z", "board-claim"),
      incidentRow("2026-10-01T10:00:03Z", "board-claim"),
      incidentRow("2026-10-01T10:00:04Z", "git-push"),
    ]);
    await putTicket(root, "pipe", "01-three", { header: ["**Class:** pipeline", `**Serves:** ${THREE_SAME}`] });
    await putTicket(root, "pipe", "02-mixed", {
      header: ["**Class:** pipeline", "**Serves:** incident:2026-10-01T10:00:01Z, incident:2026-10-01T10:00:02Z, incident:2026-10-01T10:00:04Z"],
    });
    const s = await loadSnapshot(root);
    admitted(checkAdmission(findTicket(s, "pipe/01-three"), s), "three same-tool incidents");
    refused(checkAdmission(findTicket(s, "pipe/02-mixed"), s), /incident/i, "mixed tools");
  });
});

test("loadSnapshot and checkAdmission together: the blocks-the-active-feature exemption reads Blocked by", async () => {
  await withBoard(async (root) => {
    await putUsage(root, [activeRow("den-v1"), incidentRow("2026-10-01T10:00:01Z", "board-claim")]);
    await putTicket(root, "pipe", "01-tool", { header: ["**Class:** pipeline", "**Serves:** incident:2026-10-01T10:00:01Z"] });
    await putTicket(root, "pipe", "02-lonely", { header: ["**Class:** pipeline", "**Serves:** incident:2026-10-01T10:00:01Z"] });
    await putTicket(root, "den-v1", "01-needs-tool", { blockedBy: "pipe/01", header: ["**Class:** product", "**Serves:** incident:2026-10-01T10:00:01Z"] });
    const s = await loadSnapshot(root);
    admitted(checkAdmission(findTicket(s, "pipe/01-tool"), s), "an active-feature ticket lists it in Blocked by");
    refused(checkAdmission(findTicket(s, "pipe/02-lonely"), s), /incident/i, "nothing lists it");
  });
});

// --- 3. a spec path in ticket text cannot reach outside .scratch/ --------------------------------------------

// The pipeline ticket below blocks an active-feature ticket, so the incidents rule is out of the way and the only
// thing that can decide admission is whether the named spec file is read. Each planted file holds the heading
// "Planted", so a gate that follows the path would admit.
async function pathBoard(fn) {
  await withBoard(async (root, base) => {
    for (const dir of [path.join(base, "secret"), path.join(root, "secret"), path.join(base, "abs")]) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "spec.md"), "# Planted\n\n## Planted heading\n", "utf8");
    }
    await putSpec(root, "den-v1", ["# Real", "", "## Real heading", ""]);
    await putUsage(root, [activeRow("den-v1"), incidentRow("2026-10-01T10:00:01Z", "board-claim")]);
    await putTicket(root, "den-v1", "01-needs-tool", { blockedBy: "pipe/01", header: ["**Class:** product", '**Serves:** spec:den-v1 "Real heading"'] });
    await fn(root, base, async (slug, serves) => {
      await putTicket(root, "pipe", slug, { header: ["**Class:** pipeline", `**Serves:** ${serves}`] });
      const s = await loadSnapshot(root);
      return { s, ticket: findTicket(s, `pipe/${slug}`) };
    });
  });
}

test("a spec path control: the same ticket naming a real feature and heading is admitted", async () => {
  await pathBoard(async (_root, _base, put) => {
    const { s, ticket } = await put("01-control", 'spec:den-v1 "Real heading"');
    // 01-control is pipe/01, which the den-v1 ticket lists in Blocked by
    admitted(checkAdmission(ticket, s), "control");
  });
});

test("a spec path with .. segments or an absolute path cannot make the gate read outside .scratch/", async () => {
  await pathBoard(async (_root, base, put) => {
    // pipe/01 must exist for the exemption; each probe below is a later ticket of the same pipeline feature, so
    // give each one the exemption by name instead: they all sit in the blocked ticket's Blocked by.
    const probes = [
      'spec:../secret "Planted"',
      'spec:../../secret "Planted"',
      'spec:den-v1/../../../secret "Planted"',
      `spec:${path.join(base, "abs")} "Planted"`,
      'spec:.. "Planted"',
    ];
    for (const [i, serves] of probes.entries()) {
      const slug = `0${i + 1}-probe`;
      const { s, ticket } = await put(slug, serves);
      // make the exemption apply to this probe regardless of its number
      s.tickets.push({ ...findTicket(s, "den-v1/01-needs-tool"), ref: "den-v1/50-also", blockedBy: [ticket.ref] });
      refused(checkAdmission(ticket, s), /spec|serves/i, `path probe ${serves}`);
    }
  });
});

test("a spec path through a symlink out of .scratch/ is not read", async () => {
  await pathBoard(async (root, base, put) => {
    await symlink(path.join(base, "secret"), path.join(root, ".scratch", "linked"), "dir");
    await mkdir(path.join(root, ".scratch", "halfway"), { recursive: true });
    await symlink(path.join(base, "secret", "spec.md"), path.join(root, ".scratch", "halfway", "spec.md"), "file");
    for (const [i, serves] of ['spec:linked "Planted"', 'spec:halfway "Planted"'].entries()) {
      const { s, ticket } = await put(`0${i + 1}-link`, serves);
      s.tickets.push({ ...findTicket(s, "den-v1/01-needs-tool"), ref: "den-v1/50-also", blockedBy: [ticket.ref] });
      refused(checkAdmission(ticket, s), /spec|serves/i, `symlink probe ${serves}`);
    }
  });
});

// --- 4. board gate and board queue, temp board CLI -----------------------------------------------------------

const run = (fx, args) => runBoard(args, { cwd: fx.worktree, env: { DEN_ROOT: fx.root } });

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

const GOOD = ["**Class:** product", '**Serves:** spec:den-v1 "Step 3"'];
const PIPE_OK = ["**Class:** pipeline", `**Serves:** ${THREE_SAME}`];
const REFUSED = ["den-v1/02-no-class", "den-v1/03-free-serves", "pipe/02-one-incident"];
const KEPT_READY = ["den-v1/01-good", "pipe/01-three-incidents"];

async function seedGateBoard(fx) {
  await putSpec(fx.root, "den-v1", ["# Den", "", "## Step 3: Feed the agent", ""]);
  await putUsage(fx.root, [
    activeRow("den-v1"),
    incidentRow("2026-10-01T10:00:01Z", "board-claim"),
    incidentRow("2026-10-01T10:00:02Z", "board-claim"),
    incidentRow("2026-10-01T10:00:03Z", "board-claim"),
  ]);
  await putTicket(fx.root, "den-v1", "01-good", { priority: "P1", header: GOOD });
  await putTicket(fx.root, "den-v1", "02-no-class", { priority: "P1", header: ['**Serves:** spec:den-v1 "Step 3"'] });
  await putTicket(fx.root, "den-v1", "03-free-serves", { priority: "P1", header: ["**Class:** product", "**Serves:** the den loop, roughly"] });
  await putTicket(fx.root, "pipe", "01-three-incidents", { priority: "P2", header: PIPE_OK });
  await putTicket(fx.root, "pipe", "02-one-incident", { priority: "P2", header: ["**Class:** pipeline", "**Serves:** incident:2026-10-01T10:00:01Z"] });
  await putTicket(fx.root, "pipe", "03-claimed", { priority: "P2", status: "claimed" });
  await putTicket(fx.root, "pipe", "04-hand-parked", { priority: "P2" });
  await putTicket(fx.root, "pipe", "05-resolved", { priority: "P2", status: "resolved" });
  const park = await run(fx, ["park", "pipe/04-hand-parked", "--reason", "not now"]);
  assert.equal(park.code, 0, park.stderr);
}

const SEED = { feature: "den-v1", ticket: "09-seed", status: "resolved" };

test("board gate with no flag lists the tickets it would park and writes nothing", async () => {
  const fx = await makeBoardFixture(SEED);
  try {
    await seedGateBoard(fx);
    const before = await treeSnapshot(path.join(fx.root, ".scratch"));
    const r = await run(fx, ["gate"]);
    assert.equal(r.code, 0, r.stderr);
    const after = await treeSnapshot(path.join(fx.root, ".scratch"));
    assert.deepEqual(after, before, "no file under .scratch changed, was added or removed");
    const lines = r.stdout.split("\n");
    const lineOf = (ref) => lines.find((l) => l.includes(ref));
    for (const ref of REFUSED) assert.ok(lineOf(ref), `${ref} is listed:\n${r.stdout}`);
    assert.match(lineOf("den-v1/02-no-class"), /class/i);
    assert.match(lineOf("den-v1/03-free-serves"), /serves/i);
    assert.match(lineOf("pipe/02-one-incident"), /incident/i);
    for (const ref of [...KEPT_READY, "pipe/03-claimed", "pipe/04-hand-parked", "pipe/05-resolved", "den-v1/09-seed"]) {
      assert.equal(lineOf(ref), undefined, `${ref} is not listed:\n${r.stdout}`);
    }
  } finally {
    await fx.cleanup();
  }
});

test("board gate with nothing to park exits 0 and writes nothing", async () => {
  const fx = await makeBoardFixture(SEED);
  try {
    await putSpec(fx.root, "den-v1", ["# Den", "", "## Step 3: Feed the agent", ""]);
    await putUsage(fx.root, [activeRow("den-v1")]);
    await putTicket(fx.root, "den-v1", "01-good", { header: GOOD });
    const before = await treeSnapshot(path.join(fx.root, ".scratch"));
    const r = await run(fx, ["gate"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(await treeSnapshot(path.join(fx.root, ".scratch")), before);
    assert.doesNotMatch(r.stdout, /01-good/);
  } finally {
    await fx.cleanup();
  }
});

test("board gate --apply parks each refused ticket with its reason and leaves the rest alone", async () => {
  const fx = await makeBoardFixture(SEED);
  try {
    await seedGateBoard(fx);
    const r = await run(fx, ["gate", "--apply"]);
    assert.equal(r.code, 0, r.stderr);
    for (const ref of REFUSED) assert.equal(await getStatus(fx.root, ref), "parked", `${ref} is parked`);
    for (const ref of KEPT_READY) assert.equal(await getStatus(fx.root, ref), "ready-for-agent", `${ref} stays ready`);
    assert.equal(await getStatus(fx.root, "pipe/03-claimed"), "claimed");
    assert.equal(await getStatus(fx.root, "pipe/05-resolved"), "resolved");

    // The reason is on the ticket (the existing park path writes a comment) and in the park event.
    const reasonOn = async (ref) => await readFile(path.join(fx.root, ".scratch", ...ref.split("/").slice(0, 1), "issues", `${ref.split("/")[1]}.md`), "utf8");
    assert.match(await reasonOn("den-v1/02-no-class"), /parked[\s\S]*class/i);
    assert.match(await reasonOn("den-v1/03-free-serves"), /parked[\s\S]*serves/i);
    assert.match(await reasonOn("pipe/02-one-incident"), /parked[\s\S]*incident/i);

    const events = (await readFile(fx.eventsPath, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const parkEvents = events.filter((e) => e.op === "park" && e.reason && e.ticket !== "04-hand-parked");
    assert.deepEqual(
      parkEvents.map((e) => `${e.feature}/${e.ticket}`).sort(),
      [...REFUSED].sort(),
      "one park event per refused ticket, each with a reason"
    );
  } finally {
    await fx.cleanup();
  }
});

test("board gate --apply a second time parks nothing more", async () => {
  const fx = await makeBoardFixture(SEED);
  try {
    await seedGateBoard(fx);
    assert.equal((await run(fx, ["gate", "--apply"])).code, 0);
    const before = await treeSnapshot(path.join(fx.root, ".scratch"));
    const again = await run(fx, ["gate", "--apply"]);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(await treeSnapshot(path.join(fx.root, ".scratch")), before, "nothing left to park, nothing written");
  } finally {
    await fx.cleanup();
  }
});

test("board queue lists the tickets parked by the gate, with their reasons, and no others", async () => {
  const fx = await makeBoardFixture(SEED);
  try {
    await seedGateBoard(fx);
    const empty = await run(fx, ["queue"]);
    assert.equal(empty.code, 0, empty.stderr);
    const emptyAt = empty.stdout.split("\n").findIndex((l) => /parked.by.gate/i.test(l));
    assert.ok(emptyAt >= 0);
    assert.doesNotMatch(empty.stdout.split("\n").slice(emptyAt + 1).join("\n"), /[\w-]+\/\d{2}-/, "nothing is parked by the gate before --apply");

    assert.equal((await run(fx, ["gate", "--apply"])).code, 0);
    const r = await run(fx, ["queue"]);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.split("\n");
    const gateAt = lines.findIndex((l) => /parked.by.gate/i.test(l));
    assert.ok(gateAt >= 0, r.stdout);
    const section = lines.slice(gateAt + 1);
    const lineOf = (ref) => section.find((l) => l.includes(ref));
    assert.match(lineOf("den-v1/02-no-class") ?? "", /class/i, `listed with its reason:\n${r.stdout}`);
    assert.match(lineOf("den-v1/03-free-serves") ?? "", /serves/i);
    assert.match(lineOf("pipe/02-one-incident") ?? "", /incident/i);
    assert.equal(lineOf("pipe/04-hand-parked"), undefined, "a ticket parked by hand is not a gate park");

    // Unparking takes a ticket off the list.
    const un = await run(fx, ["unpark", "den-v1/02-no-class", "--reason", "class added"]);
    assert.equal(un.code, 0, un.stderr);
    const after = (await run(fx, ["queue"])).stdout.split("\n");
    const afterSection = after.slice(after.findIndex((l) => /parked.by.gate/i.test(l)) + 1);
    assert.equal(afterSection.find((l) => l.includes("den-v1/02-no-class")), undefined);
    assert.ok(afterSection.find((l) => l.includes("den-v1/03-free-serves")));
  } finally {
    await fx.cleanup();
  }
});

// --- 5. createTicket: Class, Origin, Serves and P0-reason lines ----------------------------------------------

async function createBoard() {
  const root = await mkdtemp(path.join(tmpdir(), "gate-create-"));
  await mkdir(path.join(root, ".scratch"), { recursive: true });
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
const input = (over = {}) => ({ feature: "den", slug: "scout", title: "Den task", text: "Count the baskets.", ...over });
const headerOf = (md) => md.slice(0, md.search(/^## /m));

test("createTicket writes the Class, Origin and Serves lines in the header, and loadSnapshot reads them back", async () => {
  const b = await createBoard();
  try {
    const made = await createTicket(
      b.root,
      input({ class: "pipeline", origin: "spec", serves: `incident:2026-10-01T10:00:01Z, incident:2026-10-01T10:00:02Z` })
    );
    const md = await readFile(made.path, "utf8");
    const head = headerOf(md);
    assert.match(head, /^\*\*Class:\*\* pipeline$/m);
    assert.match(head, /^\*\*Origin:\*\* spec$/m);
    assert.match(head, /^\*\*Serves:\*\* incident:2026-10-01T10:00:01Z, incident:2026-10-01T10:00:02Z$/m);
    const t = findTicket(await loadSnapshot(b.root), made.ref);
    assert.equal(t.class, "pipeline");
    assert.equal(t.origin, "spec");
    assert.match(t.serves, /^incident:2026-10-01T10:00:01Z/);
  } finally {
    await b.cleanup();
  }
});

test("createTicket with a class and no origin writes Origin: added (ADR 0015 Amendment 3, A)", async () => {
  const b = await createBoard();
  try {
    const made = await createTicket(b.root, input({ class: "product" }));
    assert.match(headerOf(await readFile(made.path, "utf8")), /^\*\*Origin:\*\* added$/m);
  } finally {
    await b.cleanup();
  }
});

test("createTicket refuses an unknown class or origin and creates nothing", async () => {
  const b = await createBoard();
  try {
    await assert.rejects(createTicket(b.root, input({ class: "banana" })), BoardError);
    await assert.rejects(createTicket(b.root, input({ class: "product", origin: "maybe" })), BoardError);
    const issues = await readdir(path.join(b.root, ".scratch", "den", "issues")).catch(() => []);
    assert.deepEqual(issues.filter((f) => f.endsWith(".md")), [], "no ticket file was written");
  } finally {
    await b.cleanup();
  }
});

test("createTicket refuses a P0 with no reason and creates nothing", async () => {
  const b = await createBoard();
  try {
    await assert.rejects(createTicket(b.root, input({ class: "product", priority: "P0" })), BoardError);
    await assert.rejects(createTicket(b.root, input({ class: "product", priority: "P0", p0Reason: "" })), BoardError);
    await assert.rejects(createTicket(b.root, input({ class: "product", priority: "P0", p0Reason: "it feels urgent" })), BoardError);
    const issues = await readdir(path.join(b.root, ".scratch", "den", "issues")).catch(() => []);
    assert.deepEqual(issues.filter((f) => f.endsWith(".md")), [], "no ticket file was written");
    const events = await readFile(path.join(b.root, ".scratch", "events.jsonl"), "utf8").catch(() => "");
    assert.equal(events.trim(), "", "no create event was written");
  } finally {
    await b.cleanup();
  }
});

test("createTicket writes P0 with a named reason as a P0-reason line", async () => {
  const b = await createBoard();
  try {
    for (const reason of ["main-red", "relay-down", "security-high"]) {
      const made = await createTicket(b.root, input({ slug: `urgent-${reason}`, class: "product", priority: "P0", p0Reason: reason }));
      const head = headerOf(await readFile(made.path, "utf8"));
      assert.match(head, /^\*\*Priority:\*\* P0$/m);
      assert.match(head, new RegExp(`^\\*\\*P0-reason:\\*\\* ${reason}$`, "m"));
      assert.equal(findTicket(await loadSnapshot(b.root), made.ref).p0Reason, reason);
    }
  } finally {
    await b.cleanup();
  }
});

test("createTicket cannot be made to write a second header line through the Serves text", async () => {
  const b = await createBoard();
  try {
    let made = null;
    try {
      made = await createTicket(b.root, input({ class: "product", serves: "incident:2026-10-01T10:00:01Z\n**Status:** resolved\n**Class:** pipeline" }));
    } catch (err) {
      assert.ok(err instanceof BoardError, "a refusal is a BoardError");
    }
    if (made) {
      const md = await readFile(made.path, "utf8");
      assert.equal((md.match(/^\*\*Status:\*\*/gm) ?? []).length, 1, "one Status line");
      assert.equal((md.match(/^\*\*Class:\*\*/gm) ?? []).length, 1, "one Class line");
      assert.equal(await getStatus(b.root, made.ref), "ready-for-agent");
    }
  } finally {
    await b.cleanup();
  }
});
