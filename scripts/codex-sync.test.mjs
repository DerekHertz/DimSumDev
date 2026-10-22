// den-mvp/103: Codex reads the same relay as Claude. .claude/ is the one source; scripts/codex-sync.mjs
// generates .codex/agents/*.toml, .agents/skills/ and AGENTS.md from it, and --check is the drift test.
// Red until scripts/codex-sync.mjs exists and its output is generated and committed.
//
// Interface these tests pin (see the qa handoff for the Codex doc citations behind it):
//   export render(roleDefinitionMarkdown: string) -> string   one .codex/agents/<role>.toml
//   export renderAgents(claudeMd: string) -> string   AGENTS.md
//   export MODEL_MAP   { haiku, sonnet, opus } -> Codex model id
//   export EFFORT_MAP  { low, medium, high, ... } -> model_reasoning_effort value
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
  station: tea-pantry
  purpose: Sample.
---

You are a **sample** agent.
Plain line that stays exactly as written.
Delegate big reads with Agent(scout, runner) and keep your own context small.
Open the PR through \`mcp__github\` when it is there.
You hold no Agent tool.
A path with a backslash: ${MARK}
`;

// ---------- pure render ----------

test("render carries name and description, and the body verbatim as developer_instructions", async () => {
  const { render } = await mod();
  const t = parseToml(render(SAMPLE()));
  assert.equal(t.name, "sample");
  assert.equal(t.description, 'A "quoted" sample role definition (with a backslash \\ in it)');
  assert.match(t.developer_instructions, /You are a \*\*sample\*\* agent\./);
  assert.ok(t.developer_instructions.includes("Plain line that stays exactly as written."));
  assert.ok(t.developer_instructions.includes(MARK), "backslashes in the body must survive");
  assert.ok(!t.developer_instructions.startsWith("---"), "front matter leaked into the instructions");
});

test("render leaves Claude front matter keys out of the TOML (Codex has no per-agent tools, color or turns)", async () => {
  const { render } = await mod();
  const t = parseToml(render(SAMPLE()));
  for (const k of ["tools", "color", "maxTurns", "isolation", "skills", "org"]) assert.ok(!(k in t), `${k} leaked into the TOML`);
  assert.deepEqual(Object.keys(t).sort(), ["description", "developer_instructions", "model", "model_reasoning_effort", "name"]);
});

test("every Codex role focuses blocking findings on the ticket outcome and material risks", async () => {
  const { render } = await mod();
  for (const file of readdirSync(path.join(ROOT, ".claude/agents")).filter((name) => name.endsWith(".md"))) {
    const source = readFileSync(path.join(ROOT, ".claude/agents", file), "utf8");
    const instructions = parseToml(render(source)).developer_instructions;
    assert.match(instructions, /requested behavior and acceptance criteria work/, file);
    assert.match(instructions, /defer minor nonblocking bugs, cleanup and polish/, file);
    assert.match(instructions, /block only on an unmet acceptance criterion or a demonstrated material/, file);
    assert.match(instructions, /Other findings are nonblocking, even when real/, file);
    assert.match(instructions, /Required tests and approval gates still apply/, file);
  }
});

test("render maps model through MODEL_MAP and effort through EFFORT_MAP, one table each", async () => {
  const { render, MODEL_MAP, EFFORT_MAP } = await mod();
  for (const k of ["haiku", "sonnet", "opus"]) {
    assert.match(MODEL_MAP[k] ?? "", /^gpt-/, `MODEL_MAP.${k} must be a Codex model id`);
  }
  assert.notEqual(MODEL_MAP.haiku, MODEL_MAP.opus, "cheap and deepest tiers must differ");
  assert.equal(EFFORT_MAP.low, "low");
  for (const [model, effort] of [["haiku", "low"], ["sonnet", "high"], ["opus", "high"]]) {
    const t = parseToml(render(SAMPLE({ model, effort })));
    assert.equal(t.model, MODEL_MAP[model]);
    assert.equal(t.model_reasoning_effort, EFFORT_MAP[effort]);
  }
});

test("render fails closed on an unknown model, an unknown effort or a file with no front matter", async () => {
  const { render } = await mod();
  assert.throws(() => render(SAMPLE({ model: "gemini" })), /model/i);
  assert.throws(() => render(SAMPLE({ effort: "turbo" })), /effort/i);
  assert.throws(() => render("no front matter here\n"), /front matter/i);
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

test("Agent(a, b) in a body becomes Codex subagent wording; the plain words 'Agent tool' are untouched", async () => {
  const { render } = await mod();
  const body = parseToml(render(SAMPLE())).developer_instructions;
  assert.ok(!/Agent\(/.test(body), "Agent(...) survived");
  const line = body.split("\n").find((l) => l.startsWith("Delegate big reads"));
  assert.ok(line, "the delegation sentence was dropped; a rewrite should keep its meaning");
  assert.match(line, /scout/);
  assert.match(line, /runner/);
  assert.match(line, /subagent/i);
  assert.ok(body.includes("You hold no Agent tool."), "prose that merely says Agent tool must stay");
});

test("mcp__* tool names do not reach Codex (mapped or dropped) and the rest of the body survives", async () => {
  const { render } = await mod();
  const out = render(SAMPLE());
  assert.ok(!/mcp__/.test(out), "mcp__ name survived");
  assert.ok(parseToml(out).developer_instructions.includes("Plain line that stays exactly as written."));
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

test("the real AGENTS.md fits Codex's project_doc_max_bytes (32 KiB)", () => {
  assert.ok(statSync(path.join(ROOT, "AGENTS.md")).size <= 32768);
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
  return { dir, w };
}
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
    w(".claude/agents/alpha.md", SAMPLE({ name: "alpha" }).replace("Plain line", "Edited line"));
    const c = run(dir, "--check");
    assert.notEqual(c.status, 0);
    assert.match(out(c), /\.codex\/agents\/alpha\.toml/);
    assert.ok(!/beta\.toml/.test(out(c)), "only the drifted mirror should be named");
    assert.ok(!readFileSync(path.join(dir, ".codex/agents/alpha.toml"), "utf8").includes("Edited line"), "--check must not write");
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
    assert.ok(readFileSync(dst).equals(Buffer.from(renderSkill(f,readFileSync(path.join(ROOT, ".claude/skills", f))))), `.agents/skills/${f} differs`);
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
  assert.ok(disk.split("\n").length > 20);
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

test("every generated role body carries the Codex caveat about instruction-only tool limits", async () => {
  const { render } = await mod();
  const body = parseToml(render(SAMPLE())).developer_instructions;
  assert.match(body, /Codex caveat/);
  assert.match(body, /instructions, not enforced/);
  assert.match(body, /read-only or workspace-write sandbox and approvals on/);
});

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

test("Codex runtime guidance resolves inherited models, worker bonuses and full-suite conflicts without changing gates", async () => {
  const {render,renderAgents,renderSkill} = await mod();
  const shared=readFileSync(path.join(ROOT,".claude/skills/team-protocol/SKILL.md"),"utf8");
  const protocol=renderSkill("team-protocol/SKILL.md",shared);
  assert.doesNotMatch(protocol,/\b(?:Sonnet|Haiku)\b|at most about 4/);
  assert.match(protocol,/\.codex\/runtime-guidance\.md/);
  const gates=shared.slice(shared.indexOf("## Pass gates"),shared.indexOf("## Environment issues"));
  assert.ok(protocol.includes(gates),"shared approval gates must remain byte-identical");
  const implement=renderSkill("implement/SKILL.md",readFileSync(path.join(ROOT,".claude/skills/implement/SKILL.md"),"utf8"));
  assert.doesNotMatch(implement,/full test suite once at the end/);
  assert.match(implement,/literal covering test files/);
  const agents=renderAgents(readFileSync(path.join(ROOT,"CLAUDE.md"),"utf8"),"Honor explicit one-attempt limits; no publication authority.");
  assert.doesNotMatch(agents,/\b(?:Sonnet|Haiku)\b|reserved slot beside them/);
  assert.match(agents,/Honor explicit one-attempt limits/);
  const developer=parseToml(render(readFileSync(path.join(ROOT,".claude/agents/developer.md"),"utf8")));
  assert.doesNotMatch(developer.developer_instructions,/\bHaiku\b|up to 4 at once/);
  assert.match(developer.developer_instructions,/\.codex\/runtime-guidance\.md/);
  assert.match(developer.developer_instructions,/When independent delegation is useful and permitted/);
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

test("shared and generated guidance preserve the optional four-manager four-runner hierarchy", async () => {
  const { renderAgents, renderSkill } = await mod();
  const claude = readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
  const shared = readFileSync(path.join(ROOT, ".claude/skills/team-protocol/SKILL.md"), "utf8");
  const guidance = readFileSync(path.join(ROOT, ".codex/runtime-guidance.md"), "utf8");
  for (const [name, text] of [
    ["CLAUDE.md", claude],
    ["team-protocol", shared],
    ["AGENTS.md", renderAgents(claude, guidance)],
    ["Codex team-protocol", renderSkill("team-protocol/SKILL.md", shared)],
  ]) {
    assert.match(text, /Bao\s*\(Claude\)\s*(?:or|OR)\s*Jiao\s*\(Codex\)/, `${name}: either runtime can own the task`);
    assert.match(text, /(?:up to|at most) (?:four|4) (?:role )?managers/i, `${name}: manager fanout`);
    assert.match(text, /(?:up to|at most) (?:four|4) runners (?:each|per manager|under each)/i, `${name}: runner fanout`);
    assert.match(text, /maximum|structural limit/i, `${name}: topology is a maximum`);
    assert.match(text, /optional|never mandatory|not (?:a )?(?:target|required)/i, `${name}: spawning is optional`);
  }
});

test("Codex concurrency is task-adaptive while current bridge limits remain explicit and unchanged", async () => {
  const { renderAgents, renderSkill, render } = await mod();
  const guidance = readFileSync(path.join(ROOT, ".codex/runtime-guidance.md"), "utf8");
  assert.match(guidance, /small[- ]task|small task/i);
  assert.match(guidance, /(?:zero|0) or (?:one|1)|(?:no|one) helper|owner alone/i);
  assert.match(guidance, /runtime/);
  assert.match(guidance, /resource/);
  assert.match(guidance, /(?:scope|task|ticket)[^\n]*(?:limit|budget)|(?:limit|budget)[^\n]*(?:scope|task|ticket)/i);
  assert.match(guidance, /bridge/i, "the bridge's two-slot cap must not be mistaken for a universal Codex cap");
  assert.match(guidance, /per-layer|measured|concurrent|simultaneous/i, "structural fanout must not be mistaken for simultaneous-capacity approval");
  const outputs = [
    renderAgents(readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8"), guidance),
    renderSkill("team-protocol/SKILL.md", readFileSync(path.join(ROOT, ".claude/skills/team-protocol/SKILL.md"), "utf8")),
    ...["developer", "orchestrator"].map((role) => render(readFileSync(path.join(ROOT, `.claude/agents/${role}.md`), "utf8"))),
  ];
  for (const text of outputs) {
    assert.doesNotMatch(text, /(?:at most|ceiling of) two live workers besides the owner|within the Codex worker ceiling|Codex uses the worker ceiling/);
    assert.doesNotMatch(text, /two-agent limit counts a batch as one agent/);
  }
  const policy = await import(pathToFileURL(path.join(ROOT, "apps/bridge/agents/policy.mjs")).href);
  assert.deepEqual(policy.SLOTS, { worker: 2, bao: 1, scout: 1 });
  assert.equal(policy.MAX_CONCURRENT_AGENTS, 2);
  assert.equal(policy.SESSION_CAP, 4);
});

test("generated routing retains judgment tiers and bounded leaf execution without weakening safety", async () => {
  const { render, MODEL_MAP } = await mod();
  assert.deepEqual(MODEL_MAP, { opus: "gpt-6-astra", sonnet: "gpt-6.1-sol", haiku: "gpt-6-luna" });
  for (const role of ["orchestrator", "developer", "architect", "code-reviewer", "qa", "security"]) {
    const text = readFileSync(path.join(ROOT, `.claude/agents/${role}.md`), "utf8");
    const codex = parseToml(render(text));
    assert.match(text, /^model: sonnet\r?$/m, `${role}: configured Claude judgment tier`);
    assert.match(text, /^effort: high\r?$/m, `${role}: configured judgment effort`);
    assert.equal(codex.model, MODEL_MAP.sonnet, `${role}: generated judgment tier`);
    assert.equal(codex.model_reasoning_effort, "high");
  }
  for (const role of ["runner", "scout"]) {
    const text = readFileSync(path.join(ROOT, `.claude/agents/${role}.md`), "utf8");
    const codex = parseToml(render(text));
    assert.match(text, /^model: haiku\r?$/m);
    assert.equal(codex.model, MODEL_MAP.haiku);
    assert.equal(codex.model_reasoning_effort, "low");
    assert.doesNotMatch(text.match(/^tools: ([^\n]*)/m)?.[1] ?? "", /\bAgent\b/, `${role}: Claude leaf has no delegation tool`);
    if (role === "runner") assert.match(codex.developer_instructions, /(?:start(?:s)? (?:nothing|no|another)|no Agent tool)/i);
  }
  const tiered = parseToml(render(SAMPLE() + "\nSonnet judgment; Haiku execution.\n")).developer_instructions;
  assert.match(tiered, /higher-tier[^\n]*lower-cost/i, "runtime prose must retain the distinction between judgment and execution tiers");
  const guidance = readFileSync(path.join(ROOT, ".codex/runtime-guidance.md"), "utf8");
  assert.match(guidance, /never silently (?:switch|substitute|downgrade)/i);
  assert.match(guidance, /first-failure/);
  assert.match(guidance, /one-attempt/);
  assert.match(guidance, /literal covering test files/);
  assert.match(guidance, /independent code review and QA/);
  assert.match(guidance, /no push, PR, merge, deployment, dependency or spending authority/);
});

test("Codex rendering maps lowercase model directives and preserves prose tiers", async () => {
  const { render, renderSkill, MODEL_MAP } = await mod();
  const instructions = "Dispatch with `model: haiku` or `--model sonnet`.\nUse claude-opus-5-5 for deep work.\nKeep sonnet judgment above bounded haiku execution.\n";
  for (const text of [
    parseToml(render(SAMPLE() + instructions)).developer_instructions,
    renderSkill("code-review/SKILL.md", Buffer.from(instructions)),
  ]) {
    assert.ok(text.includes(`model: ${MODEL_MAP.haiku}`), "inline model arguments use the configured Codex leaf model");
    assert.ok(text.includes(`--model ${MODEL_MAP.sonnet}`), "CLI model arguments use the configured Codex judgment model");
    assert.ok(text.includes(MODEL_MAP.opus), "an explicit Claude model ID maps through the existing tier table");
    assert.match(text, /higher-tier/i);
    assert.match(text, /lower-cost/i);
    assert.doesNotMatch(text, /\bclaude-(?:haiku|sonnet|opus)-|(?:model:\s*|--model\s+)(?:haiku|sonnet|opus)\b/i);
  }
});
