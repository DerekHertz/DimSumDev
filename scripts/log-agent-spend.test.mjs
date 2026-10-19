// organism-infra/211 AC2 (agent half): log-agent.mjs --transcript <file> records the agent's billed
// spend from its subagent transcript, with no hand-written numbers.
//
// Pinned contract:
//   log-agent ... --transcript <file.jsonl>
//     - the kind:"agent" row gets the four transcript totals beside `tokens` (which stays as passed):
//       input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens
//     - one kind:"spend" row is appended too, as spend-log.mjs would write it: role = the --cell
//       type, ticket = the full ticket ref, session = the transcript's file name without ".jsonl",
//       and the same four totals (delta rules as in spend-log.test.mjs; a repeat run of the same
//       transcript adds no further spend)
//     - without --transcript the agent row has none of the four keys and no spend row is written
//       (every existing caller keeps working)
//     - an unreadable transcript exits 1, names --transcript, and writes nothing (no agent row either)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeBoardFixture, REPO_ROOT } from "../apps/board/board-fixture.mjs";
import { FOUR, assistant, userLine, transcriptDir, writeTranscript } from "./spend-fixture.mjs";

const LOG_AGENT = path.join(REPO_ROOT, "scripts", "log-agent.mjs");
const rows = (root) => {
  const file = path.join(root, ".scratch", "usage.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const logAgent = (fx, extra, role = "developer") =>
  spawnSync(
    process.execPath,
    [LOG_AGENT, "--ticket", fx.ticketRelPath, "--role", role, "--tokens", "123", "--ms", "20", "--outcome", "ok", "--allow-no-handoff", "test setup", ...extra],
    { cwd: fx.root, env: { ...process.env, DEN_ROOT: fx.root }, encoding: "utf8", timeout: 15000 },
  );
const TOTALS = { input_tokens: 15, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000, output_tokens: 90 };
const transcript = (session) =>
  writeTranscript(transcriptDir(), session, [userLine(), assistant("msg_1", [10, 100, 1000, 30]), assistant("msg_2", [5, 200, 3000, 60], "tool_use")]);

test("log-agent --transcript puts the four totals on the agent row and writes a spend row", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = logAgent(fx, ["--transcript", transcript("agent-abc123")]);
    assert.equal(r.status, 0, r.stderr);
    const all = rows(fx.root);
    const role = all.find((x) => x.kind === "agent");
    assert.equal(role.tokens, 123, "today's tokens field is untouched");
    for (const k of FOUR) assert.strictEqual(role[k], TOTALS[k], k);
    const spend = all.filter((x) => x.kind === "spend");
    assert.equal(spend.length, 1);
    assert.equal(spend[0].role, "developer");
    assert.equal(spend[0].ticket, fx.ticketRelPath);
    assert.equal(spend[0].session, "agent-abc123");
    for (const k of FOUR) assert.strictEqual(spend[0][k], TOTALS[k], k);
  } finally {
    await fx.cleanup();
  }
});

test("the spend row's role follows --role (a scout needs no handoff either)", async () => {
  const fx = await makeBoardFixture();
  try {
    assert.equal(logAgent(fx, ["--transcript", transcript("agent-scout1")], "scout").status, 0);
    assert.equal(rows(fx.root).find((x) => x.kind === "spend").role, "scout");
  } finally {
    await fx.cleanup();
  }
});

test("logging the same transcript twice does not double the spend", async () => {
  const fx = await makeBoardFixture();
  try {
    const file = transcript("agent-twice");
    assert.equal(logAgent(fx, ["--transcript", file]).status, 0);
    assert.equal(logAgent(fx, ["--transcript", file]).status, 0);
    const sum = Object.fromEntries(FOUR.map((k) => [k, rows(fx.root).filter((x) => x.kind === "spend").reduce((s, x) => s + x[k], 0)]));
    assert.deepEqual(sum, TOTALS);
  } finally {
    await fx.cleanup();
  }
});

test("without --transcript the agent row has no spend keys and no spend row is written", async () => {
  const fx = await makeBoardFixture();
  try {
    assert.equal(logAgent(fx, []).status, 0);
    const all = rows(fx.root);
    const role = all.find((x) => x.kind === "agent");
    for (const k of FOUR) assert.ok(!(k in role), k);
    assert.equal(all.filter((x) => x.kind === "spend").length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("log-agent rejects an unreadable --transcript without writing anything", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = logAgent(fx, ["--transcript", path.join(transcriptDir(), "absent.jsonl")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--transcript/);
    assert.doesNotMatch(r.stderr, /unrecognized/, "the flag must be known and its value validated");
    assert.equal(rows(fx.root).length, 0);
  } finally {
    await fx.cleanup();
  }
});
