// organism-infra/162 scope added (user, 2026-10-06): at 80k+ the hook also allows Write/Edit under the
// session scratchpad dir (the handoff skill drafts there), and still refuses a path that escapes it.
// Same seam as context-budget.test.mjs: the hook CLI with PreToolUse JSON on stdin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.resolve(fileURLToPath(new URL("../..", import.meta.url))), "scripts", "hooks", "context-budget.mjs");
const SESSION = "orch-session-162";
const PAD = `/tmp/claude-1000/-fixture-project/${SESSION}/scratchpad`;

function fixture(tokens) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "ctx-budget-pad-")));
  const wt = path.join(home, "worktrees", "agent-a");
  mkdirSync(wt, { recursive: true });
  const sub = path.join(home, ".claude", "projects", "-fixture-project", SESSION, "subagents");
  mkdirSync(sub, { recursive: true });
  const rec = (n) => JSON.stringify({ type: "assistant", cwd: wt, message: { role: "assistant", usage: { input_tokens: n, output_tokens: 1 } } });
  writeFileSync(path.join(sub, "agent-a.jsonl"), rec(tokens) + "\n");
  return { home, wt };
}

function write(f, tool, filePath, sessionId = SESSION) {
  const env = { ...process.env, HOME: f.home };
  delete env.CLAUDE_CODE_SESSION_ID;
  // organism-infra/220: mechanics at 70k/80k through the config seam (shipped numbers: tiers test).
  const cfg = path.join(f.home, "mechanics-budget.json");
  writeFileSync(cfg, JSON.stringify({ default: { warn: 70_000, stop: 80_000 }, roles: {}, orchestrator: { warn: 70_000, stop: 80_000 } }));
  env.CONTEXT_BUDGET_CONFIG = cfg;
  const input = { session_id: sessionId, cwd: f.wt, tool_name: tool, tool_input: { file_path: filePath, content: "x", old_string: "a", new_string: "b" }, agent_id: "agent-a", agent_type: "security" };
  return spawnSync("node", [SCRIPT], { cwd: f.wt, env, input: JSON.stringify(input), encoding: "utf8", timeout: 15000 });
}

test("at 95k a Write or Edit under the session scratchpad is allowed", () => {
  const f = fixture(95_000);
  for (const tool of ["Write", "Edit"]) {
    const r = write(f, tool, `${PAD}/162-developer.md`);
    assert.equal(r.status, 0, `${tool} in scratchpad must be allowed, got ${r.status}\n${r.stderr}`);
  }
});

test("at 95k a path that climbs out of the scratchpad with .. is refused", () => {
  const f = fixture(95_000);
  const r = write(f, "Write", `${PAD}/../../../../../home/someone/.bashrc`);
  assert.equal(r.status, 2, r.stderr);
});

test("at 95k another session's scratchpad and a look-alike prefix are refused", () => {
  const f = fixture(95_000);
  // /tmp itself is a wrap-up location since organism-infra/208, so the look-alikes sit under /var/tmp.
  assert.equal(write(f, "Write", "/var/tmp/claude-1000/-fixture-project/other-session/scratchpad/h.md").status, 2);
  assert.equal(write(f, "Write", `/var${PAD}-evil/h.md`).status, 2);
  assert.equal(write(f, "Write", `/tmpfoo/h.md`).status, 2);
});

test("at 95k Read of a scratchpad file is still refused (only Write/Edit are wrap-up calls)", () => {
  const f = fixture(95_000);
  const r = write(f, "Read", `${PAD}/x.md`);
  assert.equal(r.status, 2, r.stderr);
});
