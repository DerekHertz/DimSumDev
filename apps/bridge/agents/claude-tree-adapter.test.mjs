import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildClaudeArgs, compileCeiling, mcpConfigWithTokens } from "./claude-adapter.mjs";
import { createClaudeRuntime, credentialStoresForRun } from "./claude-runtime.mjs";
import { ROLES } from "./policy.mjs";

const SESSION = "0b8f1c1e-5c1a-4c0e-9a55-3f2d9e7a4b10";
const WORKTREE = "/work/den/.claude/worktrees/tree-runner";
const flag = (argv, name) => argv[argv.indexOf(name) + 1];
const settings = (argv) => JSON.parse(flag(argv, "--settings"));

test("managed Claude tree launches pin model and effort and disable native delegation while legacy launches stay compatible", () => {
  for (const [agent, model, effort] of [["orchestrator", "sonnet", "high"], ["developer", "sonnet", "high"], ["runner", "haiku", "low"]]) {
    const argv = buildClaudeArgs({ sessionId: SESSION, agent, model, effort, tree: true, ...compileCeiling(agent, { worktree: WORKTREE, tree: true }) });
    assert.equal(flag(argv, "--model"), model);
    assert.equal(flag(argv, "--effort"), effort);
    assert.match(flag(argv, "--disallowedTools"), /(?:^|,)Agent(?:,|$)/);
    assert.match(flag(argv, "--disallowedTools"), /(?:^|,)Task(?:,|$)/);
    assert.ok(!argv.includes("--fallback-model"));
    assert.equal(settings(argv).sandbox.failIfUnavailable, true);
    assert.equal(settings(argv).sandbox.allowUnsandboxedCommands, false);
  }
  const legacy = buildClaudeArgs({ sessionId: SESSION, agent: "developer" });
  assert.ok(!legacy.includes("--disallowedTools"));
  assert.ok(!legacy.includes("--effort"));
});

test("a runner is an internal read-only tree leaf, without grants, publication or a public direct role", () => {
  assert.ok(!ROLES.includes("runner"));
  assert.equal(compileCeiling("runner", { worktree: WORKTREE }), null);
  assert.throws(() => buildClaudeArgs({ sessionId: SESSION, agent: "runner" }), /known role/);
  const ceiling = compileCeiling("runner", { worktree: WORKTREE, tree: true });
  const argv = buildClaudeArgs({ sessionId: SESSION, agent: "runner", tree: true, model: "haiku", effort: "low", ...ceiling });
  const s = settings(argv);
  assert.ok(s.sandbox.filesystem.denyWrite.includes(WORKTREE));
  assert.ok(s.permissions.deny.includes(`Write(/${WORKTREE}/**)`));
  assert.ok(!s.permissions.allow.some((rule) => /^(Write|Edit)\(/.test(rule)));
  for (const tool of ["Write", "Edit", "NotebookEdit"]) assert.ok(flag(argv, "--disallowedTools").split(",").includes(tool));
  for (const command of ["git push", "gh pr create", "git commit", "board"]) assert.ok(ceiling.forbid.run.includes(command));
  assert.throws(() => compileCeiling("runner", { worktree: WORKTREE, tree: true, grants: [{ kind: "host", value: "example.com" }] }), /takes no grants/);
  assert.throws(() => buildClaudeArgs({ sessionId: SESSION, agent: "developer", tree: true, effort: "invented" }), /configured tree effort/);
});

test("the trusted tree MCP server gets its own credential through protected config rather than model argv", () => {
  const token = "t".repeat(43);
  const connection = { name: "tree", script: "/control/apps/bridge/agents/tree-tools.mjs", credential: "run" };
  const config = JSON.parse(mcpConfigWithTokens([connection], { tree: { url: "http://127.0.0.1:4317", token } }));
  assert.deepEqual(config.mcpServers.tree.args, [connection.script]);
  assert.deepEqual(config.mcpServers.tree.env, { DEN_BRIDGE_URL: "http://127.0.0.1:4317", DEN_RUN_TOKEN: token });
  const argv = buildClaudeArgs({ sessionId: SESSION, agent: "developer", tree: true, model: "sonnet", effort: "high", connections: [connection], mcpConfigFile: "/home/den/.local/state/den/credentials/run/tree.json", ...compileCeiling("developer", { worktree: WORKTREE, tree: true }) });
  assert.ok(!argv.join(" ").includes(token));
  assert.ok(argv.includes("--strict-mcp-config"));
});

test("Claude tree spawn refuses forged model selection, malformed credentials or extra grants before launch", async () => {
  let calls = 0;
  const runtime = createClaudeRuntime({ controlRoot: fileURLToPath(new URL("../../..", import.meta.url)), launcher: { enforced: true, preflight: async () => ({ ok: true }), launch: async () => { calls += 1; throw new Error("must not launch"); } } });
  assert.equal(runtime.capabilities.treeDelegation, true);
  assert.equal(runtime.validateModel({ model: "sonnet", effort: "high" }), true);
  assert.equal(runtime.validateModel({ model: "unknown", effort: "high" }), false);
  const input = { role: "developer", cwd: WORKTREE, prompt: "one scoped task", sessionId: SESSION, model: "sonnet", effort: "high", tree: { depth: 1 }, treeCredential: { url: "http://127.0.0.1:4317", token: "t".repeat(43) } };
  await assert.rejects(runtime.spawn({ ...input, model: "haiku" }), /differs from the trusted role/);
  await assert.rejects(runtime.spawn({ ...input, treeCredential: { url: "https://example.com", token: "t".repeat(43) } }), /invalid tree credential/);
  await assert.rejects(runtime.spawn({ ...input, grants: [{ kind: "host", value: "example.com" }] }), /no additional grants/);
  await assert.rejects(runtime.spawn({ ...input, tree: { depth: 3 } }), /invalid tree depth/);
  await assert.rejects(runtime.spawn({ ...input, tree: { depth: 2 } }), /role does not match its layer/);
  await assert.rejects(runtime.spawn({ ...input, treeCredential: undefined }), /own tree credential/);
  assert.equal(calls, 0);
});

test("a fresh-home tree launch profile denies reads of the credential store before its first token is written", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "den-tree-fresh-home-"));
  const store = path.join(home, ".local/state/den/credentials");
  try {
    assert.equal(existsSync(store), false, "the test starts with no existing credential store");
    assert.deepEqual(credentialStoresForRun({ home }), [], "ordinary runs retain their existing credential snapshot behavior");
    const credentials = credentialStoresForRun({ home, tree: true });
    assert.ok(credentials.includes("~/.local/state/den/credentials"), "the first tree profile must close the store that will hold its token and siblings' tokens");
    assert.equal(existsSync(path.join(store, "run")), true);
    if (process.platform !== "win32") {
      assert.equal(statSync(store).mode & 0o777, 0o700);
      assert.equal(statSync(path.join(store, "run")).mode & 0o777, 0o700);
    }
    const profile = settings(buildClaudeArgs({ sessionId: SESSION, agent: "developer", tree: true, model: "sonnet", effort: "high", ...compileCeiling("developer", { worktree: WORKTREE, tree: true, credentials }) }));
    for (const denied of ["Read(~/.local/state/den/credentials)", "Read(~/.local/state/den/credentials/**)"]) assert.ok(profile.permissions.deny.includes(denied));
    assert.ok(profile.sandbox.filesystem.denyRead.includes("~/.local/state/den/credentials"));
    assert.throws(() => credentialStoresForRun({ tree: true }), /protected credential directory/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
