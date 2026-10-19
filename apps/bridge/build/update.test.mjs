// den-mvp/86: an update applies itself when nothing is running.
//   AC1 a new run is refused while draining, naming the update; running work goes on ... "while the update drains"
//   AC2 exit only when nothing is live; the release to start is written first .......... "while the update drains", "createUpdater waits for ..."
//   AC3 "Restart now" stops running work as a restart does ............................ "Restart now"
//   AC4 with the setting off nothing drains until "Update now" ........................ "with the setting off"
//   AC5 after a failed update the setting is off ...................................... "after a failed update"
// A real bridge over a temporary git repository and a fake runtime; the box and the git host are fakes.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeBridge, until, DISPATCH_REF } from "../cells/host-test-helpers.mjs";
import { createReleases, lockHash, recordUpdateFailure } from "./releases.mjs";
import { createUpdater } from "./update.mjs";

const LOCK = '{"name":"x","lockfileVersion":3,"packages":{}}\n';
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
const box = { async build({ folder }) { await mkdir(path.join(folder, "apps/ui/dist"), { recursive: true }); await writeFile(path.join(folder, "apps/ui/dist/index.html"), "x"); return { ok: true }; } };

let t, denState, shas, exits;
beforeEach(async () => {
  denState = await mkdtemp(path.join(tmpdir(), "den-update-"));
  exits = [];
});
afterEach(async () => {
  await t?.close();
  t = null;
  await rm(denState, { recursive: true, force: true });
});

// A bridge whose repository has two commits: the running release (the first) and the tagged one (the second), built ahead.
async function start({ before, runtimeConfig } = {}) {
  t = await makeBridge({
    runtimeConfig,
    denState,
    box,
    extra: { exit: (code) => exits.push(code), updatePollMs: 20 },
    gitHost: (root) => ({
      mainSha: async () => shas[1], lastTag: async () => "v0.1.1", tagSha: async () => shas[1], mergedSince: async () => [], mergedPrs: async () => [],
      login: async () => null,
    }),
    preWrite: async (root) => {
      await writeFile(path.join(root, "package-lock.json"), LOCK);
      await writeFile(path.join(root, "package.json"), '{"name":"x"}\n');
      shas = [];
      for (const n of [1, 2]) {
        await writeFile(path.join(root, "src.txt"), `c${n}\n`);
        git(root, "add", "package-lock.json", "package.json", "src.txt");
        git(root, "commit", "-q", "-m", `c${n}`);
        shas.push(git(root, "rev-parse", "HEAD"));
      }
      git(root, "update-ref", "refs/remotes/origin/main", shas[1]); // the bridge's releases are of origin/main
      await mkdir(path.join(denState, "deps", lockHash(LOCK), "node_modules"), { recursive: true });
      const releases = createReleases({ stateDir: denState, repo: root, box });
      await releases.makeRelease(shas[0]);
      await releases.switchBridge(shas[0]);
      await releases.switchUi(shas[0]);
      await before?.();
    },
  });
}
const link = (pair) => readlink(path.join(denState, pair, "current")).catch(() => null);
const update = async () => (await t.state()).update;
const OLD = () => `../releases/${shas[0].slice(0, 12)}`;
const NEW = () => `../releases/${shas[1].slice(0, 12)}`;

describe("while the update drains", () => {
  test("a new run is refused naming the update, the running one is not interrupted, and the bridge exits only after it ends, with the release to start written", async () => {
    await start();
    const run = await t.dispatch("architect");
    assert.equal(run.status, 201, run.text);
    await t.bridge.pollRelease();
    await until(async () => (await update())?.draining === true, { what: "the drain" });
    assert.equal((await update()).auto, true);
    const refused = await t.post("/tasks", { role: "architect", text: "one more" });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.draining, true);
    assert.match(refused.body.error, /updat/);
    const other = await t.post("/deliveries", { ref: DISPATCH_REF });
    assert.deepEqual([other.status, other.body.draining], [503, true]);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await t.agent(run.body.agent.id)).state, "working", "running work is not interrupted");
    assert.deepEqual(exits, [], "the bridge does not exit while a run is live");
    assert.equal(await link("bridge"), OLD());
    t.fake.spawns[0].exit();
    await until(() => exits.length > 0, { what: "the exit" });
    assert.deepEqual(exits, [0]);
    assert.deepEqual([await link("bridge"), await link("ui")], [NEW(), NEW()], "the release to start is written before the exit");
  });

  test("with nothing running it applies at once", async () => {
    await start();
    await t.bridge.pollRelease();
    await until(() => exits.length > 0, { what: "the exit" });
    assert.equal(await link("bridge"), NEW());
  });
});

describe("with the setting off", () => {
  test("nothing drains until Update now", async () => {
    await start();
    assert.equal((await t.post("/update/auto", { auto: false })).status, 200);
    await t.bridge.pollRelease();
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual([(await update()).auto, (await update()).draining, exits], [false, false, []]);
    assert.equal((await t.dispatch("architect")).status, 201, "runs are admitted");
    const now = await t.post("/update/now");
    assert.deepEqual([now.status, now.body.started], [202, true], now.text);
    assert.equal((await update()).draining, true);
    assert.equal((await t.post("/tasks", { role: "architect", text: "x" })).status, 503);
    t.fake.spawns[0].exit();
    await until(() => exits.length > 0, { what: "the exit" });
  });
  test("Update now with no release ready starts nothing and says so", async () => {
    await start();
    const res = await t.post("/update/now");
    assert.deepEqual([res.status, res.body.started, res.body.update.draining], [200, false, false]);
    assert.deepEqual(exits, []);
  });
});

describe("Restart now", () => {
  test("stops running work as an ordinary restart does and exits", async () => {
    await start();
    await t.post("/update/auto", { auto: false });
    const run = await t.dispatch("architect");
    assert.equal(run.status, 201);
    const res = await t.post("/update/restart");
    assert.equal(res.status, 202);
    await until(() => exits.length > 0, { what: "the exit" });
    assert.deepEqual(exits, [0]);
    assert.equal(await link("bridge"), OLD(), "a restart switches no release");
    assert.equal(t.fake.spawns[0].exited, true, "the run was stopped");
  });
});

describe("after a failed update", () => {
  test("the setting is off at start, stays off through the next ready release, and the user turns it on again", async () => {
    await start({ before: () => recordUpdateFailure(denState, { sha: "f".repeat(40), tag: "v0.1.0", reason: "the den did not answer" }) });
    assert.equal((await update()).auto, false);
    await t.bridge.pollRelease();
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual([(await update()).draining, exits], [false, []]);
    const on = await t.post("/update/auto", { auto: true });
    assert.equal(on.body.update.auto, true);
    await until(() => exits.length > 0, { what: "the drain after the user turned it on" });
  });
});

describe("createUpdater", () => {
  const fakes = (over = {}) => {
    const calls = [];
    return {
      calls,
      opts: {
        stateDir: denState,
        releases: { switchBridge: async (s) => calls.push(["bridge", s]), switchUi: async (s) => calls.push(["ui", s]) },
        ready: () => ({ state: "ready", tag: "v1.2.3", sha: "a".repeat(40) }),
        busy: () => false,
        stop: async () => calls.push(["stop"]),
        exit: (c) => calls.push(["exit", c]),
        pollMs: 10,
        ...over,
      },
    };
  };
  test("waits for busy() to be false (a delivery mid-merge counts), then writes the release, stops and exits in that order", async () => {
    let busy = true;
    const f = fakes({ busy: () => busy });
    const u = createUpdater(f.opts);
    await u.check();
    assert.equal(u.snapshot().draining, true);
    assert.match(u.drainingText(), /v1\.2\.3/);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(f.calls, []);
    busy = false;
    await until(() => f.calls.length >= 4, { what: "the apply" });
    assert.deepEqual(f.calls, [["bridge", "a".repeat(40)], ["ui", "a".repeat(40)], ["stop"], ["exit", 0]]);
    u.stop();
  });
  test("a switch that fails ends the drain, names why, and does not exit", async () => {
    const f = fakes({ releases: { switchBridge: async () => { throw new Error("no such release"); }, switchUi: async () => {} } });
    const drained = [];
    const u = createUpdater({ ...f.opts, onDrain: (x) => drained.push(x) });
    await u.check();
    await until(() => u.snapshot().draining === false, { what: "the end of the drain" });
    assert.match(u.snapshot().error, /no such release/);
    assert.equal(drained.at(-1), null);
    assert.deepEqual(f.calls, []);
    u.stop();
  });
});
