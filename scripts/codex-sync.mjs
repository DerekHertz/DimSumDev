#!/usr/bin/env node
// Shared contracts come from .claude/; .codex/runtime-guidance.md owns Codex execution details.
//   .claude/agents/<role>.md -> .codex/agents/<role>.toml
//   .claude/skills/**        -> .agents/skills/**   (runtime wording adapted; licences copied unchanged)
//   CLAUDE.md + runtime guidance -> AGENTS.md
// Usage: node scripts/codex-sync.mjs [--check] [--root <dir>]
//   write mode regenerates every mirror and removes stale ones; --check writes nothing, prints each
//   drifted path and exits 1 on drift.
// Codex facts (learn.chatgpt.com/docs: models, agent-configuration/subagents, build-skills, hooks, agent-configuration/agents-md):
//   agent TOML keys name, description, developer_instructions, model, model_reasoning_effort; no per-agent tools.
import { execFileSync } from "node:child_process";
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

export const RUNTIME_NOTICE = "Before working, read `.codex/runtime-guidance.md` for the Codex execution contract. Shared safety and approval gates, explicit ticket limits and stricter session constraints still apply.";

// Narrow runtime adaptations, leaving the shared source and approval sections intact.
function runtimeWording(text) {
  return text
    .replace(/^Run agents on their role definition's model[^\n]*$/m, "For Codex, use the model and effort configured in `.codex/agents/<role>.toml`, subject to availability and session limits. Never silently substitute a Claude tier or another runtime.")
    .replace(/Have `scout` run the smoke check:/g, "Run the smoke check locally, or delegate a bounded read-only check when permitted:")
    .replace(/Run typechecking regularly, single test files regularly, and the full test suite once at the end\. Delegate long test or log output to the `scout` subagent so only a summary comes back\./g, "Run required typechecking and literal covering test files with bounded concurrency and timeouts, including affected existing callers. In resource-limited den agents, leave full suites and browser workloads to designated checks/CI or a separately authorized capable environment. Delegate only independent checkable work when permitted; report exact evidence and remaining checks.")
    .replace(/claude-(haiku|sonnet|opus)-[\w.-]+/gi, (_match, tier) => MODEL_MAP[tier.toLowerCase()])
    .replace(/(\bmodel:\s*|--model\s+)(haiku|sonnet|opus)\b/gi, (_match, prefix, tier) => prefix + MODEL_MAP[tier.toLowerCase()])
    .replace(/\bSonnet(?: 5\.5)?\b/gi, "higher-tier Codex")
    .replace(/\bHaiku\b/gi, "lower-cost Codex")
    .replace(/\bOpus\b/gi, "deepest-tier Codex");
}

export function renderSkill(relative, content) {
  if (!relative.endsWith("SKILL.md")) return content;
  const text = runtimeWording(content.toString());
  // Keep front matter first. The shared protocol/implementation skills are the
  // entry points used by standalone role sessions as well as the root owner.
  return ["team-protocol/SKILL.md", "implement/SKILL.md"].includes(relative)
    ? text.replace(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/, `$1\n${RUNTIME_NOTICE}\n`)
    : text;
}

// Codex has no per-agent tool list, so a role definition's tool limits (scout read-only, herald's draft check only) bind only as instructions.
export const CODEX_CAVEAT = "Codex caveat: under Codex, tool limits named in this role definition (scout read-only, herald's draft check only) are instructions, not enforced. Run scout and herald with a read-only or workspace-write sandbox and approvals on.";

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
  const body = RUNTIME_NOTICE + "\n\n" + applyRules(runtimeWording(m[2].replace(/^\s*\n/, ""))).trimEnd() + "\n\n" + CODEX_CAVEAT;
  if (body.includes("'''")) throw new Error("body contains ''' and cannot be a TOML literal string");
  return [
    `name = ${JSON.stringify(fm.name)}`,
    `description = ${JSON.stringify(runtimeWording(fm.description))}`,
    `model = ${JSON.stringify(model)}`,
    `model_reasoning_effort = ${JSON.stringify(effort)}`,
    `developer_instructions = '''\n${body}\n'''\n`,
  ].join("\n");
}

export function renderAgents(claudeMd, runtimeGuidance = "") {
  const head = "<!-- Generated by scripts/codex-sync.mjs from CLAUDE.md (shared contracts) and .codex/runtime-guidance.md (Codex execution). Edit those sources, not this mirror. -->\n\n";
  return head + applyRules(runtimeWording(claudeMd)) + (runtimeGuidance ? "\n\n" + runtimeGuidance.trim() + "\n" : "");
}

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join("/")]);
}

// Skill files to mirror: tracked files only, so a stray untracked file is never copied. A root that is not a
// git checkout (a test fixture) falls back to the directory walk.
function skillFiles(root) {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", ".claude/skills"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const files = out.split("\0").filter(Boolean).map((f) => f.slice(".claude/skills/".length));
    if (files.length) return files;
  } catch {}
  return walk(path.join(root, ".claude/skills"));
}

// Every mirror the root should hold: relPath -> Buffer|string. Stale paths are listed separately.
function plan(root) {
  // Fail before writing any mirror if the hand-maintained runtime source is missing.
  const runtimeGuidance = readFileSync(path.join(root, ".codex/runtime-guidance.md"), "utf8");
  const want = new Map();
  const stale = [];
  const agentsDir = path.join(root, ".claude/agents");
  const roles = readdirSync(agentsDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  for (const role of roles) want.set(`.codex/agents/${role}.toml`, render(readFileSync(path.join(agentsDir, `${role}.md`), "utf8")));
  for (const f of skillFiles(root)) want.set(`.agents/skills/${f}`, renderSkill(f,readFileSync(path.join(root, ".claude/skills", f))));
  want.set("AGENTS.md", renderAgents(readFileSync(path.join(root, "CLAUDE.md"), "utf8"),runtimeGuidance));
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
