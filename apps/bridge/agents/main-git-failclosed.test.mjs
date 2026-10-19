// agent-os/11 (ADR 0021 Amendment 2, follow-ups to agent-os/09): the main .git rule fails closed on an unusual repo path, the host's
// preflight refusal is pinned, and publish for an agent that made no commit is pinned.
//
// Criterion map:
//   1. "a main .git path outside [A-Za-z0-9._@+-] never spawns with the denies missing"
//        -> describe "the runtime never spawns a walled role without the main .git denies" (runtime seam, real process, stub binary)
//        -> describe "a repository whose path is not plain ..." (host seam, real runtime, stub binary)
//      Either outcome passes: the spawn is refused, or the four denies are in the argv's settings. Silence (spawned, denies absent) fails.
//   2. host preflight refusal -> describe "the host's preflight refusal" (fake runtime; the status, no spawn, no worktree, reservation released)
//   3. publish with no commit -> describe "publish for an agent that made no commit" (workspace seam and host seam). These two pin the
//      behavior as it is today (the branch is made at the base HEAD) and pass before the developer starts.
//   4. agent-os/02, 07, 09 tests unchanged and green; 5. npm test, risk-check, gitleaks, security: human-verified or the orchestrator's.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, test } from "node:test";
import { startBridge } from "../server.mjs";
import { makeStateFixture } from "../bridge-fixture.mjs";
import { CODE, authed, login, send } from "../bridge-auth-helpers.mjs";
import { makeBridge, sleep, until } from "./host-test-helpers.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";
import { makeStub, alive } from "./claude-stub.mjs";
import { createWorkspaces } from "./workspace.mjs";
import { unconfinedLauncher } from "./launcher-test-helpers.mjs";

const run = promisify(execFile);
const git = async (root, ...args) => (await run("git", ["-C", root, ...args])).stdout;
const SID = "0b8f1c1e-5c1a-4c0e-9a55-3f2d9e7a4b10";
const TEXT = "Fetch the package index and note which versions changed.";
const FOUR = ["refs", "HEAD", "packed-refs", "index"];

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

const settingsOf = (argv) => JSON.parse(argv[argv.indexOf("--settings") + 1]);
// The denies are "there" when every one of the four targets is denied for shell writes under the given main .git.
const hasDenies = (settings, mainGit) => {
  const denyWrite = settings.sandbox?.filesystem?.denyWrite ?? [];
  return FOUR.every((target) => denyWrite.includes(`${mainGit}/${target}`));
};
const stubRuntime = async (stubOpts = { mode: "hang" }) => {
  const stub = await makeStub(stubOpts);
  const runtime = createClaudeRuntime({ controlRoot: "/", launcher: unconfinedLauncher(), env: { PATH: process.env.PATH, HOME: process.env.HOME, DEN_CLAUDE_BIN: stub.bin } });
  cleanups.push(async () => {
    const start = await stub.start();
    if (start?.pid && alive(start.pid)) process.kill(start.pid, "SIGKILL");
  });
  return { stub, runtime };
};

describe("the runtime never spawns a walled role without the main .git denies", () => {
  // Characters outside the plain set the adapter can write as a rule: a space, a quote, a non-ASCII letter, a glob character.
  const ODD = ["/work/my den/.git", "/work/den's/.git", "/work/café/.git", "/work/den*/.git"];

  for (const role of ["developer", "qa", "security", "scout"]) {
    for (const mainGit of ODD) {
      test(`${role}, mainGit ${JSON.stringify(mainGit)}: the spawn is refused, or the four denies are in the settings`, async () => {
        const { stub, runtime } = await stubRuntime();
        const cwd = await mkdtemp(path.join(tmpdir(), "mgfc-cwd-"));
        cleanups.push(() => rm(cwd, { recursive: true, force: true }));
        const spawned = await runtime.spawn({ role, cwd, prompt: "go", sessionId: SID, mainGit }).then(
          (proc) => proc,
          () => null,
        );
        if (spawned === null) {
          await sleep(150);
          assert.equal(await stub.start(), undefined, "a refused spawn must not have started a child");
          return;
        }
        const start = await until(() => stub.start(), { what: "the stub to start" });
        spawned.signal("SIGKILL");
        const settings = settingsOf(start.argv);
        assert.ok(hasDenies(settings, mainGit), `spawned with the main .git denies missing: ${JSON.stringify(settings.sandbox?.filesystem?.denyWrite ?? null)}`);
      });
    }
  }

  test("a plain mainGit still spawns with the four denies (the refusal is not over-broad)", async () => {
    const { stub, runtime } = await stubRuntime();
    const cwd = await mkdtemp(path.join(tmpdir(), "mgfc-cwd-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    const mainGit = "/work/den/.git";
    const proc = await runtime.spawn({ role: "developer", cwd, prompt: "go", sessionId: SID, mainGit });
    const start = await until(() => stub.start(), { what: "the stub to start" });
    proc.signal("SIGKILL");
    assert.ok(hasDenies(settingsOf(start.argv), mainGit));
  });
});

describe("a repository whose path is not plain starts no walled agent without the main .git denies (host, real runtime)", () => {
  // The fixture repo is moved to a path with an odd character before the bridge starts; no worktree exists yet, so git is unharmed.
  async function bootAt(dirName) {
    const fx = await makeStateFixture({ git: true });
    const odd = path.join(path.dirname(fx.root), `${path.basename(fx.root)}${dirName}`);
    await rename(fx.root, odd);
    const { stub, runtime } = await stubRuntime();
    const bridge = await startBridge({ root: odd, port: 0, auth: { launchCode: CODE }, runtime, policy: { killGraceMs: 150 } });
    const headers = authed(bridge, await login(bridge));
    cleanups.push(async () => {
      await bridge.close();
      await rm(odd, { recursive: true, force: true });
    });
    return { root: odd, stub, post: (p, body = {}) => send(bridge, { method: "POST", path: p, body, headers }) };
  }

  for (const [label, suffix] of [["a space", " with space"], ["a quote", "-q'uote"], ["a non-ASCII letter", "-café"]]) {
    for (const role of ["developer", "scout"]) {
      test(`${role} task, root path holds ${label}: refused with nothing left, or spawned with the denies`, async () => {
        const t = await bootAt(suffix);
        const res = await t.post("/tasks", { role, text: TEXT });
        if (res.status !== 201) {
          assert.ok(res.status >= 400 && res.status < 600, `status ${res.status}`);
          await sleep(150);
          assert.equal(await t.stub.start(), undefined, "a refused task must not have started a child");
          assert.deepEqual(await readdir(path.join(t.root, ".claude", "worktrees")).catch(() => []), [], "no worktree left");
          assert.equal((await git(t.root, "worktree", "list", "--porcelain")).match(/^worktree /gm).length, 1);
          const again = await t.post("/tasks", { role, text: TEXT });
          assert.notEqual(again.status, 409, "the reservation was released");
          assert.notEqual(again.status, 429, "the reservation was released");
          return;
        }
        const start = await until(() => t.stub.start(), { what: "the stub to start" });
        const mainGit = path.join(await realpath(t.root), ".git");
        assert.ok(hasDenies(settingsOf(start.argv), mainGit), `spawned with the main .git denies missing: ${JSON.stringify(settingsOf(start.argv).sandbox?.filesystem?.denyWrite ?? null)}`);
      });
    }
  }
});

describe("the host's preflight refusal (the main .git is not ready)", () => {
  const breakIndex = (root) => rm(path.join(root, ".git", "index"), { force: true });
  const worktreesLeft = async (root) => readdir(path.join(root, ".claude", "worktrees")).catch(() => []);
  const noDenBranch = async (root) => assert.equal((await git(root, "branch", "--list", "den/*")).trim(), "");

  test("a dispatch answers 502, never asks the runtime to spawn, leaves no worktree or agent, and frees the reservation", async () => {
    const t = await makeBridge();
    cleanups.push(() => t.close());
    await breakIndex(t.fx.root);
    const res = await t.dispatch("architect");
    assert.equal(res.status, 502, res.text);
    assert.equal(typeof res.body.error, "string");
    assert.equal(t.fake.spawns.length, 0, "the runtime was never asked to spawn");
    assert.deepEqual(await worktreesLeft(t.fx.root), [], "no worktree directory");
    assert.equal((await git(t.fx.root, "worktree", "list", "--porcelain")).match(/^worktree /gm).length, 1, "git knows no extra worktree");
    await noDenBranch(t.fx.root);
    assert.deepEqual((await t.state()).agents, []);
    assert.equal((await readFile(t.sessionsFile, "utf8").catch(() => "")).includes('"spawn"'), false, "no spawn line");

    const again = await t.dispatch("architect");
    assert.equal(again.status, 502, `the reservation was released (not 409): ${again.text}`);
    assert.equal(t.fake.spawns.length, 0);
  });

  test("once the .git is whole again the same ticket dispatches (the refusal left the slot free)", async () => {
    const t = await makeBridge();
    cleanups.push(() => t.close());
    await breakIndex(t.fx.root);
    assert.equal((await t.dispatch("architect")).status, 502);
    await git(t.fx.root, "read-tree", "HEAD");
    const ok = await t.dispatch("architect");
    assert.equal(ok.status, 201, ok.text);
    assert.equal(t.fake.spawns.length, 1);
  });

  test("a den task takes the same refusal: 502, no spawn, no worktree, and a second task is not turned away as busy", async () => {
    const t = await makeBridge();
    cleanups.push(() => t.close());
    await breakIndex(t.fx.root);
    const res = await t.post("/tasks", { role: "developer", text: TEXT });
    assert.equal(res.status, 502, res.text);
    assert.equal(t.fake.spawns.length, 0);
    assert.deepEqual(await worktreesLeft(t.fx.root), []);
    await noDenBranch(t.fx.root);
    const again = await t.post("/tasks", { role: "developer", text: TEXT });
    assert.equal(again.status, 502, `the slot was released (not 409 or 429): ${again.text}`);
  });
});

describe("publish for an agent that made no commit", () => {
  const REF = "fx/02-ready-p0";
  const ID = "c-0123456789abcdef";

  test("workspace: the branch is made at the base HEAD, the main checkout does not move, and a second publish is refused", async () => {
    const fx = await makeStateFixture({ git: true });
    cleanups.push(fx.cleanup);
    const ws = createWorkspaces(fx.root);
    const made = await ws.create({ ref: REF, agentId: ID });
    const base = (await git(fx.root, "rev-parse", "HEAD")).trim();
    const mainBranch = (await git(fx.root, "branch", "--show-current")).trim();

    const out = await ws.publish(made);
    assert.deepEqual(out, { branch: made.branch, sha: base });
    assert.equal((await git(fx.root, "rev-parse", `refs/heads/${made.branch}`)).trim(), base);
    assert.equal((await git(fx.root, "rev-parse", "HEAD")).trim(), base, "the main checkout's HEAD did not move");
    assert.equal((await git(fx.root, "branch", "--show-current")).trim(), mainBranch);
    await assert.rejects(ws.publish(made), "git branch never moves or recreates an existing branch");
  });

  test("host: an agent that ends with no commit ends done, and its den/ branch sits at the base HEAD", async () => {
    const t = await makeBridge();
    cleanups.push(() => t.close());
    const base = (await git(t.fx.root, "rev-parse", "HEAD")).trim();
    const a = await t.dispatch("architect");
    assert.equal(a.status, 201, a.text);
    const { id, branch } = a.body.agent;
    t.fake.spawns[0].exit();
    await until(async () => (await t.agent(id))?.state === "done", { what: "the agent to end" });
    await until(async () => (await git(t.fx.root, "branch", "--list", branch)).trim() !== "", { what: "the bridge to create the branch" });
    assert.equal((await git(t.fx.root, "rev-parse", `refs/heads/${branch}`)).trim(), base);
    assert.equal((await git(t.fx.root, "rev-parse", "HEAD")).trim(), base, "the main checkout's HEAD did not move");
  });
});
