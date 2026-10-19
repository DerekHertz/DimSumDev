// organism-infra/119: agent-start enforces the orchestrator's 80k context rule.
//
// An agent runs agent-start inside its worktree but shares the orchestrator's CLAUDE_CODE_SESSION_ID, so
// the context reading (scripts/context.mjs, no --self) is the orchestrator's top-level transcript.
// Pinned contract, with the orchestrator reading in tokens:
//   < 70k          silent, proceeds
//   70k <= n < 80k warns (text names "orchestrator context <n>k" and "no new tickets"), exit 0
//   >= 80k         exit 1, stderr contains
//                  "orchestrator context <n>k ≥ 80k: write the session handoff and ask the user to /compact";
//                  it refuses before claiming anything or switching the worktree
//   --force        skips the refusal (proceeds, ticket claimed)
//   --continue     fix rounds / later hops: gets the warning at >= 70k, never the refusal
//   null reading   (no session id, no transcript, no usage in the transcript) never blocks
//
// Criterion map:
//   AC1 warn at >= 70k                  -> "warns at 70k", "warns at 79k"
//   AC1 refuse at >= 80k, names /compact -> "refuses at 80k", "refuses at 120k", "refusal claims nothing"
//   AC1 --force                         -> "--force proceeds"
//   AC1 --continue                      -> "--continue at 85k ...", "--continue below 70k ..."
//   AC1 null reading never blocks       -> "null reading" tests
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
const SESSION = "orch-session-gate";
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

function makeFixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "cs-ctx-")));
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
  return { dir, main, wt, sha, bin, home, projDir };
}

const assistant = (n) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: n, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } } });

function orchestratorReading(fx, tokens) {
  writeFileSync(path.join(fx.projDir, `${SESSION}.jsonl`), [assistant(1), assistant(tokens)].join("\n") + "\n");
}

function run(fx, extra = [], env = {}) {
  return spawnSync(
    "node",
    [SCRIPT, "--base", fx.sha, "--detach", "--ticket", REF, "--role", "developer", ...extra],
    {
      cwd: fx.wt,
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...process.env,
        PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
        DEN_ROOT: fx.main,
        HOME: fx.home,
        CLAUDE_CODE_SESSION_ID: SESSION,
        ...env,
      },
    },
  );
}

function ticketStatus(fx) {
  return spawnSync("node", [CLI, "status", REF], { cwd: fx.wt, encoding: "utf8", env: { ...process.env, DEN_ROOT: fx.main } }).stdout;
}

function withFixture(fn) {
  const fx = makeFixture();
  try {
    return fn(fx);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
}

const out = (r) => `${r.stdout}\n${r.stderr}`;

// --- below the warning line ---

test("below 70k: proceeds silently and claims the ticket", () =>
  withFixture((fx) => {
    orchestratorReading(fx, 69000);
    const r = run(fx);
    assert.equal(r.status, 0, out(r));
    assert.doesNotMatch(out(r), /orchestrator context/i);
    assert.match(ticketStatus(fx), /claimed/);
  }));

// --- warn at >= 70k ---

test("warns at 70k: no new tickets, but proceeds", () =>
  withFixture((fx) => {
    orchestratorReading(fx, 70000);
    const r = run(fx);
    assert.equal(r.status, 0, out(r));
    assert.match(out(r), /orchestrator context 70k/i);
    assert.match(out(r), /no new tickets/i);
    assert.match(ticketStatus(fx), /claimed/);
  }));

test("warns at 79k (just under the refusal) and proceeds", () =>
  withFixture((fx) => {
    orchestratorReading(fx, 79000);
    const r = run(fx);
    assert.equal(r.status, 0, out(r));
    assert.match(out(r), /orchestrator context 79k/i);
    assert.match(out(r), /no new tickets/i);
  }));

// --- refuse at >= 80k ---

test("refuses at 80k: exit 1 and the /compact message", () =>
  withFixture((fx) => {
    orchestratorReading(fx, 80000);
    const r = run(fx);
    assert.equal(r.status, 1, out(r));
    assert.ok(
      r.stderr.includes("orchestrator context 80k ≥ 80k: write the session handoff and ask the user to /compact"),
      `stderr was:\n${r.stderr}`,
    );
  }));

test("refuses at 120k and names the reading in k", () =>
  withFixture((fx) => {
    orchestratorReading(fx, 120000);
    const r = run(fx);
    assert.equal(r.status, 1, out(r));
    assert.ok(
      r.stderr.includes("orchestrator context 120k ≥ 80k: write the session handoff and ask the user to /compact"),
      `stderr was:\n${r.stderr}`,
    );
  }));

test("a refusal claims nothing and leaves the worktree where it was", () =>
  withFixture((fx) => {
    orchestratorReading(fx, 95000);
    const headBefore = git(fx.wt, ["rev-parse", "HEAD"]);
    const r = run(fx);
    assert.equal(r.status, 1, out(r));
    assert.match(ticketStatus(fx), /ready-for-agent/, "refused agent-start must not claim the ticket");
    assert.equal(git(fx.wt, ["rev-parse", "HEAD"]), headBefore);
  }));

// --- --force ---

test("--force proceeds at 85k and claims the ticket", () =>
  withFixture((fx) => {
    orchestratorReading(fx, 85000);
    const r = run(fx, ["--force"]);
    assert.equal(r.status, 0, out(r));
    assert.match(ticketStatus(fx), /claimed/);
  }));

// --- --continue ---

test("--continue at 85k gets the warning, not the refusal", () =>
  withFixture((fx) => {
    orchestratorReading(fx, 85000);
    const r = run(fx, ["--continue"]);
    assert.equal(r.status, 0, out(r));
    assert.match(out(r), /orchestrator context 85k/i);
    assert.doesNotMatch(out(r), /ask the user to \/compact/);
    assert.match(ticketStatus(fx), /claimed/);
  }));

test("--continue at 75k gets the warning", () =>
  withFixture((fx) => {
    orchestratorReading(fx, 75000);
    const r = run(fx, ["--continue"]);
    assert.equal(r.status, 0, out(r));
    assert.match(out(r), /orchestrator context 75k/i);
  }));

test("--continue below 70k is silent", () =>
  withFixture((fx) => {
    orchestratorReading(fx, 40000);
    const r = run(fx, ["--continue"]);
    assert.equal(r.status, 0, out(r));
    assert.doesNotMatch(out(r), /orchestrator context/i);
  }));

// --- a null reading never blocks ---

test("null reading: no transcript for the session never blocks", () =>
  withFixture((fx) => {
    const r = run(fx); // projects dir exists but holds no transcript for SESSION
    assert.equal(r.status, 0, out(r));
    assert.doesNotMatch(out(r), /orchestrator context/i);
    assert.match(ticketStatus(fx), /claimed/);
  }));

test("null reading: a transcript with no assistant usage never blocks", () =>
  withFixture((fx) => {
    writeFileSync(path.join(fx.projDir, `${SESSION}.jsonl`), JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
    const r = run(fx);
    assert.equal(r.status, 0, out(r));
    assert.doesNotMatch(out(r), /orchestrator context/i);
  }));

test("null reading: no CLAUDE_CODE_SESSION_ID never blocks", () =>
  withFixture((fx) => {
    orchestratorReading(fx, 150000); // exists, but nothing names it
    const r = run(fx, [], { CLAUDE_CODE_SESSION_ID: "" });
    assert.equal(r.status, 0, out(r));
    assert.doesNotMatch(out(r), /orchestrator context/i);
  }));
