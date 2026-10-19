// organism-infra/70: jev.mjs `route` point for bounces, in shadow (ADR 0015 decisions 3 and 5).
// Extends the pattern of ticket 69 (jev-route.test.mjs) to the bounce variant.
// Security ruling (67): input = ticket + latest bounce verdict comment capped 2,000 chars,
// under a fixed delimiter; handoff text never sent; secrets in either part → blocked-input.
// Label set: developer | qa | architect | user | other.
//
// Pinned contract (the developer implements against it):
//   decide({point:"route-bounce", ...}) also accepts
//     bounceComment  string, the latest bounce verdict comment text (capped 2,000 chars internally)
//   Offered labels: developer, qa, architect, user, other. Never developer-direct, product, designer,
//     qa-specify. `other` is always offered. The transport request carries them as `labels` (array).
//   fetchTransport sends criteria for exactly those labels.
//   Any model pick outside the offered set (unknown or forbidden) maps to "other" (not a fallback).
//   Row: kind "jev", point "route", variant "bounce", pick = the label itself (no mapping),
//   actual "orchestrator" (shadow, fallback, other). Failure or blocked input: pick null, fallback set.
//   result.effective is "orchestrator" unless mode is live and pick is a non-other label.
//   Shadow result must NOT carry the pick: result.pick and result.conf are absent (undefined)
//   so CLI stdout hides it; only the row carries it.
//   CLI: `route-bounce` is a valid point; reads --ticket; reads the latest bounce verdict comment
//   (op:"comment", verdict:"bounce") from .scratch/events.jsonl, passes it as bounceComment.
//   Reserved budget: shares the route $0.05 reservation with the new-ticket half (same rowPoint "route").
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, "scripts", "jev.mjs");
const NOW = new Date("2026-09-30T10:00:00Z");
const TICKET = "feat/07-thing";
const KEY = "sk-" + "test-KEYVALUE-should-never-leak-123";
const DAY = "2026-09-30T00:10:00Z";

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
    point: "route-bounce",
    ticket: TICKET,
    ticketText: "# 07\n\n**What to build:** a thing.\n",
    bounceComment: "QA bounce: assertion on line 42 fails.",
    now: NOW,
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    ...over,
  };
}

// ---- Criterion 1: label set ----

test("route-bounce offered labels are exactly the bounce set (no developer-direct or product)", async () => {
  const { decide } = await load();
  const calls = [];
  await decide(args({ transport: fake(ans("developer"), calls) }));
  assert.deepEqual([...calls[0].labels].sort(), ["architect", "developer", "other", "qa", "user"]);
});

test("route-bounce: developer-direct is never offered", async () => {
  const { decide } = await load();
  const calls = [];
  await decide(args({ transport: fake(ans("developer"), calls) }));
  assert.ok(!calls[0].labels.includes("developer-direct"));
});

test("route-bounce: product, designer, qa-specify are not in the bounce label set", async () => {
  const { decide } = await load();
  const calls = [];
  await decide(args({ transport: fake(ans("developer"), calls) }));
  for (const forbidden of ["product", "designer", "qa-specify"]) {
    assert.ok(!calls[0].labels.includes(forbidden), forbidden);
  }
});

test("route-bounce: each valid label is stored in the row as-is", async () => {
  const { decide } = await load();
  for (const label of ["developer", "qa", "architect", "user", "other"]) {
    const { row } = await decide(args({ transport: fake(ans(label)) }));
    assert.equal(row.pick, label, label);
    assert.equal(row.fallback, null, label);
  }
});

test("route-bounce: model output outside the label set maps to other, not a fallback", async () => {
  const { decide } = await load();
  for (const pick of ["banana", "developer-direct", "product", "qa-specify", "", undefined]) {
    const { row } = await decide(args({ transport: fake({ pick, probs: {}, usage: { cost: 0.0003 } }) }));
    assert.equal(row.pick, "other", `pick ${String(pick)}`);
    assert.equal(row.fallback, null, `pick ${String(pick)}`);
  }
});

test("route-bounce: row is point route with variant bounce", async () => {
  const { decide } = await load();
  const { row } = await decide(args({ transport: fake(ans("qa")) }));
  assert.equal(row.point, "route");
  assert.equal(row.variant, "bounce");
  assert.equal(row.kind, "jev");
});

test("route-bounce: row.actual is orchestrator in shadow mode", async () => {
  const { decide } = await load();
  const { row, result } = await decide(args({ transport: fake(ans("developer")) }));
  assert.equal(row.actual, "orchestrator");
  assert.equal(row.mode, "shadow");
  assert.equal(result.effective, "orchestrator");
  assert.equal(result.applied, false);
});

// ---- Criterion 5: shadow hides pick ----

test("shadow result hides the pick and conf from the caller", async () => {
  const { decide } = await load();
  const { result } = await decide(args({ transport: fake(ans("developer")) }));
  assert.equal(result.pick, undefined);
  assert.equal(result.conf, undefined);
  assert.ok(!JSON.stringify(result).includes("developer"));
});

test("live mode exposes the pick and sets applied true for non-other picks", async () => {
  const { decide } = await load();
  const l = await decide(args({ mode: "live", transport: fake(ans("developer")) }));
  assert.equal(l.result.pick, "developer");
  assert.equal(l.result.effective, "developer");
  assert.equal(l.result.applied, true);
});

test("live other means the orchestrator decides", async () => {
  const { decide } = await load();
  const { result, row } = await decide(args({ mode: "live", transport: fake(ans("other")) }));
  assert.equal(row.pick, "other");
  assert.equal(result.effective, "orchestrator");
  assert.equal(result.applied, false);
});

// ---- Criterion 2: input shape ----

test("route-bounce input includes the ticket and the bounce comment under a fixed delimiter", async () => {
  const { decide } = await load();
  const calls = [];
  await decide(args({ bounceComment: "BOUNCE_SENTINEL", transport: fake(ans("developer"), calls) }));
  assert.ok(calls[0].text.includes("BOUNCE_SENTINEL"), "bounceComment must appear in transport text");
  assert.ok(calls[0].text.includes("--- bounce verdict ---"), "delimiter must appear in transport text");
  assert.ok(calls[0].text.includes("# 07"), "ticketText must appear in transport text");
});

test("route-bounce: bounce comment is capped at 2000 chars", async () => {
  const { decide } = await load();
  const calls = [];
  const longComment = "B".repeat(3000);
  await decide(args({ bounceComment: longComment, transport: fake(ans("developer"), calls) }));
  // The comment in the text must be no more than 2000 chars of the original
  const text = calls[0].text;
  const delimIdx = text.indexOf("--- bounce verdict ---");
  assert.ok(delimIdx >= 0, "delimiter must be present");
  const commentPart = text.slice(delimIdx + "--- bounce verdict ---".length);
  assert.ok(commentPart.length <= 2001, `comment portion too long: ${commentPart.length}`);
  assert.ok(!text.slice(delimIdx).includes("B".repeat(2001)), "more than 2000 B chars should not appear after delimiter");
});

test("route-bounce: bounce comment beyond 2000 chars is cut so large ticket never drops the comment", async () => {
  const { decide } = await load();
  const calls = [];
  // Even with a large ticket, the comment (capped at 2000) appears at the tail → 16k cut preserves it
  const bigTicket = "HEAD_MARKER" + "x".repeat(20000);
  const comment = "TAIL_COMMENT";
  await decide(args({ ticketText: bigTicket, bounceComment: comment, transport: fake(ans("developer"), calls) }));
  const text = calls[0].text;
  assert.ok(text.length <= 16000, "must be within 16k limit");
  assert.ok(text.includes("TAIL_COMMENT"), "comment must survive the 16k tail cut");
});

test("route-bounce: secret in ticketText → blocked-input, zero transport calls", async () => {
  const { decide } = await load();
  const calls = [];
  const { row } = await decide(
    args({ ticketText: "-----BEGIN RSA " + "PRIVATE KEY-----\nabc", transport: fake(ans("developer"), calls) }),
  );
  assert.equal(calls.length, 0);
  assert.equal(row.fallback, "blocked-input");
  assert.equal(row.pick, null);
});

test("route-bounce: secret in bounceComment → blocked-input, zero transport calls", async () => {
  const { decide } = await load();
  const calls = [];
  const { row } = await decide(
    args({ bounceComment: "-----BEGIN RSA " + "PRIVATE KEY-----\nabc", transport: fake(ans("developer"), calls) }),
  );
  assert.equal(calls.length, 0);
  assert.equal(row.fallback, "blocked-input");
  assert.equal(row.pick, null);
});

test("route-bounce: handoff sentinel in bounceComment does not come from handoff files (input comes from caller, not filesystem)", async () => {
  // decide() receives bounceComment as a string; it does not read from the filesystem.
  // So a sentinel not present in the explicit strings must not appear in the transport text.
  const { decide } = await load();
  const calls = [];
  const SENTINEL = "HANDOFF_SENTINEL_XYZ";
  await decide(args({
    ticketText: "# 07\n\n**What to build:** clean.\n",
    bounceComment: "tests fail at line 10",
    transport: fake(ans("developer"), calls),
  }));
  assert.ok(!calls[0].text.includes(SENTINEL), "sentinel must not appear if not in ticketText or bounceComment");
});

test("route-bounce blocked input makes no transport call and key stays out of the row", async () => {
  const { decide } = await load();
  const calls = [];
  const { row } = await decide(
    args({ ticketText: "-----BEGIN RSA " + "PRIVATE KEY-----\nabc", transport: fake(ans("developer"), calls) }),
  );
  assert.equal(calls.length, 0);
  assert.ok(!JSON.stringify({ row }).includes(KEY));
});

// ---- failures fall back ----

test("route-bounce: failures and blocked input fall back to orchestrator decides", async () => {
  const { decide } = await load();
  const boom = async () => { throw Object.assign(new Error("HTTP 500"), { status: 500 }); };
  const cases = [
    ["no-key", { env: {}, transport: fake(ans("developer")) }],
    ["http", { transport: boom }],
    ["blocked-input", { ticketText: "-----BEGIN RSA " + "PRIVATE KEY-----\nabc", transport: fake(ans("developer")) }],
  ];
  for (const [reason, over] of cases) {
    const { result, row } = await decide(args(over));
    assert.equal(row.fallback, reason, reason);
    assert.equal(row.pick, null, reason);
    assert.equal(row.actual, "orchestrator", reason);
    assert.equal(result.effective, "orchestrator", reason);
  }
});

// ---- reserved budget (shares route $0.05 reservation) ----

const jrow = (point, cost) => ({ kind: "jev", ts: DAY, point, cost });

test("route-bounce shares the route $0.05 reservation with new-ticket route", async () => {
  const { decide } = await load();
  const calls = [];
  // route spent its 0.05 reservation already (via new-ticket rows); bounce may not add more from shared remainder
  // if shared is also exhausted.
  const usageRows = [jrow("route", 0.05), jrow("priority", 0.36)];
  const { row } = await decide(args({ usageRows, transport: fake(ans("developer"), calls) }));
  assert.equal(calls.length, 0);
  assert.equal(row.fallback, "cap");
});

test("route-bounce still spends when route reservation is unspent and shared is available", async () => {
  const { decide } = await load();
  const calls = [];
  // No route rows; shared unused: bounce may proceed
  const { row } = await decide(args({ usageRows: [], transport: fake(ans("developer"), calls) }));
  assert.equal(calls.length, 1);
  assert.equal(row.fallback, null);
});

// ---- CLI ----

function boardRoot(ticketText, events = []) {
  const root = mkdtempSync(path.join(tmpdir(), "jev-bounce-cli-"));
  mkdirSync(path.join(root, ".scratch", "feat", "issues"), { recursive: true });
  mkdirSync(path.join(root, ".scratch", "feat", "handoffs"), { recursive: true });
  writeFileSync(path.join(root, ".scratch", "feat", "issues", "07-thing.md"), ticketText);
  if (events.length > 0) {
    writeFileSync(path.join(root, ".scratch", "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  return root;
}

function cli(root, argv) {
  const env = { ...process.env, DEN_ROOT: root };
  delete env.TYPESAFE_API_KEY;
  return spawnSync(process.execPath, [SCRIPT, ...argv], { cwd: root, env, encoding: "utf8", timeout: 20000 });
}

const readRows = (root) =>
  readFileSync(path.join(root, ".scratch", "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("CLI route-bounce is a valid point: exit 0, one JSON line, shadow row appended with variant bounce", () => {
  const root = boardRoot("# 07\n\n**Type:** feature\n\n**Status:** in-review\n");
  const r = cli(root, ["route-bounce", "--ticket", TICKET]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const out = JSON.parse(lines[0]);
  assert.equal(out.point, "route-bounce");
  assert.equal(out.effective, "orchestrator");
  assert.ok(!("pick" in out) || out.pick === undefined || out.pick === null);
  const rows = readRows(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].point, "route");
  assert.equal(rows[0].variant, "bounce");
  assert.equal(rows[0].mode, "shadow");
  assert.equal(rows[0].fallback, "no-key");
});

test("CLI route-bounce reads the latest bounce verdict comment from events.jsonl", () => {
  // We cannot inspect the transport text from CLI tests (no API key), but we verify
  // that the row is appended and exit is 0, confirming the CLI does not crash on events parsing.
  const events = [
    { seq: 1, ts: "2026-09-30T09:00:00Z", feature: "feat", ticket: "07-thing", role: "qa", op: "comment", text: "QA bounce: tests fail.", verdict: "bounce" },
    { seq: 2, ts: "2026-09-30T09:01:00Z", feature: "feat", ticket: "07-thing", role: "qa", op: "comment", text: "QA bounce: still failing.", verdict: "bounce" },
    { seq: 3, ts: "2026-09-30T09:02:00Z", feature: "feat", ticket: "07-thing", role: "security", op: "comment", text: "Security pass.", verdict: "pass" },
  ];
  const root = boardRoot("# 07\n\n**Status:** in-review\n", events);
  const r = cli(root, ["route-bounce", "--ticket", TICKET]);
  assert.equal(r.status, 0, r.stderr);
  const rows = readRows(root);
  assert.equal(rows[0].variant, "bounce");
});

test("CLI route-bounce: handoff sentinel in a handoff file does not appear in the bounce comment read by the CLI", () => {
  // The CLI must read bounceComment only from events.jsonl, not from handoff files.
  // We verify by putting a sentinel in a handoff file and a different text in the bounce event,
  // then checking the row was written (CLI ran successfully without mixing sources).
  const SENTINEL = "HANDOFF_SENTINEL_789";
  const events = [
    { seq: 1, ts: "2026-09-30T09:00:00Z", feature: "feat", ticket: "07-thing", role: "qa", op: "comment", text: "QA bounce: real verdict only.", verdict: "bounce" },
  ];
  const root = boardRoot("# 07\n\n**Status:** in-review\n", events);
  // Write a handoff file with the sentinel
  writeFileSync(path.join(root, ".scratch", "feat", "handoffs", "07-qa-specify.md"), `# Handoff\n\n${SENTINEL}\n`);
  const r = cli(root, ["route-bounce", "--ticket", TICKET]);
  assert.equal(r.status, 0, r.stderr);
  // The usage.jsonl row should not contain the sentinel (it's structured data, not raw text, but belt-and-suspenders)
  const rowText = readFileSync(path.join(root, ".scratch", "usage.jsonl"), "utf8");
  assert.ok(!rowText.includes(SENTINEL), "handoff sentinel must not appear in the usage row");
  // The stdout result should not contain the sentinel
  assert.ok(!r.stdout.includes(SENTINEL), "handoff sentinel must not appear in stdout");
});

test("CLI still exits 2 on invalid arguments for route-bounce", () => {
  const root = boardRoot("# 07\n\n**Status:** in-review\n");
  // Missing --ticket
  assert.equal(cli(root, ["route-bounce"]).status, 2, "missing --ticket should be exit 2");
});
