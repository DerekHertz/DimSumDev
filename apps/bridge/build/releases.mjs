// den-mvp outcome 5 (ADR 0026 decisions 1, 3 and 8): the release folders the running den is served from.
//   createReleases({ stateDir, repo?, box?, npm?, main? }) -> { makeRelease, makeDeps, switchUi, switchBridge, rollbackUi, sweep, ... }
// `stateDir` is the den's state folder ($XDG_STATE_HOME/den). Under it:
//   releases/<sha12>/             one commit of `main` (git archive), its UI built in the box, `build.json` written last
//   deps/<lock-hash>/node_modules the packages for one package-lock.json, installed once, on the user's action only
//   ui/current, ui/previous       links to the release whose UI is served, and the one before it
//   ui/live.json                  when the served release went live, and the release a roll back undid (decision 7)
//   bridge/current, bridge/previous   the same for the bridge code
//   bridge/failed.json            the release the launcher could not start, and why (den-mvp/77); it is not started again
//   bridge/downgrade.json         the older release the user named for bridge/current, so the launcher starts it
// The launcher (service/den-launcher.mjs) cannot import this file, so it reads and writes the last two by the same names.
// Every path below is built from a checked sha (full lowercase hex, then its first 12 characters) or a checked lock hash
// and fixed names; a link's target is read back only if it is exactly `../releases/<sha12>`.
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA12_RE = /^[0-9a-f]{12}$/;
const LINK_RE = /^\.\.\/releases\/([0-9a-f]{12})$/;
const PAIRS = ["ui", "bridge"];
const MAKING = ".making";
const BUILD = "build.json";
const LIVE = "live.json";
const FAILED = "failed.json";
const DOWNGRADE = "downgrade.json";
const TAG_RE = /^v\d+\.\d+\.\d+$/;
export const UI_DIST = path.join("apps", "ui", "dist");

/** A refusal with a stable `code`: bad-sha, not-on-main, needs-update, build, missing, conflict, git, older. */
export class ReleaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseError";
    this.code = code;
  }
}

export const lockHash = (lockfileText) => createHash("sha256").update(lockfileText).digest("hex");

/** Checks a full commit id and returns it; anything else (short, upper case, not hex) is refused. */
export function checkSha(sha) {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) throw new ReleaseError("bad-sha", "a release is made from a full commit id (lower-case hex)");
  return sha;
}

const isDir = (p) => stat(p).then((s) => s.isDirectory(), () => false);
const isFile = (p) => stat(p).then((s) => s.isFile(), () => false);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};
// Whether a live process other than this one is making what carries this marker (a bridge starting must not remove it).
const madeByOther = (text) => {
  const pid = Number.parseInt(text, 10);
  return Number.isInteger(pid) && pid !== process.pid && alive(pid);
};

/** The release a link points to, as its sha12, or null when the link is missing or points anywhere else. */
async function linkedId(stateDir, pair, name) {
  try {
    return LINK_RE.exec(await readlink(path.join(stateDir, pair, name)))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The complete release with this sha12 (it has a readable build.json), as { dir, build }, or null. Never throws. */
async function completeRelease(stateDir, id) {
  if (!SHA12_RE.test(id)) return null;
  const dir = path.join(stateDir, "releases", id);
  try {
    const build = JSON.parse(await readFile(path.join(dir, BUILD), "utf8"));
    return typeof build?.sha === "string" && build.sha.startsWith(id) ? { dir, build } : null;
  } catch {
    return null;
  }
}

/**
 * What the bridge serves the UI from, resolved from the links on every call: { current, previous } as the dist
 * folders of complete releases, or null when there is no usable current link (the bridge then serves the checkout's build).
 */
export async function resolveUi(stateDir) {
  const [cur, prev] = await Promise.all(["current", "previous"].map((name) => linkedId(stateDir, "ui", name)));
  const [current, previous] = await Promise.all([cur, prev].map((id) => (id ? completeRelease(stateDir, id) : null)));
  if (!current) return null;
  return { current: path.join(current.dir, UI_DIST), previous: previous ? path.join(previous.dir, UI_DIST) : null };
}

const stamp = (v) => (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null);

// The record beside the ui links, with every field checked: { sha, at, rolledBack: { sha, at } | null }, or null.
async function readLive(stateDir) {
  try {
    const raw = JSON.parse(await readFile(path.join(stateDir, "ui", LIVE), "utf8"));
    if (!SHA_RE.test(raw?.sha)) return null;
    const undone = raw.rolledBack;
    return { sha: raw.sha, at: stamp(raw.at), rolledBack: undone && SHA_RE.test(undone.sha) ? { sha: undone.sha, at: stamp(undone.at) } : null };
  } catch {
    return null;
  }
}

/**
 * The den's own build as the snapshot shows it: { live: { sha, at }, previous: { sha } | null, rolledBack: { sha, at } | null },
 * or null when no release is served (the den then runs from the checkout). `rolledBack` names the release a roll back
 * undid, until another build goes live.
 */
export async function readBuild(stateDir) {
  const [cur, prev] = await Promise.all(["current", "previous"].map((name) => linkedId(stateDir, "ui", name)));
  const current = cur ? await completeRelease(stateDir, cur) : null;
  if (!current) return null;
  const previous = prev && prev !== cur ? await completeRelease(stateDir, prev) : null;
  const record = await readLive(stateDir);
  const mine = record?.sha === current.build.sha ? record : null;
  return {
    live: { sha: current.build.sha, at: mine?.at ?? stamp(current.build.builtAt), ...(current.build.tag ? { tag: current.build.tag } : {}) },
    previous: previous ? { sha: previous.build.sha } : null,
    rolledBack: mine?.rolledBack ?? null,
  };
}

/** The complete release a pair's `current` link points to ({ id, sha, ... } from its build.json), or null. */
export async function currentRelease(stateDir, pair) {
  const id = PAIRS.includes(pair) ? await linkedId(stateDir, pair, "current") : null;
  const release = id ? await completeRelease(stateDir, id) : null;
  return release ? { id, dir: release.dir, ...release.build } : null;
}

const run = (file, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
});

/** Whether commit `sha` is older than `than`: a strict ancestor of it in `repo`. Throws ReleaseError git when git cannot tell. */
export async function isOlder(repo, sha, than) {
  if (checkSha(sha) === checkSha(than)) return false;
  try {
    await run("git", ["-C", repo, "merge-base", "--is-ancestor", sha, than]);
    return true;
  } catch (err) {
    if (err.code === 1) return false;
    throw new ReleaseError("git", `could not compare ${sha.slice(0, 12)} with ${than.slice(0, 12)}: ${String(err.stderr || err.message).trim()}`);
  }
}

// Written beside, then renamed over, like a link (a `.new-` leftover is removed by sweep).
async function writeJson(file, record) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.new-${path.basename(file)}-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(tmp, `${JSON.stringify(record)}\n`);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Records that the bridge release of `sha` failed to start (den-mvp/77). The launcher writes the same file itself. */
export async function recordUpdateFailure(stateDir, { sha, tag, reason }) {
  checkSha(sha);
  await writeJson(path.join(stateDir, "bridge", FAILED), { sha, ...(TAG_RE.test(tag ?? "") ? { tag } : {}), reason: String(reason).slice(0, 500), at: new Date().toISOString() });
}

/** The failed update, every field checked: { sha, tag?, reason, at }, or null. */
export async function readUpdateFailure(stateDir) {
  try {
    const raw = JSON.parse(await readFile(path.join(stateDir, "bridge", FAILED), "utf8"));
    if (!SHA_RE.test(raw?.sha) || typeof raw.reason !== "string" || !stamp(raw.at)) return null;
    return { sha: raw.sha, ...(TAG_RE.test(raw.tag ?? "") ? { tag: raw.tag } : {}), reason: raw.reason.slice(0, 500), at: raw.at };
  } catch {
    return null;
  }
}

/** Forgets the failed update: the user asked for that release again. */
export const clearUpdateFailure = (stateDir) => rm(path.join(stateDir, "bridge", FAILED), { force: true });

/** `git archive` of `sha` unpacked into `dir`: no .git, owner and mode bits not taken from the archive. */
export function extractArchive(repo, sha, dir) {
  return new Promise((resolve, reject) => {
    const git = spawn("git", ["-C", repo, "archive", "--format=tar", sha], { stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-x", "-C", dir, "--no-same-owner", "--no-same-permissions"], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    const note = (chunk) => (err = (err + chunk).slice(-2000));
    git.stderr.on("data", note);
    tar.stderr.on("data", note);
    git.stdout.pipe(tar.stdin);
    tar.stdin.on("error", () => {});
    const codes = [];
    const closed = (which) => (code) => {
      codes[which] = code;
      if (!(0 in codes && 1 in codes)) return;
      if (codes[0] === 0 && codes[1] === 0) resolve();
      else reject(new ReleaseError("git", `git archive failed: ${err.trim() || `exit ${codes.join("/")}`}`));
    };
    git.on("error", reject);
    tar.on("error", reject);
    git.on("close", closed(0));
    tar.on("close", closed(1));
  });
}

const npmCi = (cwd) => run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd }).catch((err) => {
  throw new ReleaseError("build", `npm ci failed: ${String(err.stderr || err.message).trim().slice(-600)}`);
});

// `repo` is the checkout the commits come from; `box` is a build box (build/box.mjs); `npm` and `archive` are seams for tests.
export function createReleases({ stateDir, repo, box, npm = npmCi, main = "main", archive = extractArchive } = {}) {
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir)) throw new TypeError("createReleases: stateDir must be an absolute path");
  const releasesDir = path.join(stateDir, "releases");
  const depsDir = path.join(stateDir, "deps");
  const inflight = new Map();
  const held = new Map(); // sha12 -> how many callers hold it: a release made and still waiting for its switch

  /** Keeps `sha`'s release out of collect() until the returned function is called (this process's switches only). */
  function hold(sha) {
    const id = checkSha(sha).slice(0, 12);
    held.set(id, (held.get(id) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (held.get(id) > 1) held.set(id, held.get(id) - 1);
      else held.delete(id);
    };
  }

  const git = (args) => run("git", ["-C", repo, ...args]);

  async function onMain(sha) {
    try {
      await git(["cat-file", "-e", `${sha}^{commit}`]);
    } catch {
      throw new ReleaseError("not-on-main", `${sha.slice(0, 12)} is not a commit of this repository`);
    }
    try {
      await git(["merge-base", "--is-ancestor", sha, main]);
    } catch (err) {
      if (err.code === 1) throw new ReleaseError("not-on-main", `${sha.slice(0, 12)} is not on ${main}`);
      throw new ReleaseError("git", `could not check ${sha.slice(0, 12)} against ${main}: ${String(err.stderr || err.message).trim()}`);
    }
  }

  /** The installed packages folder for the lockfile of `sha`. Throws `needs-update` when there is none. -> { lock, packages } */
  async function packagesFor(sha) {
    const id = checkSha(sha).slice(0, 12);
    let lockText;
    try {
      lockText = await git(["show", `${sha}:package-lock.json`]);
    } catch {
      throw new ReleaseError("needs-update", `${id} has no package-lock.json; the den must be updated`);
    }
    const lock = lockHash(lockText);
    const packages = path.join(depsDir, lock, "node_modules");
    if (!(await isDir(packages))) throw new ReleaseError("needs-update", `the packages for ${id}'s lockfile are not installed; the den must be updated (npm run den:update) before it can be built`);
    return { lock, packages };
  }

  async function build(sha, signal, tag) {
    const id = sha.slice(0, 12);
    const dir = path.join(releasesDir, id);
    const have = await completeRelease(stateDir, id);
    if (have) {
      if (have.build.sha !== sha) throw new ReleaseError("conflict", `release ${id} is already made from a different commit`);
      if (tag && have.build.tag !== tag) { // the same commit, now released under a tag: record it
        have.build.tag = tag;
        await writeFile(path.join(dir, BUILD), `${JSON.stringify(have.build)}\n`);
      }
      return { id, dir, ...have.build };
    }
    await onMain(sha);
    const { lock, packages } = await packagesFor(sha);
    if (!box) throw new ReleaseError("build", "there is no build box to build in");
    await mkdir(releasesDir, { recursive: true });
    await rm(dir, { recursive: true, force: true }); // an earlier half-made folder: it has no build.json
    await mkdir(dir);
    try {
      await writeFile(path.join(dir, MAKING), `${process.pid}\n`);
      await archive(repo, sha, dir);
      const out = await box.build({ folder: dir, packages, signal });
      if (!out.ok) throw new ReleaseError("build", out.reason ?? "the build failed");
      const record = { sha, builtAt: new Date().toISOString(), lock, ...(tag ? { tag } : {}) };
      await writeFile(path.join(dir, BUILD), `${JSON.stringify(record)}\n`);
      await unlink(path.join(dir, MAKING));
      return { id, dir, ...record };
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }

  /** Makes the release of one commit of `main`, built in the box. Idempotent. Throws a ReleaseError. -> { id, dir, sha, builtAt, lock } */
  function makeRelease(sha, { signal, tag } = {}) {
    checkSha(sha);
    const id = sha.slice(0, 12);
    if (!inflight.has(id)) inflight.set(id, build(sha, signal, tag).finally(() => inflight.delete(id)));
    return inflight.get(id);
  }

  /**
   * Installs the packages of one lockfile (`npm ci --ignore-scripts` in a temporary folder, then renamed into place).
   * It needs the network, so only the install and update commands call it. -> { lock, dir }
   */
  async function makeDeps({ lockfile, packageJson }) {
    if (typeof lockfile !== "string" || typeof packageJson !== "string") throw new TypeError("makeDeps: lockfile and packageJson are the file texts");
    const lock = lockHash(lockfile);
    const dir = path.join(depsDir, lock);
    if (await isDir(path.join(dir, "node_modules"))) return { lock, dir };
    await mkdir(depsDir, { recursive: true });
    const tmp = path.join(depsDir, `.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
    await mkdir(tmp);
    try {
      await writeFile(path.join(tmp, "package.json"), packageJson);
      await writeFile(path.join(tmp, "package-lock.json"), lockfile);
      await npm(tmp);
      if (!(await isDir(path.join(tmp, "node_modules")))) throw new ReleaseError("build", "npm ci left no node_modules folder");
      try {
        await rename(tmp, dir);
      } catch (err) {
        if (!(await isDir(path.join(dir, "node_modules")))) throw err; // someone else made it first: theirs is as good
        await rm(tmp, { recursive: true, force: true });
      }
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      throw err;
    }
    return { lock, dir };
  }

  // A link is replaced by making a new one beside it and renaming it over: a reader sees one release or the other.
  async function setLink(pair, name, id) {
    const folder = path.join(stateDir, pair);
    await mkdir(folder, { recursive: true });
    const tmp = path.join(folder, `.new-${name}-${process.pid}-${randomBytes(4).toString("hex")}`);
    await symlink(`../releases/${id}`, tmp);
    try {
      await rename(tmp, path.join(folder, name));
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  // Written like a link: beside it, then renamed over.
  async function writeLive(record) {
    const folder = path.join(stateDir, "ui");
    const tmp = path.join(folder, `.new-live-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      await writeFile(tmp, `${JSON.stringify(record)}\n`);
      await rename(tmp, path.join(folder, LIVE));
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  /** Deletes every complete release that no link of either pair points to and nobody holds. */
  async function collect() {
    const keep = new Set(held.keys());
    for (const pair of PAIRS) for (const name of ["current", "previous"]) keep.add(await linkedId(stateDir, pair, name));
    for (const name of await readdir(releasesDir).catch(() => [])) {
      if (keep.has(name) || !(await completeRelease(stateDir, name))) continue;
      await rm(path.join(releasesDir, name), { recursive: true, force: true });
    }
  }

  async function switchPair(pair, sha, { downgrade = false } = {}) {
    checkSha(sha);
    const id = sha.slice(0, 12);
    const release = await completeRelease(stateDir, id);
    if (!release || release.build.sha !== sha) throw new ReleaseError("missing", `there is no complete release for ${id}`);
    const cur = await linkedId(stateDir, pair, "current");
    if (cur !== id) {
      if (pair === "bridge") {
        const running = cur ? (await completeRelease(stateDir, cur))?.build.sha : null;
        const older = running ? await isOlder(repo, sha, running) : false;
        if (older && !downgrade) throw new ReleaseError("older", `${id} is older than the running release ${cur}; name it to go back to it`);
        // The launcher starts an older bridge/current only with this consent, which names that one release.
        if (older) await writeJson(path.join(stateDir, pair, DOWNGRADE), { sha });
        else await rm(path.join(stateDir, pair, DOWNGRADE), { force: true });
      }
      if (cur) await setLink(pair, "previous", cur);
      await setLink(pair, "current", id);
      if (pair === "ui") await writeLive({ sha, at: new Date().toISOString(), rolledBack: null });
    }
    // den-mvp/77: only a UI switch collects. A bridge switch leaves every release in place, so the one the launcher may
    // fall back to, or a release made ahead of its switch, is still there; the UI switch that comes with it cleans up.
    if (pair === "ui") await collect();
  }

  /** Points ui/current at the release of `sha`; the release it replaces becomes ui/previous, and a release no link points to is deleted. */
  const switchUi = (sha) => switchPair("ui", sha);
  /**
   * The same for bridge/current and bridge/previous, without deleting any release. A release older than the running one
   * (a strict git ancestor) is refused with code `older` unless `downgrade` says the user named it.
   */
  const switchBridge = (sha, { downgrade = false } = {}) => switchPair("bridge", sha, { downgrade });

  /** Swaps ui/current and ui/previous. `to` names the release the caller saw as previous (its sha, or its 12 characters); anything else is a conflict. */
  async function rollbackUi(to) {
    if (typeof to !== "string" || !(SHA_RE.test(to) || SHA12_RE.test(to))) throw new ReleaseError("bad-sha", "a roll back names the release to return to by its commit id");
    const want = to.slice(0, 12);
    const [cur, prev] = await Promise.all(["current", "previous"].map((name) => linkedId(stateDir, "ui", name)));
    if (prev !== want) throw new ReleaseError("conflict", `ui/previous is ${prev ?? "empty"}, not ${want}`);
    const back = await completeRelease(stateDir, prev);
    if (!back) throw new ReleaseError("missing", `there is no complete release for ${prev}`);
    const left = cur ? await completeRelease(stateDir, cur) : null;
    const before = await readLive(stateDir);
    await setLink("ui", "current", prev);
    if (cur) await setLink("ui", "previous", cur);
    // Going back to the release an earlier roll back undid puts things as they were: nothing is rolled back any more.
    const at = new Date().toISOString();
    const redone = before?.sha === left?.build.sha && before?.rolledBack?.sha === back.build.sha;
    await writeLive({ sha: back.build.sha, at, rolledBack: redone || !left ? null : { sha: left.build.sha, at } });
    await collect();
  }

  /**
   * At start: removes every folder under releases/ that is not a release (no build.json) unless another live process is
   * making it, and the temporary leftovers of a link switch or a package install.
   */
  async function sweep() {
    for (const name of await readdir(releasesDir).catch(() => [])) {
      const dir = path.join(releasesDir, name);
      if (!(await isDir(dir)) || (await isFile(path.join(dir, BUILD)))) continue;
      if (madeByOther(await readFile(path.join(dir, MAKING), "utf8").catch(() => ""))) continue;
      await rm(dir, { recursive: true, force: true });
    }
    for (const name of await readdir(depsDir).catch(() => [])) {
      if (name.startsWith(".tmp-") && !madeByOther(/^\.tmp-(\d+)-/.exec(name)?.[1] ?? "")) await rm(path.join(depsDir, name), { recursive: true, force: true });
    }
    for (const pair of PAIRS) {
      for (const name of await readdir(path.join(stateDir, pair)).catch(() => [])) {
        if (name.startsWith(".new-")) await rm(path.join(stateDir, pair, name), { force: true });
      }
    }
  }

  return { makeRelease, makeDeps, packagesFor, hold, switchUi, switchBridge, rollbackUi, sweep, paths: { releasesDir, depsDir } };
}
