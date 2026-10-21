import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildClaudeArgs, compileCeiling, mcpConfigWithTokens } from "./claude-adapter.mjs";
import { createClaudeRuntime, credentialStoresForRun, treeExecutionProfile, treeFileWriteRefusal, treePrivateDirectories } from "./claude-runtime.mjs";
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

test("code runners opt into exact write scopes while retaining low-tier execution and no publication or native children", () => {
  const target = `${WORKTREE}/src/approved.mjs`;
  const scopeWrites = [{ path: target, directory: false }];
  const ceiling = compileCeiling("runner", { worktree: WORKTREE, tree: true, scopeWrites, mainGit: "/work/den/.git" });
  assert.equal(ceiling.worktree, undefined, "code mode must never add a full-worktree write allow");
  const argv = buildClaudeArgs({ sessionId: SESSION, agent: "runner", tree: true, model: "haiku", effort: "low", ...ceiling });
  const profile = settings(argv);
  assert.deepEqual(profile.sandbox.filesystem.allowWrite, [target]);
  assert.ok(profile.permissions.allow.includes(`Write(/${target})`));
  assert.ok(!profile.permissions.allow.includes(`Write(/${WORKTREE}/**)`));
  assert.ok(!profile.sandbox.filesystem.denyWrite.includes(WORKTREE), "the kernel, not a contradictory deny/allow profile, restricts product scope");
  assert.match(flag(argv, "--disallowedTools"), /Agent,Task/);
  assert.ok(!flag(argv, "--disallowedTools").split(",").includes("Write"));
  assert.equal(flag(argv, "--model"), "haiku");
  assert.equal(flag(argv, "--effort"), "low");
  for (const command of ["git commit", "git push", "gh pr create", "board"]) assert.ok(ceiling.forbid.run.includes(command));
});

test("native tree write requests recheck exact files, directory additions and read-only review boundaries", (t) => {
  const worktree = mkdtempSync(path.join(os.tmpdir(), "den-tree-write-check-"));
  try {
    const src = path.join(worktree, "src");
    mkdirSync(src);
    const approved = path.join(src, "approved.mjs");
    const outside = path.join(worktree, "outside.mjs");
    writeFileSync(approved, "before");
    writeFileSync(outside, "outside");
    const tree = { depth: 2, logicalRole: "runner", phase: "implementation", execution: { mode: "code", scopes: ["src/approved.mjs"] } };
    const profile = treeExecutionProfile({ role: "runner", tree, cwd: worktree });
    assert.equal(profile.code, true);
    assert.equal(profile.readonly, false);
    assert.equal(treeFileWriteRefusal(profile, worktree, "Write", { file_path: approved }), null);
    assert.match(treeFileWriteRefusal(profile, worktree, "Edit", { file_path: outside }), /approved file scopes/);
    assert.match(treeFileWriteRefusal(profile, worktree, "Write", { file_path: `${approved}.new` }), /approved file scopes/);
    const directory = treeExecutionProfile({ role: "runner", tree: { ...tree, execution: { mode: "code", scopes: ["src"] } }, cwd: worktree });
    assert.equal(treeFileWriteRefusal(directory, worktree, "Write", { file_path: path.join(src, "new.mjs") }), null);
    assert.match(treeFileWriteRefusal({ readonly: true }, worktree, "Edit", { file_path: approved }), /read-only/);
    assert.throws(() => treeExecutionProfile({ role: "runner", tree: { ...tree, execution: { mode: "code", scopes: ["../escape"] } }, cwd: worktree }), /explicit relative scopes/);
    assert.throws(() => treeExecutionProfile({ role: "developer", tree: { depth: 1, execution: { mode: "code", scopes: ["src"] } }, cwd: worktree }), /implementation runner/);
    if (process.platform === "linux") {
      const alias = path.join(src, "alias");
      symlinkSync(path.join(worktree, "outside-new.mjs"), alias);
      assert.match(treeFileWriteRefusal(directory, worktree, "Write", { file_path: alias }), /could not be checked/);
    }
  } finally { rmSync(worktree, { recursive: true, force: true }); }
});

test("every logical layer has fresh high-tier readonly reviews with only a reporting channel", () => {
  for (const [phase, role] of [["code-review", "code-reviewer"], ["qa", "qa"], ["security", "security"], ["writer-review", "technical-writer"]]) {
    for (const [depth, logicalRole] of [[0, "orchestrator"], [1, "developer"], [2, "runner"]]) {
      const tree = { depth, logicalRole, phase, candidate: "a".repeat(40) };
      const execution = treeExecutionProfile({ role, tree, cwd: WORKTREE });
      assert.equal(execution.review, true);
      assert.equal(execution.readonly, true);
      assert.throws(() => treeExecutionProfile({ role, tree, cwd: WORKTREE, resume: true }), /fresh session/);
      const argv = buildClaudeArgs({ sessionId: SESSION, agent: role, tree: true, model: "sonnet", effort: "high", ...compileCeiling(role, { worktree: WORKTREE, tree: true, treeReadOnly: true }) });
      assert.equal(flag(argv, "--allowedTools"), "mcp__tree__status,mcp__tree__review");
      assert.match(flag(argv, "--disallowedTools"), /Write,Edit/);
      assert.equal(flag(argv, "--model"), "sonnet");
      assert.equal(flag(argv, "--effort"), "high");
      assert.ok(settings(argv).sandbox.filesystem.denyWrite.includes(WORKTREE));
    }
  }
});

test("tree and concurrent legacy profiles both close future artifact receipts and bridge-owned hook storage", () => {
  const mainGit = "/work/den/.git";
  const store = `${mainGit}/den-tree-artifacts`;
  for (const tree of [false, true]) {
    const profile = settings(buildClaudeArgs({ sessionId: SESSION, agent: "developer", ...(tree ? { tree: true } : {}), ...compileCeiling("developer", { worktree: WORKTREE, mainGit, ...(tree ? { tree: true } : {}) }) }));
    assert.ok(profile.sandbox.filesystem.denyWrite.includes(store));
    assert.ok(profile.sandbox.filesystem.denyRead.includes(store));
    for (const rule of [`Read(/${store})`, `Read(/${store}/**)`, `Write(/${store}/**)`, `Edit(/${store}/**)`]) assert.ok(profile.permissions.deny.includes(rule));
  }
});

test("artifact-store initialization refuses a preexisting link before changing its target permissions", (t) => {
  if (process.platform !== "linux") return t.skip("POSIX mode and symbolic link regression");
  const root = mkdtempSync(path.join(os.tmpdir(), "den-tree-linked-store-"));
  try {
    const mainGit = path.join(root, "common.git");
    const external = path.join(root, "external");
    mkdirSync(mainGit);
    mkdirSync(external, { mode: 0o755 });
    const before = statSync(external).mode & 0o777;
    symlinkSync(external, path.join(mainGit, "den-tree-artifacts"));
    assert.throws(() => treePrivateDirectories(mainGit), /not canonical/);
    assert.equal(statSync(external).mode & 0o777, before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
