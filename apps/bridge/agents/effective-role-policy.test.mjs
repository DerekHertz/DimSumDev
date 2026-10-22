import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

// A missing compiler is the RED capability assertion, not a module-loader failure.
const policyModuleUrl = new URL("./effective-role-policy.mjs", import.meta.url);
const policyModule = existsSync(policyModuleUrl) ? await import(policyModuleUrl.href) : {};
function compiler() {
  assert.equal(typeof policyModule.compileEffectiveRolePolicy, "function", "shared compileEffectiveRolePolicy capability is missing");
  return policyModule.compileEffectiveRolePolicy;
}
const compileEffectiveRolePolicy = (...args) => compiler()(...args);
import { compileCeiling, buildClaudeArgs } from "./claude-adapter.mjs";

const COMMON = { worktree: "/project/.claude/worktrees/job", root: "/project", home: "/home/owner", mainGit: "/project/.git", toolchain: "/tools/node" };
const ROLES = ["orchestrator", "scout", "product", "architect", "designer", "herald", "developer", "qa", "security", "code-reviewer", "release-manager", "sre", "technical-writer"];
const CASES = [
  ...ROLES.map(role => ({ name: role, role, options: COMMON })),
  { name: "unknown", role: "unknown", options: COMMON },
  { name: "direct-runner", role: "runner", options: COMMON },
  { name: "tree-runner", role: "runner", options: { ...COMMON, tree: true } },
  { name: "readonly-manager", role: "developer", options: { ...COMMON, tree: true, treeReadOnly: true } },
  { name: "file-runner", role: "runner", options: { ...COMMON, tree: true, scopeWrites: [{ path: `${COMMON.worktree}/src/app.mjs`, directory: false }] } },
  { name: "directory-runner", role: "runner", options: { ...COMMON, tree: true, scopeWrites: [{ path: `${COMMON.worktree}/src`, directory: true }] } },
  { name: "remote", role: "developer", options: { ...COMMON, remote: true, credentials: ["~/.ssh", "~/.local/state/den/credentials"] } },
  { name: "host-grant", role: "qa", options: { ...COMMON, grants: [{ kind: "host", value: "example.com" }] } },
  { name: "ci-exception", role: "security", options: { ...COMMON, grants: [{ kind: "path", value: `${COMMON.worktree}/.github` }] } },
  { name: "ci-nonsecurity", role: "developer", options: { ...COMMON, grants: [{ kind: "path", value: `${COMMON.worktree}/.github` }] } },
  { name: "main-ci-denial", role: "security", options: { ...COMMON, grants: [{ kind: "path", value: "/project/.github" }] } },
  { name: "home-grant", role: "developer", options: { ...COMMON, grants: [{ kind: "path", value: "~/scratch" }] } },
  { name: "deduplicated-grants", role: "developer", options: { ...COMMON, grants: [{ kind: "path", value: "/reports" }, { kind: "path", value: "/reports" }] } },
  { name: "bare", role: "developer", options: {} },
  { name: "readonly-invalid-unused-worktree", role: "orchestrator", options: { worktree: "not-plain" } },
  { name: "bad-main-git", role: "developer", options: { ...COMMON, mainGit: "/bad git" } },
  { name: "credential-reopen", role: "developer", options: { ...COMMON, grants: [{ kind: "path", value: "~/.ssh/key" }] } },
  { name: "parent-worktree-reopen", role: "developer", options: { ...COMMON, grants: [{ kind: "path", value: "/project" }] } },
  { name: "readonly-grants", role: "orchestrator", options: { ...COMMON, grants: [{ kind: "path", value: "/reports" }] } },
  { name: "scope-without-admission", role: "runner", options: { ...COMMON, scopeWrites: [{ path: "/reports", directory: true }] } },
  { name: "readonly-without-tree", role: "developer", options: { ...COMMON, treeReadOnly: true } },
  { name: "readopen-credential-overlap", role: "developer", options: { ...COMMON, toolchain: "/home/owner/.ssh", remote: true } },
];

// Captured before extraction from cea52bb8e0dda352f830332b2a7d108acc97a734.
// Each digest pins JSON output bytes (including key/array order and omissions),
// or the exact exception name/message. They are never recomputed from the new authority.
const BASELINE = {
  "orchestrator": "93c26aba60b0e6c3cbb702b0457c8d9fcb199df22c868276f7c702e68bc754d7",
  "scout": "93c26aba60b0e6c3cbb702b0457c8d9fcb199df22c868276f7c702e68bc754d7",
  "product": "1fcfba0a1b3154b695fff2356d354f586c49e4ac01b6e652356cb452adc29436",
  "architect": "1fcfba0a1b3154b695fff2356d354f586c49e4ac01b6e652356cb452adc29436",
  "designer": "1fcfba0a1b3154b695fff2356d354f586c49e4ac01b6e652356cb452adc29436",
  "herald": "1fcfba0a1b3154b695fff2356d354f586c49e4ac01b6e652356cb452adc29436",
  "developer": "1fcfba0a1b3154b695fff2356d354f586c49e4ac01b6e652356cb452adc29436",
  "qa": "1fcfba0a1b3154b695fff2356d354f586c49e4ac01b6e652356cb452adc29436",
  "security": "1fcfba0a1b3154b695fff2356d354f586c49e4ac01b6e652356cb452adc29436",
  "code-reviewer": "1fcfba0a1b3154b695fff2356d354f586c49e4ac01b6e652356cb452adc29436",
  "release-manager": "1fcfba0a1b3154b695fff2356d354f586c49e4ac01b6e652356cb452adc29436",
  "sre": "1fcfba0a1b3154b695fff2356d354f586c49e4ac01b6e652356cb452adc29436",
  "technical-writer": "1fcfba0a1b3154b695fff2356d354f586c49e4ac01b6e652356cb452adc29436",
  "unknown": "7b3a021a00765f982fb2cecbf31d233100938a555627d8db9b86a19a08237286",
  "direct-runner": "7b3a021a00765f982fb2cecbf31d233100938a555627d8db9b86a19a08237286",
  "tree-runner": "97e19c266623d6a63c89ae5bf89a158207ce116ddf1e35f7f081ec70ffc66ae0",
  "readonly-manager": "de5cfc85a6369d99abe87ef1c9d39ba75b3fcb66e692990653ed839c8558e599",
  "file-runner": "388aa349c6e1799f2e37d7e1c334282b257a85443a58eec94bf8d2411d8876b5",
  "directory-runner": "1f6f894ba3ca56d1e70fa084a5c615da40c2bbfce7780d1c952d1ac2d522ddd7",
  "remote": "1c31d9f6bf47aac732d0f1ed3c48cb02e7b965cb39d488ea768e6f139bc37703",
  "host-grant": "e5317a6f7511d5ec7c8cdc4d0d0393cad607906c734775192fed89e3ae3f8f9c",
  "ci-exception": "9d7ad14e14f81b879cebaf04c2af9590ca03d2071108597fba7fb1922d9ddfd2",
  "ci-nonsecurity": "73920f3759ffaf30acdd32c6cea7dc4fb9fc246b54ca31d35f28a7415ffc9a29",
  "main-ci-denial": "34a8ce6486f80f92114ebdfacd4fa271ab51eaaa8b2240fd12fdf232a1afae60",
  "home-grant": "01e023397c105f1c5749b1613127fde078d0ae43fe757e3859a6cf000a612e98",
  "deduplicated-grants": "22890947f4fbc4836afd4c8df73a5f4ec417b8fad0bb7d4f3b2d30471e65aca0",
  "bare": "55f8f29545f392315661240a93bf2ff07c7ce88a75ecfddaea8e6a20365904f8",
  "readonly-invalid-unused-worktree": "55f8f29545f392315661240a93bf2ff07c7ce88a75ecfddaea8e6a20365904f8",
  "bad-main-git": "66601edc83c2be8a567b681254742749fe78ac53d99e091b27248ec485652341",
  "credential-reopen": "e234046a72131407008b8073a00c77d1f421818b3a86a57a7cbae2d17943ce85",
  "parent-worktree-reopen": "5e15a7d16172849e642b5656988e2e53bde303d565f0189e99d1f8519c69bfec",
  "readonly-grants": "fc61ca6ce307fcf373bccaa099d6d1ecad7b70f9f371070f95eee7493d4e6fcc",
  "scope-without-admission": "54716b41f483d3c3f7f1d2321b16c504a0d16cd7a47904910eb66036a9a8da96",
  "readonly-without-tree": "c541a51b259949ee6dec3d3b9f4a3e8e6334bb914814673c522606d1542001c9",
  "readopen-credential-overlap": "e4020c43e4f2c15ddcaeeba4c816fd8e3c83b773cdb5dafac9bd462cc49d209d"
};
function observed(fixture) {
  try { return JSON.stringify({ output: compileCeiling(fixture.role, fixture.options) }); }
  catch (error) { return JSON.stringify({ error: { name: error.name, message: error.message } }); }
}
for (const fixture of CASES) test(`Claude compatibility: ${fixture.name}`, () => {
  assert.equal(createHash("sha256").update(observed(fixture)).digest("hex"), BASELINE[fixture.name]);
});

test("the neutral authority retains read modes, governed patterns and private artifact restrictions", () => {
  const policy = compileEffectiveRolePolicy("developer", { ...COMMON, remote: true, credentials: ["~/.ssh"] });
  assert.equal(policy.version, 1);
  assert.equal(policy.filesystem.readMode, "home-limited");
  assert.deepEqual(policy.network.hosts, []);
  assert.ok(policy.filesystem.deniedRelativeWritePatterns.includes(".claude/**"));
  assert.ok(policy.filesystem.deniedAbsoluteWritePatterns.includes("/project/.git/refs/**"));
  assert.ok(policy.filesystem.deniedAbsoluteWritePatterns.includes("/project/.git/den-tree-artifacts/**"));
  assert.deepEqual(policy.filesystem.privatePaths, ["/project/.git/den-tree-artifacts"]);
  assert.deepEqual(policy.filesystem.credentials, ["~/.ssh"]);
  assert.ok(policy.filesystem.openReadPaths.includes("/project/node_modules"));
  assert.equal(compileEffectiveRolePolicy("developer", COMMON).filesystem.readMode, "ambient");
});

test("tree write scopes retain exact file versus directory meaning without a broad worktree write", () => {
  const scopes = [{ path: `${COMMON.worktree}/one.mjs`, directory: false }, { path: `${COMMON.worktree}/src`, directory: true }];
  const policy = compileEffectiveRolePolicy("runner", { ...COMMON, tree: true, scopeWrites: scopes });
  assert.equal(policy.filesystem.writeWorktree, undefined);
  assert.deepEqual(policy.filesystem.scopeWrites, scopes);
  assert.equal(policy.filesystem.treeReadRoot, COMMON.worktree);
  assert.ok(policy.execution.deniedCommands.includes("git commit"));
  assert.ok(policy.execution.deniedCommands.includes("board"));
  assert.ok(!policy.filesystem.deniedAbsoluteWritePatterns.includes(`${COMMON.worktree}/**`));
  const argv = buildClaudeArgs({ sessionId: "0b8f1c1e-5c1a-4c0e-9a55-3f2d9e7a4b10", agent: "runner", tree: true, ...compileCeiling("runner", { ...COMMON, tree: true, scopeWrites: scopes }) });
  const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
  assert.ok(settings.permissions.allow.includes(`Write(/${COMMON.worktree}/one.mjs)`));
  assert.ok(!settings.permissions.allow.includes(`Write(/${COMMON.worktree}/one.mjs/**)`));
  assert.ok(settings.permissions.allow.includes(`Write(/${COMMON.worktree}/src/**)`));
});

test("shared clauses retain every governed write pattern, command and supplied credential denial", () => {
  const governance = JSON.parse(readFileSync(new URL("./governance.json", import.meta.url), "utf8"));
  const policy = compileEffectiveRolePolicy("developer", { ...COMMON, credentials: governance.credentialPaths });
  assert.equal(policy.filesystem.writeWorktree, COMMON.worktree);
  assert.deepEqual(policy.filesystem.deniedRelativeWritePatterns, [...governance.guardrailPaths, ...governance.ciPaths]);
  assert.deepEqual(policy.execution.deniedCommands, governance.denyRun);
  assert.deepEqual(policy.filesystem.credentials, governance.credentialPaths);
  for (const denied of ["refs/**", "HEAD", "packed-refs", "index", "den-tree-artifacts/**"]) {
    assert.ok(policy.filesystem.deniedAbsoluteWritePatterns.includes(`${COMMON.mainGit}/${denied}`), denied);
  }
});

test("granted hosts trigger the shared read limit and retain every explicit read reopening", () => {
  const policy = compileEffectiveRolePolicy("developer", { ...COMMON, grants: [{ kind: "host", value: "example.com" }] });
  assert.deepEqual(policy.network.hosts, ["example.com"]);
  assert.equal(policy.filesystem.readMode, "home-limited");
  assert.deepEqual(policy.filesystem.openReadPaths, ["/project/node_modules", COMMON.mainGit, COMMON.toolchain, "/home/owner/.gitconfig", "/home/owner/.cache/ms-playwright"]);
});

test("CI exception belongs only to security in its own writable worktree", () => {
  const ownGrant = [{ kind: "path", value: `${COMMON.worktree}/.github` }];
  const security = compileEffectiveRolePolicy("security", { ...COMMON, grants: ownGrant });
  const developer = compileEffectiveRolePolicy("developer", { ...COMMON, grants: ownGrant });
  assert.ok(!security.filesystem.deniedRelativeWritePatterns.includes(".github/workflows/**"));
  assert.ok(developer.filesystem.deniedRelativeWritePatterns.includes(".github/workflows/**"));
  assert.ok(security.filesystem.deniedRelativeWritePatterns.includes(".claude/**"));
  const mainGrant = compileEffectiveRolePolicy("security", { ...COMMON, grants: [{ kind: "path", value: "/project/.github" }] });
  assert.ok(mainGrant.filesystem.deniedAbsoluteWritePatterns.includes("/project/.github/workflows/**"));
  assert.ok(mainGrant.filesystem.deniedRelativeWritePatterns.includes(".github/workflows/**"));
});

test("read-only trees expose their read root while denying worktree writes and child publication commands", () => {
  for (const [role, options] of [["runner", { tree: true }], ["developer", { tree: true, treeReadOnly: true }]]) {
    const policy = compileEffectiveRolePolicy(role, { ...COMMON, ...options });
    assert.equal(policy.filesystem.writeWorktree, undefined);
    assert.equal(policy.filesystem.treeReadRoot, COMMON.worktree);
    assert.ok(policy.filesystem.deniedAbsoluteWritePatterns.includes(`${COMMON.worktree}/**`));
    assert.ok(policy.execution.deniedCommands.includes("git commit"));
    assert.ok(policy.execution.deniedCommands.includes("board"));
  }
});

test("unknown roles and unadmitted direct runners receive no effective launch policy", () => {
  assert.equal(compileEffectiveRolePolicy("unknown", COMMON), null);
  assert.equal(compileEffectiveRolePolicy("runner", COMMON), null);
});

test("shared policy fails closed for unsafe paths, credential reopening and unadmitted scopes", () => {
  const compile = compiler();
  const invalid = [
    ["developer", { ...COMMON, mainGit: "/bad git" }],
    ["developer", { ...COMMON, root: "/project/../outside" }],
    ["developer", { ...COMMON, worktree: "/project/*" }],
    ["developer", { ...COMMON, credentials: ["~/unlisted-secret"] }],
    ["developer", { ...COMMON, grants: [{ kind: "path", value: "~/.ssh/key" }] }],
    ["developer", { ...COMMON, grants: [{ kind: "path", value: "/project" }] }],
    ["developer", { ...COMMON, remote: true, toolchain: "/home/owner/.ssh" }],
    ["orchestrator", { ...COMMON, grants: [{ kind: "path", value: "/reports" }] }],
    ["runner", { ...COMMON, scopeWrites: [{ path: "/reports", directory: true }] }],
    ["developer", { ...COMMON, treeReadOnly: true }],
    ["runner", { ...COMMON, tree: true, scopeWrites: [{ path: `${COMMON.worktree}/../escape`, directory: false }] }],
    ["runner", { ...COMMON, tree: true, scopeWrites: [{ path: `${COMMON.worktree}/one.mjs`, directory: "false" }] }],
  ];
  for (const [role, options] of invalid) assert.throws(() => compile(role, options), TypeError, `${role}: ${JSON.stringify(options)}`);
});
