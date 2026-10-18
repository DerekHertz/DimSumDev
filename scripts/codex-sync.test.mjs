// den-mvp/103: Codex reads the same relay as Claude. .claude/ is the one source; scripts/codex-sync.mjs
// generates .codex/agents/*.toml, .agents/skills/ and AGENTS.md from it, and --check is the drift test.
// Red until scripts/codex-sync.mjs exists and its output is generated and committed.
//
// Interface these tests pin (see the qa handoff for the Codex doc citations behind it):
//   export render(genomeMarkdown: string) -> string   one .codex/agents/<role>.toml
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

const GENOMES = readdirSync(path.join(ROOT, ".claude/agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
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
description: A "quoted" sample genome (with a backslash \\ in it)
tools: Read, Grep, Agent(scout, runner), Skill, mcp__github
model: ${over.model ?? "sonnet"}
effort: ${over.effort ?? "high"}
color: green
skills:
  - organism-protocol
organism:
  station: tea-pantry
  purpose: Sample.
---

You are a **sample** cell.
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
  assert.equal(t.description, 'A "quoted" sample genome (with a backslash \\ in it)');
  assert.match(t.developer_instructions, /You are a \*\*sample\*\* cell\./);
  assert.ok(t.developer_instructions.includes("Plain line that stays exactly as written."));
  assert.ok(t.developer_instructions.includes(MARK), "backslashes in the body must survive");
  assert.ok(!t.developer_instructions.startsWith("---"), "front matter leaked into the instructions");
});

test("render leaves Claude front matter keys out of the TOML (Codex has no per-agent tools, color or turns)", async () => {
  const { render } = await mod();
  const t = parseToml(render(SAMPLE()));
  for (const k of ["tools", "color", "maxTurns", "isolation", "skills", "organism"]) assert.ok(!(k in t), `${k} leaked into the TOML`);
  assert.deepEqual(Object.keys(t).sort(), ["description", "developer_instructions", "model", "model_reasoning_effort", "name"]);
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

Run a cell as the main session with \`claude --agent <cell-type>\`. If a session is asked to act as a cell without that flag, read \`.claude/agents/<cell-type>.md\` first and follow it.

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
  return { dir, w };
}
const run = (dir, ...args) => spawnSync("node", [SCRIPT, "--root", dir, ...args], { encoding: "utf8", timeout: 60000 });
const out = (r) => `${r.stdout}${r.stderr}`;

test("write mode creates a toml per genome, every skill file (licences included), and AGENTS.md; then --check is clean", () => {
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

test("--check fails and names the file when a genome changes without regenerating", () => {
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

test("a stale mirror (genome or skill removed) fails --check and write mode removes it", () => {
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

test("every genome in .claude/agents/ has a generated .codex/agents/<role>.toml, runner and security included, and no extras", () => {
  assert.ok(GENOMES.includes("runner") && GENOMES.includes("security"), `genomes: ${GENOMES}`);
  const toml = readdirSync(path.join(ROOT, ".codex/agents")).filter((f) => f.endsWith(".toml")).map((f) => f.slice(0, -5)).sort();
  assert.deepEqual(toml, GENOMES);
  for (const role of GENOMES) {
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

test(".agents/skills/ mirrors .claude/skills/ file for file, is tracked in git, and holds no other skill than the hand-kept jevgrep", () => {
  const walk = (d, base = d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name), base) : [path.relative(base, path.join(d, e.name)).split(path.sep).join("/")]);
  const src = walk(path.join(ROOT, ".claude/skills")).sort();
  assert.ok(src.includes("ponytail/SKILL.md") && src.includes("PONYTAIL-LICENSE") && src.includes("MATTPOCOCK-LICENSE"));
  const tracked = new Set(execFileSync("git", ["ls-files", "--", ".agents/skills"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean));
  for (const f of src) {
    const dst = path.join(ROOT, ".agents/skills", f);
    assert.ok(existsSync(dst), `.agents/skills/${f} missing`);
    assert.ok(readFileSync(dst).equals(readFileSync(path.join(ROOT, ".claude/skills", f))), `.agents/skills/${f} differs`);
    assert.ok(tracked.has(`.agents/skills/${f}`), `.agents/skills/${f} is not tracked in git`);
  }
  const extra = walk(path.join(ROOT, ".agents/skills")).filter((f) => !src.includes(f) && !f.startsWith("jevgrep/"));
  assert.deepEqual(extra, [], "stale files in .agents/skills");
  assert.ok(tracked.has(".agents/skills/jevgrep/SKILL.md"), "jevgrep must stay tracked");
});

test("AGENTS.md on disk is generated from CLAUDE.md, not the 5-line stub", async () => {
  const { renderAgents } = await mod();
  const disk = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  assert.equal(disk, renderAgents(readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8")));
  assert.ok(disk.split("\n").length > 20);
});

// ---------- hooks: Codex documents no project-dir variable ----------

test(".codex/hooks.json finds the repo with git rev-parse, not $CLAUDE_PROJECT_DIR", () => {
  const text = readFileSync(path.join(ROOT, ".codex/hooks.json"), "utf8");
  assert.ok(!/CLAUDE_PROJECT_DIR/.test(text), "Codex does not set CLAUDE_PROJECT_DIR");
  const hooks = JSON.parse(text).hooks;
  const cmds = Object.values(hooks).flatMap((evs) => evs.flatMap((e) => e.hooks.map((h) => h.command)));
  assert.ok(cmds.length >= 2);
  for (const c of cmds) assert.match(c, /git rev-parse --show-toplevel/);
  assert.ok(cmds.some((c) => c.includes("scripts/session-start.mjs")));
  assert.ok(cmds.some((c) => c.includes("scripts/notify.mjs")));
});
