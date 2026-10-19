// organism-infra/51 criterion 4: log-agent.mjs refuses to write an agent row unless
// the ticket has a recent handoff whose State block role/mode match
// --role/--mode; --allow-no-handoff "<reason>" is the logged escape.
//
// Note for the developer: log-agent-model, usage-rows, verdict-roles and
// verdict-lock-failures tests call log-agent without a handoff; they need a
// handoff fixture or --allow-no-handoff once this lands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile, utimes } from "node:fs/promises";
import path from "node:path";
import { makeBoardFixture, validStateJson, REPO_ROOT } from "../apps/board/board-fixture.mjs";

const LOG_AGENT = path.join(REPO_ROOT, "scripts", "log-agent.mjs");
const usagePath = (fx) => path.join(fx.root, ".scratch", "usage.jsonl");
const rows = (fx) => readFileSync(usagePath(fx), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function log(fx, { role = "qa", mode = "specify", extra = [] } = {}) {
  const modeArgs = mode === null ? [] : ["--mode", mode];
  return spawnSync(
    process.execPath,
    [LOG_AGENT, "--ticket", fx.ticketRelPath, "--role", role, ...modeArgs, "--tokens", "10", "--ms", "20", "--outcome", "ok", ...extra],
    { cwd: fx.root, env: { ...process.env, DEN_ROOT: fx.root }, encoding: "utf8", timeout: 15000 },
  );
}

async function handoff(fx, { name = "01-qa-specify.md", state = {}, ageMs = 0 } = {}) {
  const dir = path.join(fx.root, ".scratch", fx.feature, "handoffs");
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, name);
  const s = validStateJson({ ticket: fx.ticketRelPath, role: "qa", mode: "specify", ...state });
  await writeFile(p, "```json\n" + JSON.stringify(s) + "\n```\n\n## Summary\n\nx\n");
  if (ageMs) {
    const t = new Date(Date.now() - ageMs);
    await utimes(p, t, t);
  }
}

async function withFx(fn) {
  const fx = await makeBoardFixture();
  try {
    await fn(fx);
  } finally {
    await fx.cleanup();
  }
}
const H = 3600_000;

test("writes the row when a matching handoff was published recently", () =>
  withFx(async (fx) => {
    await handoff(fx, { ageMs: H });
    const r = log(fx);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(rows(fx)[0].role, "qa");
  }));

test("an agent with no mode matches a handoff with no mode", () =>
  withFx(async (fx) => {
    await handoff(fx, { name: "01-developer.md", state: { role: "developer", mode: undefined } });
    const r = log(fx, { role: "developer", mode: null });
    assert.equal(r.status, 0, r.stderr);
  }));

test("no handoff: refused, nothing written, stderr names the missing handoff and ticket", () =>
  withFx(async (fx) => {
    const r = log(fx);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /handoff/i);
    assert.ok(r.stderr.includes(fx.ticketRelPath), r.stderr);
    assert.equal(existsSync(usagePath(fx)), false);
  }));

test("handoff older than 24 hours is refused", () =>
  withFx(async (fx) => {
    await handoff(fx, { ageMs: 25 * H });
    const r = log(fx);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /handoff/i);
    assert.equal(existsSync(usagePath(fx)), false);
  }));

test("handoff from a different agent is refused", () =>
  withFx(async (fx) => {
    await handoff(fx, { state: { role: "developer", mode: undefined } });
    const r = log(fx);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /handoff/i);
    assert.equal(existsSync(usagePath(fx)), false);
  }));

test("handoff with a different mode is refused", () =>
  withFx(async (fx) => {
    await handoff(fx, { state: { mode: "verify" } });
    const r = log(fx, { mode: "specify" });
    assert.equal(r.status, 1);
    assert.equal(existsSync(usagePath(fx)), false);
  }));

test("handoff for another ticket does not count", () =>
  withFx(async (fx) => {
    await handoff(fx, { state: { ticket: `${fx.feature}/02-other` } });
    const r = log(fx);
    assert.equal(r.status, 1);
    assert.equal(existsSync(usagePath(fx)), false);
  }));

test("--allow-no-handoff writes the row and records the reason in it", () =>
  withFx(async (fx) => {
    const reason = "orchestrator reclaimed a dead agent";
    const r = log(fx, { extra: ["--allow-no-handoff", reason] });
    assert.equal(r.status, 0, r.stderr);
    const [row] = rows(fx);
    assert.equal(row.kind, "agent");
    assert.ok(Object.values(row).includes(reason), `row should carry the reason: ${JSON.stringify(row)}`);
  }));

test("--allow-no-handoff with an empty reason is refused", () =>
  withFx(async (fx) => {
    const r = log(fx, { extra: ["--allow-no-handoff", "  "] });
    assert.equal(r.status, 1);
    assert.equal(existsSync(usagePath(fx)), false);
  }));

test("a row logged with a matching handoff has no allow-no-handoff reason", () =>
  withFx(async (fx) => {
    await handoff(fx);
    assert.equal(log(fx).status, 0);
    assert.ok(!JSON.stringify(rows(fx)[0]).includes("allow"), "no escape marker on a normal row");
  }));
