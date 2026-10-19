// organism-infra/177: log-agent.mjs skips the missing-handoff refusal for `--role scout`
// (scouts are read-only helpers and never publish a handoff). Every other agent keeps the check.
// Seam: the log-agent CLI against a throwaway board.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeBoardFixture, REPO_ROOT } from "../apps/board/board-fixture.mjs";

const LOG_AGENT = path.join(REPO_ROOT, "scripts", "log-agent.mjs");
const usagePath = (fx) => path.join(fx.root, ".scratch", "usage.jsonl");
const rows = (fx) => readFileSync(usagePath(fx), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function log(fx, role, { mode, ticket, extra = [] } = {}) {
  const modeArgs = mode === undefined ? [] : ["--mode", mode];
  return spawnSync(
    process.execPath,
    [LOG_AGENT, "--ticket", ticket ?? fx.ticketRelPath, "--role", role, ...modeArgs, "--tokens", "10", "--ms", "20", "--outcome", "ok", ...extra],
    { cwd: fx.root, env: { ...process.env, DEN_ROOT: fx.root }, encoding: "utf8", timeout: 15000 },
  );
}

async function withFx(fn) {
  const fx = await makeBoardFixture();
  try {
    await fn(fx);
  } finally {
    await fx.cleanup();
  }
}

test("177 criterion 1: --role scout with no handoff writes its row and exits 0", () =>
  withFx(async (fx) => {
    const r = log(fx, "scout");
    assert.equal(r.status, 0, r.stderr);
    const [row] = rows(fx);
    assert.equal(row.kind, "agent");
    assert.equal(row.role, "scout");
    assert.equal(row.ticket, fx.ticketRelPath);
    assert.ok(!JSON.stringify(row).includes("allow"), "no escape marker: scout needed no escape");
  }));

test("177 criterion 1: --role scout with a mode and no handoff also writes its row", () =>
  withFx(async (fx) => {
    const r = log(fx, "scout", { mode: "survey" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(rows(fx)[0].role, "scout");
  }));

for (const role of ["product", "architect", "orchestrator", "developer", "qa", "security", "designer"]) {
  test(`177 criterion 2: --role ${role} with no handoff and no --allow-no-handoff is still refused`, () =>
    withFx(async (fx) => {
      const r = log(fx, role);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /handoff/i);
      assert.equal(existsSync(usagePath(fx)), false);
    }));
}

test("177: --allow-no-handoff still works for a non-scout agent and records the reason", () =>
  withFx(async (fx) => {
    const reason = "orchestrator reclaimed a dead agent";
    const r = log(fx, "developer", { extra: ["--allow-no-handoff", reason] });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Object.values(rows(fx)[0]).includes(reason));
  }));

test("177: --allow-no-handoff still records its reason on a scout row", () =>
  withFx(async (fx) => {
    const reason = "explicit reason on a scout";
    const r = log(fx, "scout", { extra: ["--allow-no-handoff", reason] });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Object.values(rows(fx)[0]).includes(reason));
  }));

test("177: a scout row for a ticket that is not on the board is still refused", () =>
  withFx(async (fx) => {
    const r = log(fx, "scout", { ticket: `${fx.feature}/99-nothing-here` });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not found/i);
    assert.equal(existsSync(usagePath(fx)), false);
  }));
