#!/usr/bin/env node
// Prints the current main session's context size as JSON:
// {"session","context_tokens","percent"}. Reads the newest top-level transcript in
// $HOME/.claude/projects/<cwd with non-alphanumerics -> "-">/ (subagent transcripts
// live in subdirectories and are ignored). No transcript: context_tokens null, exit 0.
// --self (organism-infra/119): the calling subagent's own reading, chosen by transcript cwd ==
// this worktree; prints {"session","context_tokens","percent","scope":"self"}, null when none matches.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadContextTokens } from "./context-state.mjs";
import { budgetFor } from "./context-budget.mjs";
import { normalizeLegacyFlags } from "../apps/board/legacy-terms.mjs";

// --role <role> (organism-infra/145): adds warn, stop (budgetFor(type), scripts/context-budget.json) and
// state ("ok" | "warn" | "stop"; null on a null reading), with or without --self.

const WINDOW = Number(process.env.CONTEXT_WINDOW_TOKENS) || 1_000_000;

function newestTranscript(dir) {
  let best = null;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const file = path.join(dir, e.name);
    const mtime = statSync(file).mtimeMs;
    if (!best || mtime > best.mtime) best = { file, mtime, session: e.name.slice(0, -".jsonl".length) };
  }
  return best;
}

function lastUsageTokens(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const u = rec?.type === "assistant" ? rec.message?.usage : null;
    if (u) {
      return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    }
  }
  return null;
}

// CLAUDE_CODE_SESSION_ID names this session's transcript; look for it under every
// project dir, since the cwd may be a worktree or subdirectory with a different slug.
function sessionTranscript(projects, id) {
  let dirs = [];
  try {
    dirs = readdirSync(projects, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = path.join(projects, d.name, `${id}.jsonl`);
    try {
      return { file, session: id, mtime: statSync(file).mtimeMs };
    } catch {
      // not in this project dir
    }
  }
  return null;
}

// organism-infra/119: first `cwd` recorded in a transcript (every subagent record carries it).
function transcriptCwd(file) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"cwd"')) continue;
    try {
      const c = JSON.parse(line)?.cwd;
      if (typeof c === "string") return c;
    } catch {
      // skip malformed line
    }
  }
  return null;
}

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// The calling subagent's own transcript: <projects>/<slug>/<session>/subagents/agent-*.jsonl whose
// cwd is this worktree. Never "newest file": two agents run at once. Newest of the matches wins.
function selfTranscript(projects, id) {
  if (!id) return null;
  const here = real(process.cwd());
  let best = null;
  let slugs = [];
  try {
    slugs = readdirSync(projects, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of slugs) {
    if (!d.isDirectory()) continue;
    const sub = path.join(projects, d.name, id, "subagents");
    let files = [];
    try {
      files = readdirSync(sub, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of files) {
      if (!e.isFile() || !e.name.startsWith("agent-") || !e.name.endsWith(".jsonl")) continue;
      const file = path.join(sub, e.name);
      const cwd = transcriptCwd(file);
      if (cwd === null || real(cwd) !== here) continue;
      const mtime = statSync(file).mtimeMs;
      if (!best || mtime > best.mtime) best = { file, mtime };
    }
  }
  return best;
}

const home = process.env.HOME || os.homedir();
const projects = path.join(home, ".claude", "projects");
const id = process.env.CLAUDE_CODE_SESSION_ID;

const argv = normalizeLegacyFlags(process.argv.slice(2), "context");
const roleFlag = argv.indexOf("--role");
const role = roleFlag >= 0 ? argv[roleFlag + 1] : undefined;

function withBudget(out) {
  if (roleFlag < 0) return out;
  const { warn, stop } = budgetFor(role);
  const t = out.context_tokens;
  const state = t === null ? null : t >= stop ? "stop" : t >= warn ? "warn" : "ok";
  return { ...out, warn, stop, state };
}

if (process.argv.includes("--self")) {
  const t = selfTranscript(projects, id);
  const tokens = t ? lastUsageTokens(t.file) : null;
  const percent = tokens === null ? null : Math.min(100, Math.round((tokens / WINDOW) * 10000) / 100);
  console.log(JSON.stringify(withBudget({ session: id || null, context_tokens: tokens, percent, scope: "self" })));
  process.exit(0);
}

const dir = path.join(projects, process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
// organism-infra/109: the status line records the real number for this session; it wins over
// the transcript. Sessions it hasn't seen fall back to transcripts as before.
const seen = id ? loadContextTokens(home, id) : null;
const t = seen !== null ? null : (id && sessionTranscript(projects, id)) || newestTranscript(dir);
const tokens = seen !== null ? seen : t ? lastUsageTokens(t.file) : null;
const session = seen !== null ? id : t ? t.session : null;
const percent = tokens === null ? null : Math.min(100, Math.round((tokens / WINDOW) * 10000) / 100);
console.log(JSON.stringify(withBudget({ session, context_tokens: tokens, percent })));
