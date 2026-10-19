// organism-infra/218: `log-agent --ticket none` logs a ticketless run (README capture scouts,
// survey scouts) with `ticket: null`.
//
// Pinned contract:
//   log-agent --ticket none --role <role> --tokens N --ms N --outcome "..." [--mode/--model/--context/--transcript]
//     - writes one kind:"agent" row whose `ticket` is null (key present, value null), with every
//       other field a ticketed row has (agent, mode, model, tokens, ms, outcome, context, the four
//       transcript totals)
//     - with --transcript, the kind:"spend" row has the same role and four totals and NO ticket key
//     - the only accepted ticketless spelling is the exact string "none"; any other ref that does
//       not resolve to a real ticket is still refused (exit 1, nothing written)
//   scripts/spend.mjs
//     - a ticketless spend row counts under its role (by_role) and adds nothing to any real
//       ticket's totals (by_ticket entries for real refs). Its by_ticket bucket, if any, is the
//       existing "(none)" key, which is not a ticket (pinned by spend-report.test.mjs).
// Not pinned (developer's call): whether a non-scout ticketless row needs --allow-no-handoff.
// These tests use scout, which never needs a handoff (organism-infra/177).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeBoardFixture, REPO_ROOT } from "../apps/board/board-fixture.mjs";
import { FOUR, assistant, userLine, transcriptDir, writeTranscript } from "./spend-fixture.mjs";

const LOG_AGENT = path.join(REPO_ROOT, "scripts", "log-agent.mjs");
const SPEND = path.join(REPO_ROOT, "scripts", "spend.mjs");

const rows = (root) => {
  const file = path.join(root, ".scratch", "usage.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const run = (fx, ticket, extra = [], role = "scout") =>
  spawnSync(
    process.execPath,
    [LOG_AGENT, "--ticket", ticket, "--role", role, "--tokens", "58000", "--ms", "20", "--outcome", "readme capture", ...extra],
    { cwd: fx.root, env: { ...process.env, DEN_ROOT: fx.root }, encoding: "utf8", timeout: 15000 },
  );
const spendJson = (fx) => {
  const r = spawnSync(process.execPath, [SPEND, "--json"], { cwd: fx.root, env: { ...process.env, DEN_ROOT: fx.root }, encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const TOTALS = { input_tokens: 15, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000, output_tokens: 90 };
const transcript = (session) =>
  writeTranscript(transcriptDir(), session, [userLine(), assistant("msg_1", [10, 100, 1000, 30]), assistant("msg_2", [5, 200, 3000, 60], "tool_use")]);

test("--ticket none writes one agent row with ticket null and the usual token/model fields", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = run(fx, "none", ["--model", "claude-haiku-4-5", "--mode", "survey", "--context", "41000"]);
    assert.equal(r.status, 0, r.stderr);
    const all = rows(fx.root);
    assert.equal(all.length, 1);
    const row = all[0];
    assert.equal(row.kind, "agent");
    assert.ok("ticket" in row, "the ticket key is present");
    assert.strictEqual(row.ticket, null);
    assert.equal(row.role, "scout");
    assert.equal(row.mode, "survey");
    assert.equal(row.model, "claude-haiku-4-5");
    assert.strictEqual(row.tokens, 58000);
    assert.strictEqual(row.ms, 20);
    assert.equal(row.outcome, "readme capture");
    assert.strictEqual(row.context, 41000);
    assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await fx.cleanup();
  }
});

test("a ticketless row has the same keys as a ticketed row (only ticket's value differs)", async () => {
  const fx = await makeBoardFixture();
  try {
    const extra = ["--model", "claude-haiku-4-5", "--context", "100"];
    assert.equal(run(fx, fx.ticketRelPath, extra).status, 0);
    assert.equal(run(fx, "none", extra).status, 0);
    const [ticketed, ticketless] = rows(fx.root);
    assert.deepEqual(Object.keys(ticketless).sort(), Object.keys(ticketed).sort());
  } finally {
    await fx.cleanup();
  }
});

test("--ticket none keeps the other checks: bad --tokens is still refused and nothing is written", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = spawnSync(process.execPath, [LOG_AGENT, "--ticket", "none", "--role", "scout", "--tokens", "lots", "--ms", "20", "--outcome", "x"], {
      cwd: fx.root, env: { ...process.env, DEN_ROOT: fx.root }, encoding: "utf8", timeout: 15000,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--tokens/);
    assert.equal(rows(fx.root).length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("--ticket none with --transcript adds the four totals and a spend row with no ticket", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = run(fx, "none", ["--transcript", transcript("agent-readme1")]);
    assert.equal(r.status, 0, r.stderr);
    const all = rows(fx.root);
    const role = all.find((x) => x.kind === "agent");
    assert.strictEqual(role.ticket, null);
    for (const k of FOUR) assert.strictEqual(role[k], TOTALS[k], k);
    const spend = all.filter((x) => x.kind === "spend");
    assert.equal(spend.length, 1);
    assert.equal(spend[0].role, "scout");
    assert.equal(spend[0].session, "agent-readme1");
    assert.ok(!spend[0].ticket, "a ticketless spend row carries no ticket");
    for (const k of FOUR) assert.strictEqual(spend[0][k], TOTALS[k], k);
  } finally {
    await fx.cleanup();
  }
});

test("an unreadable --transcript with --ticket none still exits 1 and writes nothing", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = run(fx, "none", ["--transcript", path.join(transcriptDir(), "absent.jsonl")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--transcript/);
    assert.equal(rows(fx.root).length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("a ref other than none that is not a real ticket is still refused", async () => {
  const fx = await makeBoardFixture();
  try {
    for (const bad of ["nosuch/99-ghost", "None", "NONE", "null", "-", "none/01-x", "none "]) {
      const r = run(fx, bad);
      assert.equal(r.status, 1, `${JSON.stringify(bad)} must be refused`);
      assert.equal(rows(fx.root).length, 0, `${JSON.stringify(bad)} must write nothing`);
    }
  } finally {
    await fx.cleanup();
  }
});

test("--ticket is still required: an omitted or empty value is refused", async () => {
  const fx = await makeBoardFixture();
  try {
    const omitted = spawnSync(process.execPath, [LOG_AGENT, "--role", "scout", "--tokens", "1", "--ms", "1", "--outcome", "x"], {
      cwd: fx.root, env: { ...process.env, DEN_ROOT: fx.root }, encoding: "utf8", timeout: 15000,
    });
    assert.equal(omitted.status, 1);
    assert.equal(run(fx, "").status, 1);
    assert.equal(rows(fx.root).length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("npm run spend counts a ticketless run under its role and leaves real tickets' totals alone", async () => {
  const fx = await makeBoardFixture();
  try {
    assert.equal(run(fx, fx.ticketRelPath, ["--allow-no-handoff", "test setup", "--transcript", transcript("agent-ticketed")], "developer").status, 0, "setup: ticketed developer run");
    const before = spendJson(fx);
    assert.deepEqual(before.by_role.developer && Object.keys(before.by_role), ["developer"]);

    const r = run(fx, "none", ["--transcript", transcript("agent-readme2")]);
    assert.equal(r.status, 0, r.stderr);
    const after = spendJson(fx);

    const total = Object.values(TOTALS).reduce((a, b) => a + b, 0);
    assert.deepEqual(after.by_role.scout, { ...TOTALS, total }, "the scout run shows under its role");
    assert.deepEqual(after.by_role.developer, before.by_role.developer, "other roles are unchanged");
    assert.deepEqual(after.by_ticket[fx.ticketRelPath], before.by_ticket[fx.ticketRelPath], "the real ticket's totals are unchanged");
    const realRefs = Object.keys(after.by_ticket).filter((k) => k !== "(none)");
    assert.deepEqual(realRefs, [fx.ticketRelPath], "no ticket entry appears for the ticketless run");
  } finally {
    await fx.cleanup();
  }
});

test("a ticketless row from a non-scout agent is refused unless --allow-no-handoff gives a reason (organism-infra/51 guard)", async () => {
  const fx = await makeBoardFixture();
  try {
    const refused = run(fx, "none", [], "developer");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /allow-no-handoff/);
    assert.equal(rows(fx.root).length, 0, "nothing written");

    const ok = run(fx, "none", ["--allow-no-handoff", "no ticket to hand off on"], "developer");
    assert.equal(ok.status, 0, ok.stderr);
    const [row] = rows(fx.root);
    assert.strictEqual(row.ticket, null);
    assert.equal(row.role, "developer");
    assert.equal(row.allow_no_handoff, "no ticket to hand off on");

    assert.equal(run(fx, "none", [], "scout").status, 0, "scout stays exempt");
    assert.equal(rows(fx.root).length, 2);
  } finally {
    await fx.cleanup();
  }
});
