// organism-infra/69: jev.mjs `route` point for new tickets, in shadow, plus reserved budget
// (ADR 0015 decisions 3 and 7). Seam: exported decide(...), fetchTransport(...) and the CLI.
// The only fake is `transport` (and a stubbed globalThis.fetch for fetchTransport); no network.
//
// Pinned contract (the developer implements against it):
//   decide({point:"route", ...}) also accepts
//     variant      "new" (default; the bounce variant is ticket 70)
//     codeTicket   boolean, default true (safe). developer-direct is offered only when false.
//     forbid       string[], extra labels the state machine forbids; removed before the call.
//     status       ticket Status. When given and not "ready-for-agent" the state machine dictates
//                  the next agent: no transport call, row.fallback "state-machine", cost 0.
//   Offered labels: product, architect, designer, qa-specify, user, other, plus developer-direct
//   when codeTicket is false, minus `forbid`. `other` is always offered. The transport request
//   carries them as `labels` (array). fetchTransport sends criteria for exactly those labels.
//   Any model pick outside the offered set (unknown or forbidden) maps to "other" (not unparseable).
//   Row: kind "jev", point "route", variant "new", pick = the label itself (no mapping),
//   actual "orchestrator" whenever nothing is applied (shadow, fallback, other). Failure or
//   blocked input: pick null, fallback set, actual "orchestrator".
//   result.effective is "orchestrator" unless mode is live and pick is a non-other label.
//   Shadow result must NOT carry the pick: result.pick and result.conf are absent (undefined)
//   so the CLI stdout hides it; only the row carries it. In live mode result.pick is present.
//   Reserved budget: $0.05 each for tier, verify, route inside the CAP of 0.5; the unreserved
//   remainder is 0.35. Today's rows are grouped by row.point (rows without a point draw shared
//   only). Call is refused with fallback "cap" when today's total >= CAP, or when the point's own
//   spend >= its reservation and today's shared draw (sum over points of max(0, own - reserve))
//   >= 0.35. A point under its reservation is never blocked by shared exhaustion.
//   CLI: `route` is a valid point; it reads `**Status:**` from the ticket and passes it as `status`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, "scripts", "jev.mjs");
const NOW = new Date("2026-09-29T01:20:00Z");
const TICKET = "feat/07-thing";
const KEY = "sk-" + "test-KEYVALUE-should-never-leak-123";
const DAY = "2026-09-29T00:10:00Z";

const load = () => import("./jev.mjs");
const ans = (pick, cost = 0.0004) => ({ pick, probs: { [pick]: 0.9, other: 0.1 }, usage: { cost } });
function fake(answer, calls = []) {
  return async (req) => {
    calls.push(req);
    return answer;
  };
}
function args(over = {}) {
  return {
    point: "route",
    ticket: TICKET,
    ticketText: "# 07\n\n**What to build:** a thing.\n",
    now: NOW,
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    ...over,
  };
}
const jrow = (point, cost) => ({ kind: "jev", ts: DAY, point, cost });

test("route returns the label in the row, in shadow the orchestrator decides", async () => {
  const { decide } = await load();
  const calls = [];
  const { row } = await decide(args({ transport: fake(ans("architect"), calls) }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].point, "route");
  assert.equal(row.kind, "jev");
  assert.equal(row.point, "route");
  assert.equal(row.variant, "new");
  assert.equal(row.pick, "architect");
  assert.equal(row.actual, "orchestrator");
  assert.equal(row.mode, "shadow");
  assert.equal(row.fallback, null);
  assert.equal(row.cost, 0.0004);
});

test("shadow result hides the pick and conf from the caller; live shows them", async () => {
  const { decide } = await load();
  const s = await decide(args({ transport: fake(ans("product")) }));
  assert.equal(s.result.pick, undefined);
  assert.equal(s.result.conf, undefined);
  assert.equal(s.result.effective, "orchestrator");
  assert.equal(s.result.applied, false);
  assert.ok(!JSON.stringify(s.result).includes("product"));
  const l = await decide(args({ mode: "live", transport: fake(ans("product")) }));
  assert.equal(l.result.pick, "product");
  assert.equal(l.result.effective, "product");
  assert.equal(l.result.applied, true);
});

test("live other means the orchestrator decides", async () => {
  const { decide } = await load();
  const { result, row } = await decide(args({ mode: "live", transport: fake(ans("other")) }));
  assert.equal(row.pick, "other");
  assert.equal(result.effective, "orchestrator");
  assert.equal(result.applied, false);
});

test("code ticket: offered labels are the closed set without developer-direct, other always included", async () => {
  const { decide } = await load();
  const calls = [];
  await decide(args({ codeTicket: true, transport: fake(ans("product"), calls) }));
  assert.deepEqual([...calls[0].labels].sort(), ["architect", "designer", "other", "product", "qa-specify", "user"]);
});

test("non-code ticket: the full label set including developer-direct is offered", async () => {
  const { decide } = await load();
  const calls = [];
  await decide(args({ codeTicket: false, transport: fake(ans("developer-direct"), calls) }));
  assert.deepEqual(
    [...calls[0].labels].sort(),
    ["architect", "designer", "developer-direct", "other", "product", "qa-specify", "user"],
  );
});

test("code ticket is the default when codeTicket is omitted", async () => {
  const { decide } = await load();
  const calls = [];
  await decide(args({ transport: fake(ans("product"), calls) }));
  assert.ok(!calls[0].labels.includes("developer-direct"));
});

test("forbid removes labels before the call", async () => {
  const { decide } = await load();
  const calls = [];
  await decide(args({ codeTicket: false, forbid: ["designer", "user"], transport: fake(ans("product"), calls) }));
  assert.ok(!calls[0].labels.includes("designer"));
  assert.ok(!calls[0].labels.includes("user"));
  assert.ok(calls[0].labels.includes("developer-direct"));
  assert.ok(calls[0].labels.includes("other"));
});

test("a forbidden label the model returns anyway maps to other", async () => {
  const { decide } = await load();
  const a = await decide(args({ codeTicket: true, mode: "live", transport: fake(ans("developer-direct")) }));
  assert.equal(a.row.pick, "other");
  assert.equal(a.row.fallback, null);
  assert.equal(a.result.effective, "orchestrator");
  const b = await decide(args({ forbid: ["designer"], transport: fake(ans("designer")) }));
  assert.equal(b.row.pick, "other");
});

test("any output outside the label set maps to other, not to a fallback", async () => {
  const { decide } = await load();
  for (const pick of ["banana", "standard", "", undefined, 7]) {
    const { row } = await decide(args({ transport: fake({ pick, probs: {}, usage: { cost: 0.0003 } }) }));
    assert.equal(row.pick, "other", `pick ${String(pick)}`);
    assert.equal(row.fallback, null);
  }
});

test("state machine dictates the next agent: no call, fallback state-machine, cost 0", async () => {
  const { decide } = await load();
  for (const status of ["in-review", "claimed", "blocked", "resolved", "ready-for-human"]) {
    const calls = [];
    const { result, row } = await decide(args({ status, transport: fake(ans("product"), calls) }));
    assert.equal(calls.length, 0, status);
    assert.equal(row.fallback, "state-machine", status);
    assert.equal(row.cost, 0);
    assert.equal(row.pick, null);
    assert.equal(result.effective, "orchestrator");
  }
});

test("ready-for-agent (or no status) does call", async () => {
  const { decide } = await load();
  const calls = [];
  await decide(args({ status: "ready-for-agent", transport: fake(ans("product"), calls) }));
  await decide(args({ transport: fake(ans("product"), calls) }));
  assert.equal(calls.length, 2);
});

test("failures and blocked input fall back to orchestrator decides", async () => {
  const { decide } = await load();
  const boom = async () => {
    throw Object.assign(new Error("HTTP 500"), { status: 500 });
  };
  const cases = [
    ["no-key", { env: {}, transport: fake(ans("product")) }],
    ["http", { transport: boom }],
    ["blocked-input", { ticketText: "-----BEGIN RSA " + "PRIVATE KEY-----\nabc", transport: fake(ans("product")) }],
  ];
  for (const [reason, over] of cases) {
    const { result, row } = await decide(args(over));
    assert.equal(row.fallback, reason);
    assert.equal(row.pick, null);
    assert.equal(row.actual, "orchestrator");
    assert.equal(row.cost, 0);
    assert.equal(result.effective, "orchestrator");
  }
});

test("blocked input makes no transport call, and the key stays out of the row", async () => {
  const { decide } = await load();
  const calls = [];
  const { result, row } = await decide(
    args({ ticketText: "-----BEGIN RSA " + "PRIVATE KEY-----\nabc", transport: fake(ans("product"), calls) }),
  );
  assert.equal(calls.length, 0);
  assert.ok(!JSON.stringify({ result, row }).includes(KEY));
});

test("input is tail-truncated to 16000 chars for route too", async () => {
  const { decide } = await load();
  const calls = [];
  await decide(args({ ticketText: "HEAD_MARKER" + "x".repeat(20000) + "TAIL_MARKER", transport: fake(ans("product"), calls) }));
  assert.ok(calls[0].text.length <= 16000);
  assert.match(calls[0].text, /TAIL_MARKER$/);
});

// ---- reserved budget ----

test("reserved budget: shared exhausted by other points, route still spends its own $0.05", async () => {
  const { decide } = await load();
  const calls = [];
  // priority 0.36 (all shared, reserve 0) + tier 0.05 + verify 0.05 = 0.46 < 0.5
  const usageRows = [jrow("priority", 0.36), jrow("tier", 0.05), jrow("verify", 0.05)];
  const { row } = await decide(args({ usageRows, transport: fake(ans("product"), calls) }));
  assert.equal(calls.length, 1);
  assert.equal(row.fallback, null);
});

test("reserved budget: route over its reservation draws only from the shared remainder, which is spent", async () => {
  const { decide } = await load();
  const calls = [];
  // route spent its 0.05; priority spent all 0.36 shared. Total 0.41 < 0.5 but route may not touch others' reservations.
  const usageRows = [jrow("route", 0.05), jrow("priority", 0.36)];
  const { result, row } = await decide(args({ usageRows, transport: fake(ans("product"), calls) }));
  assert.equal(calls.length, 0);
  assert.equal(row.fallback, "cap");
  assert.equal(row.cost, 0);
  assert.equal(row.actual, "orchestrator");
  assert.equal(result.effective, "orchestrator");
});

test("reserved budget: route over its reservation may draw from the unspent shared remainder", async () => {
  const { decide } = await load();
  const calls = [];
  // route 0.20 = 0.05 reserved + 0.15 shared overflow; shared used 0.15 < 0.35
  const { row } = await decide(args({ usageRows: [jrow("route", 0.2)], transport: fake(ans("product"), calls) }));
  assert.equal(calls.length, 1);
  assert.equal(row.fallback, null);
});

test("reserved budget: other points' overflow counts against the shared remainder", async () => {
  const { decide } = await load();
  const calls = [];
  // tier 0.40 = 0.05 reserved + 0.35 shared (exhausted); route spent its own 0.05
  const usageRows = [jrow("tier", 0.4), jrow("route", 0.05)];
  const { row } = await decide(args({ usageRows, transport: fake(ans("product"), calls) }));
  assert.equal(calls.length, 0);
  assert.equal(row.fallback, "cap");
});

test("reserved budget: verify and tier are held to the same rule", async () => {
  const { decide } = await load();
  for (const point of ["tier", "verify"]) {
    const calls = [];
    const usageRows = [jrow(point, 0.05), jrow("priority", 0.36)];
    const ok = { pick: point === "tier" ? "standard" : "light", probs: { standard: 0.9, light: 0.9, other: 0.1 }, usage: { cost: 0.0003 } };
    const { row } = await decide(args({ point, testsText: "# pass 3\n", usageRows, transport: fake(ok, calls) }));
    assert.equal(calls.length, 0, point);
    assert.equal(row.fallback, "cap", point);
    // and each is served from its own reservation when unspent
    const fresh = await decide(args({ point, testsText: "# pass 3\n", usageRows: [jrow("priority", 0.36)], transport: fake(ok, calls) }));
    assert.equal(fresh.row.fallback, null, point);
  }
});

test("total cap still binds every point, even one under its reservation", async () => {
  const { decide } = await load();
  const calls = [];
  const usageRows = [jrow("priority", 0.3), jrow("wake", 0.2)];
  const { row } = await decide(args({ usageRows, transport: fake(ans("product"), calls) }));
  assert.equal(calls.length, 0);
  assert.equal(row.fallback, "cap");
});

test("budget counts only today's kind:jev rows", async () => {
  const { decide } = await load();
  const calls = [];
  const usageRows = [
    { kind: "jev", ts: "2026-09-28T23:59:59Z", point: "route", cost: 0.9 },
    { kind: "cell", ts: DAY, point: "route", cost: 5 },
  ];
  await decide(args({ usageRows, transport: fake(ans("product"), calls) }));
  assert.equal(calls.length, 1);
});

// ---- transport request shape ----

test("fetchTransport sends route criteria for exactly the offered labels", async () => {
  const { fetchTransport } = await load();
  const realFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ answers: { route: { choice: "product", probabilities: { product: 1 } } }, usage: { input_tokens: 100 } }) };
  };
  try {
    const labels = ["product", "architect", "designer", "qa-specify", "user", "other"];
    const out = await fetchTransport({ point: "route", text: "t", model: "jev-1.13.0", apiKey: KEY, labels });
    assert.equal(out.pick, "product");
    assert.deepEqual(Object.keys(body.questions.route.criteria).sort(), [...labels].sort());
    assert.ok(!("developer-direct" in body.questions.route.criteria));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- CLI ----

function boardRoot(ticketText) {
  const root = mkdtempSync(path.join(tmpdir(), "jev-route-cli-"));
  mkdirSync(path.join(root, ".scratch", "feat", "issues"), { recursive: true });
  writeFileSync(path.join(root, ".scratch", "feat", "issues", "07-thing.md"), ticketText);
  return root;
}
function cli(root, argv) {
  const env = { ...process.env, DEN_ROOT: root };
  delete env.TYPESAFE_API_KEY;
  return spawnSync(process.execPath, [SCRIPT, ...argv], { cwd: root, env, encoding: "utf8", timeout: 20000 });
}
const readRows = (root) =>
  readFileSync(path.join(root, ".scratch", "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("CLI route without a key: exit 0, one JSON line, no pick shown, shadow row appended", () => {
  const root = boardRoot("# 07\n\n**Type:** feature\n\n**Status:** ready-for-agent\n");
  const r = cli(root, ["route", "--ticket", TICKET]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const out = JSON.parse(lines[0]);
  assert.equal(out.point, "route");
  assert.equal(out.effective, "orchestrator");
  assert.ok(!("pick" in out) || out.pick === undefined || out.pick === null);
  const rows = readRows(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].point, "route");
  assert.equal(rows[0].mode, "shadow");
  assert.equal(rows[0].fallback, "no-key");
});

test("CLI route on an in-review ticket: state machine dictates, no call, fallback state-machine", () => {
  const root = boardRoot("# 07\n\n**Status:** in-review\n");
  const r = cli(root, ["route", "--ticket", TICKET]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readRows(root)[0].fallback, "state-machine");
  assert.equal(JSON.parse(r.stdout.trim()).effective, "orchestrator");
});

test("CLI still exits 2 on invalid arguments for route", () => {
  const root = boardRoot("# 07\n\n**Status:** ready-for-agent\n");
  for (const argv of [["route"], ["route", "--ticket", TICKET, "--mode", "wild"]]) {
    assert.equal(cli(root, argv).status, 2, JSON.stringify(argv));
  }
});
