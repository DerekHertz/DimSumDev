// den-mvp/85: the newest release is built ahead, into staging, with no link changed.
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReleases, lockHash } from "./releases.mjs";
import { createReadyRelease } from "./ready-release.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
const LOCK = '{"name":"x","lockfileVersion":3,"packages":{}}\n';

describe("ready release", () => {
  let tmp, repo, state, commits, builds, tags, releases, ready, mergeCalls;
  const fakeBox = (fail) => ({
    async build({ folder }) {
      builds.push(folder);
      if (fail) return { ok: false, reason: fail };
      await mkdir(path.join(folder, "apps/ui/dist"), { recursive: true });
      await writeFile(path.join(folder, "apps/ui/dist/index.html"), "x");
      return { ok: true };
    },
  });
  const hostGit = () => ({
    lastTag: async () => tags.at(-1)?.name ?? null,
    tagSha: async (t) => tags.find((x) => x.name === t).sha,
    mergedSince: async (a) => { mergeCalls.push(a); return [{ number: 7, title: "fix: a thing", body: "" }]; },
  });
  const setup = (box) => {
    releases = createReleases({ stateDir: state, repo, box });
    ready = createReadyRelease({ git: hostGit(), releases, stateDir: state, repo });
  };
  const runningAt = async (sha) => {
    await mkdir(path.join(state, "deps", lockHash(LOCK), "node_modules"), { recursive: true });
    await releases.makeRelease(sha);
    await releases.switchBridge(sha);
    await releases.switchUi(sha);
  };

  before(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "ready-"));
    repo = path.join(tmp, "repo");
    git(tmp, "init", "-q", "-b", "main", repo);
    await writeFile(path.join(repo, "package-lock.json"), LOCK);
    await writeFile(path.join(repo, "package.json"), '{"name":"x"}\n');
    commits = [];
    for (const n of [1, 2]) {
      await writeFile(path.join(repo, "src.txt"), `c${n}\n`);
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", `c${n}`);
      commits.push(git(repo, "rev-parse", "HEAD"));
    }
  });
  beforeEach(async () => {
    state = await mkdtemp(path.join(tmp, "state-"));
    builds = [];
    mergeCalls = [];
    tags = [];
    setup(fakeBox());
  });
  after(() => rm(tmp, { recursive: true, force: true }));
  const link = (pair) => readlinkSync(path.join(state, pair, "current"));

  test("with no newer tag the snapshot carries nothing", async () => {
    await runningAt(commits[0]);
    tags = [{ name: "v0.1.0", sha: commits[0] }];
    await ready.poll();
    assert.equal(ready.snapshot(), null);
    assert.equal(builds.length, 1); // only the running release's own build
  });

  test("a newer tag is built into staging; the snapshot names tag, sha and the merged PRs; no link changes", async () => {
    await runningAt(commits[0]);
    const before = [link("bridge"), link("ui")];
    builds.length = 0;
    tags = [{ name: "v0.1.1", sha: commits[1] }];
    await ready.poll();
    assert.deepEqual(ready.snapshot(), { state: "ready", tag: "v0.1.1", sha: commits[1], prs: [{ number: 7, title: "fix: a thing" }] });
    assert.equal(builds.length, 1);
    assert.equal(existsSync(path.join(state, "releases", commits[1].slice(0, 12), "build.json")), true);
    assert.deepEqual([link("bridge"), link("ui")], before);
    assert.equal(mergeCalls[0].base, commits[0]);
  });

  test("a failed build is recorded with its reason and not retried until a newer tag exists", async () => {
    await runningAt(commits[0]);
    builds.length = 0;
    setup(fakeBox("the box said no"));
    tags = [{ name: "v0.1.1", sha: commits[1] }];
    await ready.poll();
    assert.equal(ready.snapshot().state, "failed");
    assert.match(ready.snapshot().reason, /the box said no/);
    await ready.poll();
    await createReadyRelease({ git: hostGit(), releases, stateDir: state, repo }).poll(); // even after a restart
    assert.equal(builds.length, 1);
  });

  test("a lockfile whose packages are not installed is reported as needing den:update, and nothing is built", async () => {
    await runningAt(commits[0]);
    builds.length = 0;
    await rm(path.join(state, "deps"), { recursive: true });
    await releases.makeRelease(commits[1]).catch(() => {});
    tags = [{ name: "v0.1.1", sha: commits[1] }];
    await ready.poll();
    assert.equal(ready.snapshot().state, "needs-update");
    assert.match(ready.snapshot().reason, /den:update/);
    assert.equal(builds.length, 0);
  });
});
