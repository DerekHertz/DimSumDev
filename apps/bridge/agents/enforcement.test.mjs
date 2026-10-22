// den-mvp outcome 1: what the host and the adapter do around the enforced launcher (resource-group.test.mjs has the launcher).
//   host      a failed enforcement preflight refuses the run before a worktree or a ticket exists; a refusal at the launch
//             itself reads the same; a run that hits a hard limit ends failed with the limit named
//   adapter   credential stores are closed to reads and writes for every role; a web fetch to a local, private or numeric
//             destination is refused without becoming a question; a host the wall allows may be fetched unasked
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { makeBridge, until, DISPATCH_REF } from "./host-test-helpers.mjs";
import { CREDENTIAL_PATHS, buildClaudeArgs, compileCeiling, webRefusal } from "./claude-adapter.mjs";
import { EnforcementError } from "./resource-group.mjs";
import { DEN_FEATURE, ROLES } from "./policy.mjs";

let t;
afterEach(async () => {
  await t?.close();
  t = null;
});
const names = async (dir) => (await readdir(dir).catch(() => [])).sort();
const worktrees = (root) => names(path.join(root, ".claude", "worktrees"));
const denTickets = (root) => names(path.join(root, ".scratch", DEN_FEATURE, "issues"));

describe("the host refuses a run the kernel cannot confine", () => {
  const REASON = "the user service manager's bus is not reachable at /run/user/1000/bus";

  test("a failed preflight is a 503 with the reason: no spawn, no worktree, no ticket, no agent", async () => {
    t = await makeBridge();
    t.fake.preflight = async () => ({ ok: false, reason: REASON });
    const res = await t.dispatch("developer");
    assert.equal(res.status, 503, res.text);
    assert.equal(res.body.error, `the run was refused: ${REASON}`);
    const task = await t.post("/tasks", { role: "scout", text: "what is the package name?" });
    assert.equal(task.status, 503, task.text);
    assert.equal(task.body.error, `the run was refused: ${REASON}`);
    assert.equal(t.fake.spawns.length, 0);
    assert.deepEqual(await worktrees(t.fx.root), []);
    assert.deepEqual(await denTickets(t.fx.root), []);
    assert.deepEqual((await t.state()).agents, []);
  });

  test("a preflight that throws, or gives no reason, still refuses", async () => {
    t = await makeBridge();
    t.fake.preflight = async () => {
      throw new Error("boom");
    };
    assert.equal((await t.dispatch("architect")).status, 503);
    t.fake.preflight = async () => ({ ok: false });
    const res = await t.dispatch("architect");
    assert.equal(res.status, 503);
    assert.match(res.body.error, /hardware limits cannot be enforced/);
    assert.equal(t.fake.spawns.length, 0);
  });

  test("once the host can enforce again the same request starts: the refusal is not remembered", async () => {
    t = await makeBridge();
    let ok = false;
    t.fake.preflight = async () => (ok ? { ok: true } : { ok: false, reason: REASON });
    assert.equal((await t.dispatch("architect")).status, 503);
    ok = true;
    assert.equal((await t.dispatch("architect")).status, 201);
  });

  test("a refusal at the launch itself reads the same, frees the slot and leaves no worktree", async () => {
    t = await makeBridge();
    const spawn = t.fake.spawn;
    t.fake.spawn = async () => {
      throw new EnforcementError("den-run-x.scope has memory.max = max, not 2147483648; the limits are not applied");
    };
    const res = await t.dispatch("developer");
    assert.equal(res.status, 503, res.text);
    assert.match(res.body.error, /^the run was refused: den-run-x\.scope has memory\.max = max/);
    assert.deepEqual(await worktrees(t.fx.root), []);
    t.fake.spawn = spawn;
    assert.equal((await t.dispatch("developer")).status, 201, "the failed attempt released its reservation");
  });

  test("the reason is cleaned like any other text the page shows", async () => {
    t = await makeBridge();
    t.fake.preflight = async () => ({ ok: false, reason: `bad\u0000‮thing ${"x".repeat(500)}` });
    const res = await t.dispatch("architect");
    assert.equal(res.status, 503);
    assert.ok(!/[\u0000‮]/.test(res.body.error));
    assert.ok(res.body.error.length < 340);
  });
});

describe("a run that hits a hard limit fails and says which", () => {
  for (const resource of ["memory", "processes", "storage"]) {
    test(`${resource}: the agent ends failed with reason "resource-limit: ${resource}", even after it reported done`, async () => {
      t = await makeBridge();
      const { agent } = (await t.dispatch("developer")).body;
      const rec = t.fake.spawns[0];
      rec.emit({ type: "resource-limit", resource });
      rec.exit({ code: null, signal: "SIGKILL" });
      await until(async () => (await t.agent(agent.id))?.state === "failed", { what: "the agent to fail" });
      assert.equal((await t.agent(agent.id)).reason, `resource-limit: ${resource}`);
      assert.equal(t.fake.spawns.length, 1, "nothing restarted it");
    });
  }

  test("an unknown resource name from the runtime is ignored", async () => {
    t = await makeBridge();
    const { agent } = (await t.dispatch("developer")).body;
    t.fake.spawns[0].emit({ type: "resource-limit", resource: "<script>" });
    t.fake.spawns[0].emit({ type: "done", ok: true });
    await until(async () => (await t.agent(agent.id))?.state === "done", { what: "the agent to finish" });
    assert.equal((await t.agent(agent.id)).reason, null);
  });

  test("a stop by the user stays a stop: the limit does not relabel it", async () => {
    t = await makeBridge();
    const { agent } = (await t.dispatch("developer")).body;
    assert.equal((await t.post(`/agents/${agent.id}/stop`)).status, 202);
    t.fake.spawns[0].emit({ type: "resource-limit", resource: "memory" });
    await until(async () => (await t.agent(agent.id))?.state === "terminated", { what: "the agent to be terminated" });
    assert.equal((await t.agent(agent.id)).reason, "stopped-by-user");
  });
});

// ---- adapter ----------------------------------------------------------------------------------
const SID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const WT = "/home/u/den/.claude/worktrees/den-x";
const settingsOf = (argv) => JSON.parse(argv[argv.indexOf("--settings") + 1]);
const settingsFor = (role, options = {}) => settingsOf(buildClaudeArgs({ sessionId: SID, agent: role, ...compileCeiling(role, { worktree: WT, ...options }) }));

describe("credential stores are closed to every role", () => {
  test("governance.json names the stores: ssh, gpg, cloud, git host and model credentials among them", () => {
    for (const p of ["~/.ssh", "~/.gnupg", "~/.aws", "~/.config/gh", "~/.git-credentials", "~/.netrc", "~/.claude/.credentials.json"]) assert.ok(CREDENTIAL_PATHS.includes(p), p);
    for (const p of CREDENTIAL_PATHS) assert.match(p, /^~(?:\/[A-Za-z0-9._@+-]+)+$/);
  });

  // den-mvp/88 security H1: the router's two secrets live in the same folder as projects.json (ADR 0021), for the same reason.
  test("the router's service token and ntfy topic URL are credential stores like projects.json", () => {
    for (const p of ["~/.local/state/den/projects.json", "~/.local/state/den/service-token", "~/.local/state/den/ntfy-url"]) assert.ok(CREDENTIAL_PATHS.includes(p), p);
  });

  test("each store given is a Read and Edit deny for the file tools and a denyRead for the shell, for all nine roles", () => {
    const credentials = ["~/.ssh", "~/.claude/.credentials.json"];
    for (const role of ROLES) {
      const settings = settingsFor(role, { credentials });
      for (const p of credentials) for (const rule of [`Read(${p})`, `Read(${p}/**)`, `Edit(${p})`, `Edit(${p}/**)`]) assert.ok(settings.permissions.deny.includes(rule), `${role}: ${rule}`);
      assert.deepEqual(settings.sandbox.filesystem.denyRead, ["~/"], `${role}: hardening/01: the whole home is closed to the shell, which covers every store`);
    }
  });

  test("a granted host keeps the whole-home read limit, which already covers them", () => {
    const settings = settingsFor("developer", { credentials: ["~/.ssh"], grants: [{ kind: "host", value: "registry.npmjs.org" }] });
    assert.deepEqual(settings.sandbox.filesystem.denyRead, ["~/"]);
    assert.ok(settings.permissions.deny.includes("Read(~/.ssh/**)"));
  });

  test("only paths from governance.json are accepted: anything else is a TypeError, not a rule", () => {
    for (const bad of [["~/.ssh/../.."], ["/etc/shadow"], ["~/x)"], "~/.ssh", [null]]) assert.throws(() => compileCeiling("developer", { worktree: WT, credentials: bad }), TypeError, JSON.stringify(bad));
    assert.throws(() => buildClaudeArgs({ sessionId: SID, agent: "developer", credentials: ["~/.ssh"] }), TypeError, "credentials need the wall");
  });
});

describe("a grant cannot reopen a credential store", () => {
  const TOUCHING = ["~/.aws", "~/.aws/credentials", "~/.codex", "~/.kube/config", "~/.gnupg", "~/.docker", "~/.netrc", "~/.npmrc", "~/.claude.json", "~/.AWS", "~/.local/state/den/projects.json", "~/.local/state/den/service-token", "~/.local/state/den/ntfy-url", "~/.local/state/den"];

  test("the ceiling compiler refuses a path grant on, under or above a store, in either form", () => {
    for (const value of [...TOUCHING, "/home/u/.aws", "/home/u/.codex", "/home/u/.kube/config", "/home/u/.local/state/den/projects.json", "/home/u/.local/state/den/service-token", "/home/u/.local/state/den/ntfy-url"]) {
      assert.throws(() => compileCeiling("developer", { worktree: WT, home: "/home/u", root: "/home/u/den", grants: [{ kind: "path", value }] }), /may not reach a credential store/, value);
    }
    for (const value of ["~/projects/data", "/home/u/projects/data", "/srv/data", "~/.awsome"]) {
      assert.doesNotThrow(() => compileCeiling("developer", { worktree: WT, home: "/home/u", root: "/home/u/den", grants: [{ kind: "path", value }] }), value);
    }
  });

  test("the host refuses such a task with a 400 that does not echo the path, and starts nothing", async () => {
    t = await makeBridge();
    for (const value of TOUCHING) {
      const res = await t.post("/tasks", { role: "developer", text: "list the buckets", grants: [{ kind: "path", value }] });
      assert.equal(res.status, 400, `${value}: ${res.text}`);
      assert.match(res.body.error, /credential store|home configuration path/, value);
      assert.ok(!res.body.error.includes(value.slice(2)), "the reason does not echo the grant");
    }
    assert.equal(t.fake.spawns.length, 0);
    assert.deepEqual(await denTickets(t.fx.root), []);
  });
});

describe("the CLI's own web tool", () => {
  test("a fetch to a local, private or numeric destination is refused outright", () => {
    for (const url of [
      "http://localhost:4317/state", "http://127.0.0.1:4317/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/", "http://192.168.1.1/",
      "http://2130706433/", "http://0x7f.1/", "http://printer.local/", "http://db.internal/", "http://intranet/", "https://user:pw@example.com/", "file:///etc/passwd", "ftp://example.com/", "not a url", "",
    ]) {
      assert.match(webRefusal("WebFetch", { url }) ?? "", /local, private or numeric/, url);
    }
    assert.match(webRefusal("WebFetch", {}) ?? "", /local, private or numeric/);
    assert.match(webRefusal("WebFetch", null) ?? "", /local, private or numeric/);
  });

  test("a public host name goes on to the user, and other tools are not this check's business", () => {
    for (const url of ["https://example.com/a?b=c", "http://docs.python.org/3/", "https://registry.npmjs.org./left-pad"]) assert.equal(webRefusal("WebFetch", { url }), null, url);
    assert.equal(webRefusal("Read", { file_path: "/etc/passwd" }), null);
    assert.equal(webRefusal("WebSearch", { query: "localhost" }), null);
  });

  test("a host the wall allows is fetched without a question; no role has one by default", () => {
    for (const role of ROLES) assert.ok(!(settingsFor(role).permissions.allow ?? []).some((rule) => rule.startsWith("WebFetch")), role);
    const granted = settingsFor("developer", { grants: [{ kind: "host", value: "registry.npmjs.org" }] });
    assert.ok(granted.permissions.allow.includes("WebFetch(domain:registry.npmjs.org)"));
    assert.deepEqual(granted.sandbox.network.allowedDomains, ["registry.npmjs.org"]);
  });
});

describe("the dispatch ref is still checked", () => {
  test("a developer cannot be started on a ticket that is not in the frontier", async () => {
    t = await makeBridge();
    assert.equal((await t.dispatch("developer")).status, 201);
    t.fake.spawns[0].exit();
    await until(async () => (await t.state()).agents.every((a) => a.state !== "working"), { what: "the agent to end" });
    const snap = await t.state();
    const blocked = snap.tickets.find((x) => !snap.frontier.includes(x.ref));
    assert.ok(blocked, "the fixture board has a ticket outside the frontier");
    const res = await t.dispatch("developer", blocked.ref);
    assert.equal(res.status, 409, res.text);
    assert.equal(t.fake.spawns.length, 1);
    assert.notEqual(blocked.ref, DISPATCH_REF);
  });
});

// The kernel review (2026-10-18): a remote connection is a way out of the wall, like a host. A run with either gets the read
// limit, which closes the home folder to the shell and reopens only what the work needs: the project, the Node install, git's
// own config and the Playwright browsers. Before this, a remote connection with no host left all of home readable but the
// credential stores, and a host grant closed the Node install and ~/.gitconfig that npm test and git commit need.
describe("any way out brings the read limit, with the project and the toolchain reopened", () => {
  const HOME = "/home/u";
  const ROOT = "/home/u/den";
  const NODE = "/home/u/.nvm/versions/node/v22.0.0";
  const MAIN_GIT = "/home/u/den/.git";
  const OPEN = [WT, "/home/u/den/node_modules", MAIN_GIT, NODE, "/home/u/.gitconfig", "/home/u/.cache/ms-playwright"];
  const limited = (options) => settingsFor("developer", { root: ROOT, mainGit: MAIN_GIT, home: HOME, toolchain: NODE, credentials: ["~/.ssh"], ...options });

  test("a remote connection with no host closes home to the shell and reopens the worktree, the project's packages and .git, and the toolchain", () => {
    const s = limited({ remote: true });
    assert.deepEqual(s.sandbox.filesystem.denyRead, ["~/"]);
    assert.deepEqual([...s.sandbox.filesystem.allowRead].sort(), [...OPEN].sort());
    assert.equal(s.permissions.blockReadsOutsideWorkingDirectories, true);
    assert.deepEqual(s.sandbox.network.allowedDomains, [], "a connection opens no host to the shell");
  });

  // Live probe 2026-10-18: reopening the project root, which holds the worktree, left the worktree read-only and every command failed.
  test("the project root itself is never reopened", () => {
    assert.equal(limited({ remote: true }).sandbox.filesystem.allowRead.includes(ROOT), false);
  });

  test("a granted host reopens the same paths", () => {
    const s = limited({ grants: [{ kind: "host", value: "registry.npmjs.org" }] });
    assert.deepEqual([...s.sandbox.filesystem.allowRead].sort(), [...OPEN].sort());
  });

  // hardening/01 addendum (2026-10-22): the limit no longer waits for a way out. Every agent with a worktree gets it.
  test("with no way out, an agent with a worktree gets the same read limit and reopening", () => {
    const s = limited({});
    assert.deepEqual(s.sandbox.filesystem.denyRead, ["~/"]);
    assert.deepEqual([...s.sandbox.filesystem.allowRead].sort(), [...OPEN, "/home/u/.npm"].sort());
    assert.equal(s.permissions.blockReadsOutsideWorkingDirectories, true);
  });

  test("a role that cannot write gets the limit too", () => {
    const s = settingsFor("scout", { root: ROOT, mainGit: MAIN_GIT, home: HOME, toolchain: NODE, remote: true });
    assert.deepEqual(s.sandbox.filesystem.denyRead, ["~/"]);
    assert.deepEqual([...s.sandbox.filesystem.allowRead].sort(), OPEN.filter((p) => p !== WT).sort());
  });

  test("a reopened path that would reach a credential store refuses the run", () => {
    assert.throws(() => compileCeiling("developer", { worktree: WT, root: ROOT, home: HOME, toolchain: "/home/u/.local/state/den", remote: true }), TypeError, "a toolchain on the den's state");
  });

  test("toolchain and remote take only their plain shapes", () => {
    for (const bad of ["relative/node", "/home/u/../x", "/a b", 7]) assert.throws(() => compileCeiling("developer", { worktree: WT, toolchain: bad }), TypeError, String(bad));
    assert.throws(() => compileCeiling("developer", { worktree: WT, remote: "yes" }), TypeError);
    assert.throws(() => buildClaudeArgs({ sessionId: SID, agent: "developer", wall: { hosts: [] }, readOpen: ["/x"] }), TypeError, "readOpen needs the read limit");
  });
});
