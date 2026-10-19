// den-v1 loop S0 (ADR 0016 decision 3, amendment 7): every bridge-started agent runs in its own git worktree, on its
// own branch, never in the repo root. Over HTTP through startBridge: the real Claude runtime with the stub as the
// binary where the child's cwd matters, the fake runtime for the rest.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { startBridge } from "../server.mjs";
import { makeStateFixture } from "../bridge-fixture.mjs";
import { CODE, login, authed, send } from "../bridge-auth-helpers.mjs";
import { DISPATCH_REF, NO_GATE_REF, makeBridge, seedSessions, until } from "./host-test-helpers.mjs";
import { buildClaudeArgs } from "./claude-adapter.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";
import { makeStub, alive } from "./claude-stub.mjs";
import { unconfinedLauncher } from "./launcher-test-helpers.mjs";

const run = promisify(execFile);
const git = async (root, ...args) => (await run("git", ["-C", root, ...args])).stdout;
const exists = (p) => access(p).then(() => true, () => false);
const shortOf = (id) => id.slice(2, 10);
const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

// A bridge over the real Claude runtime with the stub as the binary, in a git fixture.
async function boot(stubOpts = {}) {
  const fx = await makeStateFixture({ git: true });
  const outside = path.join(fx.root, "outside.txt");
  const stub = await makeStub({ ...stubOpts, writePath: outside });
  const runtime = createClaudeRuntime({ launcher: unconfinedLauncher(), env: { PATH: process.env.PATH, HOME: process.env.HOME, DEN_CLAUDE_BIN: stub.bin } });
  const bridge = await startBridge({ root: fx.root, port: 0, auth: { launchCode: CODE }, runtime, policy: { killGraceMs: 150 } });
  const headers = authed(bridge, await login(bridge));
  cleanups.push(async () => {
    const start = await stub.start();
    if (start?.pid && alive(start.pid)) process.kill(start.pid, "SIGKILL");
    await bridge.close();
    await fx.cleanup();
  });
  return {
    fx, stub, outside,
    post: (p, body = {}) => send(bridge, { method: "POST", path: p, body, headers }),
    get: (p) => send(bridge, { path: p, headers }),
    state: async () => (await send(bridge, { path: "/state" })).body,
    sessions: async () =>
      (await readFile(path.join(fx.root, ".scratch", "_run", "sessions.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}
async function fake(options) {
  const t = await makeBridge(options);
  cleanups.push(() => t.close());
  return t;
}

describe("the child's working directory", () => {
  test("is a new detached worktree under .claude/worktrees at the root's HEAD (branch name recorded, no branch yet), never the root", async () => {
    const t = await boot({ mode: "hang" });
    const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
    assert.equal(res.status, 201, res.text);
    const { id, sessionId, worktree, branch } = res.body.agent;
    assert.equal(worktree, `.claude/worktrees/den-fx-02-ready-p0-${shortOf(id)}`);
    assert.equal(branch, `den/${DISPATCH_REF}-${shortOf(id)}`);

    const start = await until(() => t.stub.start(), { what: "the stub to start" });
    const root = await realpath(t.fx.root);
    assert.equal(start.cwd, await realpath(path.join(t.fx.root, worktree)), "the child's cwd is the worktree");
    assert.notEqual(start.cwd, root, "the child never runs in the repo root");
    const listed = await git(t.fx.root, "worktree", "list", "--porcelain");
    // agent-os/09 (ADR 0021 Amendment 2): detached while the agent runs; the bridge makes the branch at the final commit.
    assert.match(listed, new RegExp(`worktree ${start.cwd}\\nHEAD [0-9a-f]+\\ndetached\\n`));
    assert.equal((await git(t.fx.root, "branch", "--list", "den/*")).trim(), "", "no branch exists while the agent runs");
    assert.equal((await git(start.cwd, "rev-parse", "HEAD")).trim(), (await git(t.fx.root, "rev-parse", "HEAD")).trim());

    // The argv is still the fixed template: the worktree reaches the child as its cwd and nothing else. The one
    // path in it is the agent's own ticket file in the main checkout, inside the inline settings (amendment 13).
    const ticketFile = path.join(t.fx.root, ".scratch", "fx", "issues", "02-ready-p0.md");
    // den-mvp outcome 1: an architect starts behind the wall and may write in its own worktree, so the settings name it.
    const at = start.argv.indexOf("--settings") + 1;
    const settings = JSON.parse(start.argv[at]);
    assert.deepEqual(start.argv.filter((_, i) => i !== at), buildClaudeArgs({ sessionId, agent: "architect", ticketFile }).filter((_, i) => i !== at));
    assert.ok(settings.permissions.allow.includes(`Read(/${ticketFile})`));
    assert.equal(settings.sandbox?.enabled, true);
    assert.ok(!start.argv.some((a, i) => i !== at && a.includes(worktree)), "the worktree path is in the settings and nowhere else in argv");
    assert.deepEqual(start.argv.filter((a) => a.includes(root)), [start.argv.at(-1)], "the root appears only in the settings value");
    assert.deepEqual(JSON.parse(start.argv.at(-1)).permissions.allow, ["Bash", `Read(/${ticketFile})`, `Write(/${start.cwd}/**)`, `Edit(/${start.cwd}/**)`]);

    const spawn = (await t.sessions()).find((l) => l.event === "spawn" && l.agentId === id);
    assert.equal(spawn.worktree, worktree);
    assert.equal(spawn.branch, branch);
  });

  test("a write outside the worktree is held as an approval and never performed without an allow", async () => {
    const t = await boot({ mode: "write" });
    const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
    assert.equal(res.status, 201, res.text);
    const { id, worktree } = res.body.agent;
    const approval = await until(async () => (await t.state()).approvals?.find((a) => a.agentId === id && a.state === "pending"), { what: "a pending approval" });
    assert.equal(approval.tool, "Write");

    const full = await t.get(`/approvals/${approval.id}`);
    const cwd = await realpath(path.join(t.fx.root, worktree));
    assert.ok(path.relative(cwd, full.body.input.file_path).startsWith(".."), "the requested path is outside the agent's worktree");
    assert.equal((await t.state()).agents.find((a) => a.id === id).state, "waiting_on_user");
    assert.equal(await exists(t.outside), false, "nothing is written while the request is held");

    const denied = await t.post(`/approvals/${approval.id}`, { decision: "deny" });
    assert.equal(denied.status, 200, denied.text);
    const answer = await until(async () => (await t.stub.stdinLines()).find((l) => l.type === "control_response"), { what: "the answer on the child's stdin" });
    assert.equal(answer.response.response.behavior, "deny");
    await until(async () => (await t.state()).agents.find((a) => a.id === id)?.state === "done", { what: "the agent to end" });
    assert.equal(await exists(t.outside), false, "a denied write leaves no file");
  });
});

describe("one worktree per agent", () => {
  test("two agents get two worktrees and two branches", async () => {
    const t = await fake();
    const a = await t.dispatch("architect");
    const b = await t.bridge.host.start({ ref: NO_GATE_REF, role: "scout" });
    assert.equal(a.status, 201, a.text);
    assert.equal(b.status, 201, b.error);
    const [first, second] = t.fake.spawns.map((s) => s.args.cwd);
    const root = await realpath(t.fx.root);
    assert.notEqual(first, second);
    for (const cwd of [first, second]) {
      assert.ok(cwd.startsWith(path.join(root, ".claude", "worktrees") + path.sep), `${cwd} is under .claude/worktrees`);
      assert.ok(await exists(path.join(cwd, ".git")), `${cwd} is a worktree`);
    }
    assert.notEqual(a.body.agent.branch, b.agent.branch);
  });

  test("the worktree is kept after the run, and the same ticket's next agent gets a fresh one", async () => {
    const t = await fake();
    const a = await t.dispatch("architect");
    t.fake.spawns[0].exit();
    await until(async () => (await t.agent(a.body.agent.id))?.state === "done", { what: "the first agent to end" });
    const b = await t.dispatch("architect");
    assert.equal(b.status, 201, b.text);
    const [first, second] = t.fake.spawns.map((s) => s.args.cwd);
    assert.notEqual(first, second);
    assert.ok(await exists(first), "the first worktree is still there");
    assert.equal((await t.agent(a.body.agent.id)).worktree, a.body.agent.worktree, "the ended agent still names its worktree");
  });
});

describe("the bridge creates the agent's branch at its final commit (agent-os/09)", () => {
  test("when the agent ends, den/<ref>-<short> points at the worktree's last commit and main HEAD has not moved", async () => {
    const t = await fake();
    const base = (await git(t.fx.root, "rev-parse", "HEAD")).trim();
    const a = await t.dispatch("architect");
    assert.equal(a.status, 201, a.text);
    const { id, branch } = a.body.agent;
    const cwd = t.fake.spawns[0].args.cwd;
    await git(cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-m", "agent work");
    const final = (await git(cwd, "rev-parse", "HEAD")).trim();
    assert.equal((await git(t.fx.root, "branch", "--list", "den/*")).trim(), "", "no branch while the agent runs");

    t.fake.spawns[0].exit();
    await until(async () => (await t.agent(id))?.state === "done", { what: "the agent to end" });
    await until(async () => (await git(t.fx.root, "branch", "--list", branch)).trim() !== "", { what: "the bridge to create the branch" });
    assert.equal((await git(t.fx.root, "rev-parse", `refs/heads/${branch}`)).trim(), final);
    assert.equal((await git(t.fx.root, "rev-parse", "HEAD")).trim(), base, "the main checkout's HEAD did not move");
  });
});

describe("failures start nothing and leave nothing", () => {
  test("no worktree, no agent: a root that is not a git repository answers 500 and spawns nothing", async () => {
    const t = await fake({ noGit: true });
    const res = await t.dispatch("architect");
    assert.equal(res.status, 500, res.text);
    assert.equal(t.fake.spawns.length, 0, "the runtime was never asked to spawn");
    assert.deepEqual((await t.state()).agents, []);
    assert.equal((await readFile(t.sessionsFile, "utf8").catch(() => "")).includes('"spawn"'), false);
    assert.equal((await t.dispatch("architect")).status, 500, "the reservation was released (not 409)");
  });

  test("a failed spawn removes the worktree and leaves no den/ branch", async () => {
    const t = await fake({ runtimeConfig: { failSpawn: true } });
    const res = await t.dispatch("architect");
    assert.equal(res.status, 502, res.text);
    assert.deepEqual(await readdir(path.join(t.fx.root, ".claude", "worktrees")).catch(() => []), []);
    assert.equal((await git(t.fx.root, "branch", "--list", "den/*")).trim(), "");
    assert.equal((await git(t.fx.root, "worktree", "list", "--porcelain")).match(/^worktree /gm).length, 1);
  });
});

describe("replay", () => {
  const ID = "c-0123456789abcdef";
  const spawn = (extra) => ({ ts: "2026-10-10T09:00:00.000Z", event: "spawn", agentId: ID, ref: DISPATCH_REF, role: "architect", sessionId: "08376463-453a-4135-a7df-4ee921c22e86", ...extra });

  test("a replayed agent names its worktree only when the line matches what the bridge would have derived", async () => {
    const good = { worktree: ".claude/worktrees/den-fx-02-ready-p0-01234567", branch: "den/fx/02-ready-p0-01234567" };
    const t = await fake({ preWrite: (root) => seedSessions(root, [spawn(good)]) });
    const agent = await t.agent(ID);
    assert.equal(agent.worktree, good.worktree);
    assert.equal(agent.branch, good.branch);
  });

  test("a forged or absent worktree on a replayed line is shown as none", async () => {
    for (const extra of [{ worktree: "../../etc", branch: "main" }, { worktree: ".claude/worktrees/den-fx-02-ready-p0-ffffffff", branch: "den/fx/02-ready-p0-ffffffff" }, {}]) {
      const t = await fake({ preWrite: (root) => seedSessions(root, [spawn(extra)]) });
      const agent = await t.agent(ID);
      assert.equal(agent.worktree, null, JSON.stringify(extra));
      assert.equal(agent.branch, null, JSON.stringify(extra));
    }
  });
});
