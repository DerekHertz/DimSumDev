// den-mvp/16 item 1: two release makers on one state folder (the bridge and `npm run den:update`) never remove each
// other's work. A lock file under the state folder is held around making, linking and collecting a release.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReleaseError, createReleases, lockHash } from "./releases.mjs";
import { putRelease } from "./release-test-helpers.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
const LOCK = '{"name":"x","lockfileVersion":3,"packages":{}}\n';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a lock around making, linking and collecting", () => {
  let tmp, repo, commits;
  before(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "releases-lock-"));
    repo = path.join(tmp, "repo");
    git(tmp, "init", "-q", "-b", "main", repo);
    await mkdir(path.join(repo, "apps/ui"), { recursive: true });
    await writeFile(path.join(repo, "package-lock.json"), LOCK);
    await writeFile(path.join(repo, "apps/ui/vite.config.mjs"), "export default {};\n");
    commits = [];
    for (const n of [1, 2]) {
      await writeFile(path.join(repo, "src.txt"), `c${n}\n`);
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", `c${n}`);
      commits.push(git(repo, "rev-parse", "HEAD"));
    }
  });
  after(() => rm(tmp, { recursive: true, force: true }));

  const newState = async () => {
    const state = await mkdtemp(path.join(tmp, "state-"));
    await mkdir(path.join(state, "deps", lockHash(LOCK), "node_modules"), { recursive: true });
    return state;
  };

  test("a second maker of the same release waits; neither removes the other's half-made folder", async () => {
    const state = await newState();
    let building = 0;
    let overlap = 0;
    const box = {
      async build({ folder }) {
        building += 1;
        overlap = Math.max(overlap, building);
        await mkdir(path.join(folder, "apps/ui/dist"), { recursive: true });
        await sleep(100);
        assert.ok(existsSync(path.join(folder, "src.txt")), "the other maker did not remove this folder");
        await writeFile(path.join(folder, "apps/ui/dist/index.html"), "x");
        building -= 1;
        return { ok: true, files: 1, bytes: 1, tail: "" };
      },
    };
    const a = createReleases({ stateDir: state, repo, box });
    const b = createReleases({ stateDir: state, repo, box });
    const [x, y] = await Promise.all([a.makeRelease(commits[0]), b.makeRelease(commits[0])]);
    assert.equal(overlap, 1);
    assert.equal(x.sha, y.sha);
    assert.ok(existsSync(path.join(state, "releases", commits[0].slice(0, 12), "build.json")));
    assert.equal(existsSync(path.join(state, "releases.lock")), false, "the lock is released");
  });

  test("collect in one process leaves a release another process holds for its switch", async () => {
    const state = await newState();
    const mine = "d4".repeat(20);
    const other = "e5".repeat(20);
    await putRelease(state, mine);
    await putRelease(state, other);
    const a = createReleases({ stateDir: state });
    const b = createReleases({ stateDir: state });
    const letGo = a.hold(mine); // a made `mine` and is about to link it
    await b.switchUi(other); // b's switch collects every release no link points to
    assert.ok(existsSync(path.join(state, "releases", mine.slice(0, 12), "build.json")), "held release survived the other's collect");
    letGo();
    await b.switchUi(mine);
    assert.ok(existsSync(path.join(state, "ui", "current")));
  });

  test("a lock left by a process that is gone is taken over", async () => {
    const state = await newState();
    await writeFile(path.join(state, "releases.lock"), "2147483646\n");
    const sha = "d4".repeat(20);
    await putRelease(state, sha);
    await createReleases({ stateDir: state }).switchUi(sha);
    assert.ok(existsSync(path.join(state, "ui", "current")));
  });

  test("a lock held by a live process that does not let go is refused with a reason, not waited on for ever", async () => {
    const state = await newState();
    await writeFile(path.join(state, "releases.lock"), `${process.pid}\n`);
    const sha = "d4".repeat(20);
    await putRelease(state, sha);
    const releases = createReleases({ stateDir: state, lockWaitMs: 150 });
    await assert.rejects(releases.switchUi(sha), (err) => err instanceof ReleaseError && err.code === "locked" && /another process/.test(err.message));
    assert.equal(existsSync(path.join(state, "releases.lock")), true, "a lock that is not ours is left alone");
  });
});
