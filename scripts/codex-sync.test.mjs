// den-mvp/103, den-revival/05: Codex reads the same relay as Claude, in lean outcome-first form.
// scripts/codex-sync.mjs generates .codex/agents/*.toml from a short per-role template (job, inputs, outputs,
// done when, stop rules) fed by the role definition's org block, .agents/skills/ from .claude/skills (except
// team-protocol, which is the Codex-only .codex/team-protocol.md), and AGENTS.md from CLAUDE.md plus
// .codex/runtime-guidance.md. --check is the drift test.
//
// Interface these tests pin (see the qa handoff for the Codex doc citations behind it):
//   export render(roleDefinitionMarkdown: string) -> string   one .codex/agents/<role>.toml
//   export renderAgents(claudeMd: string) -> string   AGENTS.md
//   export MODEL_MAP   { haiku, sonnet, opus } -> Codex model id
//   export CODEX_EFFORT { default, <role>: effort } -> model_reasoning_effort (the Claude effort field is not read)
//   export RULES       [{ name, pattern: RegExp, action: "rewrite" | "drop", ... }] the Claude-only line rules
//   CLI: node scripts/codex-sync.mjs [--check] [--root <dir>]
//        write mode regenerates every mirror (and removes stale ones); --check writes nothing, prints each
//        drifted path, exits 1 on drift and 0 when clean. --root defaults to the repo root.
//   TOML shape: top-level `key = "<JSON string>"` lines, then `developer_instructions = '''` (a multi-line
//   literal string, no escapes, so the body is verbatim) as the last key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(ROOT, "scripts/codex-sync.mjs");
const mod = () => import(pathToFileURL(SCRIPT).href);

const ROLE_DEFINITIONS = readdirSync(path.join(ROOT, ".claude/agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
const MARK = String.raw`C:\temp\keep`;

// Reads the TOML shape pinned above. Not a general TOML parser.
function parseToml(text) {
  const m = text.match(/^developer_instructions = '''\r?\n?([\s\S]*)'''\s*$/m);
  assert.ok(m, "developer_instructions is not a ''' literal block at the end of the file");
  const head = text.slice(0, m.index);
  const out = { developer_instructions: m[1] };
  for (const line of head.split(/\r?\n/).filter((l) => l.trim())) {
    const kv = line.match(/^([a-z_]+) = (".*")$/);
    assert.ok(kv, `unexpected TOML line: ${line}`);
    out[kv[1]] = JSON.parse(kv[2]);
  }
  return out;
}

const SAMPLE = (over = {}) => `---
name: ${over.name ?? "sample"}
description: A "quoted" sample role definition (with a backslash \\ in it)
tools: Read, Grep, Agent(scout, runner), Skill, mcp__github
model: ${over.model ?? "sonnet"}
effort: ${over.effort ?? "high"}
color: green
skills:
  - team-protocol
org:
  team: tea-pantry
  purpose: Sample the pipeline.
  inputs: ["ticket path", "diff"]
  outputs: ["verdict", "handoff"]
  gates: ["adding a dependency"]
  done: "The verdict is written."
---

You are a **sample** agent.
Plain line that stays exactly as written.
Delegate big reads with Agent(scout, runner) and keep your own context small.
Open the PR through \`mcp__github\` when it is there.
You hold no Agent tool.
A path with a backslash: ${MARK}
`;

// ---------- pure render ----------

test("render carries name and description, then the template sections; the Claude body is not copied", async () => {
  const { render } = await mod();
  const t = parseToml(render(SAMPLE()));
  assert.equal(t.name, "sample");
  assert.equal(t.description, 'A "quoted" sample role definition (with a backslash \\ in it)');
  const b = t.developer_instructions;
  assert.match(b, /^Job: Sample the pipeline\./m);
  assert.match(b, /^Inputs: ticket path; diff$/m);
  assert.match(b, /^Outputs: verdict; handoff$/m);
  assert.match(b, /^Done when: The verdict is written\.$/m);
  assert.match(b, /^Stop rules: /m);
  assert.match(b, /adding a dependency/, "gates become ask-first stop rules");
  assert.ok(!b.includes("Plain line that stays exactly as written."), "the Claude workflow body was copied");
  assert.ok(!b.includes(MARK));
  assert.ok(!b.startsWith("---"), "front matter leaked into the instructions");
});

test("stop rules: stop when checks pass, log other findings as follow-ups, one fix round for nonblocking findings, block only on unmet criteria or material risk", async () => {
  const { render } = await mod();
  const rules = parseToml(render(SAMPLE())).developer_instructions.match(/^Stop rules: .*$/m)[0];
  assert.match(rules, /Stop when the done-when checks pass/i);
  assert.match(rules, /follow-ups/i);
  assert.match(rules, /at most one fix round for nonblocking findings/i);
  assert.match(rules, /unmet criterion or material risk/i);
});

test("a role with no gates (a leaf) has no ask-first clause", async () => {
  const { render } = await mod();
  const noGates = SAMPLE().replace('  gates: ["adding a dependency"]\n', "  gates: []\n");
  assert.ok(!/Ask the user/i.test(parseToml(render(noGates)).developer_instructions));
});

test("render leaves Claude front matter keys out of the TOML (Codex has no per-agent tools, color or turns)", async () => {
  const { render } = await mod();
  const t = parseToml(render(SAMPLE()));
  for (const k of ["tools", "color", "maxTurns", "isolation", "skills", "org"]) assert.ok(!(k in t), `${k} leaked into the TOML`);
  assert.deepEqual(Object.keys(t).sort(), ["description", "developer_instructions", "model", "model_reasoning_effort", "name"]);
});

test("render maps model through MODEL_MAP", async () => {
  const { render, MODEL_MAP } = await mod();
  for (const k of ["haiku", "sonnet", "opus"]) assert.match(MODEL_MAP[k] ?? "", /^gpt-/, `MODEL_MAP.${k} must be a Codex model id`);
  assert.notEqual(MODEL_MAP.haiku, MODEL_MAP.opus, "cheap and deepest tiers must differ");
  for (const model of ["haiku", "sonnet", "opus"]) assert.equal(parseToml(render(SAMPLE({ model }))).model, MODEL_MAP[model]);
});

test("effort is medium by default and high for architect and security, whatever the Claude effort says", async () => {
  const { render, CODEX_EFFORT } = await mod();
  assert.deepEqual(CODEX_EFFORT, { default: "medium", architect: "high", security: "high" });
  for (const claudeEffort of ["low", "high", "max"]) {
    assert.equal(parseToml(render(SAMPLE({ effort: claudeEffort }))).model_reasoning_effort, "medium");
    for (const name of ["architect", "security"]) assert.equal(parseToml(render(SAMPLE({ name, effort: claudeEffort }))).model_reasoning_effort, "high");
  }
});

test("render fails closed on an unknown model, no front matter, or an org block missing its job or done line", async () => {
  const { render } = await mod();
  assert.throws(() => render(SAMPLE({ model: "gemini" })), /model/i);
  assert.throws(() => render("no front matter here\n"), /front matter/i);
  assert.throws(() => render(SAMPLE().replace("  purpose: Sample the pipeline.\n", "")), /purpose/i);
  assert.throws(() => render(SAMPLE().replace('  done: "The verdict is written."\n', "")), /done/i);
});

// ---------- the rewrite-rules table ----------

test("RULES is one table of named rules, each rewrite or drop", async () => {
  const { RULES } = await mod();
  assert.ok(Array.isArray(RULES) && RULES.length >= 2, "expected rules for Agent(...) and mcp__*");
  const names = new Set();
  for (const r of RULES) {
    assert.equal(typeof r.name, "string");
    assert.ok(!names.has(r.name), `duplicate rule name ${r.name}`);
    names.add(r.name);
    assert.ok(r.pattern instanceof RegExp, `${r.name}: pattern must be a RegExp`);
    assert.ok(["rewrite", "drop"].includes(r.action), `${r.name}: action must be rewrite or drop`);
  }
});

// ---------- AGENTS.md ----------

const CLAUDE_MD = `# Project

Single paragraph that Codex needs too.

Run an agent as the main session with \`claude --agent <role>\`. If a session is asked to act as an agent without that flag, read \`.claude/agents/<role>.md\` first and follow it.

## Section

- keep this bullet
`;

test("renderAgents keeps the shared text, drops the claude --agent line, and says it is generated", async () => {
  const { renderAgents } = await mod();
  const out = renderAgents(CLAUDE_MD);
  assert.ok(out.includes("Single paragraph that Codex needs too."));
  assert.ok(out.includes("- keep this bullet"));
  assert.ok(!/claude --agent/.test(out), "the Claude-only launch line survived");
  assert.match(out.split("\n").slice(0, 6).join("\n"), /generated/i);
  assert.match(out.split("\n").slice(0, 6).join("\n"), /codex-sync/);
  assert.ok(!/mcp__|Agent\(/.test(out));
});

test("AGENTS.md rules are the same RULES table (renderAgents applies Agent(...) and mcp__ rules too)", async () => {
  const { renderAgents } = await mod();
  const out = renderAgents("# T\n\nAsk Agent(scout) for the log. Use `mcp__github` for PRs.\n");
  assert.ok(!/Agent\(|mcp__/.test(out));
  assert.match(out, /scout/);
});

test("renderAgents drops the Claude-relay sections of CLAUDE.md (they live in the lean Codex team-protocol) and keeps the rest", async () => {
  const { renderAgents } = await mod();
  const md = `${CLAUDE_MD}\n## Agents\n\nLong relay prose.\n\n## Cloud sessions\n\nContainer setup.\n\n## Agent skills\n\n### Issue tracker\n\nBoard is local.\n\n## Token hygiene\n\nPro plan.\n\n# Compact instructions\n\nKeep the ticket.\n`;
  const out = renderAgents(md);
  for (const gone of ["Long relay prose.", "Container setup.", "Pro plan.", "Keep the ticket."]) assert.ok(!out.includes(gone), `${gone} should be dropped`);
  for (const kept of ["Single paragraph that Codex needs too.", "- keep this bullet", "Board is local."]) assert.ok(out.includes(kept), `${kept} should be kept`);
});

test("the real AGENTS.md fits Codex's project_doc_max_bytes (32 KiB) and is lean (6 KiB)", () => {
  const size = statSync(path.join(ROOT, "AGENTS.md")).size;
  assert.ok(size <= 32768);
  assert.ok(size <= 6144, `AGENTS.md is ${size} bytes`);
});

// ---------- CLI against a fixture tree: write, check, drift ----------

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-sync-"));
  const w = (rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };
  w(".claude/agents/alpha.md", SAMPLE({ name: "alpha" }));
  w(".claude/agents/beta.md", SAMPLE({ name: "beta", model: "haiku", effort: "low" }));
  w(".claude/skills/one/SKILL.md", "---\nname: one\ndescription: One.\n---\nBody of one.\n");
  w(".claude/skills/one/extra/notes.md", "nested file\n");
  w(".claude/skills/MATTPOCOCK-LICENSE", "MIT licence text\n");
  w(".claude/skills/VENDORED.md", "# vendored\n");
  w("CLAUDE.md", CLAUDE_MD);
  w(".codex/runtime-guidance.md", "# Codex execution contract\n\nKeep explicit one-attempt limits and human publication gates.\n");
  w(".codex/team-protocol.md", CODEX_PROTOCOL);
  return { dir, w };
}
const CODEX_PROTOCOL = "---\nname: team-protocol\ndescription: Lean Codex protocol.\n---\nClaim, gates, handoff, end.\n";
const run = (dir, ...args) => spawnSync("node", [SCRIPT, "--root", dir, ...args], { encoding: "utf8", timeout: 60000 });
const out = (r) => `${r.stdout}${r.stderr}`;

test("write mode creates a toml per role definition, every skill file (licences included), and AGENTS.md; then --check is clean", () => {
  const { dir } = fixture();
  try {
    const w = run(dir);
    assert.equal(w.status, 0, out(w));
    for (const r of ["alpha", "beta"]) assert.ok(existsSync(path.join(dir, `.codex/agents/${r}.toml`)), `${r}.toml missing`);
    assert.equal(readFileSync(path.join(dir, ".agents/skills/one/SKILL.md"), "utf8"), "---\nname: one\ndescription: One.\n---\nBody of one.\n");
    assert.equal(readFileSync(path.join(dir, ".agents/skills/one/extra/notes.md"), "utf8"), "nested file\n");
    assert.equal(readFileSync(path.join(dir, ".agents/skills/MATTPOCOCK-LICENSE"), "utf8"), "MIT licence text\n");
    assert.ok(existsSync(path.join(dir, ".agents/skills/VENDORED.md")));
    assert.ok(existsSync(path.join(dir, "AGENTS.md")));
    const c = run(dir, "--check");
    assert.equal(c.status, 0, out(c));
    assert.equal(run(dir).status, 0, "a second write must be a no-op");
    assert.equal(run(dir, "--check").status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--check fails and names the file when a role definition changes without regenerating", () => {
  const { dir, w } = fixture();
  try {
    run(dir);
    w(".claude/agents/alpha.md", SAMPLE({ name: "alpha" }).replace("Sample the pipeline.", "Edited purpose."));
    const c = run(dir, "--check");
    assert.notEqual(c.status, 0);
    assert.match(out(c), /\.codex\/agents\/alpha\.toml/);
    assert.ok(!/beta\.toml/.test(out(c)), "only the drifted mirror should be named");
    assert.ok(!readFileSync(path.join(dir, ".codex/agents/alpha.toml"), "utf8").includes("Edited purpose"), "--check must not write");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--check fails when a skill file changes, is added, or a licence file changes", () => {
  const { dir, w } = fixture();
  try {
    run(dir);
    w(".claude/skills/one/SKILL.md", "---\nname: one\ndescription: One.\n---\nChanged.\n");
    assert.match(out(run(dir, "--check")), /\.agents\/skills\/one\/SKILL\.md/);
    run(dir);
    w(".claude/skills/two/SKILL.md", "---\nname: two\ndescription: Two.\n---\n");
    assert.match(out(run(dir, "--check")), /\.agents\/skills\/two\/SKILL\.md/);
    run(dir);
    w(".claude/skills/MATTPOCOCK-LICENSE", "changed licence\n");
    assert.match(out(run(dir, "--check")), /\.agents\/skills\/MATTPOCOCK-LICENSE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--check fails when CLAUDE.md changes (AGENTS.md is generated), and when a mirror is hand-edited or deleted", () => {
  const { dir, w } = fixture();
  try {
    run(dir);
    w("CLAUDE.md", `${CLAUDE_MD}\nA new rule.\n`);
    const c = run(dir, "--check");
    assert.notEqual(c.status, 0);
    assert.match(out(c), /AGENTS\.md/);
    run(dir);
    writeFileSync(path.join(dir, ".codex/agents/beta.toml"), "name = \"beta\"\n");
    assert.match(out(run(dir, "--check")), /beta\.toml/);
    run(dir);
    rmSync(path.join(dir, ".codex/agents/alpha.toml"));
    assert.match(out(run(dir, "--check")), /alpha\.toml/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a stale mirror (role definition or skill removed) fails --check and write mode removes it", () => {
  const { dir } = fixture();
  try {
    run(dir);
    writeFileSync(path.join(dir, ".codex/agents/ghost.toml"), "name = \"ghost\"\n");
    mkdirSync(path.join(dir, ".agents/skills/gone"), { recursive: true });
    writeFileSync(path.join(dir, ".agents/skills/gone/SKILL.md"), "stale\n");
    const c = run(dir, "--check");
    assert.notEqual(c.status, 0);
    assert.match(out(c), /ghost\.toml/);
    assert.match(out(c), /skills\/gone/);
    assert.equal(run(dir).status, 0);
    assert.ok(!existsSync(path.join(dir, ".codex/agents/ghost.toml")));
    assert.ok(!existsSync(path.join(dir, ".agents/skills/gone")));
    assert.equal(run(dir, "--check").status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the real repo ----------

test("every role definition in .claude/agents/ has a generated .codex/agents/<role>.toml, runner and security included, and no extras", () => {
  assert.ok(ROLE_DEFINITIONS.includes("runner") && ROLE_DEFINITIONS.includes("security"), `role definitions: ${ROLE_DEFINITIONS}`);
  const toml = readdirSync(path.join(ROOT, ".codex/agents")).filter((f) => f.endsWith(".toml")).map((f) => f.slice(0, -5)).sort();
  assert.deepEqual(toml, ROLE_DEFINITIONS);
  for (const role of ROLE_DEFINITIONS) {
    const t = parseToml(readFileSync(path.join(ROOT, `.codex/agents/${role}.toml`), "utf8"));
    assert.equal(t.name, role);
    assert.ok(t.description && t.model && t.model_reasoning_effort && t.developer_instructions.length > 100, `${role}.toml is incomplete`);
  }
});

test("the real mirrors are in sync: codex-sync --check exits 0 (the drift test)", () => {
  const c = spawnSync("node", [SCRIPT, "--check"], { encoding: "utf8", timeout: 60000, cwd: ROOT });
  assert.equal(c.status, 0, `drift: run npm run codex:sync\n${out(c)}`);
});

test("npm run codex:sync is wired", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.match(pkg.scripts["codex:sync"] ?? "", /scripts\/codex-sync\.mjs/);
});

test(".agents/skills/ renders the shared files with Codex runtime adaptations and retains tracked licences", async () => {
  const {renderSkill} = await mod();
  const walk = (d, base = d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name), base) : [path.relative(base, path.join(d, e.name)).split(path.sep).join("/")]);
  const src = walk(path.join(ROOT, ".claude/skills")).sort();
  assert.ok(src.includes("ponytail/SKILL.md") && src.includes("PONYTAIL-LICENSE") && src.includes("MATTPOCOCK-LICENSE"));
  const tracked = new Set(execFileSync("git", ["ls-files", "--", ".agents/skills"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean));
  for (const f of src) {
    const dst = path.join(ROOT, ".agents/skills", f);
    assert.ok(existsSync(dst), `.agents/skills/${f} missing`);
    const expected = f === "team-protocol/SKILL.md" ? readFileSync(path.join(ROOT, ".codex/team-protocol.md")) : Buffer.from(renderSkill(f, readFileSync(path.join(ROOT, ".claude/skills", f))));
    assert.ok(readFileSync(dst).equals(expected), `.agents/skills/${f} differs`);
    assert.ok(tracked.has(`.agents/skills/${f}`), `.agents/skills/${f} is not tracked in git`);
  }
  const extra = walk(path.join(ROOT, ".agents/skills")).filter((f) => !src.includes(f) && !f.startsWith("jevgrep/"));
  assert.deepEqual(extra, [], "stale files in .agents/skills");
  assert.ok(tracked.has(".agents/skills/jevgrep/SKILL.md"), "jevgrep must stay tracked");
});

test("AGENTS.md on disk is generated from CLAUDE.md, not the 5-line stub", async () => {
  const { renderAgents } = await mod();
  const disk = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  assert.equal(disk, renderAgents(readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8"),readFileSync(path.join(ROOT,".codex/runtime-guidance.md"),"utf8")));
  assert.ok(disk.split("\n").length > 10);
});

// ---------- hooks: Codex documents no project-dir variable ----------

test(".codex/hooks.json walks up to the den root, not a nested repo, and does not use $CLAUDE_PROJECT_DIR", () => {
  const text = readFileSync(path.join(ROOT, ".codex/hooks.json"), "utf8");
  assert.ok(!/CLAUDE_PROJECT_DIR/.test(text), "Codex does not set CLAUDE_PROJECT_DIR");
  const hooks = JSON.parse(text).hooks;
  const cmds = Object.values(hooks).flatMap((evs) => evs.flatMap((e) => e.hooks.map((h) => h.command)));
  assert.ok(cmds.length >= 2);
  for (const c of cmds) {
    assert.doesNotMatch(c, /git rev-parse --show-toplevel/, "show-toplevel picks a nested repo (.scratch, a client project)");
    assert.match(c, /dirname/);
  }
  assert.ok(cmds.some((c) => c.includes("scripts/session-start.mjs")));
  assert.ok(cmds.some((c) => c.includes("scripts/notify.mjs")));
});

// ---------- den-mvp/104 ----------

test("skills are mirrored from git ls-files: an untracked file is never copied", () => {
  const { dir, w } = fixture();
  try {
    const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
    g("init", "-q");
    g("add", ".claude");
    w(".claude/skills/one/stray.md", "untracked\n");
    const r = run(dir);
    assert.equal(r.status, 0, out(r));
    assert.ok(existsSync(path.join(dir, ".agents/skills/one/SKILL.md")));
    assert.ok(!existsSync(path.join(dir, ".agents/skills/one/stray.md")), "untracked file was mirrored");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the hand-maintained Codex supplement participates in drift checks and is required before writing", () => {
  const {dir,w}=fixture();
  try{
    assert.equal(run(dir).status,0);
    w(".codex/runtime-guidance.md","# Updated Codex contract\nHonor explicit first-failure stops.\n");
    const drift=run(dir,"--check");assert.notEqual(drift.status,0);assert.match(out(drift),/AGENTS\.md/);
    assert.equal(run(dir).status,0);assert.match(readFileSync(path.join(dir,"AGENTS.md"),"utf8"),/Honor explicit first-failure stops/);
    rmSync(path.join(dir,".codex/runtime-guidance.md"));
    const missing=run(dir);assert.notEqual(missing.status,0);assert.match(out(missing),/runtime-guidance\.md/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

// ---------- den-revival/05: lean, outcome-first Codex roles ----------

const roleToml = (role) => readFileSync(path.join(ROOT, `.codex/agents/${role}.toml`), "utf8");
const size = (rel) => statSync(path.join(ROOT, rel)).size;
const ROLE_MAX = 2048; // "about 2 KB or less" per role
const PRELOAD_MAX = 16 * 1024; // AGENTS.md + team-protocol skill + role, before a ticket

test("each real role toml is 2 KB or less and has job, inputs, outputs, done when and stop rules", () => {
  for (const role of ROLE_DEFINITIONS) {
    const text = roleToml(role);
    assert.ok(Buffer.byteLength(text) <= ROLE_MAX, `${role}.toml is ${Buffer.byteLength(text)} bytes`);
    const b = parseToml(text).developer_instructions;
    for (const label of ["Job", "Inputs", "Outputs", "Done when", "Stop rules"]) assert.match(b, new RegExp(`^${label}: \\S`, "m"), `${role}: no ${label} line`);
    assert.match(b, /at most one fix round for nonblocking findings/, `${role}: no fix-round stop rule`);
  }
});

test("instructions loaded before a ticket (AGENTS.md, runtime-guidance.md, team-protocol skill, role) total 16 KB or less for every role", () => {
  const fixed = size("AGENTS.md") + size(".codex/runtime-guidance.md") + size(".agents/skills/team-protocol/SKILL.md");
  for (const role of ROLE_DEFINITIONS) {
    const total = fixed + size(`.codex/agents/${role}.toml`);
    assert.ok(total <= PRELOAD_MAX, `${role} loads ${total} bytes before a ticket`);
  }
});

test("the 16 KB budget also holds with every skill's name and description, which Codex lists up front", () => {
  const dir = path.join(ROOT, ".agents/skills");
  const meta = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(path.join(dir, e.name, "SKILL.md")))
    .map((e) => readFileSync(path.join(dir, e.name, "SKILL.md"), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)[1])
    .reduce((n, fm) => n + Buffer.byteLength(fm), 0);
  const fixed = size("AGENTS.md") + size(".codex/runtime-guidance.md") + size(".agents/skills/team-protocol/SKILL.md") + meta;
  for (const role of ROLE_DEFINITIONS) assert.ok(fixed + size(`.codex/agents/${role}.toml`) <= PRELOAD_MAX, `${role} loads ${fixed + size(`.codex/agents/${role}.toml`)} bytes with skill metadata`);
});

test("a den-agent role never asks for the full suite: the developer's done line names the covering tests", () => {
  assert.match(parseToml(roleToml("developer")).developer_instructions, /^Done when: .*covering tests pass/m);
  assert.doesNotMatch(parseToml(roleToml("developer")).developer_instructions, /full test suite/);
});

test("real roles run at medium effort, architect and security at high", () => {
  for (const role of ROLE_DEFINITIONS) {
    assert.equal(parseToml(roleToml(role)).model_reasoning_effort, ["architect", "security"].includes(role) ? "high" : "medium", role);
  }
});

test("no role carries the Codex caveat or Claude-only wording; read-only roles rely on the parent's sandbox", () => {
  for (const role of ROLE_DEFINITIONS) {
    const b = parseToml(roleToml(role)).developer_instructions;
    assert.doesNotMatch(b, /Codex caveat|instructions, not enforced|workspace-write sandbox/, `${role} still carries the caveat`);
    assert.doesNotMatch(b, /\b(?:Sonnet|Haiku)\b|Agent\(|mcp__|claude --agent/, `${role} carries Claude-only wording`);
  }
  assert.match(readFileSync(path.join(ROOT, "AGENTS.md"), "utf8"), /subagents inherit the parent session's sandbox/i);
});

test("the orchestrator hands each stage to a fresh subagent thread instead of carrying the relay in one context", () => {
  assert.match(parseToml(roleToml("orchestrator")).developer_instructions, /fresh subagent/);
});

test("the Codex team-protocol skill is Codex-only, lean, and keeps claims, gates, handoff and end", () => {
  const p = readFileSync(path.join(ROOT, ".agents/skills/team-protocol/SKILL.md"), "utf8");
  assert.ok(Buffer.byteLength(p) <= 4096, `team-protocol is ${Buffer.byteLength(p)} bytes`);
  assert.match(p, /^---\r?\nname: team-protocol\r?\n/);
  for (const h of ["Board", "Gates", "Handoff", "End"]) assert.match(p, new RegExp(`^## ${h}\\b`, "m"), `no ## ${h} section`);
  for (const cmd of ["claim", "comment", "handoff", "release"]) assert.match(p, new RegExp(`board -- ${cmd}\\b`), `no board ${cmd} command`);
  for (const gate of [/push/, /merge/, /dependency/, /\.claude\//, /ADR/]) assert.match(p, gate, `gate ${gate} missing`);
  assert.doesNotMatch(p, /\bClaude\b|Sonnet|Haiku|runtime-guidance/, "Claude-only wording in the Codex protocol");
});

test("the hand-maintained Codex team-protocol participates in drift checks and is required before writing", () => {
  const { dir, w } = fixture();
  try {
    assert.equal(run(dir).status, 0);
    assert.equal(readFileSync(path.join(dir, ".agents/skills/team-protocol/SKILL.md"), "utf8"), CODEX_PROTOCOL);
    w(".codex/team-protocol.md", CODEX_PROTOCOL.replace("end.", "end, fast."));
    const drift = run(dir, "--check");
    assert.notEqual(drift.status, 0);
    assert.match(out(drift), /\.agents\/skills\/team-protocol\/SKILL\.md/);
    rmSync(path.join(dir, ".codex/team-protocol.md"));
    const missing = run(dir);
    assert.notEqual(missing.status, 0);
    assert.match(out(missing), /team-protocol\.md/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the Claude team-protocol skill is not the Codex mirror source, and Claude files are untouched by a sync", () => {
  const { dir, w } = fixture();
  try {
    w(".claude/skills/team-protocol/SKILL.md", "---\nname: team-protocol\ndescription: Claude long form.\n---\nLong Claude workflow.\n");
    const files = [".claude/agents/alpha.md", ".claude/agents/beta.md", ".claude/skills/team-protocol/SKILL.md", ".claude/skills/one/SKILL.md", "CLAUDE.md"];
    const before = files.map((f) => readFileSync(path.join(dir, f), "utf8"));
    for (const args of [[], ["--check"], []]) run(dir, ...args);
    assert.deepEqual(files.map((f) => readFileSync(path.join(dir, f), "utf8")), before);
    assert.ok(!readFileSync(path.join(dir, ".agents/skills/team-protocol/SKILL.md"), "utf8").includes("Long Claude workflow."));
    assert.deepEqual(readdirSync(path.join(dir, ".claude/agents")).sort(), ["alpha.md", "beta.md"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Codex runtime guidance keeps the gates, the one-owner rule and the verification limits in a few lines", () => {
  const g = readFileSync(path.join(ROOT, ".codex/runtime-guidance.md"), "utf8");
  assert.ok(Buffer.byteLength(g) <= 3072, `runtime-guidance is ${Buffer.byteLength(g)} bytes`);
  assert.match(g, /no push, PR, merge/i);
  assert.match(g, /one implementation owner/i);
  assert.match(g, /timeout 300 node --test/);
  assert.match(g, /exit codes/i);
  const agents = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  assert.doesNotMatch(agents, /\b(?:Sonnet|Haiku)\b|reserved slot beside them|Cloud sessions|Token hygiene/);
});

test("the Codex team-protocol keeps the user's approval points and the orchestrator's autonomy defers to them", () => {
  const p = readFileSync(path.join(ROOT, ".agents/skills/team-protocol/SKILL.md"), "utf8");
  const gates = p.slice(p.indexOf("## Gates"), p.indexOf("## Handoff"));
  for (const k of [/user-merge list/, /visual verdicts/, /twice-failed ticket/, /5-hour usage at 90%/, /open scope question/]) assert.match(gates, k, `Gates lacks ${k}`);
  assert.match(parseToml(roleToml("orchestrator")).developer_instructions, /except the user-kept approvals in team-protocol Gates/);
});

test("the generated implement skill keeps den agents off the full suite", () => {
  const implement = readFileSync(path.join(ROOT, ".agents/skills/implement/SKILL.md"), "utf8");
  assert.doesNotMatch(implement, /full test suite once at the end/);
  assert.match(implement, /literal covering test files/);
});

test("AGENTS.md tells a session asked to act as an agent to read .codex/agents/<role>.toml", () => {
  assert.match(readFileSync(path.join(ROOT, "AGENTS.md"), "utf8"), /read its definition `\.codex\/agents\/<role>\.toml`/);
});
