// den-mvp/77 (ADR 0026 Amendment 1): what the den's unit runs instead of the bridge. `den:install` copies this file to
// <state>/launcher/den-launcher.mjs, outside every release, and no release or update rewrites it; so it imports only node:
// built-ins and repeats the few names it shares with build/releases.mjs (the links, bridge/failed.json, bridge/downgrade.json).
//   createLauncher({ stateDir, repo, ... }).launch()
//     starts the bridge release bridge/current names and waits until the den answers. A release that exits or does not
//     answer in time is stopped, recorded in bridge/failed.json, and bridge/current goes back to bridge/previous, which is
//     started instead. A recorded failure is not started again, and an older release only with the user's say
//     (bridge/downgrade.json, written by switchBridge(sha, { downgrade: true })).
// Run as a script (DEN_STATE_DIR and PORT in the environment, the checkout as cwd) it launches, then supervises: a SIGTERM
// stops the bridge and exits 143; a bridge that exits on its own makes the launcher exit 1, so the unit's Restart= applies.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LINK_RE = /^\.\.\/releases\/([0-9a-f]{12})$/;
const TAG_RE = /^v\d+\.\d+\.\d+$/;

class Stopped extends Error {}

export function createLauncher({ stateDir, repo, node = process.execPath, port = 4317, checkMs = 30_000, pollMs = 500 }) {
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir)) throw new TypeError("createLauncher: stateDir must be an absolute path");
  const bridgeDir = path.join(stateDir, "bridge");
  let stopped = false;
  let active = null;

  const readJson = (name) => readFile(path.join(bridgeDir, name), "utf8").then(JSON.parse, () => null).catch(() => null);

  // The complete release a bridge link points to: { id, dir, sha, tag? }, or null.
  async function linked(name) {
    try {
      const id = LINK_RE.exec(await readlink(path.join(bridgeDir, name)))?.[1];
      if (!id) return null;
      const dir = path.join(stateDir, "releases", id);
      const build = JSON.parse(await readFile(path.join(dir, "build.json"), "utf8"));
      if (!SHA_RE.test(build?.sha) || !build.sha.startsWith(id)) return null;
      return { id, dir, sha: build.sha, ...(TAG_RE.test(build.tag ?? "") ? { tag: build.tag } : {}) };
    } catch {
      return null;
    }
  }

  // Beside, then renamed over, as build/releases.mjs writes them.
  async function replace(name, make) {
    const tmp = path.join(bridgeDir, `.new-${name}-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      await make(tmp);
      await rename(tmp, path.join(bridgeDir, name));
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
  const record = (rel, reason) => replace("failed.json", (tmp) => writeFile(tmp, `${JSON.stringify({ sha: rel.sha, ...(rel.tag ? { tag: rel.tag } : {}), reason, at: new Date().toISOString() })}\n`));

  // Whether `sha` is a strict git ancestor of `than`: true, false, or "unknown" when git cannot tell. Unknown is refused,
  // as releases.mjs isOlder refuses it (security review of den-mvp/77: fail closed).
  const older = (sha, than) => sha !== than && new Promise((resolve) => {
    execFile("git", ["-C", repo, "merge-base", "--is-ancestor", sha, than], { timeout: 10_000 }, (err) => resolve(!err ? true : err.code === 1 ? false : "unknown"));
  });

  // Starts one release and waits for the den to answer: { ok: true, child } or { ok: false, reason } with the child gone.
  async function start(rel) {
    if (stopped) throw new Stopped("stopped");
    const child = spawn(node, [path.join(rel.dir, "apps", "bridge", "server.mjs")], { env: { ...process.env, PORT: String(port) }, stdio: "inherit" });
    active = child;
    let exit = null;
    const gone = new Promise((resolve) => {
      child.on("exit", (code, signal) => resolve((exit = signal ? `signal ${signal}` : `code ${code}`)));
      child.on("error", (err) => resolve((exit ??= err.message)));
    });
    const deadline = Date.now() + checkMs;
    while (!exit && !stopped && Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual", signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
        await res.arrayBuffer();
        if (res.status === 200 && !exit) return { ok: true, child };
      } catch {}
      await Promise.race([gone, new Promise((r) => setTimeout(r, pollMs))]);
    }
    const exited = exit;
    if (!exited) {
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await gone;
      clearTimeout(killer);
    }
    if (stopped) throw new Stopped("stopped");
    return { ok: false, reason: exited ? `the release exited (${exited}) before the den answered` : `the den did not answer on port ${port} within ${checkMs / 1000} seconds` };
  }

  async function launch() {
    const [cur, prev] = await Promise.all([linked("current"), linked("previous")]);
    if (!cur) throw new Error(`bridge/current names no complete release under ${stateDir}`);
    const failed = await readJson("failed.json");
    const consent = await readJson("downgrade.json");
    let why = null;
    let age;
    if (failed?.sha === cur.sha) why = `it failed before (${failed.reason})`;
    else if (prev && consent?.sha !== cur.sha && (age = await older(cur.sha, prev.sha))) {
      why = age === "unknown" ? `git could not compare it with ${prev.id}` : `it is older than ${prev.id} and the user did not name it`;
      await record(cur, why);
    } else {
      const out = await start(cur);
      if (out.ok) return { sha: cur.sha, ...(cur.tag ? { tag: cur.tag } : {}), child: out.child, rolledBack: false };
      why = out.reason;
      await record(cur, why);
    }
    if (!prev || prev.sha === cur.sha) throw new Error(`the bridge release ${cur.id} was not started (${why}) and there is no previous release`);
    // bridge/current names the previous release again, so a crash restart cannot start the bad one; previous stays.
    await replace("current", (tmp) => symlink(`../releases/${prev.id}`, tmp));
    const back = await start(prev);
    if (!back.ok) throw new Error(`the bridge release ${cur.id} was not started (${why}), and the previous one ${prev.id} failed too: ${back.reason}`);
    return { sha: prev.sha, ...(prev.tag ? { tag: prev.tag } : {}), child: back.child, rolledBack: true };
  }

  /** Stops the bridge being started or run; a launch in progress then rejects without recording a failure. */
  function stop() {
    stopped = true;
    active?.kill("SIGTERM");
  }

  return { launch, stop };
}

// import.meta.url is the real path; argv[1] is as the unit gave it, possibly through a symlinked state dir (server.mjs does the same).
const startedDirectly = () => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

if (startedDirectly()) {
  const launcher = createLauncher({ stateDir: process.env.DEN_STATE_DIR, repo: process.cwd(), port: Number(process.env.PORT) || 4317 });
  let stopping = false;
  process.on("SIGTERM", () => {
    stopping = true;
    launcher.stop();
  });
  try {
    const { sha, child, rolledBack } = await launcher.launch();
    console.log(`den-launcher: the bridge ${sha.slice(0, 12)} answers${rolledBack ? " (rolled back; see bridge/failed.json)" : ""}`);
    const done = () => process.exit(stopping ? 143 : 1);
    if (child.exitCode !== null || child.signalCode !== null) done();
    child.on("exit", done);
  } catch (err) {
    if (stopping) process.exit(143);
    console.error(`den-launcher: ${err.message}`);
    process.exit(1);
  }
}
