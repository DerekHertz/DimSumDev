// organism-infra/145 (batch C): agent-start takes the orchestrator's warn and refuse thresholds from the
// shared config's `orchestrator` key (budgetFor("orchestrator")) instead of fixed 70k/80k.
//
// Seam: the agent-start CLI, exactly as in agent-start-context-gate.test.mjs (that file pins the shipped
// 70k/80k behaviour and must keep passing). Here CONTEXT_BUDGET_CONFIG=<fixture file> moves the numbers:
//   orchestrator {warn 30k, stop 40k}: 30k to 39k warns ("orchestrator context <n>k", "no new tickets"),
//   40k and over refuses with "orchestrator context <n>k ≥ 40k: write the session handoff and ask the
//   user to /compact" (the refusal limit in the message comes from the config), --continue and --force
//   behave as before. An agent entry (developer) never moves the orchestrator's numbers. With no
//   orchestrator key the `default` entry applies.
//
// Criterion map:
//   agent-start reads the config's orchestrator key -> "warns at the configured warn ...", "refuses at the configured stop ..."
//   the message carries the configured limit        -> "refuses at the configured stop ..."
//   --continue / --force keep their meaning         -> "--continue ...", "--force ..."
//   agent entries do not leak into the orchestrator  -> "a developer entry ..." test
//   no orchestrator key -> default                  -> "no orchestrator key ..." test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, realpathSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, "scripts", "agent-start.mjs");
const CLI = path.join(REPO_ROOT, "apps", "board", "board.mjs");
const SESSION = "orch-session-cfg";
const REF = "test-feature/01-do-thing";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitFile(cwd, name, body, msg) {
  writeFileSync(path.join(cwd, name), body);
  git(cwd, ["add", name]);
  git(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function makeFixture(config) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "cs-cfg-")));
  const main = path.join(dir, "main");
  mkdirSync(main);
  git(main, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(main, "package.json"), "{}");
  git(main, ["add", "package.json"]);
  commitFile(main, "a.txt", "a", "A");
  const issuesDir = path.join(main, ".scratch", "test-feature", "issues");
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(issuesDir, "01-do-thing.md"), "# 01-do-thing\n\nStatus: ready-for-agent\n\n- [ ] criterion\n\n## Comments\n");
  git(main, ["add", ".scratch"]);
  const sha = commitFile(main, "b.txt", "b", "B with ticket");
  const wt = path.join(main, ".claude", "worktrees", "agent-x");
  git(main, ["worktree", "add", "-q", "--detach", wt, "main"]);
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const stub = path.join(bin, "npm");
  writeFileSync(stub, "#!/bin/sh\nexit 0\n");
  chmodSync(stub, 0o755);
  const home = path.join(dir, "home");
  const projDir = path.join(home, ".claude", "projects", "-fixture-project");
  mkdirSync(projDir, { recursive: true });
  const configPath = path.join(dir, "context-budget.json");
  writeFileSync(configPath, JSON.stringify(config));
  return { dir, main, wt, sha, bin, home, projDir, configPath };
}

const assistant = (n) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: n, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } } });

function run(fx, tokens, extra = []) {
  writeFileSync(path.join(fx.projDir, `${SESSION}.jsonl`), [assistant(1), assistant(tokens)].join("\n") + "\n");
  return spawnSync("node", [SCRIPT, "--base", fx.sha, "--detach", "--ticket", REF, "--role", "developer", ...extra], {
    cwd: fx.wt,
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
      DEN_ROOT: fx.main,
      HOME: fx.home,
      CLAUDE_CODE_SESSION_ID: SESSION,
      CONTEXT_BUDGET_CONFIG: fx.configPath,
    },
  });
}

function ticketStatus(fx) {
  return spawnSync("node", [CLI, "status", REF], { cwd: fx.wt, encoding: "utf8", env: { ...process.env, DEN_ROOT: fx.main } }).stdout;
}

function withFixture(config, fn) {
  const fx = makeFixture(config);
  try {
    return fn(fx);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
}

const out = (r) => `${r.stdout}\n${r.stderr}`;
const CONFIG = {
  default: { warn: 70_000, stop: 80_000 },
  roles: { developer: { warn: 10_000, stop: 20_000 } },
  orchestrator: { warn: 30_000, stop: 40_000 },
};

test("below the configured warn (29k) is silent and claims the ticket, though 29k is under the old 70k too", () =>
  withFixture(CONFIG, (fx) => {
    const r = run(fx, 29_000);
    assert.equal(r.status, 0, out(r));
    assert.doesNotMatch(out(r), /orchestrator context/i);
    assert.match(ticketStatus(fx), /claimed/);
  }));

// A run that proceeds claims the ticket, so each reading gets its own fresh fixture (a second run on the
// same fixture would be refused with "ticket already claimed" for a reason unrelated to the budget).
test("warns at the configured warn (30k) and at 39k, and proceeds", () => {
  for (const n of [30_000, 39_000]) {
    withFixture(CONFIG, (fx) => {
      const r = run(fx, n);
      assert.equal(r.status, 0, out(r));
      assert.match(out(r), new RegExp(`orchestrator context ${n / 1000}k`, "i"));
      assert.match(out(r), /no new tickets/i);
    });
  }
});

test("refuses at the configured stop (40k) and names that limit in the message", () =>
  withFixture(CONFIG, (fx) => {
    const r = run(fx, 40_000);
    assert.equal(r.status, 1, out(r));
    assert.ok(r.stderr.includes("orchestrator context 40k ≥ 40k: write the session handoff and ask the user to /compact"), `stderr was:\n${r.stderr}`);
    assert.match(ticketStatus(fx), /ready-for-agent/, "a refusal claims nothing");
  }));

test("--continue at 45k gets the warning, not the refusal; --force proceeds", () =>
  withFixture(CONFIG, (fx) => {
    const c = run(fx, 45_000, ["--continue"]);
    assert.equal(c.status, 0, out(c));
    assert.match(out(c), /orchestrator context 45k/i);
    assert.doesNotMatch(out(c), /ask the user to \/compact/);
  }));

test("--force proceeds at 45k", () =>
  withFixture(CONFIG, (fx) => {
    const r = run(fx, 45_000, ["--force"]);
    assert.equal(r.status, 0, out(r));
    assert.match(ticketStatus(fx), /claimed/);
  }));

test("a developer entry never moves the orchestrator's numbers: 15k is silent despite developer 10k/20k", () =>
  withFixture(CONFIG, (fx) => {
    const r = run(fx, 15_000);
    assert.equal(r.status, 0, out(r));
    assert.doesNotMatch(out(r), /orchestrator context/i);
  }));

test("no orchestrator key: the default entry applies (default 50k/60k)", () =>
  withFixture({ default: { warn: 50_000, stop: 60_000 }, roles: {} }, (fx) => {
    const w = run(fx, 55_000);
    assert.equal(w.status, 0, out(w));
    assert.match(out(w), /orchestrator context 55k/i);
    const r = run(fx, 60_000);
    assert.equal(r.status, 1, out(r));
    assert.ok(r.stderr.includes("orchestrator context 60k ≥ 60k:"), `stderr was:\n${r.stderr}`);
  }));
