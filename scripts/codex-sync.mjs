#!/usr/bin/env node
// den-mvp/103: .claude/ is the one source for the relay; this writes the Codex mirrors from it.
//   .claude/agents/<role>.md -> .codex/agents/<role>.toml
//   .claude/skills/**        -> .agents/skills/**   (byte copies; .agents/skills/jevgrep is hand-kept, left alone)
//   CLAUDE.md                -> AGENTS.md
// Usage: node scripts/codex-sync.mjs [--check] [--root <dir>]
//   write mode regenerates every mirror and removes stale ones; --check writes nothing, prints each
//   drifted path and exits 1 on drift.
// Codex facts (learn.chatgpt.com/docs: models, agent-configuration/subagents, build-skills, hooks, agent-configuration/agents-md):
//   agent TOML keys name, description, developer_instructions, model, model_reasoning_effort; no per-agent tools.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, rmdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Claude model tier -> Codex model id (docs: learn.chatgpt.com/docs/models).
export const MODEL_MAP = { opus: "gpt-6-astra", sonnet: "gpt-6.1-sol", haiku: "gpt-6-luna" };
// Claude effort -> model_reasoning_effort. The values below are the ones the Codex subagents page documents
// (low, medium, high, xhigh, max, ultra); Claude has no "ultra", so it is not a source value.
export const EFFORT_MAP = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs[0]);
const subagents = (_m, args) => {
  const names = args.split(",").map((s) => s.trim()).filter(Boolean);
  return names.length ? `the ${list(names)} subagent${names.length > 1 ? "s" : ""}` : "the subagents";
};
// The Claude-only line rules, applied to role definition bodies and to CLAUDE.md. First match wins per text span, in order.
export const RULES = [
  { name: "agent-call", pattern: /\bAgent\(([^)]*)\)/g, action: "rewrite", to: subagents,
    why: "Codex has no Agent(...) tool list; delegation is natural language naming the subagent" },
  { name: "mcp-tool", pattern: /`?mcp__((?:(?!__)\w)+)(?:__\w+)?`?/g, action: "rewrite", to: (_m, server) => `the ${server} MCP server`,
    why: "Codex addresses MCP servers by config, not mcp__ tool names" },
  { name: "claude-launch", pattern: /^[^\n]*claude --agent[^\n]*$/gm, action: "rewrite",
    to: "To act as an agent, read its role definition first and follow it: `.codex/agents/<role>.toml` (generated from `.claude/agents/<role>.md`).",
    why: "the claude --agent launch flag is meaningless to Codex; the read-the-role-definition rule still holds" },
];
const applyRules = (text) => RULES.reduce((t, r) => t.replace(r.pattern, r.to), text);

export function render(roleDefinition) {
  const m = roleDefinition.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error("role definition has no front matter");
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue; // nested keys (org:, skills:) are Claude-only and dropped
    if (/^[|>]/.test(kv[2])) throw new Error(`front matter key ${kv[1]} is a multi-line scalar; codex-sync cannot read it`);
    fm[kv[1]] = kv[2].trim();
  }
  for (const k of ["name", "description"]) if (!fm[k]) throw new Error(`front matter has no ${k}`);
  const model = MODEL_MAP[fm.model];
  if (!model) throw new Error(`unknown model "${fm.model}" (add it to MODEL_MAP)`);
  const effort = EFFORT_MAP[fm.effort];
  if (!effort) throw new Error(`unknown effort "${fm.effort}" (add it to EFFORT_MAP)`);
  const body = applyRules(m[2].replace(/^\s*\n/, "")).trimEnd();
  if (body.includes("'''")) throw new Error("body contains ''' and cannot be a TOML literal string");
  return [
    `name = ${JSON.stringify(fm.name)}`,
    `description = ${JSON.stringify(fm.description)}`,
    `model = ${JSON.stringify(model)}`,
    `model_reasoning_effort = ${JSON.stringify(effort)}`,
    `developer_instructions = '''\n${body}\n'''\n`,
  ].join("\n");
}

export function renderAgents(claudeMd) {
  const head = "<!-- Generated from CLAUDE.md by scripts/codex-sync.mjs (npm run codex:sync). Do not edit; edit CLAUDE.md. -->\n\n";
  return head + applyRules(claudeMd);
}

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join("/")]);
}

// Every mirror the root should hold: relPath -> Buffer|string. Stale paths are listed separately.
function plan(root) {
  const want = new Map();
  const stale = [];
  const agentsDir = path.join(root, ".claude/agents");
  const roles = readdirSync(agentsDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  for (const role of roles) want.set(`.codex/agents/${role}.toml`, render(readFileSync(path.join(agentsDir, `${role}.md`), "utf8")));
  for (const f of walk(path.join(root, ".claude/skills"))) want.set(`.agents/skills/${f}`, readFileSync(path.join(root, ".claude/skills", f)));
  want.set("AGENTS.md", renderAgents(readFileSync(path.join(root, "CLAUDE.md"), "utf8")));
  for (const f of walk(path.join(root, ".codex/agents"))) if (f.endsWith(".toml") && !want.has(`.codex/agents/${f}`)) stale.push(`.codex/agents/${f}`);
  // .agents/skills/jevgrep is hand-kept: never stale.
  for (const f of walk(path.join(root, ".agents/skills"))) if (!f.startsWith("jevgrep/") && !want.has(`.agents/skills/${f}`)) stale.push(`.agents/skills/${f}`);
  return { want, stale };
}

function pruneEmpty(dir, stop) {
  for (let d = dir; d !== stop && existsSync(d) && readdirSync(d).length === 0; d = path.dirname(d)) rmdirSync(d);
}

export function sync(root, { check = false } = {}) {
  const { want, stale } = plan(root);
  const drift = [...stale];
  for (const [rel, content] of want) {
    const abs = path.join(root, rel);
    const same = existsSync(abs) && readFileSync(abs).equals(Buffer.from(content));
    if (same) continue;
    drift.push(rel);
    if (!check) { mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, content); }
  }
  if (!check) for (const rel of stale) { const abs = path.join(root, rel); rmSync(abs); pruneEmpty(path.dirname(abs), root); }
  return drift;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const ri = args.indexOf("--root");
  const root = path.resolve(ri >= 0 ? args[ri + 1] : fileURLToPath(new URL("..", import.meta.url)));
  const check = args.includes("--check");
  const drift = sync(root, { check });
  if (check && drift.length) {
    console.error(`codex-sync: ${drift.length} mirror(s) drifted from .claude/ or CLAUDE.md; run npm run codex:sync\n${drift.join("\n")}`);
    process.exit(1);
  }
  console.log(check ? "codex-sync: mirrors in sync" : `codex-sync: ${drift.length} file(s) written or removed`);
}
