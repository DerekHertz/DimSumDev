// mods-trial/01: the sleep-chain guard, our first mod (a project-scope plugin in mods/sleep-guard).
//
// Seam (confirmed by the user): the hook entry mods/sleep-guard/hooks/sleep-guard.mjs, run the way
// Claude Code runs a command hook: the PreToolUse JSON on stdin, decision on exit code and output.
//   allow -> exit 0, no output
//   deny  -> exit 2, stderr (and stdout) carry the message, as scripts/hooks/bash-guard.mjs does
// Criterion map:
//   AC1 deny/allow cases + malformed stdin allows -> "denies ...", "allows ...", "fails open ..."
//   AC2 the deny message names the alternative    -> "deny message names ..."
//   AC3 plugin installs at project scope from the in-repo marketplace -> "marketplace ...", "plugin manifest ..."
//       (the live install/uninstall run is a one-off check recorded in the handoff)
//   AC4 a block adds a board comment on the trial ticket, from a worktree too -> "block log ..."
//   AC5 orchestrator session-start line -> "session-start ..."
//   AC6 coverage spike -> a one-off live check, recorded on the ticket
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeBoardFixture, REPO_ROOT } from "../apps/board/board-fixture.mjs";

const PLUGIN = path.join(REPO_ROOT, "mods", "sleep-guard");
const HOOK = path.join(PLUGIN, "hooks", "sleep-guard.mjs");

function run(stdin, { env = {}, cwd = REPO_ROOT } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    cwd,
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT, DEN_ROOT: "", ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const bash = (command, extra = {}) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...extra });
// Tests that are not about logging point the log at a board that does not exist.
const NOLOG = { env: { DEN_ROOT: path.join(tmpdir(), "sleep-guard-no-such-root") } };

const DENIED = [
  ["a sleep then another command with ;", "sleep 30; gh pr checks"],
  ["a sleep then another command with &&", "sleep 5 && npm test"],
  ["a sleep then another command with ||", "sleep 5 || echo late"],
  ["a sleep over a pipe", "sleep 3 | cat"],
  ["a command then a sleep over a pipe", "gh pr checks | sleep 2"],
  ["a command then a chained sleep", "gh pr view 3; sleep 20"],
  ["a sleep chained over a newline", "sleep 5\ngh pr checks"],
  ["an until loop", "until gh pr checks --required; do sleep 5; done"],
  ["a while loop", "while ! test -f /tmp/x; do sleep 1; done"],
  ["a multi-line poll loop", "until test -f /tmp/x\ndo\n  sleep 2\ndone"],
  ["a for loop with a sleep", "for i in 1 2 3; do curl -s localhost:3000 && break; sleep 2; done"],
  ["a sleep by absolute path", "/bin/sleep 5; echo done"],
  ["a sleep behind an env assignment", "FOO=1 sleep 5; echo done"],
  ["a sleep in a subshell", "(sleep 5; echo done)"],
  ["a sleep in a brace group", "{ sleep 5; echo done; }"],
  ["a sleep after a heredoc-free echo with quotes", 'echo "waiting"; sleep 5'],
];

const ALLOWED = [
  ["gh pr checks --watch", "gh pr checks 12 --watch"],
  ["a lone sleep", "sleep 2"],
  ["a lone sleep with a trailing semicolon", "sleep 2;"],
  ["sleep in a path", "ls scripts/sleep-helper/ && cat docs/sleeping.md"],
  ["sleep as a file name argument", "node scripts/sleep.mjs --fast"],
  ["sleep as a grep pattern", "grep -rn sleep apps/ | head"],
  ["sleep inside double quotes", 'echo "sleep 5; rm -rf x"'],
  ["sleep inside single quotes", "git commit -m 'drop the sleep 5; gh chain'"],
  ["sleep in a comment", "npm test # no sleep 5; here"],
  ["sleep in a heredoc body", "cat <<'EOF' > /tmp/note.md\nsleep 5; gh pr checks\nEOF"],
  ["sleep inside a longer word", "asleep 5; echo hi"],
  ["a sleep-prefixed binary", "sleepy-tool --run; echo ok"],
  ["an ordinary chain", "git add -A && git commit -m wip"],
  ["an empty command", ""],
];

for (const [label, command] of DENIED) {
  test(`AC1 denies ${label}`, () => {
    const r = run(bash(command), NOLOG);
    assert.equal(r.code, 2, `expected deny for: ${JSON.stringify(command)}\n${r.stderr}`);
    assert.match(r.stderr, /sleep/i);
  });
}

for (const [label, command] of ALLOWED) {
  test(`AC1 allows ${label}`, () => {
    const r = run(bash(command), NOLOG);
    assert.equal(r.code, 0, `expected allow for: ${JSON.stringify(command)}\n${r.stderr}`);
    assert.equal(r.stderr, "");
    assert.equal(r.stdout, "");
  });
}

test("AC1 allows a tool that is not Bash", () => {
  const r = run(JSON.stringify({ tool_name: "Write", tool_input: { command: "sleep 5; ls", file_path: "/tmp/x" } }), NOLOG);
  assert.equal(r.code, 0);
});

for (const [label, stdin] of [
  ["malformed JSON", "{not json"],
  ["empty stdin", ""],
  ["a JSON array", "[1,2]"],
  ["a null payload", "null"],
  ["a command that is not a string", JSON.stringify({ tool_name: "Bash", tool_input: { command: { x: 1 } } })],
  ["no tool_input", JSON.stringify({ tool_name: "Bash" })],
]) {
  test(`AC1 fails open on ${label}`, () => {
    const r = run(stdin, NOLOG);
    assert.equal(r.code, 0);
  });
}

test("AC2 deny message names gh pr checks --watch and Monitor, and says what was blocked", () => {
  const r = run(bash("sleep 30; gh pr checks"), NOLOG);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /gh pr checks --watch/);
  assert.match(r.stderr, /Monitor/);
  assert.match(r.stderr, /sleep/);
  assert.equal(r.stdout.trim(), r.stderr.trim(), "stdout carries the same message for direct callers");
});

test("AC2 there is no override: an env flag, a marker comment or an agent identity does not bypass it", () => {
  for (const [command, extra, env] of [
    ["SLEEP_GUARD_OFF=1 sleep 5; ls", {}, { SLEEP_GUARD_OFF: "1", SLEEP_GUARD_ALLOW: "1" }],
    ["sleep 5; ls # sleep-guard: allow", {}, {}],
    ["sleep 5; ls", { agent_type: "orchestrator" }, {}],
  ]) {
    const r = run(bash(command, extra), { env: { ...NOLOG.env, ...env } });
    assert.equal(r.code, 2, command);
  }
});

// --- Block log (AC4) -------------------------------------------------------------------------

async function trialBoard({ ticket = "02-mods-trial", withTicket = true } = {}) {
  const fx = await makeBoardFixture({ feature: "mods-trial", ticket, status: "in-review" });
  if (!withTicket) {
    // a board with no standing trial ticket: the fixture ticket is some other ticket
    await fx.cleanup();
    return makeBoardFixture({ feature: "mods-trial", ticket: "01-other-thing", status: "in-review" });
  }
  return fx;
}

test("AC4 block log: a block adds a comment on the standing mods-trial ticket, run from a worktree", async () => {
  const fx = await trialBoard();
  try {
    const r = run(bash("sleep 30; gh pr checks 99", { agent_type: "developer", cwd: fx.worktree }), { cwd: fx.worktree });
    assert.equal(r.code, 2, r.stderr);
    const ticket = await fx.readTicket();
    assert.match(ticket, /\*\*developer, \d{4}-\d{2}-\d{2}:\*\*/, "stamped with the agent");
    assert.match(ticket, /sleep-guard/);
    assert.match(ticket, /sleep 30; gh pr checks 99/, "carries the head of the command");
  } finally {
    await fx.cleanup();
  }
});

test("AC4 block log: a main-session block (no agent_type) is still logged", async () => {
  const fx = await trialBoard();
  try {
    const r = run(bash("sleep 5 && npm test", { cwd: fx.worktree }), { cwd: fx.worktree });
    assert.equal(r.code, 2, r.stderr);
    assert.match(await fx.readTicket(), /sleep 5 && npm test/);
  } finally {
    await fx.cleanup();
  }
});

test("AC4 block log: only the head of a long command is logged", async () => {
  const fx = await trialBoard();
  try {
    const long = "sleep 5; echo " + "x".repeat(2000);
    const r = run(bash(long, { cwd: fx.worktree }), { cwd: fx.worktree });
    assert.equal(r.code, 2);
    const ticket = await fx.readTicket();
    assert.ok(ticket.length < 1500, `ticket grew by ${ticket.length}`);
    assert.match(ticket, /sleep 5; echo x/);
  } finally {
    await fx.cleanup();
  }
});

// Security finding (medium): the board is committed and pushed, so a secret in a blocked command
// must not reach the logged comment. The block itself still denies and the sleep stays readable.
const SK = ["sk", "live"].join("-") + "-"; // fake secrets are built at runtime so the repo secret scan stays clean
const GH = "gh" + "p_";
const AUTH = "Author" + "ization"; // the header name is built too, so no curl line sits in the source as a literal
const SECRETS = [
  ["an env assignment", `API_KEY=${SK}abc123def456 sleep 5; echo done`, `${SK}abc123def456`],
  ["a bearer header", `sleep 5; curl -H '${AUTH}: Bearer ${GH}aBcDeF0123456789xyz' https://x.test`, `${GH}aBcDeF0123456789xyz`],
  ["a basic auth header", `sleep 5; curl -H "${AUTH}: Basic dXNlcjpwYXNzd29yZA==" https://x.test`, "dXNlcjpwYXNzd29yZA"],
  ["a token flag", "sleep 5; gh api --token s3cr3tvalue99 /user", "s3cr3tvalue99"],
  ["a token flag with =", "sleep 5; tool --password=hunter2hunter2 run", "hunter2hunter2"],
  ["credentials in a url", `sleep 5; git clone https://bob:${"pa55"}w0rdZ@host.test/r.git`, "pa55w0rdZ"],
  ["a quoted env assignment", "sleep 5; export SECRET_TOKEN='abc def ghi123'", "ghi123"],
  ["a known token shape", `sleep 5; echo ${GH}0123456789abcdefghijklmnopqrstuvwxyz01`, `${GH}0123456789abcdefghijklmnopqrstuvwxyz01`],
];

for (const [label, command, secret] of SECRETS) {
  test(`AC4 block log: redacts ${label} before it reaches the board`, async () => {
    const fx = await trialBoard();
    try {
      const r = run(bash(command, { cwd: fx.worktree }), { cwd: fx.worktree });
      assert.equal(r.code, 2, r.stderr);
      const ticket = await fx.readTicket();
      assert.match(ticket, /sleep-guard blocked/, "the block is still logged");
      assert.ok(!ticket.includes(secret), `secret ${secret} leaked into the ticket`);
      assert.match(ticket, /\[redacted\]/);
      assert.match(ticket, /sleep 5/, "the sleep stays readable");
    } finally {
      await fx.cleanup();
    }
  });
}

test("AC4 block log: a huge dash run does not stall the hook in redact()", async () => {
  const fx = await trialBoard();
  try {
    const t0 = Date.now();
    const r = run(bash("sleep 5; echo " + "-".repeat(60000), { cwd: fx.worktree }), { cwd: fx.worktree });
    assert.equal(r.code, 2, r.stderr);
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  } finally {
    await fx.cleanup();
  }
});

test("AC4 block log: a command with no secret is logged unchanged", async () => {
  const fx = await trialBoard();
  try {
    run(bash("sleep 9; gh pr checks 7 --required", { cwd: fx.worktree }), { cwd: fx.worktree });
    const ticket = await fx.readTicket();
    assert.match(ticket, /sleep 9; gh pr checks 7 --required/);
    assert.doesNotMatch(ticket, /\[redacted\]/);
  } finally {
    await fx.cleanup();
  }
});

test("AC4 block log: an allowed command adds no comment", async () => {
  const fx = await trialBoard();
  try {
    const before = await fx.readTicket();
    const r = run(bash("gh pr checks --watch", { cwd: fx.worktree }), { cwd: fx.worktree });
    assert.equal(r.code, 0);
    assert.equal(await fx.readTicket(), before);
  } finally {
    await fx.cleanup();
  }
});

test("AC4 block log: with no standing trial ticket the block still denies, quietly", async () => {
  const fx = await trialBoard({ withTicket: false });
  try {
    const before = await fx.readTicket();
    const r = run(bash("sleep 5; ls", { cwd: fx.worktree }), { cwd: fx.worktree });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /gh pr checks --watch/);
    assert.equal(await fx.readTicket(), before);
  } finally {
    await fx.cleanup();
  }
});

test("AC4 block log: with the board CLI unreachable the block still denies", () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "sleep-guard-nocli-")));
  const r = run(bash("sleep 5; ls", { cwd: dir }), { cwd: dir, env: { CLAUDE_PROJECT_DIR: dir, DEN_ROOT: dir } });
  assert.equal(r.code, 2);
});

// --- Plugin shape (AC3) ----------------------------------------------------------------------

const readJson = (...p) => JSON.parse(readFileSync(path.join(REPO_ROOT, ...p), "utf8"));

test("AC3 marketplace: the in-repo marketplace lists the sleep-guard plugin at a relative source that exists", () => {
  const m = readJson(".claude-plugin", "marketplace.json");
  assert.match(m.name, /^[a-z0-9-]+$/);
  assert.ok(m.owner?.name, "owner.name is required");
  const entry = m.plugins.find((p) => p.name === "sleep-guard");
  assert.ok(entry, "sleep-guard is listed");
  assert.match(entry.source, /^\.\//);
  assert.ok(existsSync(path.join(REPO_ROOT, entry.source, ".claude-plugin", "plugin.json")));
  assert.equal(path.resolve(REPO_ROOT, entry.source), PLUGIN);
});

test("AC3 plugin manifest: loads, and registers one Bash PreToolUse command hook that exists", () => {
  const manifest = readJson("mods", "sleep-guard", ".claude-plugin", "plugin.json");
  assert.equal(manifest.name, "sleep-guard");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description);
  const hooks = readJson("mods", "sleep-guard", "hooks", "hooks.json");
  const groups = hooks.hooks?.PreToolUse;
  assert.ok(Array.isArray(groups) && groups.length === 1, "one PreToolUse group");
  assert.equal(groups[0].matcher, "Bash");
  const cmd = groups[0].hooks[0];
  assert.equal(cmd.type, "command");
  assert.ok(cmd.timeout > 0 && cmd.timeout <= 15, "a short timeout; a timed-out hook allows");
  const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?)"?$/.exec(cmd.command);
  assert.ok(m, `command uses CLAUDE_PLUGIN_ROOT: ${cmd.command}`);
  assert.ok(existsSync(path.join(PLUGIN, m[1])), `${m[1]} exists`);
});

test("AC3 the existing settings hooks are untouched: no sleep-guard wiring in .claude/settings.json hooks", () => {
  const s = readJson(".claude", "settings.json");
  assert.ok(!JSON.stringify(s.hooks).includes("sleep-guard"));
  assert.ok(s.hooks.PreToolUse.some((h) => /context-budget/.test(h.hooks[0].command)));
});

// --- session-start install line (AC5) --------------------------------------------------------

const START = path.join(REPO_ROOT, "scripts", "session-start.mjs");
const INSTALL_RE = /claude plugin install sleep-guard@\S+ --scope project/;

function startFixture({ settings = null, local = null, userSettings = null } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "sleep-guard-start-")));
  const root = path.join(dir, "root");
  const project = path.join(dir, "project");
  const home = path.join(dir, "home");
  mkdirSync(path.join(root, ".scratch", "_handoffs"), { recursive: true });
  mkdirSync(path.join(root, ".scratch", "_requests"), { recursive: true });
  mkdirSync(path.join(project, ".claude"), { recursive: true });
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  if (settings) writeFileSync(path.join(project, ".claude", "settings.json"), JSON.stringify(settings));
  if (local) writeFileSync(path.join(project, ".claude", "settings.local.json"), JSON.stringify(local));
  if (userSettings) writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify(userSettings));
  const usage = path.join(dir, "usage.mjs");
  writeFileSync(usage, 'console.log(JSON.stringify({"5-hour":{percent:1},weekly:{percent:2}}));\n');
  const gh = path.join(dir, "gh");
  writeFileSync(gh, "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
  return { dir, root, project, home, usage, gh };
}

function start(f, input) {
  const r = spawnSync(process.execPath, [START], {
    input: JSON.stringify(input),
    cwd: f.project,
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, DEN_ROOT: f.root, CLAUDE_PROJECT_DIR: f.project, HOME: f.home, GH_BIN: f.gh, SESSION_START_USAGE_SCRIPT: f.usage },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const ORCH = { hook_event_name: "SessionStart", source: "startup", agent_type: "orchestrator" };

test("AC5 session-start: an orchestrator session prints one install line when the mod is not enabled", () => {
  const f = startFixture({ settings: { enabledPlugins: {} } });
  const r = start(f, ORCH);
  assert.equal(r.code, 0);
  const lines = r.stdout.split("\n").filter((l) => /sleep-guard/.test(l));
  assert.equal(lines.length, 1, r.stdout);
  assert.match(lines[0], INSTALL_RE);
  assert.match(lines[0], /marketplace add/);
});

test("AC5 session-start: the line appears when settings has no enabledPlugins at all", () => {
  const f = startFixture({ settings: { permissions: {} } });
  assert.match(start(f, ORCH).stdout, INSTALL_RE);
});

test("AC5 session-start: the line appears when the settings file is missing", () => {
  const f = startFixture();
  assert.match(start(f, ORCH).stdout, INSTALL_RE);
});

test("AC5 session-start: the line appears when the mod is listed but disabled", () => {
  const m = readJson(".claude-plugin", "marketplace.json").name;
  const f = startFixture({ settings: { enabledPlugins: { [`sleep-guard@${m}`]: false } } });
  assert.match(start(f, ORCH).stdout, INSTALL_RE);
});

test("AC5 session-start: no line when the mod is enabled in project settings", () => {
  const m = readJson(".claude-plugin", "marketplace.json").name;
  const f = startFixture({ settings: { enabledPlugins: { [`sleep-guard@${m}`]: true } } });
  const r = start(f, ORCH);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, /sleep-guard/);
  assert.match(r.stdout, /Latest chief-of-staff handoff/, "the usual pickup is still printed");
});

test("AC5 session-start: no line when the mod is enabled in local or user settings", () => {
  const m = readJson(".claude-plugin", "marketplace.json").name;
  const key = `sleep-guard@${m}`;
  assert.doesNotMatch(start(startFixture({ local: { enabledPlugins: { [key]: true } } }), ORCH).stdout, /sleep-guard/);
  assert.doesNotMatch(start(startFixture({ userSettings: { enabledPlugins: { [key]: true } } }), ORCH).stdout, /sleep-guard/);
});

test("AC5 session-start: other session types get no install line", () => {
  const f = startFixture({ settings: { enabledPlugins: {} } });
  for (const input of [{ hook_event_name: "SessionStart", source: "startup" }, { ...ORCH, agent_type: "developer" }]) {
    const r = start(f, input);
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stdout, /sleep-guard/);
  }
});

test("AC5 session-start: unreadable settings still print the line and exit 0", () => {
  const f = startFixture();
  writeFileSync(path.join(f.project, ".claude", "settings.json"), "{not json");
  const r = start(f, ORCH);
  assert.equal(r.code, 0);
  assert.match(r.stdout, INSTALL_RE);
});

test("AC5 the cloud-sessions doc carries a note on the mod and its install", () => {
  const doc = readFileSync(path.join(REPO_ROOT, "docs", "agents", "cloud-sessions.md"), "utf8");
  assert.match(doc, /sleep-guard/);
  assert.match(doc, /claude plugin install/);
});
