// Batch B: organism-infra/47 (jev input hardening) + security Lows from 70, 72, 80.
//
// Ticket 47/1: jev-report.mjs skips null lines, guards against prototype-inherited weights
//   (constructor pick → NaN), and rejects ticket keys that contain | or control characters.
// Ticket 47/2: jev.mjs exits non-zero with a clear message when --ticket names no issue file,
//   and appends no row.
// Low 70: decide({point:"route-bounce", bounceComment:""}) returns a fallback without calling
//   transport (avoids a wasted Jev call on no-bounce tickets; jev.mjs ~line 343).
// Low 72: newInputs() drops events whose feature or ticket contains ".." so the ticketTextOf
//   callback is never invoked with a path-traversal sequence.
// Low 80: runJg is refused when no explicit checkout is given and the root has no .git ancestor
//   (checkout boundary currently skipped when checkoutOf returns null; jg.mjs ~lines 57-61).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const JEV_SCRIPT = path.join(REPO_ROOT, "scripts", "jev.mjs");
// Test key used only locally; never reaches real transport.
const KEY = "sk" + "-test-KEYVALUE-hardening-batch-B-47";
const NOW = new Date("2026-09-30T10:00:00Z");

// ─── helpers ─────────────────────────────────────────────────────────────────

const role = (ticket, c, mode, tokens) =>
  ({ kind: "agent", ticket, role: c, mode, tokens, ms: 1, outcome: "pass" });
const resolved = (ticket, bounces) =>
  ({ kind: "resolved", ts: "2026-09-30T01:00:00Z", ticket, pr: 1, bounces });
const jevRow = (ticket, point, pick, extra = {}) => ({
  kind: "jev", ts: "2026-09-30T00:30:00Z", ticket, point, pick,
  actual: pick, cost: 0.001, conf: 0.9, fallback: null, ms: 100, model: "jev-1.13.0", ...extra,
});

// ─── 47/1: null JSON line ─────────────────────────────────────────────────────

test("47/1: buildReport skips a null row without throwing", async () => {
  const { buildReport } = await import("./jev-report.mjs");
  // null is valid JSON but not an object; accessing null.ticket must not throw
  assert.doesNotThrow(() => buildReport([null]));
});

test("47/1: buildReport skips a non-object row (number, string) without throwing", async () => {
  const { buildReport } = await import("./jev-report.mjs");
  assert.doesNotThrow(() => buildReport([42, "text", true, null, undefined]));
});

// ─── 47/1: constructor pick → NaN ────────────────────────────────────────────

test("47/1: buildReport does not produce NaN in projected.tier when jev pick is 'constructor'", async () => {
  const { buildReport } = await import("./jev-report.mjs");
  const rows = [
    jevRow("f/01-alpha", "tier", "constructor"),   // pick hits Object.prototype.constructor
    role("f/01", "developer", "implement", 1000),
    resolved("f/01", 0),
  ];
  const { tickets } = buildReport(rows);
  const t = tickets.find((x) => x.ticket === "f/01");
  assert.ok(t, "ticket f/01 must be in the report");
  assert.ok(
    Number.isFinite(t.projected.tier),
    `projected.tier must not be NaN when pick is 'constructor' (got ${t.projected.tier})`,
  );
});

test("47/1: buildReport does not produce NaN in projected.verify when jev pick is 'toString'", async () => {
  const { buildReport } = await import("./jev-report.mjs");
  const rows = [
    jevRow("f/01-alpha", "verify", "toString"),   // pick hits Object.prototype.toString
    role("f/01", "qa", "verify", 400),
    role("f/01", "developer", "implement", 1000),
    resolved("f/01", 0),
  ];
  const { tickets } = buildReport(rows);
  const t = tickets.find((x) => x.ticket === "f/01");
  assert.ok(t);
  assert.ok(
    Number.isFinite(t.projected.verify),
    `projected.verify must not be NaN when pick is 'toString' (got ${t.projected.verify})`,
  );
});

// ─── 47/1: ticket key with | or control character ────────────────────────────

test("47/1: buildReport excludes tickets whose key contains '|'", async () => {
  const { buildReport } = await import("./jev-report.mjs");
  const rows = [role("feat|bad/01", "developer", "implement", 500)];
  const { tickets } = buildReport(rows);
  assert.ok(
    !tickets.some((t) => t.ticket.includes("|")),
    `ticket key with '|' must not appear in report; got: ${tickets.map((t) => t.ticket).join(", ")}`,
  );
});

test("47/1: buildReport excludes tickets whose key contains a control character", async () => {
  const { buildReport } = await import("./jev-report.mjs");
  const rows = [role("feat\x01bad/01", "developer", "implement", 500)];
  const { tickets } = buildReport(rows);
  assert.ok(
    !tickets.some((t) => /[\x00-\x1f]/.test(t.ticket)),
    "ticket key with control character must not appear in report",
  );
});

test("47/1: formatReport output contains no '|' from a bad ticket key", async () => {
  const { buildReport, formatReport } = await import("./jev-report.mjs");
  const rows = [
    jevRow("feat|bad/01-thing", "tier", "sonnet"),
    role("feat|bad/01", "developer", "implement", 500),
    resolved("feat|bad/01", 0),
  ];
  const out = formatReport(buildReport(rows));
  // Pipe characters from ticket keys must not reach the formatted output
  const linesWithPipe = out.split("\n").filter((l) => /feat\|bad/.test(l));
  assert.equal(
    linesWithPipe.length, 0,
    `output must not include raw ticket key with '|'; found: ${linesWithPipe.join("; ")}`,
  );
});

// ─── 47/2: jev.mjs unknown ticket ────────────────────────────────────────────

function makeBoardRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), "jev47-"));
  mkdirSync(path.join(dir, ".scratch", "feat", "issues"), { recursive: true });
  writeFileSync(path.join(dir, ".scratch", "usage.jsonl"), "");
  return dir;
}

test("47/2: jev.mjs exits non-zero when --ticket names no issue file on the board", () => {
  const dir = makeBoardRoot();
  // No API key → fallback path exits 0 today (no-key); but unknown ticket must exit non-zero first
  const res = spawnSync(
    process.execPath,
    [JEV_SCRIPT, "tier", "--ticket", "feat/99-does-not-exist"],
    { encoding: "utf8", env: { ...process.env, DEN_ROOT: dir, TYPESAFE_API_KEY: "" } },
  );
  assert.notEqual(
    res.status, 0,
    `expected non-zero exit for unknown ticket; got ${res.status}; stderr: ${res.stderr}`,
  );
});

test("47/2: jev.mjs appends no row when --ticket names no issue file", () => {
  const dir = makeBoardRoot();
  const usagePath = path.join(dir, ".scratch", "usage.jsonl");
  spawnSync(
    process.execPath,
    [JEV_SCRIPT, "tier", "--ticket", "feat/99-does-not-exist"],
    { encoding: "utf8", env: { ...process.env, DEN_ROOT: dir, TYPESAFE_API_KEY: "" } },
  );
  const content = readFileSync(usagePath, "utf8").trim();
  assert.equal(content, "", "no row must be appended when the ticket file does not exist");
});

test("47/2: jev.mjs stderr includes a clear message when the ticket file is missing", () => {
  const dir = makeBoardRoot();
  const res = spawnSync(
    process.execPath,
    [JEV_SCRIPT, "tier", "--ticket", "feat/99-does-not-exist"],
    { encoding: "utf8", env: { ...process.env, DEN_ROOT: dir, TYPESAFE_API_KEY: "" } },
  );
  assert.ok(
    res.stderr.toLowerCase().includes("ticket") || res.stderr.toLowerCase().includes("not found"),
    `stderr must mention the unknown ticket; got: ${res.stderr}`,
  );
});

// ─── Low 70: empty bounceComment skips the Jev call ──────────────────────────

test("Low-70: decide({point:'route-bounce', bounceComment:''}) returns fallback without calling transport", async () => {
  const { decide } = await import("./jev.mjs");
  const calls = [];
  const transport = async (req) => {
    calls.push(req);
    return { pick: "developer", probs: { developer: 0.9, qa: 0.05, architect: 0.04, user: 0.01 }, usage: { cost: 0.001 } };
  };
  const { result, row } = await decide({
    point: "route-bounce",
    ticket: "feat/07-thing",
    ticketText: "# 07\n\n**Status:** in-review\n**Type:** task\n",
    bounceComment: "",        // empty: no bounce verdict on file
    now: NOW,
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    transport,
  });
  assert.equal(calls.length, 0, "transport must not be called when bounceComment is empty");
  assert.ok(result.fallback, `result must carry a fallback reason; got: ${JSON.stringify(result)}`);
  assert.ok(row.fallback, `row must carry a fallback reason; got: ${JSON.stringify(row)}`);
});

// ─── Low 72: newInputs drops events with path traversal in feature/ticket ────

test("Low-72: newInputs drops events whose feature contains '..' (path traversal guard)", async () => {
  const { newInputs } = await import("./jev-wake-prelude.mjs");
  const calledWith = [];
  const noOp = (f, t) => { calledWith.push(`${f}/${t}`); return ""; };
  const since = "2026-09-30T00:00:00Z";
  const events = [
    { op: "comment", feature: "../../etc", ticket: "passwd", role: "developer", ts: "2026-09-30T01:00:00Z", text: "done" },
    { op: "comment", feature: "../sibling", ticket: "01-thing", role: "developer", ts: "2026-09-30T01:00:00Z", text: "done" },
  ];
  newInputs(events, since, noOp);
  assert.equal(
    calledWith.filter((ref) => ref.includes("..")).length, 0,
    `newInputs must not forward traversal sequences to ticketTextOf; called with: ${calledWith.join(", ")}`,
  );
});

test("Low-72: newInputs drops events whose ticket slug contains '..' ", async () => {
  const { newInputs } = await import("./jev-wake-prelude.mjs");
  const calledWith = [];
  const noOp = (f, t) => { calledWith.push(`${f}/${t}`); return ""; };
  const events = [
    { op: "comment", feature: "organism-infra", ticket: "../../../etc/passwd", role: "developer", ts: "2026-09-30T01:00:00Z", text: "ok" },
  ];
  newInputs(events, "2026-09-30T00:00:00Z", noOp);
  assert.equal(
    calledWith.filter((ref) => ref.includes("..")).length, 0,
    `newInputs must not forward traversal sequences to ticketTextOf; called with: ${calledWith.join(", ")}`,
  );
});

// ─── Low 80: runJg refused when no checkout param and no .git ancestor ────────

test("Low-80: runJg is refused when checkout param is omitted and root has no .git ancestor", async () => {
  const { runJg } = await import("./jg.mjs");
  // mkdtempSync in /tmp: no .git above it on any standard Linux system.
  const isolatedRoot = mkdtempSync(path.join(tmpdir(), "jg-no-co-"));
  const run = async () => ({ stdout: "## file.mjs\n", exitCode: 0 });
  // Without a checkout boundary the call is currently allowed; after the fix it must be refused.
  await assert.rejects(
    () => runJg({ query: "find auth code", root: isolatedRoot, run /* no checkout param */ }),
    (err) => {
      // Must reject with a Refused error (not just fail silently)
      const msg = String(err?.message ?? "").toLowerCase();
      return msg.includes("refused") || msg.includes("checkout") || msg.includes("git");
    },
    "runJg must refuse when there is no .git ancestor and no explicit checkout param",
  );
});
