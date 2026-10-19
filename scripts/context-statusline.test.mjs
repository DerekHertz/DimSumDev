// organism-infra/109 AC "If the status-line input carries context numbers, scripts/context.mjs
// uses the same source (fixes null readings)". Black-box through both CLIs sharing one HOME:
// scripts/statusline.mjs receives the status-line input for session S; afterwards
// `node scripts/context.mjs` with CLAUDE_CODE_SESSION_ID=S reports that number, even with no
// transcript on disk. How statusline hands the number over (a file under $HOME/.claude/) is the
// developer's choice. Other sessions still fall back to transcripts (organism-infra/44 behaviour).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const STATUSLINE = path.join(ROOT, "scripts", "statusline.mjs");
const CONTEXT = path.join(ROOT, "scripts", "context.mjs");

function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ctx-sl-")));
  const home = path.join(dir, "home");
  const cwd = path.join(home, "work", "proj");
  mkdirSync(cwd, { recursive: true });
  const projDir = path.join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(projDir, { recursive: true });
  const usage = path.join(dir, "fake-usage.mjs");
  writeFileSync(usage, `console.log(JSON.stringify({"5-hour":{percent:1,resets_at:null},weekly:{percent:2,resets_at:null}}));\n`);
  return { dir, home, cwd, projDir, usage };
}

function statusline(f, session, tokens) {
  const stdin = {
    session_id: session,
    context_window: { context_window_size: 200000, current_usage: { input_tokens: tokens, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  };
  const env = { ...process.env, HOME: f.home, DEN_ROOT: f.dir, STATUSLINE_USAGE_SCRIPT: f.usage, STATUSLINE_CACHE: path.join(f.dir, "cache.json") };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync("node", [STATUSLINE], { cwd: f.cwd, env, input: JSON.stringify(stdin), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

function context(f, session) {
  const env = { ...process.env, HOME: f.home };
  delete env.CLAUDE_CODE_SESSION_ID;
  if (session) env.CLAUDE_CODE_SESSION_ID = session;
  const r = spawnSync("node", [CONTEXT], { cwd: f.cwd, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const asst = (n) => JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: n, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });

test("AC5: with no transcript, context.mjs reports the number the status line saw for this session (no longer null)", () => {
  const f = fixture();
  statusline(f, "sess-sl", 32_010);
  const out = context(f, "sess-sl");
  assert.equal(out.context_tokens, 32_010);
  assert.equal(out.session, "sess-sl");
  assert.equal(typeof out.percent, "number");
});

test("AC5: the status-line number wins over a stale transcript for the same session", () => {
  const f = fixture();
  writeFileSync(path.join(f.projDir, "sess-sl.jsonl"), asst(111) + "\n");
  statusline(f, "sess-sl", 32_010);
  assert.equal(context(f, "sess-sl").context_tokens, 32_010);
});

test("AC5: a different session still falls back to its transcript", () => {
  const f = fixture();
  writeFileSync(path.join(f.projDir, "other-sess.jsonl"), asst(222) + "\n");
  statusline(f, "sess-sl", 32_010);
  const out = context(f, "other-sess");
  assert.equal(out.context_tokens, 222);
  assert.equal(out.session, "other-sess");
});
