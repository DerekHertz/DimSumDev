// den-mvp/77 (ADR 0026 Amendment 1, decision 5): the launcher the unit runs instead of the bridge. It starts the bridge release
// the bridge named (bridge/current), checks that it answers, and if not starts the previous one (bridge/previous) and records
// the failure. The releases here are fake: a build.json and a tiny server.mjs that is good, silent (never answers) or crashes.
// Real child processes, a real temporary git repository (for "older"), no systemd.
import { test, describe, beforeEach, afterEach, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLauncher } from "./den-launcher.mjs";
import { createReleases, currentRelease, readUpdateFailure } from "../build/releases.mjs";

const LAUNCHER = fileURLToPath(new URL("./den-launcher.mjs", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();

const SERVER = (mode) => `import http from "node:http";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
appendFileSync(path.join(root, "starts.log"), process.pid + "\\n");
process.on("SIGTERM", () => process.exit(143));
if (${JSON.stringify(mode)} === "crash") process.exit(1);
if (${JSON.stringify(mode)} === "silent") setInterval(() => {}, 1000);
else http.createServer((_req, res) => res.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
`;

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const answers = async (port) => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/`)).status === 200;
  } catch {
    return false;
  }
};

describe("the launcher (den-mvp/77)", () => {
  let tmp, repo, shas, state, port, releases;
  const [c1, c2, c3] = [0, 1, 2]; // shas[c1] is the oldest commit

  before(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "den-launcher-"));
    repo = path.join(tmp, "repo");
    await mkdir(repo);
    git(tmp, "init", "-q", "-b", "main", repo);
    shas = [];
    for (const n of [1, 2, 3]) {
      git(repo, "commit", "-q", "--allow-empty", "-m", `c${n}`);
      shas.push(git(repo, "rev-parse", "HEAD"));
    }
  });
  after(() => rm(tmp, { recursive: true, force: true }));

  beforeEach(async () => {
    state = path.join(tmp, `state-${Math.random().toString(36).slice(2)}`);
    port = await freePort();
    releases = createReleases({ stateDir: state, repo });
  });
  afterEach(async () => {
    for (const id of await readdir(path.join(state, "releases")).catch(() => [])) {
      const log = path.join(state, "releases", id, "starts.log");
      if (existsSync(log)) for (const pid of readFileSync(log, "utf8").split("\n").filter(Boolean)) if (alive(+pid)) process.kill(+pid, "SIGKILL");
    }
  });

  /** A complete fake release of commit `i`. */
  async function put(i, mode = "good", tag) {
    const dir = path.join(state, "releases", shas[i].slice(0, 12));
    await mkdir(path.join(dir, "apps/bridge"), { recursive: true });
    await writeFile(path.join(dir, "apps/bridge/server.mjs"), SERVER(mode));
    await writeFile(path.join(dir, "build.json"), `${JSON.stringify({ sha: shas[i], builtAt: "2026-10-17T08:00:00.000Z", lock: "0".repeat(64), ...(tag ? { tag } : {}) })}\n`);
  }
  const starts = (i) => {
    const log = path.join(state, "releases", shas[i].slice(0, 12), "starts.log");
    return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map(Number) : [];
  };
  const launcher = (over = {}) => createLauncher({ stateDir: state, repo, port, checkMs: 1500, pollMs: 50, ...over });

  test("it starts the named release (bridge/current) and returns once the den answers", async () => {
    await put(c1);
    await put(c2);
    await releases.switchBridge(shas[c1]);
    await releases.switchBridge(shas[c2]);
    const out = await launcher().launch();
    assert.equal(out.sha, shas[c2]);
    assert.equal(out.rolledBack, false);
    assert.ok(alive(out.child.pid));
    assert.equal(await answers(port), true);
    assert.equal(starts(c2).length, 1);
    assert.equal(starts(c1).length, 0, "the previous release is not started when the new one answers");
    assert.equal(await readUpdateFailure(state), null);
    out.child.kill("SIGTERM");
  });

  describe("a release that does not answer is replaced by the previous one, and the failure is recorded", () => {
    test("one that never answers within the check time", async () => {
      await put(c1);
      await put(c2, "silent", "v0.0.2");
      await releases.switchBridge(shas[c1]);
      await releases.switchBridge(shas[c2]);
      const out = await launcher({ checkMs: 800 }).launch();
      assert.equal(out.sha, shas[c1]);
      assert.equal(out.rolledBack, true);
      assert.equal(await answers(port), true, "the previous release answers");
      assert.equal(starts(c2).length, 1);
      assert.equal(alive(starts(c2)[0]), false, "the release that never answered is stopped");
      const failure = await readUpdateFailure(state);
      assert.equal(failure.sha, shas[c2]);
      assert.equal(failure.tag, "v0.0.2");
      assert.match(failure.reason, /answer/i);
      assert.ok(Number.isFinite(Date.parse(failure.at)));
      assert.equal((await currentRelease(state, "bridge")).sha, shas[c1], "the link no longer names the bad release, so a crash restart cannot start it");
      out.child.kill("SIGTERM");
    });

    test("one that exits at once says so and does not wait out the check time", async () => {
      await put(c1);
      await put(c2, "crash");
      await releases.switchBridge(shas[c1]);
      await releases.switchBridge(shas[c2]);
      const began = Date.now();
      const out = await launcher({ checkMs: 20_000 }).launch();
      assert.ok(Date.now() - began < 10_000, "an exited release is not waited on");
      assert.equal(out.sha, shas[c1]);
      assert.match((await readUpdateFailure(state)).reason, /exit/i);
      out.child.kill("SIGTERM");
    });

    test("with no previous release the failure is recorded and the launch fails", async () => {
      await put(c2, "silent");
      await releases.switchBridge(shas[c2]);
      await assert.rejects(launcher({ checkMs: 500 }).launch());
      assert.equal((await readUpdateFailure(state)).sha, shas[c2]);
      assert.equal(alive(starts(c2)[0]), false);
    });
  });

  test("after a failed update the same release is not started again", async () => {
    await put(c1);
    await put(c2, "silent");
    await releases.switchBridge(shas[c1]);
    await releases.switchBridge(shas[c2]);
    (await launcher({ checkMs: 500 }).launch()).child.kill("SIGTERM");
    await wait(100);
    await releases.switchBridge(shas[c2]); // the bridge names the same release again
    const out = await launcher({ checkMs: 500 }).launch();
    assert.equal(out.sha, shas[c1]);
    assert.equal(starts(c2).length, 1, "the failed release was started once, never again");
    assert.equal((await currentRelease(state, "bridge")).sha, shas[c1]);
    assert.equal((await readUpdateFailure(state)).sha, shas[c2], "the record stays until the user asks");
    out.child.kill("SIGTERM");
  });

  test("a malformed bridge/failed.json fails open: it names nothing, so the release is started", async () => {
    await put(c1);
    await put(c2);
    await releases.switchBridge(shas[c1]);
    await releases.switchBridge(shas[c2]);
    await writeFile(path.join(state, "bridge", "failed.json"), "{ not json");
    const out = await launcher().launch();
    assert.equal(out.sha, shas[c2]);
    assert.equal(out.rolledBack, false);
    out.child.kill("SIGTERM");
  });

  describe("a release older than the running one", () => {
    // links made by hand: a name the bridge could not have written without consent
    const link = async (pair, name, i) => {
      await mkdir(path.join(state, pair), { recursive: true });
      await symlink(`../releases/${shas[i].slice(0, 12)}`, path.join(state, pair, name));
    };

    test("is not started unless the user named it: the previous (newer) release runs instead and the refusal is recorded", async () => {
      await put(c1);
      await put(c3);
      await link("bridge", "current", c1);
      await link("bridge", "previous", c3);
      const out = await launcher().launch();
      assert.equal(out.sha, shas[c3]);
      assert.equal(starts(c1).length, 0);
      assert.match((await readUpdateFailure(state)).reason, /older/i);
      out.child.kill("SIGTERM");
    });

    test("switchBridge refuses it without the user's say, and takes it with { downgrade: true }, and then the launcher starts it", async () => {
      await put(c1);
      await put(c3);
      await releases.switchBridge(shas[c3]);
      await assert.rejects(releases.switchBridge(shas[c1]), (err) => err.code === "older");
      assert.equal((await currentRelease(state, "bridge")).sha, shas[c3], "nothing changed");
      await releases.switchBridge(shas[c1], { downgrade: true });
      const out = await launcher().launch();
      assert.equal(out.sha, shas[c1]);
      assert.equal(out.rolledBack, false);
      assert.equal(await readUpdateFailure(state), null);
      out.child.kill("SIGTERM");
    });

    test("a malformed bridge/downgrade.json fails closed: it is no consent, so the older release is refused", async () => {
      await put(c1);
      await put(c3);
      await link("bridge", "current", c1);
      await link("bridge", "previous", c3);
      await writeFile(path.join(state, "bridge", "downgrade.json"), "{ not json");
      const out = await launcher().launch();
      assert.equal(out.sha, shas[c3]);
      assert.equal(starts(c1).length, 0);
      assert.match((await readUpdateFailure(state)).reason, /older/i);
      out.child.kill("SIGTERM");
    });

    test("a newer release and the running release itself are never refused", async () => {
      await put(c1);
      await put(c2);
      await releases.switchBridge(shas[c1]);
      await releases.switchBridge(shas[c2]);
      await releases.switchBridge(shas[c2]);
      assert.equal((await currentRelease(state, "bridge")).sha, shas[c2]);
    });
  });

  describe("run as the unit runs it (node den-launcher.mjs, DEN_STATE_DIR and PORT in the environment, the checkout as cwd)", () => {
    test("it supervises the bridge: the den answers, and a SIGTERM stops the bridge and the launcher", async () => {
      await put(c2);
      await releases.switchBridge(shas[c2]);
      const proc = spawn(process.execPath, [LAUNCHER], { cwd: repo, env: { PATH: process.env.PATH, DEN_STATE_DIR: state, PORT: String(port) }, stdio: "ignore" });
      const exited = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));
      try {
        for (let i = 0; i < 100 && !(await answers(port)); i += 1) await wait(50);
        assert.equal(await answers(port), true);
        const [pid] = starts(c2);
        proc.kill("SIGTERM");
        const done = await Promise.race([exited, wait(5000).then(() => null)]);
        assert.ok(done, "the launcher exits after SIGTERM");
        assert.ok(done.code === 143 || done.code === 0 || done.signal === "SIGTERM", `a stop is a clean exit, got ${JSON.stringify(done)}`);
        assert.equal(alive(pid), false, "the bridge does not outlive the launcher");
      } finally {
        proc.kill("SIGKILL");
      }
    });

    test("a state dir reached through a symlink still starts the release (the unit's path need not be the real one)", async () => {
      await put(c2);
      await releases.switchBridge(shas[c2]);
      await mkdir(path.join(state, "launcher"));
      await copyFile(LAUNCHER, path.join(state, "launcher", "den-launcher.mjs"));
      const viaLink = `${state}-link`;
      await symlink(state, viaLink);
      const proc = spawn(process.execPath, [path.join(viaLink, "launcher", "den-launcher.mjs")], { cwd: repo, env: { PATH: process.env.PATH, DEN_STATE_DIR: viaLink, PORT: String(port) }, stdio: "ignore" });
      const exited = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));
      try {
        let early = null;
        for (let i = 0; i < 100 && !(await answers(port)) && !early; i += 1) {
          await wait(50);
          early = await Promise.race([exited, Promise.resolve(null)]);
        }
        assert.equal(early, null, `the launcher stays up, got ${JSON.stringify(early)}`);
        assert.equal(await answers(port), true);
        assert.equal(starts(c2).length, 1);
      } finally {
        proc.kill("SIGKILL");
      }
    });

    test("when the bridge dies by itself the launcher exits too, so the unit's Restart= applies", async () => {
      await put(c2, "good");
      await releases.switchBridge(shas[c2]);
      const proc = spawn(process.execPath, [LAUNCHER], { cwd: repo, env: { PATH: process.env.PATH, DEN_STATE_DIR: state, PORT: String(port) }, stdio: "ignore" });
      const exited = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));
      try {
        for (let i = 0; i < 100 && !(await answers(port)); i += 1) await wait(50);
        process.kill(starts(c2)[0], "SIGKILL");
        const done = await Promise.race([exited, wait(5000).then(() => null)]);
        assert.ok(done, "the launcher exits when its bridge does");
        assert.ok(done.code !== 0, "and not as a clean stop");
      } finally {
        proc.kill("SIGKILL");
      }
    });
  });

  test("the launcher imports only node: built-ins, so it needs nothing from any release", () => {
    const text = readFileSync(LAUNCHER, "utf8");
    const specs = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)].map((m) => m[1]);
    assert.ok(specs.length > 0);
    for (const spec of specs) assert.match(spec, /^node:/, spec);
  });
});
