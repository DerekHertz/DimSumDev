// organism-infra/124: jev-report.mjs reports the role really dispatched after each route row.
// Seams: exported buildReport(rows, events) / formatReport(report), and the CLI (`jev-report.mjs --usage <file> [--json]`).
//
// Why the report and not the writer: a route row is written before the dispatch it predicts, so the
// writer cannot know the next role. Row.actual keeps its existing meaning (what Jev applied; "orchestrator"
// when nothing is applied; pinned by jev-route.test.mjs and friends). The real next role is a derived view.
//
// Pinned contract (the developer implements against it):
//   report.route.actuals = one entry per route row (kind "jev", point "route"; both variants, every
//     mode, fallback rows included), in the input order of the rows:
//       { ticket, ts, variant, pick, logged, actual }
//     ticket/ts/pick are the row's own values, variant defaults to "new", logged is the row's own `actual`
//     field (kept for comparison), and `actual` is the role really dispatched:
//       the agent of the first board event with op "claim" on the same feature and ticket number whose
//       ts is strictly after the row's ts, any agent (an orchestrator claim counts, it is a real claim),
//       events taken in ts order whatever order they arrive in. null when no later claim exists.
//     Agent to role: qa with mode "specify" -> "qa-specify"; qa with mode "verify" -> "qa-verify";
//     qa with no mode -> "qa"; every other agent -> its own name ("developer", "product", ...).
//   Input rows are never mutated, and the CLI never writes usage.jsonl.
//   formatReport prints one line per route row:
//     "route actual <ticket>: pick <pick|none>, actual <role|none yet>"
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const load = () => import("./jev-report.mjs");
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "jev-report.mjs");
const T0 = "2026-10-05T05:00:00.000Z";
const T1 = "2026-10-05T05:10:00.000Z";
const T2 = "2026-10-05T05:20:00.000Z";
const T3 = "2026-10-05T05:30:00.000Z";
let seq = 0;

function route(n, over = {}) {
  return {
    kind: "jev", ts: T1, ticket: `feat/${String(n).padStart(2, "0")}-t${n}`, point: "route", pick: "product",
    actual: "orchestrator", cost: 0.0001, conf: 0.9, mode: "advisory", fallback: null, floor: null, ms: 150,
    model: "jev-1.13.0", variant: "new", ...over,
  };
}
function claim(n, role, ts = T2, mode = null, feature = "feat") {
  return { seq: ++seq, ts, feature, ticket: `${String(n).padStart(2, "0")}-t${n}`, role, mode, op: "claim" };
}
async function actuals(rows, events) {
  const { buildReport } = await load();
  return buildReport(rows, events).route.actuals;
}

test("a developer claim after the route call gives actual developer, not the logged orchestrator", async () => {
  const [a] = await actuals([route(1, { pick: "developer-direct" })], [claim(1, "developer")]);
  assert.equal(a.actual, "developer");
  assert.equal(a.logged, "orchestrator");
  assert.equal(a.ticket, "feat/01-t1");
  assert.equal(a.pick, "developer-direct");
  assert.equal(a.variant, "new");
});

test("qa claimed with mode specify gives qa-specify; verify gives qa-verify; no mode gives qa", async () => {
  const rows = [route(1), route(2), route(3)];
  const events = [claim(1, "qa", T2, "specify"), claim(2, "qa", T2, "verify"), claim(3, "qa", T2, null)];
  const out = await actuals(rows, events);
  assert.deepEqual(out.map((a) => a.actual), ["qa-specify", "qa-verify", "qa"]);
});

test("other agents report their own name", async () => {
  const rows = [route(1), route(2), route(3), route(4)];
  const events = [claim(1, "product"), claim(2, "architect"), claim(3, "designer"), claim(4, "security")];
  const out = await actuals(rows, events);
  assert.deepEqual(out.map((a) => a.actual), ["product", "architect", "designer", "security"]);
});

test("the next claim wins: earlier claims, other tickets and later hops are ignored", async () => {
  const rows = [route(1, { pick: "qa-specify" })];
  const events = [
    claim(1, "architect", T0), // before the route row
    claim(2, "developer", T2), // another ticket
    claim(1, "developer", T3), // later hop; arrives before the earlier claim below
    claim(1, "qa", T2, "specify"),
    claim(1, "product", T1), // same ts as the row is not after it
  ];
  const [a] = await actuals(rows, events);
  assert.equal(a.actual, "qa-specify");
});

test("a claim in another feature with the same number is not this ticket", async () => {
  const [a] = await actuals([route(1)], [claim(1, "developer", T2, null, "other-feat")]);
  assert.equal(a.actual, null);
});

test("a route row with no later claim reports actual null, not orchestrator", async () => {
  const out = await actuals([route(1), route(2)], [claim(1, "developer", T0)]);
  assert.deepEqual(out.map((a) => a.actual), [null, null]);
});

test("an orchestrator claim after the route call reports orchestrator (it really happened)", async () => {
  const [a] = await actuals([route(1)], [claim(1, "orchestrator", T2)]);
  assert.equal(a.actual, "orchestrator");
});

test("no routed ticket with a later non-orchestrator claim reports orchestrator", async () => {
  const roles = ["product", "architect", "developer", "qa", "designer"];
  const rows = roles.map((_, i) => route(i + 1));
  const events = roles.map((c, i) => claim(i + 1, c, T2, c === "qa" ? "specify" : null));
  const out = await actuals(rows, events);
  assert.ok(out.every((a) => a.actual !== "orchestrator"), JSON.stringify(out));
  assert.ok(out.every((a) => a.logged === "orchestrator"));
});

test("every route row is covered: both variants, every mode, fallback rows, and non-route rows are skipped", async () => {
  const rows = [
    route(1, { variant: "bounce", pick: "developer" }),
    route(2, { mode: "shadow" }),
    route(3, { pick: null, fallback: "http" }),
    route(4, { variant: undefined }),
    { kind: "jev", ts: T1, ticket: "feat/05-t5", point: "tier", pick: "sonnet", actual: "sonnet" },
    { kind: "agent", ticket: "feat/06-t6", role: "developer", tokens: 10 },
  ];
  const events = [1, 2, 3, 4, 5, 6].map((n) => claim(n, "developer"));
  const out = await actuals(rows, events);
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((a) => a.ticket), ["feat/01-t1", "feat/02-t2", "feat/03-t3", "feat/04-t4"]);
  assert.deepEqual(out.map((a) => a.variant), ["bounce", "new", "new", "new"]);
  assert.equal(out[2].pick, null);
  assert.ok(out.every((a) => a.actual === "developer"));
});

test("two route rows on one ticket are each scored against the first claim after their own ts", async () => {
  const rows = [route(1, { ts: T0, pick: "product" }), route(1, { ts: T2, pick: "developer" })];
  const events = [claim(1, "product", T1), claim(1, "developer", T3)];
  const out = await actuals(rows, events);
  assert.deepEqual(out.map((a) => a.actual), ["product", "developer"]);
});

test("buildReport does not mutate the usage rows", async () => {
  const rows = [route(1), route(2, { pick: null, fallback: "http" })];
  const before = JSON.stringify(rows);
  await actuals(rows, [claim(1, "developer")]);
  assert.equal(JSON.stringify(rows), before);
});

test("buildReport without events returns an empty actuals list for no rows, null actuals for rows", async () => {
  const { buildReport } = await load();
  assert.deepEqual(buildReport([]).route.actuals, []);
  assert.equal(buildReport([route(1)]).route.actuals[0].actual, null);
});

test("formatReport prints one 'route actual' line per route row", async () => {
  const { buildReport, formatReport } = await load();
  const rows = [route(1, { pick: "developer-direct" }), route(2, { pick: null, fallback: "http" }), route(3)];
  const events = [claim(1, "developer"), claim(2, "qa", T2, "specify")];
  const out = formatReport(buildReport(rows, events));
  assert.match(out, /^route actual feat\/01-t1: pick developer-direct, actual developer$/m);
  assert.match(out, /^route actual feat\/02-t2: pick none, actual qa-specify$/m);
  assert.match(out, /^route actual feat\/03-t3: pick product, actual none yet$/m);
  assert.doesNotMatch(out, /actual orchestrator/);
});

test("CLI: existing usage.jsonl rows report their real next role from the sibling events.jsonl, file untouched", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-actual-"));
  try {
    const usage = path.join(dir, ".scratch", "usage.jsonl");
    mkdirSync(path.dirname(usage), { recursive: true });
    const text = [route(1, { pick: "developer-direct" }), route(2, { pick: "qa-specify" })].map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(usage, text);
    writeFileSync(
      path.join(dir, ".scratch", "events.jsonl"),
      [claim(1, "developer"), claim(2, "qa", T2, "specify")].map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const env = { ...process.env };
    delete env.DEN_ROOT;
    const run = (argv) => spawnSync(process.execPath, [SCRIPT, "--usage", usage, ...argv], { cwd: dir, env, encoding: "utf8", timeout: 20000 });

    const plain = run([]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /^route actual feat\/01-t1: pick developer-direct, actual developer$/m);
    assert.match(plain.stdout, /^route actual feat\/02-t2: pick qa-specify, actual qa-specify$/m);

    const js = run(["--json"]);
    assert.equal(js.status, 0, js.stderr);
    assert.deepEqual(JSON.parse(js.stdout).route.actuals.map((a) => a.actual), ["developer", "qa-specify"]);

    assert.equal(readFileSync(usage, "utf8"), text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
