// agent-os/04: the production runtime passes the wall for a role with a ceiling, and only for one.
// Same harness as claude-process.test.mjs: a stub script behind DEN_CLAUDE_BIN records the argv it was started with.
// Pinned: spawn({ role, cwd, ... }) treats cwd as the worktree; for developer, qa and security the child's inline
// settings carry the sandbox block with an empty host list (ADR 0021 amendment 1) and, for the roles that write, Write and
// Edit allow rules for cwd. A cwd that cannot be written as a plain rule keeps the wall and drops the write rules (the ticket
// file precedent: the request stays). Roles with no ceiling start exactly as before.
// The expected settings are hand-written literals; only the "no ceiling" case compares against buildClaudeArgs itself.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { until } from "./host-test-helpers.mjs";
import { makeStub, alive } from "./claude-stub.mjs";
import { buildClaudeArgs } from "./claude-adapter.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";
import { unconfinedLauncher } from "./launcher-test-helpers.mjs";

const SESSION = "0b8f1c1e-5c1a-4c0e-9a55-3f2d9e7a4b10";
const DENY = ["Write(.claude/**)", "Edit(.claude/**)", "Bash(git push:*)", "Bash(gh pr create:*)"];
const WALL_NO_HOSTS = {
  enabled: true,
  failIfUnavailable: true,
  allowUnsandboxedCommands: false,
  autoAllowBashIfSandboxed: true,
  network: { allowedDomains: [], strictAllowlist: true },
};

const noFs = (sandbox) => ({ ...sandbox, filesystem: undefined });
const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function launch(role, { dirName = "den-wall-cwd-", extra = {} } = {}) {
  const stub = await makeStub({ mode: "hang" });
  const cwd = await mkdtemp(path.join(tmpdir(), dirName));
  const runtime = createClaudeRuntime({ controlRoot: "/", launcher: unconfinedLauncher(), env: { PATH: process.env.PATH, HOME: process.env.HOME, DEN_CLAUDE_BIN: stub.bin } });
  const proc = await runtime.spawn({ role, cwd, prompt: "do the thing", sessionId: SESSION, ...extra });
  cleanups.push(async () => {
    try {
      proc.signal("SIGKILL");
    } catch {}
    const gc = await stub.grandchildPid();
    if (gc && alive(gc)) process.kill(gc, "SIGKILL");
  });
  await until(async () => (await stub.start()) !== undefined, { what: "the child to start" });
  const argv = (await stub.start()).argv;
  return { cwd, argv, settings: JSON.parse(argv[argv.indexOf("--settings") + 1]) };
}

describe("the runtime passes the wall for a role with a ceiling", () => {
  for (const role of ["developer", "qa", "security"]) {
    test(`${role}: the sandbox has no hosts, Write and Edit are allowed in cwd, and the deny rules stay`, async () => {
      const { cwd, settings } = await launch(role);
      assert.deepEqual(noFs(settings.sandbox), noFs(WALL_NO_HOSTS)); // agent-os/02: sandbox.filesystem may now ride along
      assert.deepEqual([...settings.permissions.allow].sort(), ["Bash", `Edit(/${cwd}/**)`, `Write(/${cwd}/**)`]);
      for (const rule of DENY) assert.ok(settings.permissions.deny.includes(rule), `deny keeps ${rule}`); // agent-os/02: governance denies join the four
    });
  }

  test("chief-of-staff: the sandbox has no hosts and nothing may be written", async () => {
    const { settings } = await launch("chief-of-staff");
    assert.deepEqual(noFs(settings.sandbox), noFs(WALL_NO_HOSTS)); // agent-os/02: sandbox.filesystem may now ride along
    assert.deepEqual(settings.permissions.allow, ["Bash"]);
    for (const rule of DENY) assert.ok(settings.permissions.deny.includes(rule), `deny keeps ${rule}`); // agent-os/02: governance denies join the four
  });

  test("the ticket file rule is kept beside the worktree rules", async () => {
    const ticketFile = "/repo/.scratch/den/issues/01-developer.md";
    const { cwd, settings } = await launch("developer", { extra: { ticketFile } });
    assert.deepEqual([...settings.permissions.allow].sort(), ["Bash", `Edit(/${cwd}/**)`, `Read(/${ticketFile})`, `Write(/${cwd}/**)`]);
    assert.deepEqual(noFs(settings.sandbox), noFs(WALL_NO_HOSTS)); // agent-os/02: sandbox.filesystem may now ride along
  });

  test("a cwd that cannot be written as a plain rule keeps the wall and drops the write rules", async () => {
    const { settings } = await launch("developer", { dirName: "den wall cwd " });
    assert.deepEqual(noFs(settings.sandbox), noFs(WALL_NO_HOSTS)); // agent-os/02: sandbox.filesystem may now ride along
    assert.deepEqual(settings.permissions.allow, ["Bash"], "the Write request stays a request");
    for (const rule of DENY) assert.ok(settings.permissions.deny.includes(rule), `deny keeps ${rule}`); // agent-os/02: governance denies join the four
  });
});

describe("every role starts behind the wall (den-mvp outcome 1)", () => {
  for (const role of ["architect", "designer", "product", "technical-writer", "orchestrator"]) {
    test(`${role}: the sandbox is on, strict, with no host`, async () => {
      const { settings } = await launch(role);
      assert.equal(settings.sandbox?.enabled, true);
      assert.equal(settings.sandbox.failIfUnavailable, true);
      assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
      assert.deepEqual(settings.sandbox.network, { allowedDomains: [], strictAllowlist: true });
    });
  }
});

// den-mvp outcome 4: the production runtime hands the child the catalog's connections for the role, and only those.
describe("the runtime passes a role's connections", () => {
  test("they are the one --mcp-config value; the wall and the deny rules are as before", async () => {
    const connections = [{ name: "docs", url: "https://docs.example.com/mcp" }];
    const { argv, settings } = await launch("developer", { extra: { connections } });
    assert.ok(argv.includes("--strict-mcp-config"));
    assert.deepEqual(JSON.parse(argv[argv.indexOf("--mcp-config") + 1]), { mcpServers: { docs: { type: "http", url: "https://docs.example.com/mcp" } } });
    assert.deepEqual(noFs(settings.sandbox), noFs(WALL_NO_HOSTS));
    for (const rule of DENY) assert.ok(settings.permissions.deny.includes(rule));
  });

  // The kernel review (2026-10-18): a remote connection is a way out, so it brings the read limit with the toolchain reopened.
  test("a remote connection brings the read limit; a script connection alone does not", async () => {
    const remote = await launch("developer", { extra: { connections: [{ name: "docs", url: "https://docs.example.com/mcp" }] } });
    assert.deepEqual(remote.settings.sandbox.filesystem.denyRead, ["~/"]);
    for (const p of [remote.cwd, path.dirname(path.dirname(process.execPath))]) assert.ok(remote.settings.sandbox.filesystem.allowRead.includes(p), p);
    const script = await launch("developer", { extra: { connections: [{ name: "board", script: "/opt/den/board-tools.mjs" }] } });
    assert.notDeepEqual(script.settings.sandbox.filesystem?.denyRead, ["~/"]);
  });

  test("none, or an empty list: no --mcp-config at all", async () => {
    for (const extra of [{}, { connections: [] }]) {
      const { argv } = await launch("developer", { extra });
      assert.ok(argv.includes("--strict-mcp-config") && !argv.includes("--mcp-config"));
    }
  });

  test("a connection the adapter cannot write refuses the spawn: nothing starts with a looser one", async () => {
    const stub = await makeStub({ mode: "hang" });
    const cwd = await mkdtemp(path.join(tmpdir(), "den-wall-cwd-"));
    const runtime = createClaudeRuntime({ controlRoot: "/", launcher: unconfinedLauncher(), env: { PATH: process.env.PATH, HOME: process.env.HOME, DEN_CLAUDE_BIN: stub.bin } });
    await assert.rejects(runtime.spawn({ role: "developer", cwd, prompt: "x", sessionId: SESSION, connections: [{ name: "docs", command: "sh" }] }), TypeError);
    assert.equal(await stub.start(), undefined);
  });
});
