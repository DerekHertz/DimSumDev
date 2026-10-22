import { test } from "node:test";
import assert from "node:assert/strict";
import { compileCodexPermissions, renderCodexConfig } from "./codex-permissions.mjs";

const input = (patch = {}) => ({ profileId: "bridge-test", worktree: "/project/worktrees/job", nativeStore: "/state/private-native",
  policy: { version: 1, readRoots: ["/project/worktrees/job", "/project/node_modules"], writeRoots: ["/project/worktrees/job"],
    readOnlyPaths: ["/project/worktrees/job/.claude", "/project/worktrees/job/.git", "/project/.git/refs"],
    denyPaths: ["/home/user/.ssh", "/home/user/.codex/auth.json"], denyCommands: [["git", "push"], ["gh", "pr", "merge"]], hosts: [], ...patch } });

test("neutral effective restrictions translate into an exact named profile without becoming launch authority", () => {
  const compiled = compileCodexPermissions(input());
  assert.equal(compiled.launchable, false);
  assert.equal(compiled.profileId, "bridge-test");
  const profile = compiled.config.permissions[compiled.profileId];
  assert.equal(compiled.config.default_permissions, compiled.profileId);
  assert.equal(profile.filesystem[":minimal"], "read");
  assert.equal(profile.filesystem[":root"], undefined, "restricted profiles already default to deny; no broad root grant");
  assert.equal(profile.filesystem["/project/worktrees/job"], "write");
  assert.equal(profile.filesystem["/project/node_modules"], "read");
  for (const path of input().policy.readOnlyPaths.slice(0, 2)) assert.equal(profile.filesystem[path], "read");
  assert.equal(profile.filesystem["/project/.git/refs"], "deny", "governance outside admitted roots cannot add read access");
  for (const path of [...input().policy.denyPaths, input().nativeStore]) assert.equal(profile.filesystem[path], "deny");
  assert.equal(profile.network.enabled, false);
  assert.ok(!Object.hasOwn(profile, "extends"));
  assert.ok(Object.isFrozen(compiled.config.permissions[compiled.profileId].filesystem));
  assert.ok(compiled.requirements.includes("private-configuration-stack"));
  assert.ok(compiled.requirements.includes("canonical-path-and-symlink-check"));
  assert.ok(compiled.requirements.includes("actual-launch-conformance"));
});

test("actual native feature names suppress children and alternate surfaces without pretending to clear inherited config", () => {
  const compiled = compileCodexPermissions(input());
  for (const name of ["multi_agent", "multi_agent_v2", "multi_agent_v2_dynamic_tools", "collab", "enable_fanout", "hooks", "codex_hooks", "plugin_hooks", "plugins", "apps", "connectors", "shell_snapshot", "request_permissions", "request_permissions_tool", "request_rule", "step_model_switching"]) {
    assert.equal(compiled.config.features[name], false, name);
  }
  assert.equal(compiled.config.approval_policy, "never");
  assert.equal(compiled.config.approvals_reviewer, "user");
  assert.equal(compiled.config.shell_environment_policy.inherit, "none");
  assert.equal(compiled.config.web_search, "disabled");
  assert.deepEqual(compiled.config.mcp_servers, {});
  assert.equal(compiled.launchable, false);
});

test("forbidden command prefixes retain every neutral-policy rule and have no allow or prompt rule", () => {
  const compiled = compileCodexPermissions(input());
  assert.match(compiled.execPolicy, /pattern = \["git","push"\]/);
  assert.match(compiled.execPolicy, /pattern = \["gh","pr","merge"\]/);
  assert.equal((compiled.execPolicy.match(/decision = "forbidden"/g) ?? []).length, 2);
  assert.doesNotMatch(compiled.execPolicy, /decision = "(?:allow|prompt)"/);
  assert.ok(compiled.requirements.includes("protected-exec-policy-loading"));
});

test("a more specific read or write grant cannot reopen a credential/store denial or governed read-only path", () => {
  assert.throws(() => compileCodexPermissions(input({ readRoots: ["/home/user/.ssh/key"] })), /reopens/);
  assert.throws(() => compileCodexPermissions(input({ writeRoots: ["/state/private-native/session"] })), /reopens/);
  assert.throws(() => compileCodexPermissions(input({ writeRoots: ["/project/worktrees/job/.claude/agents"] })), /read-only/);
  assert.throws(() => compileCodexPermissions(input({ writeRoots: ["/project/.git/refs"] })), /read-only/);
});

test("unsupported hosts, globs, traversal, root writes and unknown policy requirements refuse compilation", () => {
  for (const policy of [
    { hosts: ["registry.npmjs.org"] }, { readRoots: ["/project/../outside"] }, { denyPaths: ["/project/**/secret"] },
    { writeRoots: ["/"] }, { shellEscapeAllowed: true }, { version: 2 }, { denyCommands: [["git", "push;curl"]] },
  ]) assert.throws(() => compileCodexPermissions(input(policy)));
  assert.throws(() => compileCodexPermissions({ ...input(), profileId: ":danger-full-access" }));
  assert.throws(() => compileCodexPermissions({ ...input(), nativeStore: "/project/worktrees/job" }), /store/);
});

test("read-only roles retain read access but never gain a write root", () => {
  const compiled = compileCodexPermissions(input({ writeRoots: [] }));
  const fs = compiled.config.permissions[compiled.profileId].filesystem;
  assert.equal(fs["/project/worktrees/job"], "read");
  assert.ok(!Object.values(fs).includes("write"));
});

test("governed read ceilings never reopen a more-specific denied subtree or add a new readable root", () => {
  const compiled = compileCodexPermissions(input({
    readOnlyPaths: ["/home/user/.ssh/key", "/state/private-native/session", "/unadmitted/governance", "/project/worktrees/job/controlled"],
  }));
  const filesystem = compiled.config.permissions[compiled.profileId].filesystem;
  for (const path of ["/home/user/.ssh/key", "/state/private-native/session", "/unadmitted/governance"]) assert.equal(filesystem[path], "deny");
  assert.equal(filesystem["/project/worktrees/job/controlled"], "read");
});

test("sparse and decorated path/command lists refuse compilation rather than omitting restrictions", () => {
  const sparse = Array(1);
  const decorated = Object.assign(["/project/worktrees/job"], { extra: "/outside" });
  for (const patch of [{ readRoots: sparse }, { denyPaths: sparse }, { readOnlyPaths: decorated },
    { denyCommands: sparse }, { denyCommands: [sparse] }, { denyCommands: [Object.assign(["git", "push"], { extra: "ignored" })] },
    { hosts: Object.assign([], { extra: "ignored-host" }) }]) {
    assert.throws(() => compileCodexPermissions(input(patch)));
  }
});

test("config rendering quotes path keys and preserves the named profile without legacy sandbox settings", () => {
  const compiled = compileCodexPermissions(input());
  const toml = renderCodexConfig(compiled.config);
  assert.match(toml, /default_permissions = "bridge-test"/);
  assert.match(toml, /\["permissions"\."bridge-test"\."filesystem"\]/);
  assert.match(toml, /"\/home\/user\/\.codex\/auth\.json" = "deny"/);
  assert.doesNotMatch(toml, /sandbox_mode|sandbox_workspace_write/);
  assert.throws(() => renderCodexConfig({ invalid: null }));
});
