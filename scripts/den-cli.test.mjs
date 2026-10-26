// The den kit: `den` runs the board, tests and the risk check in another project, and the plugin carries the guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bareRole, budgetFor, isChiefOfStaff } from "./context-budget.mjs";
import { check } from "./hooks/bash-guard.mjs";

const DEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(DEN, "scripts", "den-cli.mjs");

function project() {
  const root = mkdtempSync(path.join(tmpdir(), "den-kit-"));
  const git = (...a) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "k@example.com");
  git("config", "user.name", "Kit");
  writeFileSync(path.join(root, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return { root, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const den = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });

test("den init writes the project config, ignores .scratch and adds the relay summary once", () => {
  const p = project();
  try {
    assert.equal(den(p.root, "init").status, 0);
    assert.equal(den(p.root, "init").status, 0);
    const cfg = JSON.parse(readFileSync(path.join(p.root, ".den", "project.json"), "utf8"));
    assert.ok(cfg.test && Array.isArray(cfg.codePaths));
    assert.match(readFileSync(path.join(p.root, ".gitignore"), "utf8"), /^\.scratch\/$/m);
    const claude = readFileSync(path.join(p.root, "CLAUDE.md"), "utf8");
    assert.equal(claude.match(/## Agents \(den kit\)/g).length, 1);
    assert.ok(existsSync(path.join(p.root, ".scratch")));
  } finally {
    p.cleanup();
  }
});

test("den test runs the project's own test command with the files appended", () => {
  const p = project();
  try {
    mkdirSync(path.join(p.root, ".den"));
    writeFileSync(path.join(p.root, ".den", "project.json"), JSON.stringify({ test: `${process.execPath} -e console.log(process.argv.slice(1).join(","))` }));
    // node -e prints argv; the file arguments follow the configured command.
    writeFileSync(path.join(p.root, ".den", "project.json"), JSON.stringify({ test: `${process.execPath} ${path.join(p.root, "echo.mjs")}` }));
    writeFileSync(path.join(p.root, "echo.mjs"), "console.log('ran:' + process.argv.slice(2).join(','));\n");
    const r = den(p.root, "test", "a.test.js", "b.test.js");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ran:a\.test\.js,b\.test\.js/);
  } finally {
    p.cleanup();
  }
});

test("den risk-check uses the project's code dirs and guardrail files", () => {
  const p = project();
  try {
    mkdirSync(path.join(p.root, ".den"));
    writeFileSync(path.join(p.root, ".den", "project.json"), JSON.stringify({ codePaths: ["server"], guardrailPaths: ["config/policy.json"] }));
    p.git("add", "-A");
    p.git("commit", "-qm", "config");
    p.git("checkout", "-qb", "work");
    mkdirSync(path.join(p.root, "server"));
    mkdirSync(path.join(p.root, "config"));
    writeFileSync(path.join(p.root, "server", "s.js"), "require('child_process').execSync('ls');\n");
    writeFileSync(path.join(p.root, "config", "policy.json"), "{}\n");
    p.git("add", "-A");
    p.git("commit", "-qm", "work");
    const r = den(p.root, "risk-check", "main...HEAD");
    assert.match(r.stdout + r.stderr, /server\/s\.js: shelling out/);
    assert.match(r.stdout + r.stderr, /config\/policy\.json: guardrail file changed/);
  } finally {
    p.cleanup();
  }
});

test("den board reads this project's own .scratch board", () => {
  const p = project();
  try {
    mkdirSync(path.join(p.root, ".scratch", "feat", "issues"), { recursive: true });
    writeFileSync(path.join(p.root, ".scratch", "feat", "issues", "01-thing.md"), "# 01: thing\n\nStatus: ready-for-agent\n\n## Comments\n");
    const r = den(p.root, "board", "status", "feat/01-thing");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ready-for-agent/);
  } finally {
    p.cleanup();
  }
});

test("plugin roles (agent_type den:<role>) get their role's budget and board identity", () => {
  assert.equal(bareRole("den:qa"), "qa");
  assert.ok(isChiefOfStaff("den:chief-of-staff"));
  assert.deepEqual(budgetFor("den:security"), budgetFor("security"));
  const bash = (command) => ({ tool_name: "Bash", tool_input: { command }, agent_id: "a", agent_type: "den:security" });
  assert.equal(check(bash("den board comment f/01-x --as security --verdict pass ok")), null);
  assert.match(check(bash("den board comment f/01-x --as qa --verdict pass ok")) ?? "", /own role/);
});

test("the plugin carries the guards as its own hooks, on paths that exist", () => {
  const hooks = JSON.parse(readFileSync(path.join(DEN, ".claude", "hooks", "hooks.json"), "utf8")).hooks.PreToolUse.flatMap((h) => h.hooks);
  for (const name of ["context-budget", "bash-guard", "test-run-guard", "sleep-guard"]) {
    const h = hooks.find((x) => x.command.includes(name));
    assert.ok(h, name);
    const rel = /\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?)"/.exec(h.command)[1];
    assert.ok(existsSync(path.join(DEN, ".claude", rel)), rel);
  }
});
