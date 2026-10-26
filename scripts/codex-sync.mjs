#!/usr/bin/env node
// Shared contracts come from .claude/; .codex/runtime-guidance.md owns Codex execution details.
//   .claude/agents/<role>.md -> .codex/agents/<role>.toml
//   .claude/skills/**        -> .agents/skills/**   (runtime wording adapted; licences copied unchanged)
//   .claude/agents/<role>.md org block + ROLE_FOCUS -> lean role (job, inputs, outputs, done when, stop rules); the Claude body is not copied
//   .codex/team-protocol.md  -> .agents/skills/team-protocol/SKILL.md   (Codex-only protocol replaces the Claude skill)
//   CLAUDE.md (minus AGENTS_DROP sections) + runtime guidance -> AGENTS.md
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
// model_reasoning_effort per role (den-revival/05): medium unless listed. The Claude effort field is not read.
export const CODEX_EFFORT = { default: "medium", architect: "high", security: "high" };

// One or two outcome sentences per role that its org block does not say; appended to the Job line.
// A role not listed here gets only its org purpose. Keep each short: a role file is about 2 KB.
export const ROLE_FOCUS = {
  architect: "Answer the design question in the ticket with seams a developer can test; write an ADR only when the decision is hard to reverse.",
  "chief-of-staff": "Fresh subagent per stage; ship except the user-kept approvals in team-protocol Gates.",
  "code-reviewer": "Read the candidate commit's diff on two axes, standards and spec fit; write no code. On a bug ticket, check the fix lands at the layer named in the cause note (in the ticket's Comments), grep the cause pattern outside the diff and list the hits as Pre-existing. Each finding is file:line and a reason; end with `board comment --verdict pass|bounce` naming the commit.",
  designer: "Run only the mode the ticket names (direction, spec, review, critique). The user decides visuals.",
  developer: "Write one failing test per criterion first, or start from qa's tests branch without editing its tests; make them pass, run only the covering tests, commit, release at in-review. On a bug ticket, load diagnosing-bugs first and post the cause note as a ticket comment (the Cause field stays empty; symptom, repro, hypotheses, chosen cause, where else, target layer) before the first test; fix at the target layer. File work outside the ticket as a new ticket. Never review your own work. In a fix round answer each finding in one line: fixed, wrong, intentional or didn't matter.",
  product: "Settle requirements with the user in CONTEXT.md terms; publish the spec only after the user confirms.",
  qa: "Map each criterion to a test that fails without the change and give a verdict on each `node scripts/test-guard.mjs` hit, with `board comment --verdict pass|bounce`.",
  "release-manager": "Propose; never push, merge or tag. Answer the question you were started for with evidence.",
  runner: "Do exactly the task as written; start no agents.",
  security: "Check the branch for vulnerabilities, risky dependencies, secrets and CI changes; verdict via `board comment --verdict pass|bounce`. Scan the range with gitleaks; a committed secret always bounces; never print a secret's value. CI actions pin to a commit SHA, and `pull_request_target` never checks out PR code.",
  sre: "Measure, do not change; every finding is a ticket or a proposal for the user.",
  "technical-writer": "Make the docs match what the code does, with a source for every claim; never publish.",
};

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
    .replace(/Up to two worker agents run at once[^\n]*reserved slot beside them\./g, "Codex uses the worker ceiling in `.codex/runtime-guidance.md`, without reserved extra slots; stricter runtime, resource and ticket limits still apply.")
    .replace(/^- The agent tree has three levels:[^\n]*$/m, "- Codex delegation follows `.codex/runtime-guidance.md`: one implementation owner, at most two live workers besides the owner, no reserved bonus slots, and no agent started by a leaf. Stricter session and resource limits win.")
    .replace(/Start `runner` \(Haiku, up to 4 at once\)/g, "When independent delegation is useful and permitted, start `runner` (within the Codex worker ceiling)")
    .replace(/Have `runner` run the smoke check:/g, "Run the smoke check locally, or delegate a bounded read-only check when permitted:")
    .replace(/Run typechecking regularly, single test files regularly, and the full test suite once at the end\. Delegate long test or log output to the `runner` subagent so only a summary comes back\./g, "Run required typechecking and literal covering test files with bounded concurrency and timeouts, including affected existing callers. In resource-limited den agents, leave full suites and browser workloads to designated checks/CI or a separately authorized capable environment. Delegate only independent checkable work when permitted; report exact evidence and remaining checks.")
    .replace(/claude-(?:haiku|sonnet|opus)-[\w.-]+/g, "configured Codex model ID")
    .replace(/\b(?:Sonnet(?: 5\.5)?|Haiku)\b/g, "Codex")
    .replace(/\bOpus agents\b/g, "higher-cost agents");
}

export function renderSkill(relative, content) {
  if (!relative.endsWith("SKILL.md")) return content;
  const text = runtimeWording(content.toString());
  // Keep front matter first. The shared protocol/implementation skills are the
  // entry points used by standalone role sessions as well as the root owner.
  return relative === "implement/SKILL.md" // team-protocol is the Codex-only .codex/team-protocol.md, not a mirror
    ? text.replace(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/, `$1\n${RUNTIME_NOTICE}\n`)
    : text;
}

// Parse the front matter into top-level keys and the nested `org:` block (Claude-only keys are simply not read later).
function frontMatter(text) {
  const fm = {}, org = {};
  let inOrg = false;
  for (const line of text.split(/\r?\n/)) {
    const nested = line.match(/^\s+([A-Za-z_]+):\s*(.*)$/);
    if (nested) { if (inOrg) org[nested[1]] = nested[2].trim(); continue; }
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue; // list items under skills:
    if (/^[|>]/.test(kv[2])) throw new Error(`front matter key ${kv[1]} is a multi-line scalar; codex-sync cannot read it`);
    inOrg = kv[1] === "org";
    fm[kv[1]] = kv[2].trim();
  }
  return { fm, org };
}
const orgText = (org, key) => {
  if (!org[key]) throw new Error(`front matter org block has no ${key}`);
  return org[key].startsWith('"') ? JSON.parse(org[key]) : org[key];
};
const orgList = (org, key) => {
  try { return org[key] ? JSON.parse(org[key]) : []; } catch { throw new Error(`org ${key} is not a JSON list`); }
};

// One lean, outcome-first role: job, inputs, outputs, done when, stop rules. The Claude workflow body is not copied.
export function render(roleDefinition) {
  const m = roleDefinition.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error("role definition has no front matter");
  const { fm, org } = frontMatter(m[1]);
  for (const k of ["name", "description"]) if (!fm[k]) throw new Error(`front matter has no ${k}`);
  const model = MODEL_MAP[fm.model];
  if (!model) throw new Error(`unknown model "${fm.model}" (add it to MODEL_MAP)`);
  const effort = CODEX_EFFORT[fm.name] ?? CODEX_EFFORT.default;
  const purpose = runtimeWording(orgText(org, "purpose"));
  const done = runtimeWording(orgText(org, "done")).replace(/the full test suite passes/, "the covering tests pass").replace(/Every check below that applies/, "Every applicable check").replace(/Every check below/, "Every check").replace(/, in the fixed shape below/, " (result, evidence, failures)");
  const [inputs, outputs, gates] = ["inputs", "outputs", "gates"].map((k) => orgList(org, k).join("; "));
  const body = [
    `Job: ${[purpose, ROLE_FOCUS[fm.name]].filter(Boolean).join(" ")}`,
    `Inputs: ${inputs || "the ticket"}`,
    `Outputs: ${outputs || "a handoff"}`,
    `Done when: ${done}`,
    `Stop rules: Stop when the done-when checks pass. File other follow-ups as new tickets; do at most one fix round for nonblocking findings. Block only on an unmet criterion or material risk.${gates ? ` Ask the user before: ${gates}.` : ""}`,
    "Follow AGENTS.md and the team-protocol skill. Evidence is the commands run and their exit codes, a few lines.",
  ].join("\n");
  if (body.includes("'''")) throw new Error("body contains ''' and cannot be a TOML literal string");
  return [
    `name = ${JSON.stringify(fm.name)}`,
    `description = ${JSON.stringify(runtimeWording(fm.description.startsWith('"') ? JSON.parse(fm.description) : fm.description))}`,
    `model = ${JSON.stringify(model)}`,
    `model_reasoning_effort = ${JSON.stringify(effort)}`,
    `developer_instructions = '''\n${body}\n'''\n`,
  ].join("\n");
}

// CLAUDE.md sections that describe the Claude relay; the Codex versions live in .codex/team-protocol.md and runtime-guidance.md.
export const AGENTS_DROP = ["Agents", "Cloud sessions", "Token hygiene", "Compact instructions"];

export function renderAgents(claudeMd, runtimeGuidance = "") {
  const head = "<!-- Generated by scripts/codex-sync.mjs from CLAUDE.md (shared contracts) and .codex/runtime-guidance.md (Codex execution). Edit those sources, not this mirror. -->\n\n";
  const shared = claudeMd.split(/^(?=#{1,2} )/m).filter((s) => !AGENTS_DROP.includes(s.match(/^#{1,2} (.*)/)?.[1].trim())).join("").trimEnd() + "\n";
  return head + applyRules(runtimeWording(shared)) + (runtimeGuidance ? "\n" + runtimeGuidance.trim() + "\n" : "");
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
  // Fail before writing any mirror if a hand-maintained Codex source is missing.
  const runtimeGuidance = readFileSync(path.join(root, ".codex/runtime-guidance.md"), "utf8");
  const codexProtocol = readFileSync(path.join(root, ".codex/team-protocol.md"), "utf8");
  const want = new Map();
  const stale = [];
  const agentsDir = path.join(root, ".claude/agents");
  const roles = readdirSync(agentsDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  for (const role of roles) want.set(`.codex/agents/${role}.toml`, render(readFileSync(path.join(agentsDir, `${role}.md`), "utf8")));
  for (const f of skillFiles(root)) want.set(`.agents/skills/${f}`, renderSkill(f,readFileSync(path.join(root, ".claude/skills", f))));
  want.set(".agents/skills/team-protocol/SKILL.md", codexProtocol); // Codex-only, lean: not a mirror of the Claude skill
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
