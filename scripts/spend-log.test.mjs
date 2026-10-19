// organism-infra/211 AC1 and the first half of AC2: scripts/spend-log.mjs reads a Claude session
// transcript and appends kind:"spend" rows to .scratch/usage.jsonl.
//
// Pinned contract:
//   node scripts/spend-log.mjs --transcript <file.jsonl> --role <orchestrator|role>
//                              [--ticket <feature>/<NN-slug>] [--session <id>]
//   - Root is $DEN_ROOT (as log-agent does). --session defaults to the transcript's file name
//     without ".jsonl".
//   - Billed usage is read from each assistant record's message.usage. One API message can span
//     several records with the same message.id; it counts ONCE (the last record with that id wins).
//     Records with no usage (user lines, garbage lines, a bad JSON line) are skipped.
//   - The four totals are named as in the transcript: input_tokens, cache_creation_input_tokens,
//     cache_read_input_tokens, output_tokens.
//   - Row: {"kind":"spend","ts":<iso>,"session":<id>,"role":<role>,["ticket":<ref>,] and the four totals}.
//     The row holds the DELTA: the transcript's total minus what earlier spend rows for the same
//     session already logged. A run whose delta is all zero appends no row and exits 0.
//   - stdout is one JSON object with the four delta totals (zeros included), so a caller can see them.
//   - A bad --role, a missing/unreadable transcript, or a --ticket that is not on the board exits 1,
//     names the flag in stderr, and writes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeBoardFixture, REPO_ROOT } from "../apps/board/board-fixture.mjs";
import { FOUR, assistant, userLine, transcriptDir, writeTranscript, appendTranscript } from "./spend-fixture.mjs";

const SPEND_LOG = path.join(REPO_ROOT, "scripts", "spend-log.mjs");

const rows = (root) => {
  const file = path.join(root, ".scratch", "usage.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const spendRows = (root) => rows(root).filter((r) => r.kind === "spend");
const run = (fx, args) =>
  spawnSync(process.execPath, [SPEND_LOG, ...args], { cwd: fx.root, env: { ...process.env, DEN_ROOT: fx.root }, encoding: "utf8", timeout: 15000 });
const totals = (o) => Object.fromEntries(FOUR.map((k) => [k, o[k]]));

// 100+10 in, 1000+200 cache creation, 5000+6000 cache read, 50+60 out.
const base = () => [
  userLine(),
  assistant("msg_1", [100, 1000, 5000, 50]),
  userLine("more"),
  assistant("msg_2", [10, 200, 6000, 60], "tool_use"),
];
const BASE_TOTALS = { input_tokens: 110, cache_creation_input_tokens: 1200, cache_read_input_tokens: 11000, output_tokens: 110 };

test("a fixture transcript yields the four billed totals in a spend row", async () => {
  const fx = await makeBoardFixture();
  try {
    const dir = transcriptDir();
    const file = writeTranscript(dir, "sess-aaa", base());
    const r = run(fx, ["--transcript", file, "--role", "orchestrator"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(totals(JSON.parse(r.stdout)), BASE_TOTALS);
    const got = spendRows(fx.root);
    assert.equal(got.length, 1);
    assert.equal(got[0].session, "sess-aaa");
    assert.equal(got[0].role, "orchestrator");
    assert.ok(!("ticket" in got[0]), "no --ticket, no ticket key");
    assert.ok(Number.isFinite(Date.parse(got[0].ts)), "ts is an ISO time");
    assert.deepEqual(totals(got[0]), BASE_TOTALS);
  } finally {
    await fx.cleanup();
  }
});

test("a second run on an unchanged transcript logs nothing new", async () => {
  const fx = await makeBoardFixture();
  try {
    const file = writeTranscript(transcriptDir(), "sess-bbb", base());
    assert.equal(run(fx, ["--transcript", file, "--role", "orchestrator"]).status, 0);
    const r = run(fx, ["--transcript", file, "--role", "orchestrator"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(totals(JSON.parse(r.stdout)), { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 });
    assert.equal(spendRows(fx.root).length, 1, "no second row for a zero delta");
  } finally {
    await fx.cleanup();
  }
});

test("a second run after the transcript grew logs only the delta", async () => {
  const fx = await makeBoardFixture();
  try {
    const file = writeTranscript(transcriptDir(), "sess-ccc", base());
    assert.equal(run(fx, ["--transcript", file, "--role", "orchestrator"]).status, 0);
    appendTranscript(file, [userLine("next"), assistant("msg_3", [1, 2, 3, 4])]);
    const r = run(fx, ["--transcript", file, "--role", "orchestrator"]);
    assert.equal(r.status, 0, r.stderr);
    const got = spendRows(fx.root);
    assert.equal(got.length, 2);
    assert.deepEqual(totals(got[1]), { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 });
    // the rows add up to the transcript's whole spend: nothing double counted
    for (const k of FOUR) assert.equal(got[0][k] + got[1][k], BASE_TOTALS[k] + { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 }[k]);
  } finally {
    await fx.cleanup();
  }
});

test("deltas are tracked per session: another session starts from zero", async () => {
  const fx = await makeBoardFixture();
  try {
    const dir = transcriptDir();
    const a = writeTranscript(dir, "sess-ddd", base());
    const b = writeTranscript(dir, "sess-eee", base());
    assert.equal(run(fx, ["--transcript", a, "--role", "orchestrator"]).status, 0);
    assert.equal(run(fx, ["--transcript", b, "--role", "orchestrator"]).status, 0);
    const got = spendRows(fx.root);
    assert.equal(got.length, 2);
    assert.deepEqual(totals(got[1]), BASE_TOTALS);
    assert.deepEqual(got.map((x) => x.session), ["sess-ddd", "sess-eee"]);
  } finally {
    await fx.cleanup();
  }
});

test("one API message split over several records counts once, at its last usage", async () => {
  const fx = await makeBoardFixture();
  try {
    const file = writeTranscript(transcriptDir(), "sess-fff", [
      assistant("msg_1", [2, 100, 900, 5], "text"),
      assistant("msg_1", [2, 100, 900, 5], "tool_use"), // same message, second content block
      assistant("msg_2", [3, 0, 1000, 10]),
      assistant("msg_2", [3, 0, 1000, 40]), // streamed: the final record carries the full output count
    ]);
    const r = run(fx, ["--transcript", file, "--role", "developer"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(totals(spendRows(fx.root)[0]), { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1900, output_tokens: 45 });
  } finally {
    await fx.cleanup();
  }
});

test("lines with no usage, and unparseable lines, are skipped", async () => {
  const fx = await makeBoardFixture();
  try {
    const file = writeTranscript(transcriptDir(), "sess-ggg", [
      "this is not json {",
      userLine(),
      { type: "summary", summary: "x" },
      { type: "assistant", message: { id: "msg_nu", role: "assistant", content: [] } }, // assistant record without usage
      assistant("msg_1", [7, 8, 9, 10]),
      "",
    ]);
    const r = run(fx, ["--transcript", file, "--role", "qa"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(totals(spendRows(fx.root)[0]), { input_tokens: 7, cache_creation_input_tokens: 8, cache_read_input_tokens: 9, output_tokens: 10 });
  } finally {
    await fx.cleanup();
  }
});

test("--ticket and --session are recorded on the row", async () => {
  const fx = await makeBoardFixture();
  try {
    const file = writeTranscript(transcriptDir(), "file-name-id", base());
    const r = run(fx, ["--transcript", file, "--role", "developer", "--ticket", fx.ticketRelPath, "--session", "explicit-id"]);
    assert.equal(r.status, 0, r.stderr);
    const row = spendRows(fx.root)[0];
    assert.equal(row.ticket, fx.ticketRelPath);
    assert.equal(row.session, "explicit-id");
    assert.equal(row.role, "developer");
  } finally {
    await fx.cleanup();
  }
});

for (const [name, mk] of [
  ["an unknown role", (file) => ["--transcript", file, "--role", "wizard"]],
  ["a missing --role", (file) => ["--transcript", file]],
  ["a ticket that is not on the board", (file) => ["--transcript", file, "--role", "qa", "--ticket", "nope/99-missing"]],
]) {
  test(`spend-log rejects ${name} without writing`, async () => {
    const fx = await makeBoardFixture();
    try {
      const file = writeTranscript(transcriptDir(), "sess-hhh", base());
      const r = run(fx, mk(file));
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stderr, /--role|--ticket|ticket/);
      assert.equal(spendRows(fx.root).length, 0);
    } finally {
      await fx.cleanup();
    }
  });
}

test("spend-log rejects a missing transcript without writing", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = run(fx, ["--transcript", path.join(transcriptDir(), "absent.jsonl"), "--role", "qa"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--transcript|transcript/);
    assert.equal(spendRows(fx.root).length, 0);
  } finally {
    await fx.cleanup();
  }
});
