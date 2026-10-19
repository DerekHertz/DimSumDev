// organism-infra/72: scripts/jev-wake-prelude.mjs, wake-up gate prelude (ADR 0015 decision 6).
//
// Seam: exported codeDecides({frontierCount, usagePct, ciRed, conflicted, openVerdictRequest, ciUnknown, inFlightCount})
//   -> { wake: true, reason: string } | { wake: false, reason?: string }
// and runPrelude({context, inputs, usageRows, env, now, transport, mode})
//   -> Promise<{ wake: boolean, reason: string, rows: object[] }>
//
// Pinned contract (developer implements against this):
//   codeDecides(ctx) is a pure function returning { wake: true, reason } when any code-decidable
//   condition holds: ciRed, conflicted, ciUnknown, openVerdictRequest, inFlightCount > 0, or
//   frontierCount > 0 while usagePct < 0.9. Usage alone never wakes; at 0.9+ it suppresses the frontier wake
//   (Scope added, user verdict 2026-09-30; wind-down moved from 80% to 90%, user 2026-10-01, organism-infra/91). Returns { wake: false } when none hold.
//
//   runPrelude(args) runs the full prelude:
//     1. Calls codeDecides first; if wake, returns { wake: true, reason, rows: [] } without calling Jev.
//     2. For each input not caught by codeWakes (i.e., not user-authored, not Scope-added, not verdict),
//        calls jev.decide({point:"wake", ...input, usageRows, env, now, transport, mode}).
//     3. Any "needs-claude" or "other" pick, or any fallback on any input → wake: true overall.
//     4. All inputs "informational" (or no inputs) → wake: false.
//     5. Returns { wake, reason, rows } where rows are the jev row objects from each decide() call.
//     6. No daemon, no timer: the returned Promise resolves and no interval/timer is retained.
//
//   Input object shape: { newComment?, author?, verdict?, ticketText, ticket }
//     (same fields that jev.decide's wake point uses)
//
//   AC6: input sent to Jev is only the ticket header and new comment
//     (enforced by jev.mjs INPUTS.wake; already covered by exposure.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, "scripts", "jev-wake-prelude.mjs");
const NOW = new Date("2026-09-30T10:00:00Z");
const KEY = "sk" + "-test-KEYVALUE-wake-prelude-72-test";
const TICKET = "organism-infra/72-thing";
const TICKET_TEXT = "# 72\n\n**Status:** ready-for-agent\n\n**What to build:** a thing.\n";

const needsClaude = {
  pick: "needs-claude",
  probs: { "needs-claude": 0.9, informational: 0.08, other: 0.02 },
  usage: { cost: 0.0004 },
};
const informational = {
  pick: "informational",
  probs: { "needs-claude": 0.05, informational: 0.93, other: 0.02 },
  usage: { cost: 0.0004 },
};
const otherAns = {
  pick: "other",
  probs: { "needs-claude": 0.1, informational: 0.1, other: 0.8 },
  usage: { cost: 0.0003 },
};

function fake(answer, calls = []) {
  return async (req) => { calls.push(req); return answer; };
}

async function load() {
  return await import("./jev-wake-prelude.mjs");
}

const noCode = {
  frontierCount: 0,
  usagePct: 0.5,
  ciRed: false,
  conflicted: false,
  openVerdictRequest: false,
};

// ─── AC1: code-decidable conditions wake without calling Jev ──────────────────

test("codeDecides: frontier non-empty returns wake:true with a reason string", async () => {
  const { codeDecides } = await load();
  const r = codeDecides({ ...noCode, frontierCount: 1 });
  assert.equal(r.wake, true);
  assert.ok(typeof r.reason === "string" && r.reason.length > 0, "reason must be a non-empty string");
});

test("codeDecides: frontierCount 0 does not wake", async () => {
  const { codeDecides } = await load();
  assert.equal(codeDecides({ ...noCode, frontierCount: 0 }).wake, false);
});

// Scope added (user verdict, 2026-09-30), superseding qa's pinned "usage at 80% wakes": at 90%+ usage (organism-infra/91
// moved the line from 80%) never wakes on its own and suppresses frontier wakes; wind-down items still wake.
test("codeDecides: usage alone never wakes, at any level", async () => {
  const { codeDecides } = await load();
  for (const usagePct of [0.5, 0.799, 0.8, 0.899, 0.9, 1.0]) {
    assert.equal(codeDecides({ ...noCode, usagePct }).wake, false, `${usagePct * 100}% alone must not wake`);
  }
});

test("[91] AC1: usage at 90%+ suppresses a frontier wake; 89.9% does not", async () => {
  const { codeDecides } = await load();
  for (const usagePct of [0.9, 0.95, 1.0]) {
    const r = codeDecides({ ...noCode, frontierCount: 2, usagePct });
    assert.equal(r.wake, false, `frontier must not wake at ${usagePct * 100}%`);
    assert.match(r.reason, /suppress/, "a suppressed frontier says so in the reason");
  }
  assert.equal(codeDecides({ ...noCode, frontierCount: 2, usagePct: 0.899 }).wake, true, "89.9% keeps the frontier wake");
});

test("[91] AC1: the old 80% line no longer suppresses a frontier wake (80%, 85%, 89% all wake)", async () => {
  const { codeDecides } = await load();
  for (const usagePct of [0.8, 0.85, 0.89]) {
    const r = codeDecides({ ...noCode, frontierCount: 2, usagePct });
    assert.equal(r.wake, true, `frontier must still wake at ${usagePct * 100}%`);
    assert.match(r.reason, /frontier/);
  }
});

test("[91] AC1: the suppression reason names the 90% reading", async () => {
  const { codeDecides } = await load();
  assert.match(codeDecides({ ...noCode, frontierCount: 2, usagePct: 0.9 }).reason, /usage at 90%/);
});

test("[91] AC2: wind-down items still wake at 90%+ usage, including exactly 90% and 89.9%", async () => {
  const { codeDecides } = await load();
  for (const usagePct of [0.899, 0.9, 1.0]) {
    const high = { ...noCode, frontierCount: 2, usagePct };
    for (const item of [{ inFlightCount: 1 }, { ciRed: true }, { conflicted: true }, { openVerdictRequest: true }, { ciUnknown: true }]) {
      assert.equal(codeDecides({ ...high, ...item }).wake, true, `${JSON.stringify(item)} must wake at ${usagePct * 100}%`);
    }
  }
});

test("codeDecides: an agent in flight wakes; none does not", async () => {
  const { codeDecides } = await load();
  const r = codeDecides({ ...noCode, inFlightCount: 1 });
  assert.equal(r.wake, true);
  assert.match(r.reason, /in flight/);
  assert.equal(codeDecides({ ...noCode, inFlightCount: 0 }).wake, false);
});

test("[91] AC1: runPrelude at 90%+ usage: a frontier alone does not wake, and says why", async () => {
  const { runPrelude } = await load();
  const r = await runPrelude({
    context: { ...noCode, frontierCount: 3, usagePct: 0.9 },
    inputs: [],
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    now: NOW,
    transport: fake(needsClaude),
  });
  assert.equal(r.wake, false);
  assert.match(r.reason, /suppress/);
});

test("[91] AC1: runPrelude at 85% usage: a frontier still wakes (the line is 90%)", async () => {
  const { runPrelude } = await load();
  const r = await runPrelude({
    context: { ...noCode, frontierCount: 3, usagePct: 0.85 },
    inputs: [],
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    now: NOW,
    transport: fake(needsClaude),
  });
  assert.equal(r.wake, true);
  assert.match(r.reason, /frontier/);
});

test("[91] AC2: runPrelude at 90%+ usage, user-authored, Scope added and verdict comments still wake without Jev", async () => {
  const { runPrelude } = await load();
  const inputs = [
    { newComment: "looks good", author: "user", ticket: TICKET, ticketText: TICKET_TEXT },
    { newComment: "Scope added (user): edge case", author: "orchestrator", ticket: TICKET, ticketText: TICKET_TEXT },
    { verdict: "bounce", author: "qa", ticket: TICKET, ticketText: TICKET_TEXT },
  ];
  for (const input of inputs) {
    const calls = [];
    const r = await runPrelude({
      context: { ...noCode, frontierCount: 3, usagePct: 0.95 },
      inputs: [input],
      usageRows: [],
      env: { TYPESAFE_API_KEY: KEY },
      now: NOW,
      transport: fake(informational, calls),
    });
    assert.equal(r.wake, true, `${JSON.stringify(input)} must wake at 95%`);
    assert.equal(calls.length, 0);
  }
});

test("codeDecides: CI red wakes", async () => {
  const { codeDecides } = await load();
  assert.equal(codeDecides({ ...noCode, ciRed: true }).wake, true);
  assert.equal(codeDecides({ ...noCode, ciRed: false }).wake, false);
});

test("codeDecides: merge conflict wakes", async () => {
  const { codeDecides } = await load();
  assert.equal(codeDecides({ ...noCode, conflicted: true }).wake, true);
  assert.equal(codeDecides({ ...noCode, conflicted: false }).wake, false);
});

test("codeDecides: open user-verdict gate request wakes", async () => {
  const { codeDecides } = await load();
  assert.equal(codeDecides({ ...noCode, openVerdictRequest: true }).wake, true);
  assert.equal(codeDecides({ ...noCode, openVerdictRequest: false }).wake, false);
});

test("codeDecides: no condition → wake:false", async () => {
  const { codeDecides } = await load();
  assert.equal(codeDecides(noCode).wake, false);
});

test("runPrelude: code condition wakes immediately, Jev is not called", async () => {
  const { runPrelude } = await load();
  const calls = [];
  const r = await runPrelude({
    context: { ...noCode, frontierCount: 3 },
    inputs: [{ newComment: "something", author: "developer", ticket: TICKET, ticketText: TICKET_TEXT }],
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    now: NOW,
    transport: fake(needsClaude, calls),
  });
  assert.equal(r.wake, true);
  assert.equal(calls.length, 0, "Jev must not be called when a code condition holds");
  assert.equal(r.rows.length, 0, "no jev rows when code condition short-circuits");
});

// ─── AC2: code wakes on specific comment types (ADR 0015 decision 6) ──────────

test("runPrelude: user-authored comment wakes without calling Jev", async () => {
  const { runPrelude } = await load();
  const calls = [];
  const r = await runPrelude({
    context: noCode,
    inputs: [{ newComment: "looks good", author: "user", ticket: TICKET, ticketText: TICKET_TEXT }],
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    now: NOW,
    transport: fake(informational, calls),
  });
  assert.equal(r.wake, true, "user-authored comment must wake");
  assert.equal(calls.length, 0, "Jev must not be called for user-authored comment");
});

test("runPrelude: 'Scope added' comment wakes without calling Jev", async () => {
  const { runPrelude } = await load();
  const calls = [];
  const r = await runPrelude({
    context: noCode,
    inputs: [{ newComment: "Scope added (user): handle edge case", author: "orchestrator", ticket: TICKET, ticketText: TICKET_TEXT }],
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    now: NOW,
    transport: fake(informational, calls),
  });
  assert.equal(r.wake, true);
  assert.equal(calls.length, 0, "Jev must not be called for Scope added comment");
});

test("runPrelude: verdict comment wakes without calling Jev", async () => {
  const { runPrelude } = await load();
  const calls = [];
  const r = await runPrelude({
    context: noCode,
    inputs: [{ verdict: "bounce", author: "qa", ticket: TICKET, ticketText: TICKET_TEXT }],
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    now: NOW,
    transport: fake(informational, calls),
  });
  assert.equal(r.wake, true);
  assert.equal(calls.length, 0, "Jev must not be called for a verdict comment");
});

test("runPrelude: comment with no author (unknown) wakes without calling Jev", async () => {
  const { runPrelude } = await load();
  const calls = [];
  const r = await runPrelude({
    context: noCode,
    inputs: [{ newComment: "anonymous note", ticket: TICKET, ticketText: TICKET_TEXT }],
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    now: NOW,
    transport: fake(informational, calls),
  });
  assert.equal(r.wake, true, "unknown author must wake");
  assert.equal(calls.length, 0, "Jev must not be called for unknown-author comment");
});

// ─── AC3: ambiguous inputs call Jev; labels determine outcome ─────────────────

test("runPrelude: agent-authored non-verdict comment calls Jev exactly once", async () => {
  const { runPrelude } = await load();
  const calls = [];
  await runPrelude({
    context: noCode,
    inputs: [{ newComment: "progress note", author: "developer", ticket: TICKET, ticketText: TICKET_TEXT }],
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    now: NOW,
    transport: fake(informational, calls),
  });
  assert.equal(calls.length, 1, "ambiguous comment must call Jev exactly once");
});

test("runPrelude: 'needs-claude' label wakes the orchestrator", async () => {
  const { runPrelude } = await load();
  const r = await runPrelude({
    context: noCode,
    inputs: [{ newComment: "please decide next step", author: "developer", ticket: TICKET, ticketText: TICKET_TEXT }],
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    now: NOW,
    transport: fake(needsClaude),
  });
  assert.equal(r.wake, true, "needs-claude must wake");
});

test("runPrelude: 'informational' label does not wake", async () => {
  const { runPrelude } = await load();
  const r = await runPrelude({
    context: noCode,
    inputs: [{ newComment: "CI passed, no action needed", author: "developer", ticket: TICKET, ticketText: TICKET_TEXT }],
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    now: NOW,
    transport: fake(informational),
  });
  assert.equal(r.wake, false, "informational label must not wake");
});

test("runPrelude: 'other' label wakes the orchestrator", async () => {
  const { runPrelude } = await load();
  const r = await runPrelude({
    context: noCode,
    inputs: [{ newComment: "ambiguous situation", author: "developer", ticket: TICKET, ticketText: TICKET_TEXT }],
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    now: NOW,
    transport: fake(otherAns),
  });
  assert.equal(r.wake, true, "other label must wake");
});

test("runPrelude: Jev failure (no API key) wakes the orchestrator", async () => {
  const { runPrelude } = await load();
  const r = await runPrelude({
    context: noCode,
    inputs: [{ newComment: "a comment", author: "developer", ticket: TICKET, ticketText: TICKET_TEXT }],
    usageRows: [],
    env: {}, // no key → fallback
    now: NOW,
    transport: fake(informational),
  });
  assert.equal(r.wake, true, "Jev fallback must wake the orchestrator");
});

test("runPrelude: one needs-claude among multiple informational inputs → overall wake", async () => {
  const { runPrelude } = await load();
  let idx = 0;
  const answers = [informational, needsClaude, informational];
  const transport = async () => answers[idx++];
  const r = await runPrelude({
    context: noCode,
    inputs: [
      { newComment: "CI passed", author: "developer", ticket: TICKET, ticketText: TICKET_TEXT },
      { newComment: "please decide X", author: "architect", ticket: TICKET, ticketText: TICKET_TEXT },
      { newComment: "FYI done", author: "qa", ticket: TICKET, ticketText: TICKET_TEXT },
    ],
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    now: NOW,
    transport,
  });
  assert.equal(r.wake, true, "any needs-claude among inputs must wake overall");
});

test("runPrelude: no inputs (nothing ambiguous) → wake:false", async () => {
  const { runPrelude } = await load();
  const calls = [];
  const r = await runPrelude({
    context: noCode,
    inputs: [],
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    now: NOW,
    transport: fake(needsClaude, calls),
  });
  assert.equal(r.wake, false, "empty inputs must not wake");
  assert.equal(calls.length, 0);
});

// ─── AC4: shadow logs jev rows; no daemon, no timer ───────────────────────────

test("runPrelude: logs a jev row for each Jev call, row.point is 'wake'", async () => {
  const { runPrelude } = await load();
  const r = await runPrelude({
    context: noCode,
    inputs: [
      { newComment: "note A", author: "developer", ticket: TICKET, ticketText: TICKET_TEXT },
      { newComment: "note B", author: "architect", ticket: TICKET, ticketText: TICKET_TEXT },
    ],
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    now: NOW,
    transport: fake(informational),
  });
  assert.equal(r.rows.length, 2, "one row per Jev call");
  for (const row of r.rows) {
    assert.equal(row.kind, "jev");
    assert.equal(row.point, "wake");
  }
});

test("runPrelude: code-wake inputs produce no jev rows", async () => {
  const { runPrelude } = await load();
  const r = await runPrelude({
    context: noCode,
    inputs: [{ newComment: "user note", author: "user", ticket: TICKET, ticketText: TICKET_TEXT }],
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    now: NOW,
    transport: fake(needsClaude),
  });
  assert.equal(r.rows.length, 0, "code-wake inputs must not produce jev rows");
});

test("runPrelude: resolves to a plain object (no retained timer)", async () => {
  // If runPrelude sets a persistent timer, the process would not exit cleanly.
  // Verifying the Promise resolves is sufficient at the unit level.
  const { runPrelude } = await load();
  const r = await runPrelude({
    context: noCode,
    inputs: [],
    usageRows: [],
    env: { TYPESAFE_API_KEY: KEY },
    now: NOW,
    transport: fake(informational),
  });
  assert.ok(r !== null && typeof r === "object");
  assert.ok("wake" in r);
  assert.ok(Array.isArray(r.rows));
});

// ─── CLI: script exits (no daemon) ────────────────────────────────────────────

test("CLI: jev-wake-prelude.mjs exits within timeout when run with no arguments", () => {
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 10000,
  });
  // Must exit (status !== null) — a daemon would hang and timeout
  assert.notEqual(r.status, null, "script must exit rather than hang");
});
