#!/usr/bin/env node
// PreToolUse hook (organism-infra/162): enforces the agent context budget (organism-infra/119) with code.
// Reads the hook JSON on stdin. Applies only to agent sessions (subagent calls: the input has agent_id);
// the orchestrator main session is never gated here (it has its own gate in agent-start).
// Thresholds come from scripts/context-budget.json by the call's agent_type (organism-infra/145):
//   under warn           -> allow, silent
//   warn to under stop   -> allow, inject a checkpoint warning once per agent (hookSpecificOutput.additionalContext)
//   stop and over        -> exit 2 with wrap-up instructions, except the wrap-up calls below
//   no reading / bad input -> allow (fails open)
// The agent's own reading comes from `scripts/context.mjs --self`, run as a child with the session from
// the hook input (the hook's env does not carry CLAUDE_CODE_SESSION_ID).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { budgetFor } from "../context-budget.mjs";

const SESSION_ID = /^[\w.-]+$/;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_SCRIPT = path.join(HERE, "..", "context.mjs");

const WRAP_UP_BASH = [
  /^git (?:add|commit)(?:\s|$)/,
  /^npm run board -- (?:handoff|release|comment)(?:\s|$)/,
  /^node scripts\/context\.mjs(?:\s+--self)?$/,
  /^node scripts\/log-(?:agent|cell)\.mjs(?:\s|$)/, // log-cell: the old name, kept for one release (ADR 0028)
];

export function isAgentSession(input) {
  return Boolean(input?.agent_id) && input.agent_type !== "orchestrator";
}

// One simple command only: no chaining, pipes, redirects, substitution or newlines. Quoted text may
// hold ; & | < > ( ) (a commit message), but never $ or a backtick (expansion inside double quotes).
// A backslash outside single quotes is chain-unsafe: it can escape a quote and hide a chain (organism-infra/165).
export function isSimpleCommand(command) {
  if (/[`$\n\r]/.test(command)) return false;
  if (command.replace(/'[^']*'/g, "").includes("\\")) return false;
  const bare = command.replace(/"[^"]*"|'[^']*'/g, "");
  return !/[;&|<>()"']/.test(bare);
}

export function isWrapUpBash(command) {
  const c = String(command ?? "").trim();
  return isSimpleCommand(c) && WRAP_UP_BASH.some((re) => re.test(c));
}

// Candidate roots of the session scratchpad: /tmp/claude-<uid>/<project slug>/<session>/scratchpad
function scratchpadRoots(sessionId) {
  if (!sessionId || !SESSION_ID.test(sessionId)) return [];
  const bases = new Set(["/tmp", os.tmpdir()]);
  return [...bases].map((b) => new RegExp(`^${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/claude-[^/]+/[^/]+/${sessionId}/scratchpad/`));
}

function resolveFrom(input, filePath) {
  return path.resolve(String(input.cwd || process.cwd()), String(filePath ?? ""));
}

// The main checkout: $DEN_ROOT when set, else the first entry of `git worktree list` from the call's cwd.
function mainCheckout(input) {
  const envRoot = process.env.DEN_ROOT || process.env.ORGANISM_ROOT;
  if (envRoot) return path.resolve(envRoot);
  const r = spawnSync("git", ["worktree", "list", "--porcelain", "-z"], { cwd: String(input.cwd || process.cwd()), encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0) return null;
  const first = r.stdout.split("\0").find((l) => l.startsWith("worktree "));
  return first ? path.resolve(first.slice("worktree ".length)) : null;
}

const inside = (abs, dir) => abs === dir || abs.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

// A handoff draft under /tmp (organism-infra/208). Not a path inside the agent's own cwd or HOME, which could
// sit under /tmp in a fixture or a temp checkout: those are real work, not a draft.
function isTmpDraft(input, abs) {
  if (!inside(abs, "/tmp") || abs === "/tmp") return false;
  const guarded = [input.cwd, process.env.HOME].filter(Boolean).map((p) => path.resolve(String(p)));
  return !guarded.some((g) => g !== "/tmp" && inside(abs, g));
}

export function isWrapUpWrite(input) {
  const filePath = input?.tool_input?.file_path;
  if (!filePath) return false;
  const abs = resolveFrom(input, filePath);
  const main = mainCheckout(input);
  if (main && abs.startsWith(path.join(main, ".scratch") + path.sep)) return true;
  if (isTmpDraft(input, abs)) return true;
  return scratchpadRoots(input.session_id).some((re) => re.test(abs));
}

export function isWrapUpCall(input) {
  const tool = input?.tool_name;
  if (tool === "Bash") return isWrapUpBash(input.tool_input?.command);
  if (tool === "Write" || tool === "Edit") return isWrapUpWrite(input);
  if (tool === "SubagentHandback") return true;
  return false;
}

export function readContextTokens(input) {
  // Never hand an unvalidated id to context.mjs (it becomes a path segment there); "." and ".." also fail.
  if (!input.session_id || !SESSION_ID.test(String(input.session_id)) || /^\.+$/.test(String(input.session_id))) return null;
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: String(input.session_id) };
  const r = spawnSync("node", [CONTEXT_SCRIPT, "--self"], {
    cwd: input.cwd || process.cwd(),
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (r.status !== 0) return null;
  try {
    const t = JSON.parse(r.stdout).context_tokens;
    return typeof t === "number" ? t : null;
  } catch {
    return null;
  }
}

const k = (n) => `${Math.round(n / 1000)}k`;

export const warningText = (tokens, stop) =>
  `Context budget: this agent is at ${k(tokens)} of its ${k(stop)} budget. Checkpoint now: finish the current stage, start no new exploration, and plan a WIP commit, a handoff and board release. At ${k(stop)} every call except the wrap-up calls is refused.`;

export const refusalText = (tokens, stop) =>
  `context-budget: this agent is at ${k(tokens)}, over the ${k(stop)} budget (organism-infra/119), so this call is refused. Wrap up now: make a WIP commit (git add <paths>, git commit), draft the handoff (Write under .scratch/ or the session scratchpad), publish it with npm run board -- handoff, run npm run board -- release <ref> --keep-status, and end your final report with outcome: partial. Allowed now: git add, git commit, npm run board -- handoff|release|comment and node scripts/log-agent.mjs (one simple command, no chaining), node scripts/context.mjs, SubagentHandback (your final report), and Write/Edit under .scratch/, /tmp or the session scratchpad.`;

// The 70k-80k warning is sent once per agent (organism-infra/208). The marker is a file keyed by session and agent
// under ~/.claude (HOME is the test seam). If it cannot be read or written, the warning is sent (a repeat beats a silent miss).
function warnedBefore(input) {
  const key = `${input.session_id ?? "nosession"}-${input.agent_id}`.replace(/[^\w.-]/g, "_");
  const dir = path.join(os.homedir(), ".claude", "context-budget-warned");
  const marker = path.join(dir, key);
  try {
    readFileSync(marker);
    return true;
  } catch {
    // not warned yet
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, "1");
  } catch {
    // fall through: warn anyway
  }
  return false;
}

// Returns {code, stdout, stderr}.
export function decide(input) {
  const allow = { code: 0, stdout: "", stderr: "" };
  if (!isAgentSession(input)) return allow;
  const tokens = readContextTokens(input);
  const { warn, stop } = budgetFor(input.agent_type);
  if (tokens === null || tokens < warn) return allow;
  if (tokens < stop) {
    if (warnedBefore(input)) return allow;
    const out = { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: warningText(tokens, stop) } };
    return { code: 0, stdout: JSON.stringify(out) + "\n", stderr: "" };
  }
  if (isWrapUpCall(input)) return allow;
  const msg = refusalText(tokens, stop) + "\n";
  return { code: 2, stdout: msg, stderr: msg };
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return 0;
  }
  if (!input || typeof input !== "object") return 0;
  const r = decide(input);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.code;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
