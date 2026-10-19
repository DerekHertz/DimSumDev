// Ticket dimsumden-ui-v0/08 scope add: scripts/log-agent.mjs --model records the model an agent ran on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeBoardFixture, REPO_ROOT } from "../apps/board/board-fixture.mjs";

const LOG_AGENT = path.join(REPO_ROOT, "scripts", "log-agent.mjs");
const rows = (root) =>
  readFileSync(path.join(root, ".scratch", "usage.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const run = (fx, extra) =>
  spawnSync(
    process.execPath,
    [LOG_AGENT, "--ticket", fx.ticketRelPath, "--role", "developer", "--tokens", "10", "--ms", "20", "--outcome", "ok", "--allow-no-handoff", "test setup", ...extra],
    { cwd: fx.root, env: { ...process.env, DEN_ROOT: fx.root }, encoding: "utf8", timeout: 15000 },
  );

test("log-agent --model records model on the row", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = run(fx, ["--model", "claude-sonnet-5-5"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(rows(fx.root)[0].model, "claude-sonnet-5-5");
  } finally {
    await fx.cleanup();
  }
});

test("log-agent without --model omits the model key", async () => {
  const fx = await makeBoardFixture();
  try {
    assert.equal(run(fx, []).status, 0);
    assert.ok(!("model" in rows(fx.root)[0]));
  } finally {
    await fx.cleanup();
  }
});

for (const [name, val] of [["empty", ""], ["blank", "  "], ["too long", "m".repeat(65)]]) {
  test(`log-agent rejects ${name} --model without writing`, async () => {
    const fx = await makeBoardFixture();
    try {
      const r = run(fx, ["--model", val]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /--model/);
      assert.throws(() => rows(fx.root));
    } finally {
      await fx.cleanup();
    }
  });
}
