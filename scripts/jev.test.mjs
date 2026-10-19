// organism-infra/38: scripts/jev.mjs, the Jev pre-check script (ADR 0010).
// Seam: exported decide({point, ticket, ticketText, testsText, now, usageRows,
// env, mode, timeoutMs, transport}) -> Promise<{result, row}>, and the CLI.
// The only fake is `transport`; no network, no API key.
//
// Pinned transport contract (the developer implements decide against it):
//   transport({point, text, model, apiKey, signal}) -> Promise<{pick, probs, usage:{cost}}>
//   pick is the Jev label: tier -> standard|hard|other, verify -> light|full|other.
//   Row/result `pick` is mapped: standard->sonnet, hard->opus, light->light, full->full.
//   conf = probs[pick]. `text` is only the assembled input (<= 16000 chars).
// Pinned fallback reasons: no-key, network, http, timeout, unparseable,
// blocked-input, cap.
// CLI board root: $DEN_ROOT (else cwd); ticket at
// <root>/.scratch/<feature>/issues/<NN-slug>.md; rows go to <root>/.scratch/usage.jsonl.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, "scripts", "jev.mjs");
const NOW = new Date("2026-09-29T01:20:00Z");
const TICKET = "feat/07-thing";
const KEY = "sk-" + "test-KEYVALUE-should-never-leak-123";

async function load() {
  return await import("./jev.mjs");
}

function fake(answer, calls = []) {
  return async (req) => {
    calls.push(req);
    return answer;
  };
}
const tierHard = { pick: "hard", probs: { standard: 0.05, hard: 0.93, other: 0.02 }, usage: { cost: 0.0007 } };
const tierStd = { pick: "standard", probs: { standard: 0.9, hard: 0.08, other: 0.02 }, usage: { cost: 0.0004 } };
const verLight = { pick: "light", probs: { light: 0.88, full: 0.1, other: 0.02 }, usage: { cost: 0.0005 } };
const otherAns = { pick: "other", probs: { standard: 0.1, hard: 0.1, other: 0.8 }, usage: { cost: 0.0003 } };

function args(over = {}) {
  return {
    point: "tier",
    ticket: TICKET,
    ticketText: "# 07\n\n**What to build:** a thing.\n",
    testsText: "ok 1\n# pass 3\n",
    now: NOW,
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    ...over,
  };
}

test("tier point returns pick/conf and a full jev row (shadow default: effective stays sonnet)", async () => {
  const { decide } = await load();
  const calls = [];
  const { result, row } = await decide(args({ transport: fake(tierHard, calls) }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "jev-1.13.0");
  assert.equal(result.pick, "opus");
  assert.equal(result.conf, 0.93);
  assert.equal(result.effective, "sonnet");
  assert.equal(result.applied, false);
  assert.equal(row.kind, "jev");
  assert.equal(row.ticket, TICKET);
  assert.equal(row.point, "tier");
  assert.equal(row.pick, "opus");
  assert.equal(row.actual, "sonnet");
  assert.equal(row.cost, 0.0007);
  assert.equal(row.conf, 0.93);
  assert.equal(row.mode, "shadow");
  assert.equal(row.fallback, null);
  assert.equal(row.model, "jev-1.13.0");
  assert.equal(typeof row.ms, "number");
  assert.equal(Date.parse(row.ts), NOW.getTime());
});

test("verify point returns pick/conf and a jev row (shadow: actual stays full)", async () => {
  const { decide } = await load();
  const { result, row } = await decide(args({ point: "verify", qaSpecified: false, transport: fake(verLight) }));
  assert.equal(result.pick, "light");
  assert.equal(result.conf, 0.88);
  assert.equal(result.effective, "full");
  assert.equal(row.point, "verify");
  assert.equal(row.pick, "light");
  assert.equal(row.actual, "full");
  assert.equal(row.mode, "shadow");
});

test("verify input includes the tests text; tier input does not", async () => {
  const { decide } = await load();
  const v = [];
  await decide(args({ point: "verify", testsText: "UNIQUE_TEST_OUTPUT", transport: fake(verLight, v) }));
  assert.match(v[0].text, /UNIQUE_TEST_OUTPUT/);
  const t = [];
  await decide(args({ testsText: "UNIQUE_TEST_OUTPUT", transport: fake(tierStd, t) }));
  assert.doesNotMatch(t[0].text, /UNIQUE_TEST_OUTPUT/);
});

test("live mode applies max(minimum, pick); other gives the fallback default", async () => {
  const { decide } = await load();
  let r = await decide(args({ mode: "live", transport: fake(tierHard) }));
  assert.equal(r.result.effective, "opus");
  assert.equal(r.result.applied, true);
  assert.equal(r.row.actual, "opus");
  assert.equal(r.row.mode, "live");
  r = await decide(args({ mode: "live", transport: fake(tierStd) }));
  assert.equal(r.result.effective, "sonnet");
  r = await decide(args({ mode: "live", transport: fake(otherAns) }));
  assert.equal(r.result.effective, "sonnet");
  assert.equal(r.row.pick, "other");
  r = await decide(args({ mode: "live", point: "verify", transport: fake(verLight) }));
  assert.equal(r.result.effective, "light");
  assert.equal(r.row.actual, "light");
});

test("every fallback reason returns the default, logs fallback, and never throws", async () => {
  const { decide } = await load();
  const cases = [
    ["no-key", { env: {}, transport: fake(tierHard) }],
    ["network", { transport: async () => { throw new Error("ECONNRESET"); } }],
    ["http", { transport: async () => { const e = new Error("HTTP 503"); e.status = 503; throw e; } }],
    ["timeout", { timeoutMs: 30, transport: () => new Promise(() => {}) }],
    ["unparseable", { transport: fake({ nonsense: true }) }],
    ["unparseable", { transport: fake({ pick: "banana", probs: {}, usage: { cost: 0 } }) }],
    ["blocked-input", { ticketText: "key " + "AKIA" + "ABCDEFGHIJKLMNOP here", transport: fake(tierHard) }],
  ];
  for (const [reason, over] of cases) {
    const { result, row } = await decide(args(over));
    assert.equal(row.fallback, reason, `reason ${reason}`);
    assert.equal(result.fallback, reason);
    assert.equal(result.effective, "sonnet");
    assert.equal(row.actual, "sonnet");
    assert.equal(row.pick, null);
    assert.equal(row.cost, 0);
    assert.equal(row.kind, "jev");
  }
  const v = await decide(args({ point: "verify", qaSpecified: false, env: {}, transport: fake(verLight) }));
  assert.equal(v.result.effective, "full");
  assert.equal(v.row.actual, "full");
});

test("a secret pattern in the tests text blocks the call for verify", async () => {
  const { decide } = await load();
  const calls = [];
  const { row } = await decide(
    args({ point: "verify", testsText: "-----BEGIN RSA " + "PRIVATE KEY-----\nabc", transport: fake(verLight, calls) }),
  );
  assert.equal(calls.length, 0);
  assert.equal(row.fallback, "blocked-input");
});

test("cap reached: no network call, fallback cap, cost 0", async () => {
  const { decide } = await load();
  const calls = [];
  const usageRows = [
    { kind: "jev", ts: "2026-09-29T00:10:00Z", cost: 0.3 },
    { kind: "jev", ts: "2026-09-29T00:50:00Z", cost: 0.2 },
  ];
  const { result, row } = await decide(args({ usageRows, transport: fake(tierHard, calls) }));
  assert.equal(calls.length, 0);
  assert.equal(row.fallback, "cap");
  assert.equal(row.cost, 0);
  assert.equal(result.effective, "sonnet");
});

test("cap counts only kind:jev rows from today's UTC date", async () => {
  const { decide } = await load();
  const calls = [];
  const usageRows = [
    { kind: "jev", ts: "2026-09-28T23:59:59Z", cost: 0.9 },
    { kind: "cell", ts: "2026-09-29T00:10:00Z", cost: 5 },
    { kind: "jev", ts: "2026-09-29T00:10:00Z", cost: 0.49 },
  ];
  const { row } = await decide(args({ usageRows, transport: fake(tierHard, calls) }));
  assert.equal(calls.length, 1);
  assert.equal(row.fallback, null);
});

test("input over 16k chars is tail-truncated", async () => {
  const { decide } = await load();
  const calls = [];
  const ticketText = "HEAD_MARKER" + "x".repeat(20000) + "TAIL_MARKER";
  await decide(args({ ticketText, transport: fake(tierStd, calls) }));
  assert.ok(calls[0].text.length <= 16000);
  assert.match(calls[0].text, /TAIL_MARKER$/);
  assert.doesNotMatch(calls[0].text, /HEAD_MARKER/);
});

test("the API key goes to the transport only, never into the row or result", async () => {
  const { decide } = await load();
  const calls = [];
  const { result, row } = await decide(args({ transport: fake(tierStd, calls) }));
  assert.equal(calls[0].apiKey, KEY);
  assert.ok(!JSON.stringify({ result, row }).includes(KEY));
});

// ---- CLI ----

function boardRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "jev-cli-"));
  mkdirSync(path.join(root, ".scratch", "feat", "issues"), { recursive: true });
  writeFileSync(path.join(root, ".scratch", "feat", "issues", "07-thing.md"), "# 07\n\n**What to build:** a thing.\n");
  return root;
}

function cli(root, argv) {
  const env = { ...process.env, DEN_ROOT: root };
  delete env.TYPESAFE_API_KEY;
  return spawnSync(process.execPath, [SCRIPT, ...argv], { cwd: root, env, encoding: "utf8", timeout: 20000 });
}

test("CLI without a key exits 0, prints one JSON line with fallback no-key, appends a shadow row", () => {
  const root = boardRoot();
  const r = cli(root, ["tier", "--ticket", TICKET]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const out = JSON.parse(lines[0]);
  assert.equal(out.fallback, "no-key");
  assert.equal(out.effective, "sonnet");
  const usage = path.join(root, ".scratch", "usage.jsonl");
  assert.ok(existsSync(usage));
  const rows = readFileSync(usage, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "jev");
  assert.equal(rows[0].point, "tier");
  assert.equal(rows[0].mode, "shadow");
  assert.equal(rows[0].fallback, "no-key");
});

test("CLI verify without a key falls back to full and exits 0", () => {
  const root = boardRoot();
  const tests = path.join(root, "tests.txt");
  writeFileSync(tests, "# pass 3\n");
  const r = cli(root, ["verify", "--ticket", TICKET, "--tests", tests]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim()).effective, "full");
});

test("CLI exits 2 on invalid arguments", () => {
  const root = boardRoot();
  for (const argv of [[], ["bogus", "--ticket", TICKET], ["tier"], ["tier", "--ticket", TICKET, "--mode", "wild"]]) {
    const r = cli(root, argv);
    assert.equal(r.status, 2, `argv ${JSON.stringify(argv)}: ${r.stderr}`);
  }
});
