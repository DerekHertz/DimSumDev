// organism-infra/119: `node scripts/context.mjs --self` reports the calling subagent's own context.
//
// Seam: the CLI, run with HOME=<fixture>, CLAUDE_CODE_SESSION_ID=<id> and cwd=<the agent's worktree>.
// A subagent's transcript lives at $HOME/.claude/projects/<project slug>/<session id>/subagents/agent-*.jsonl
// and every record carries the subagent's `cwd`. --self picks the transcript whose cwd matches the
// current worktree (two agents run at once, so never "newest file"), prints
// {session, context_tokens, percent, scope:"self"}, and with no match prints context_tokens null, exit 0.
//
// Criterion map:
//   AC2 reads the matching subagent transcript            -> "--self reads the subagent transcript whose cwd matches"
//   AC2 ignores other concurrent agents' transcripts       -> "--self ignores a newer transcript from another worktree"
//   AC2 null when none matches                            -> "--self returns null ..." tests
//   AC3 output without --self is unchanged                -> "without --self ..." test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { saveContextTokens } from "./context-state.mjs";

const SCRIPT = path.join(path.resolve(fileURLToPath(new URL("..", import.meta.url))), "scripts", "context.mjs");
const SESSION = "orch-session-1";

function fixture() {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "ctx-self-")));
  const projDir = path.join(home, ".claude", "projects", "-fixture-project");
  mkdirSync(projDir, { recursive: true });
  const wtA = path.join(home, "worktrees", "agent-a");
  const wtB = path.join(home, "worktrees", "agent-b");
  mkdirSync(wtA, { recursive: true });
  mkdirSync(wtB, { recursive: true });
  return { home, projDir, wtA, wtB };
}

const usage = (n) => ({ input_tokens: n, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 7 });
const asst = (cwd, n) => JSON.stringify({ type: "assistant", cwd, message: { role: "assistant", usage: usage(n) } });
const user = (cwd) => JSON.stringify({ type: "user", cwd, message: { role: "user", content: "hi" } });

function writeAt(file, lines, mtimeSec) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n") + "\n");
  utimesSync(file, mtimeSec, mtimeSec);
}

const subagent = (f, name) => path.join(f.projDir, SESSION, "subagents", `${name}.jsonl`);

function run(f, cwd, args, env = {}) {
  const r = spawnSync("node", [SCRIPT, ...args], {
    cwd,
    env: { ...process.env, HOME: f.home, CLAUDE_CODE_SESSION_ID: SESSION, ...env },
    encoding: "utf8",
    timeout: 15000,
  });
  return { ...r, json: r.status === 0 ? JSON.parse(r.stdout) : null };
}

test("--self reads the subagent transcript whose cwd matches the worktree", () => {
  const f = fixture();
  writeAt(subagent(f, "agent-aaa"), [user(f.wtA), asst(f.wtA, 1000), user(f.wtA), asst(f.wtA, 52000)], 1000);
  const r = run(f, f.wtA, ["--self"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.scope, "self");
  assert.equal(r.json.context_tokens, 52000); // last assistant usage, output_tokens excluded
  assert.equal(typeof r.json.percent, "number");
  assert.ok(r.json.percent > 0 && r.json.percent <= 100);
  assert.deepEqual(Object.keys(r.json).sort(), ["context_tokens", "percent", "scope", "session"]);
});

test("--self ignores a newer transcript from another worktree (two agents at once)", () => {
  const f = fixture();
  writeAt(subagent(f, "agent-aaa"), [user(f.wtA), asst(f.wtA, 41000)], 1000);
  writeAt(subagent(f, "agent-bbb"), [user(f.wtB), asst(f.wtB, 99000)], 5000); // newest file, wrong cwd
  const a = run(f, f.wtA, ["--self"]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.json.context_tokens, 41000);
  const b = run(f, f.wtB, ["--self"]);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(b.json.context_tokens, 99000);
});

test("--self returns null when no subagent transcript matches the worktree", () => {
  const f = fixture();
  writeAt(subagent(f, "agent-bbb"), [user(f.wtB), asst(f.wtB, 99000)], 5000);
  const r = run(f, f.wtA, ["--self"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.context_tokens, null);
  assert.equal(r.json.scope, "self");
  assert.equal(r.json.percent, null);
});

test("--self returns null when the session has no subagents directory", () => {
  const f = fixture();
  const r = run(f, f.wtA, ["--self"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.context_tokens, null);
  assert.equal(r.json.scope, "self");
});

test("--self returns null, exit 0, when CLAUDE_CODE_SESSION_ID is unset", () => {
  const f = fixture();
  writeAt(subagent(f, "agent-aaa"), [user(f.wtA), asst(f.wtA, 41000)], 1000);
  const r = run(f, f.wtA, ["--self"], { CLAUDE_CODE_SESSION_ID: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.context_tokens, null);
  assert.equal(r.json.scope, "self");
});

test("--self ignores subagent transcripts of other sessions, even with a matching cwd", () => {
  const f = fixture();
  writeAt(path.join(f.projDir, "some-other-session", "subagents", "agent-zzz.jsonl"), [user(f.wtA), asst(f.wtA, 77000)], 5000);
  const r = run(f, f.wtA, ["--self"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.context_tokens, null);
});

test("--self never reports the orchestrator's number (status-line file and top-level transcript are ignored)", () => {
  const f = fixture();
  saveContextTokens(f.home, SESSION, 123456); // the status line's reading for the shared session id
  writeAt(path.join(f.projDir, `${SESSION}.jsonl`), [asst(f.home, 150000)], 9000); // orchestrator transcript
  writeAt(subagent(f, "agent-aaa"), [user(f.wtA), asst(f.wtA, 30000)], 1000);
  const r = run(f, f.wtA, ["--self"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.context_tokens, 30000);
  const none = run(f, f.wtB, ["--self"]);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.json.context_tokens, null);
});

test("without --self, output is unchanged: orchestrator reading, no scope key, subagents ignored", () => {
  const f = fixture();
  writeAt(path.join(f.projDir, `${SESSION}.jsonl`), [asst(f.home, 88000)], 1000);
  writeAt(subagent(f, "agent-aaa"), [user(f.wtA), asst(f.wtA, 30000)], 9000);
  const r = run(f, f.wtA, []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.session, SESSION);
  assert.equal(r.json.context_tokens, 88000);
  assert.deepEqual(Object.keys(r.json).sort(), ["context_tokens", "percent", "session"]);
});
