// organism-infra/93: batch-groups script (scripts/batch-groups.mjs), specify tests (qa).
//
// Seam 1 (pure): groupTickets({ tickets, inFlight, max = 3 }) -> { groups, singles, unknown, inFlight }
//   tickets:  EVERY ticket on the board, [{ ref: "<feature>/<NN-slug>", text: <ticket markdown>, locked: boolean }].
//             The function reads `**Type:**`, `**Status:**` and `**Blocked by:**` from text. Blocked by lists same-feature
//             numbers ("01, 02"), or "None ..." / "none". A blocker counts only when its ticket is on this list and its
//             Status is `resolved`. Only `ready-for-agent`, unblocked, unlocked tickets are considered; every other
//             ticket appears nowhere in the result.
//   paths:    backticked repo-relative paths in the `## What to build`, `## Acceptance criteria` and `## Paths (advisory)` sections and a `Paths (advisory):` line.
//             `.scratch/` and `.claude/` paths are ignored. A considered ticket with no paths goes to `unknown`.
//   inFlight: [{ branch, files: [path] }] from open PR heads, or null when the seam failed (no in-flight data).
//   max:      positive integer cap on the size of a group.
//   result:   groups:  [{ refs: [ref], paths: [shared path], reason: <non-empty string> }]   (always 2..max refs)
//             singles: [ref]    considered tickets with paths that are in no group (including dropped groups)
//             unknown: [ref]    considered tickets with no paths
//             inFlight: { available: boolean }   false exactly when the inFlight argument was null
//   `paths` of a group are the paths shared by at least two of its tickets. A group is dropped to singles when ANY path of
//   ANY of its tickets (shared or not) is in an in-flight branch's files.
//
// Seam 2 (CLI): main(argv, { readBoard, inFlightFiles }) -> Promise<{ code, stdout, stderr }>   (no process side effects)
//   readBoard():      Promise<tickets>      the same shape as above
//   inFlightFiles():  Promise<[{ branch, files }]>   a rejection means no in-flight data
//   Text output: one line per group holding ALL its refs, its shared paths and the reason; then the singles; then a line
//   containing "unknown files" followed by the unknown refs. A failed in-flight seam adds a line matching /no in-flight data/i
//   (and no such line otherwise). `--json` prints ONE JSON object { groups, singles, unknown, inFlight } and nothing else.
//   Exit 0 always except bad arguments: exit 2 (unknown flag, `--max` missing, non-integer or < 1), before any seam is called.
// Also run as a subprocess in the bad-argument test: node scripts/batch-groups.mjs <args>.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Loaded lazily so a missing script fails each test by name instead of aborting the file.
const load = () => import("./batch-groups.mjs");
const groupTickets = async (a) => (await load()).groupTickets(a);
const main = async (...a) => (await load()).main(...a);
const SCRIPT = fileURLToPath(new URL("./batch-groups.mjs", import.meta.url));

const ticketText = ({ type = "feature", status = "ready-for-agent", blockedBy = "None", build = "", criteria = "", comments = "" } = {}) =>
  `# 99: sample\n\n**Type:** ${type}\n\n**Priority:** P1\n\n**Blocked by:** ${blockedBy}\n\n**Status:** ${status}\n\n` +
  `## What to build\n\n${build}\n\n## Acceptance criteria\n\n${criteria}\n\n## Comments\n\n${comments}\n`;
const touches = (...ps) => `Change ${ps.map((p) => `\`${p}\``).join(" and ")}.`;
// T("feat/01-a", ["scripts/a.mjs"], { type: "fix" }): a ready ticket that names those paths in What to build.
const T = (ref, paths = [], opts = {}) => ({ ref, locked: opts.locked ?? false, text: ticketText({ build: touches(...paths), ...opts }) });

const sortedRefs = (g) => [...g.refs].sort();
const groupSets = (res) => res.groups.map(sortedRefs).sort((a, b) => a.join().localeCompare(b.join()));
const group = (tickets, over = {}) => groupTickets({ tickets, inFlight: [], max: 3, ...over });
const everywhere = (res) => [...res.groups.flatMap((g) => g.refs), ...res.singles, ...res.unknown];

// ---- pure grouping ----

test("two tickets that share a path are grouped; a third that shares none is single", async () => {
  const res = await group([
    T("f/01-a", ["scripts/x.mjs", "scripts/a.mjs"]),
    T("f/02-b", ["scripts/x.mjs"]),
    T("f/03-c", ["scripts/other.mjs"]),
  ]);
  assert.deepEqual(groupSets(res), [["f/01-a", "f/02-b"]]);
  assert.deepEqual(res.singles, ["f/03-c"]);
  assert.deepEqual(res.unknown, []);
});

test("a group names its shared path (not an unshared one) and gives a reason", async () => {
  const res = await group([T("f/01-a", ["scripts/x.mjs", "scripts/a.mjs"]), T("f/02-b", ["scripts/x.mjs", "scripts/b.mjs"])]);
  assert.equal(res.groups.length, 1);
  assert.deepEqual(res.groups[0].paths, ["scripts/x.mjs"]);
  assert.equal(typeof res.groups[0].reason, "string");
  assert.ok(res.groups[0].reason.trim().length > 0);
});

test("paths in Acceptance criteria count; paths in Comments or outside backticks do not", async () => {
  const a = { ref: "f/01-a", locked: false, text: ticketText({ build: "No path here.", criteria: "- [ ] `scripts/x.mjs` handles it" }) };
  const b = T("f/02-b", ["scripts/x.mjs"]);
  const c = { ref: "f/03-c", locked: false, text: ticketText({ build: "Edit scripts/x.mjs without backticks.", comments: "See `scripts/x.mjs`." }) };
  const res = await group([a, b, c]);
  assert.deepEqual(groupSets(res), [["f/01-a", "f/02-b"]]);
  assert.deepEqual(res.unknown, ["f/03-c"]);
});

test("paths in a `## Paths (advisory)` section or a `Paths (advisory):` line count (hardening/02 template)", async () => {
  const a = { ref: "f/01-a", locked: false, text: ticketText({ build: "No path here.", criteria: "- [ ] done" }).replace("## Comments", "## Paths (advisory)\n\nTouches `scripts/x.mjs`.\n\n## Comments") };
  const b = { ref: "f/02-b", locked: false, text: ticketText({ build: "No path here." }).replace("## What to build", "Paths (advisory): `scripts/x.mjs`, other files allowed.\n\n## What to build") };
  const c = T("f/03-c", ["scripts/other.mjs"]);
  const res = await group([a, b, c]);
  assert.deepEqual(groupSets(res), [["f/01-a", "f/02-b"]]);
  assert.deepEqual(res.singles, ["f/03-c"]);
});

test(".scratch/ and .claude/ paths are ignored, so such a ticket is `unknown`", async () => {
  const res = await group([
    T("f/01-a", [".scratch/f/issues/01-a.md", ".claude/agents/qa.md"]),
    T("f/02-b", [".scratch/f/issues/01-a.md", ".claude/agents/qa.md"]),
  ]);
  assert.deepEqual(res.groups, []);
  assert.deepEqual(res.unknown.sort(), ["f/01-a", "f/02-b"]);
  assert.deepEqual(res.singles, []);
});

test("a path overlap groups tickets across features", async () => {
  const res = await group([T("one/01-a", ["scripts/x.mjs"]), T("two/05-b", ["scripts/x.mjs"])]);
  assert.deepEqual(groupSets(res), [["one/01-a", "two/05-b"]]);
});

test("a chain of overlaps forms one connected group (A-B share p1, B-C share p2)", async () => {
  const res = await group([T("f/01-a", ["p/one.mjs"]), T("f/02-b", ["p/one.mjs", "p/two.mjs"]), T("f/03-c", ["p/two.mjs"])]);
  assert.deepEqual(groupSets(res), [["f/01-a", "f/02-b", "f/03-c"]]);
});

test("a component over the cap is split by most shared paths", async () => {
  // A,B share two paths; C shares p/two with both; C,D share p/three. max 2 => {A,B} (most shared) and {C,D}.
  const res = await group(
    [
      T("f/01-a", ["p/one.mjs", "p/two.mjs"]),
      T("f/02-b", ["p/one.mjs", "p/two.mjs"]),
      T("f/03-c", ["p/two.mjs", "p/three.mjs"]),
      T("f/04-d", ["p/three.mjs"]),
    ],
    { max: 2 },
  );
  assert.deepEqual(groupSets(res), [["f/01-a", "f/02-b"], ["f/03-c", "f/04-d"]]);
  assert.deepEqual(res.singles, []);
});

test("no group exceeds max and every ticket lands exactly once (five tickets on one path, max 3)", async () => {
  const refs = ["f/01-a", "f/02-b", "f/03-c", "f/04-d", "f/05-e"];
  const res = await group(refs.map((r) => T(r, ["p/shared.mjs"])), { max: 3 });
  assert.ok(res.groups.length >= 1);
  for (const g of res.groups) {
    assert.ok(g.refs.length >= 2 && g.refs.length <= 3, `group of ${g.refs.length}`);
  }
  assert.deepEqual(everywhere(res).sort(), refs);
});

test("max defaults to 3", async () => {
  const refs = ["f/01-a", "f/02-b", "f/03-c", "f/04-d"];
  const res = await groupTickets({ tickets: refs.map((r) => T(r, ["p/shared.mjs"])), inFlight: [] });
  assert.ok(res.groups.every((g) => g.refs.length <= 3));
  assert.deepEqual(everywhere(res).sort(), refs);
});

// ---- in-flight overlap ----

test("a group whose shared path is in an in-flight branch is left single", async () => {
  const res = await group([T("f/01-a", ["scripts/x.mjs"]), T("f/02-b", ["scripts/x.mjs"])], {
    inFlight: [{ branch: "feat/other", files: ["scripts/x.mjs", "README.md"] }],
  });
  assert.deepEqual(res.groups, []);
  assert.deepEqual(res.singles.sort(), ["f/01-a", "f/02-b"]);
});

test("any path of a group's tickets (even an unshared one) overlapping in-flight drops the group", async () => {
  const res = await group([T("f/01-a", ["scripts/x.mjs", "scripts/mine.mjs"]), T("f/02-b", ["scripts/x.mjs"])], {
    inFlight: [{ branch: "feat/other", files: ["scripts/mine.mjs"] }],
  });
  assert.deepEqual(res.groups, []);
  assert.deepEqual(res.singles.sort(), ["f/01-a", "f/02-b"]);
});

test("in-flight files that touch none of the group's paths leave it grouped", async () => {
  const res = await group([T("f/01-a", ["scripts/x.mjs"]), T("f/02-b", ["scripts/x.mjs"])], {
    inFlight: [{ branch: "feat/other", files: ["apps/ui/src/App.jsx"] }],
  });
  assert.deepEqual(groupSets(res), [["f/01-a", "f/02-b"]]);
  assert.equal(res.inFlight.available, true);
});

test("with no in-flight data (null) groups are still formed and the result says so", async () => {
  const res = await group([T("f/01-a", ["scripts/x.mjs"]), T("f/02-b", ["scripts/x.mjs"])], { inFlight: null });
  assert.deepEqual(groupSets(res), [["f/01-a", "f/02-b"]]);
  assert.equal(res.inFlight.available, false);
});

// ---- eligibility ----

test("a ticket with no paths is under `unknown` only, never grouped", async () => {
  const res = await group([T("f/01-a", ["scripts/x.mjs"]), T("f/02-b", ["scripts/x.mjs"]), T("f/03-none", [])]);
  assert.deepEqual(res.unknown, ["f/03-none"]);
  assert.deepEqual(groupSets(res), [["f/01-a", "f/02-b"]]);
  assert.ok(!res.singles.includes("f/03-none"));
});

test("blocked, locked and non-ready tickets are skipped entirely (not even listed)", async () => {
  const ready = (ref) => T(ref, ["scripts/x.mjs"]);
  const res = await group([
    ready("f/01-open"),
    ready("f/02-open"),
    T("f/03-blocker", ["scripts/zzz.mjs"], { status: "claimed" }),
    T("f/04-blocked", ["scripts/x.mjs"], { blockedBy: "03" }),
    T("f/05-locked", ["scripts/x.mjs"], { locked: true }),
    T("f/06-claimed", ["scripts/x.mjs"], { status: "claimed" }),
    T("f/07-review", ["scripts/x.mjs"], { status: "in-review" }),
    T("f/08-resolved", ["scripts/x.mjs"], { status: "resolved" }),
    T("f/09-blockedstatus", ["scripts/x.mjs"], { status: "blocked" }),
    T("f/10-human", ["scripts/x.mjs"], { status: "ready-for-human" }),
    T("f/11-noPathBlocked", [], { blockedBy: "03" }),
  ]);
  assert.deepEqual(groupSets(res), [["f/01-open", "f/02-open"]]);
  const seen = everywhere(res);
  for (const skipped of ["f/04-blocked", "f/05-locked", "f/06-claimed", "f/07-review", "f/08-resolved", "f/09-blockedstatus", "f/10-human", "f/11-noPathBlocked", "f/03-blocker"]) {
    assert.ok(!seen.includes(skipped), `${skipped} should be skipped`);
  }
});

test("a ticket whose blockers are all resolved is eligible", async () => {
  const res = await group([
    T("f/01-done", ["scripts/zzz.mjs"], { status: "resolved" }),
    T("f/02-done", ["scripts/yyy.mjs"], { status: "resolved" }),
    T("f/03-a", ["scripts/x.mjs"], { blockedBy: "01, 02" }),
    T("f/04-b", ["scripts/x.mjs"], { blockedBy: "None (can start immediately)" }),
  ]);
  assert.deepEqual(groupSets(res), [["f/03-a", "f/04-b"]]);
});

test("a ticket with one unresolved blocker among several is skipped", async () => {
  const res = await group([
    T("f/01-done", [], { status: "resolved" }),
    T("f/02-open", ["scripts/zzz.mjs"]),
    T("f/03-a", ["scripts/x.mjs"], { blockedBy: "01, 02" }),
    T("f/04-b", ["scripts/x.mjs"]),
  ]);
  assert.ok(!everywhere(res).includes("f/03-a"));
  assert.deepEqual(res.groups, []);
});

test("code and asset tickets are never grouped together", async () => {
  const res = await group([
    T("f/01-code", ["assets/bao.glb"], { type: "feature" }),
    T("f/02-asset", ["assets/bao.glb"], { type: "asset" }),
  ]);
  assert.deepEqual(res.groups, []);
  assert.deepEqual(res.singles.sort(), ["f/01-code", "f/02-asset"]);
});

test("code ticket types mix: task, fix and chore sharing a path group together", async () => {
  const res = await group([
    T("f/01-a", ["scripts/x.mjs"], { type: "task" }),
    T("f/02-b", ["scripts/x.mjs"], { type: "fix" }),
    T("f/03-c", ["scripts/x.mjs"], { type: "chore" }),
  ]);
  assert.deepEqual(groupSets(res), [["f/01-a", "f/02-b", "f/03-c"]]);
});

// ---- CLI ----

const fakeBoard = () => [
  T("f/01-a", ["scripts/x.mjs"]),
  T("f/02-b", ["scripts/x.mjs"]),
  T("f/03-solo", ["apps/ui/solo.jsx"]),
  T("f/04-nopaths", []),
  T("f/05-claimed", ["scripts/x.mjs"], { status: "claimed" }),
];
const seams = (over = {}) => ({ readBoard: async () => fakeBoard(), inFlightFiles: async () => [], ...over });
const lineWith = (out, ...needles) => out.split("\n").find((l) => needles.every((n) => l.includes(n)));

test("CLI text: group line, then singles, then `unknown files`; skipped tickets absent; exit 0", async () => {
  const { code, stdout } = await main([], seams());
  assert.equal(code, 0);
  const groupLine = lineWith(stdout, "f/01-a", "f/02-b", "scripts/x.mjs");
  assert.ok(groupLine, `no group line in:\n${stdout}`);
  const iGroup = stdout.indexOf("f/01-a");
  const iSingle = stdout.indexOf("f/03-solo");
  const iUnknownHeading = stdout.toLowerCase().indexOf("unknown files");
  const iUnknown = stdout.indexOf("f/04-nopaths");
  assert.ok(iGroup >= 0 && iGroup < iSingle, "group before singles");
  assert.ok(iSingle < iUnknownHeading, "singles before the unknown files heading");
  assert.ok(iUnknownHeading >= 0 && iUnknownHeading < iUnknown, "unknown files heading before its tickets");
  assert.ok(!stdout.includes("f/05-claimed"));
  assert.doesNotMatch(stdout, /no in-flight data/i);
});

test("CLI: a failing in-flight seam still prints groups and notes no in-flight data (exit 0)", async () => {
  const { code, stdout } = await main([], seams({ inFlightFiles: async () => { throw new Error("gh: not logged in"); } }));
  assert.equal(code, 0);
  assert.ok(lineWith(stdout, "f/01-a", "f/02-b"), `group missing in:\n${stdout}`);
  assert.match(stdout, /no in-flight data/i);
});

test("CLI: a ticket overlapping an in-flight branch's files is printed single", async () => {
  const { code, stdout } = await main(["--json"], seams({ inFlightFiles: async () => [{ branch: "feat/other", files: ["scripts/x.mjs"] }] }));
  assert.equal(code, 0);
  const obj = JSON.parse(stdout);
  assert.deepEqual(obj.groups, []);
  assert.deepEqual(obj.singles.sort(), ["f/01-a", "f/02-b", "f/03-solo"]);
  assert.equal(obj.inFlight.available, true);
});

test("CLI --json: one parseable object that matches the text grouping", async () => {
  const text = (await main([], seams())).stdout;
  const { code, stdout } = await main(["--json"], seams());
  assert.equal(code, 0);
  const obj = JSON.parse(stdout);
  assert.deepEqual(groupSets(obj), [["f/01-a", "f/02-b"]]);
  assert.deepEqual(obj.groups[0].paths, ["scripts/x.mjs"]);
  assert.ok(obj.groups[0].reason.length > 0);
  assert.deepEqual(obj.singles, ["f/03-solo"]);
  assert.deepEqual(obj.unknown, ["f/04-nopaths"]);
  assert.equal(obj.inFlight.available, true);
  for (const g of obj.groups) assert.ok(lineWith(text, ...g.refs, ...g.paths), "each JSON group is one text line");
});

test("CLI --json with a failing in-flight seam reports inFlight.available false", async () => {
  const { stdout } = await main(["--json"], seams({ inFlightFiles: async () => { throw new Error("gh missing"); } }));
  const obj = JSON.parse(stdout);
  assert.equal(obj.inFlight.available, false);
  assert.deepEqual(groupSets(obj), [["f/01-a", "f/02-b"]]);
});

test("CLI --max caps the group size; the default is 3", async () => {
  const board = ["f/01-a", "f/02-b", "f/03-c"].map((r) => T(r, ["scripts/x.mjs"]));
  const dflt = JSON.parse((await main(["--json"], seams({ readBoard: async () => board }))).stdout);
  assert.deepEqual(groupSets(dflt), [["f/01-a", "f/02-b", "f/03-c"]]);
  const two = JSON.parse((await main(["--json", "--max", "2"], seams({ readBoard: async () => board }))).stdout);
  assert.ok(two.groups.every((g) => g.refs.length <= 2));
  assert.deepEqual([...two.groups.flatMap((g) => g.refs), ...two.singles].sort(), ["f/01-a", "f/02-b", "f/03-c"]);
});

test("CLI bad arguments exit 2 and never call a seam", async () => {
  for (const argv of [["--bogus"], ["--max"], ["--max", "abc"], ["--max", "0"], ["--max", "-1"], ["extra"]]) {
    let called = 0;
    const count = (v) => async () => { called++; return v; };
    const { code } = await main(argv, { readBoard: count([]), inFlightFiles: count([]) });
    assert.equal(code, 2, `argv ${JSON.stringify(argv)}`);
    assert.equal(called, 0, `seam called for ${JSON.stringify(argv)}`);
  }
});

test("running the script with a bad argument exits 2", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--bogus"], { encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
});
