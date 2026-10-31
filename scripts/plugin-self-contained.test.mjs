// portable-den/02: the den plugin resolves its guards from ${CLAUDE_PLUGIN_ROOT} alone.
// A by-name install copies only .claude/ into the plugin cache (portable-den/01), so the hooks in
// .claude/hooks/hooks.json must find every script inside that copy.
// Seam: the hook commands from hooks.json, run as Claude Code runs them (sh -c, PreToolUse JSON on
// stdin, CLAUDE_PLUGIN_ROOT in the env, exit 2 blocks).
// Criterion map:
//   AC1 copied .claude/ passes a normal Read and Bash   -> "a plain Read and a plain Bash pass ..."
//   AC2 bash-guard allows with no den board, blocks in the den -> "board identity ..." (two tests)
//   AC3 sleep and test guards still exit 2 from the copy -> "a sleep chain ...", "an uncapped node --test ..."
//   AC4 the test-run-guard names test:path only where it exists -> "the test-run-guard message ..."
//   AC5 the mirrored guard files cannot drift from their sources -> "mirrored guard scripts ..."
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEN_PLUGIN = path.join(ROOT, ".claude");

// The sources of the guards the plugin mirrors under .claude/ (the lib sits one level up from hooks/).
const MIRRORS = [
  ["scripts/hooks/bash-guard.mjs", ".claude/hooks/bash-guard.mjs"],
  ["scripts/hooks/context-budget.mjs", ".claude/hooks/context-budget.mjs"],
  ["scripts/context-budget.mjs", ".claude/context-budget.mjs"],
  ["mods/test-run-guard/hooks/test-run-guard.mjs", ".claude/hooks/test-run-guard.mjs"],
  ["mods/sleep-guard/hooks/sleep-guard.mjs", ".claude/hooks/sleep-guard.mjs"],
];

// What a by-name install leaves: .claude/ alone, as <cache>/den/0.1.0, beside a project that has no den.
function install() {
  const dir = mkdtempSync(path.join(tmpdir(), "den-plugin-"));
  const pluginRoot = path.join(dir, "cache", "dimsumden-mods", "den", "0.1.0");
  const project = path.join(dir, "project");
  mkdirSync(project, { recursive: true });
  cpSync(DEN_PLUGIN, pluginRoot, { recursive: true, filter: (src) => !/^(worktrees|node_modules)(\/|$)/.test(path.relative(DEN_PLUGIN, src)) });
  return { pluginRoot, project };
}

function hooksFor(pluginRoot, toolName) {
  const { hooks } = JSON.parse(readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  return hooks.PreToolUse.filter((g) => !g.matcher || new RegExp(`^(?:${g.matcher})$`).test(toolName)).flatMap((g) => g.hooks.map((h) => h.command));
}

// Every matching hook's {code, stderr}, with the plugin root pointed at `pluginRoot`.
function fire(pluginRoot, cwd, toolName, toolInput, extra = {}) {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, cwd, ...extra });
  return hooksFor(pluginRoot, toolName).map((command) => {
    const r = spawnSync("sh", ["-c", command], {
      input,
      cwd,
      encoding: "utf8",
      timeout: 20000,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: cwd, DEN_ROOT: "" },
    });
    return { code: r.status, stderr: r.stderr };
  });
}

const blocked = (results) => results.find((r) => r.code === 2);

test("a plain Read and a plain Bash pass every hook from a copied .claude/", () => {
  const { pluginRoot, project } = install();
  const read = fire(pluginRoot, project, "Read", { file_path: path.join(project, "README.md") });
  assert.ok(read.length >= 1, "a Read matches at least the context-budget hook");
  assert.deepEqual(read.map((r) => r.code), read.map(() => 0), read.map((r) => r.stderr).join());
  const bash = fire(pluginRoot, project, "Bash", { command: "ls -la" });
  assert.equal(bash.length, 4, "context-budget, bash-guard, test-run-guard and sleep-guard all run on Bash");
  assert.deepEqual(bash.map((r) => r.code), [0, 0, 0, 0], bash.map((r) => r.stderr).join());
});

test("a sleep chain is still blocked from the copy", () => {
  const { pluginRoot, project } = install();
  const hit = blocked(fire(pluginRoot, project, "Bash", { command: "sleep 30; gh pr checks" }));
  assert.ok(hit, "some hook exits 2");
  assert.match(hit.stderr, /sleep-guard/);
});

test("an uncapped node --test over a glob is still blocked from the copy", () => {
  const { pluginRoot, project } = install();
  const hit = blocked(fire(pluginRoot, project, "Bash", { command: "node --test apps/**/*.test.mjs" }));
  assert.ok(hit, "some hook exits 2");
  assert.match(hit.stderr, /test-run-guard/);
});

test("the test-run-guard message names npm run test:path only where the project has that script", () => {
  const { pluginRoot, project } = install();
  const command = { command: "node --test apps/**/*.test.mjs" };
  const without = blocked(fire(pluginRoot, project, "Bash", command));
  assert.doesNotMatch(without.stderr, /test:path/);
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ scripts: { "test:path": "node scripts/test-path.mjs" } }));
  const sub = path.join(project, "src");
  mkdirSync(sub);
  const withScript = blocked(fire(pluginRoot, sub, "Bash", command));
  assert.match(withScript.stderr, /npm run test:path/);
});

const SIGN_AS_OTHER = { command: "npm run board -- comment portable-den/02 --as qa \"looks fine\"" };
const AS_DEVELOPER = { agent_type: "den:developer", agent_id: "a1" };

test("board identity does nothing in a copy with no den board", () => {
  const { pluginRoot, project } = install();
  const results = fire(pluginRoot, project, "Bash", SIGN_AS_OTHER, AS_DEVELOPER);
  assert.deepEqual(results.map((r) => r.code), [0, 0, 0, 0], results.map((r) => r.stderr).join());
});

test("board identity and the raw-jg rule still block in the den", () => {
  const signs = blocked(fire(DEN_PLUGIN, ROOT, "Bash", SIGN_AS_OTHER, AS_DEVELOPER));
  assert.ok(signs, "a developer signing as qa is blocked");
  assert.match(signs.stderr, /signs as your own role only/);
  const jg = blocked(fire(DEN_PLUGIN, ROOT, "Bash", { command: "jg \"where is X\"" }));
  assert.ok(jg, "raw jg is blocked");
  assert.match(jg.stderr, /raw jg calls are blocked/);
});

test("no hook command in hooks.json reaches outside the plugin root", () => {
  for (const tool of ["Read", "Bash"]) {
    for (const command of hooksFor(DEN_PLUGIN, tool)) assert.doesNotMatch(command, /\$\{CLAUDE_PLUGIN_ROOT\}\/\.\./, command);
  }
});

test("mirrored guard scripts under .claude/ are byte-identical to their sources", () => {
  const drifted = MIRRORS.filter(([src, copy]) => readFileSync(path.join(ROOT, src), "utf8") !== readFileSync(path.join(ROOT, copy), "utf8"));
  assert.deepEqual(drifted, [], `drifted mirrors; refresh each with: ${drifted.map(([src, copy]) => `cp ${src} ${copy}`).join(" && ")}`);
});
