// den-mvp/86: an update applies itself when nothing is running.
//   createUpdater({ stateDir, releases, ready, busy, stop, exit, onChange, onDrain, pollMs? }) -> { ready, snapshot, check, updateNow, restartNow, setAuto, stop }
//   stateDir  the den's state folder; the setting is stateDir/update.json { auto, failedSeen? }, with the update on by default
//   releases  build/releases.mjs createReleases' object (switchBridge, switchUi)
//   ready     () -> the ready release's view ({ state: "ready", tag, sha, ... }) or null (build/ready-release.mjs)
//   busy      () -> true while a run, a delivery step or a meeting is live (the drain waits for it, for as long as it takes)
//   stop      async: ends the bridge's work as an ordinary shutdown does (runs pause; deliveries and meetings wait for Resume)
//   exit      (code) -> the process exit; none in a test that does not want one
// Draining: the host and the routes refuse new runs, naming the update. When busy() is false the bridge writes the release to
// start (bridge/current and ui/current), stops its work and exits; the launcher (service/den-launcher.mjs) starts the release.
// A release the launcher could not start (bridge/failed.json, newer than the last time the user turned the setting on)
// turns the setting off at start, until the user turns it on.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { clearUpdateFailure, readUpdateFailure } from "./releases.mjs";

const POLL_MS = 1000;
export const DRAIN_TEXT = (tag) => `the den is updating${tag ? ` to ${tag}` : ""}; it takes no new run until it restarts`;

export function createUpdater({ stateDir, releases, ready: readyView, busy, stop, exit, onChange = () => {}, onDrain = () => {}, pollMs = POLL_MS }) {
  const file = path.join(stateDir, "update.json");
  let auto = true;
  let failedSeen = null;
  let draining = null; // { tag, sha, mode } while an update waits for the work to end
  let timer = null;
  let applying = null;
  let applied = false; // the release is written and the bridge is leaving: nothing is done twice
  let lastError = null;

  const save = async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(`${file}.tmp`, `${JSON.stringify({ auto, ...(failedSeen ? { failedSeen } : {}) })}\n`);
    await rename(`${file}.tmp`, file);
  };
  const view = () => ({ auto, draining: draining !== null, ...(draining?.tag ? { tag: draining.tag } : {}), ...(lastError ? { error: lastError } : {}) });
  const publish = () => onChange({ type: "update", update: view() });

  const loaded = (async () => {
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      if (typeof raw?.auto === "boolean") auto = raw.auto;
      if (typeof raw?.failedSeen === "string") failedSeen = raw.failedSeen;
    } catch {}
    const failed = await readUpdateFailure(stateDir);
    if (failed && failed.at !== failedSeen) {
      auto = false;
      failedSeen = failed.at;
      await save().catch(() => {});
    }
  })();

  async function apply() {
    const { sha, tag } = draining;
    try {
      await releases.switchBridge(sha);
      await releases.switchUi(sha);
    } catch (err) {
      lastError = `the update to ${tag ?? sha.slice(0, 12)} was not applied: ${String(err?.message ?? err).slice(0, 300)}`;
      draining = null;
      onDrain(null);
      clearInterval(timer);
      timer = null;
      return publish();
    }
    applied = true;
    clearInterval(timer);
    await stop();
    exit?.(0);
  }

  function tick() {
    if (!draining || applying || applied) return;
    if (busy()) return;
    applying = apply().finally(() => (applying = null));
  }

  async function begin(mode) {
    const release = readyView();
    if (draining) return { ok: true, status: 200, started: false, reason: "the update is already draining", update: view() };
    if (release?.state !== "ready") return { ok: true, status: 200, started: false, reason: "no update is ready", update: view() };
    lastError = null;
    draining = { sha: release.sha, tag: release.tag, mode };
    onDrain(DRAIN_TEXT(release.tag));
    timer = setInterval(tick, pollMs);
    timer.unref?.();
    // The user asking for the release again forgets its earlier failure; the launcher would not start it otherwise.
    if (mode === "manual") await clearUpdateFailure(stateDir).catch(() => {});
    publish();
    tick();
    return { ok: true, status: 202, started: true, update: view() };
  }

  return {
    ready: loaded,
    snapshot: view,
    /** The refusal text a new run gets while draining, or null. */
    drainingText: () => (draining ? DRAIN_TEXT(draining.tag) : null),
    /** With the setting on and a release ready, starts the drain. Called when the ready release changes. */
    async check() {
      await loaded;
      if (auto && !draining && readyView()?.state === "ready") await begin("auto");
    },
    /** "Update now": the same drain with the setting off or on. */
    async updateNow() {
      await loaded;
      return begin("manual");
    },
    /** "Restart now": running work stops as in an ordinary restart (runs pause and need Resume); nothing is lost. */
    async restartNow() {
      await loaded;
      await stop();
      exit?.(0);
      return { ok: true, status: 202 };
    },
    async setAuto(value) {
      await loaded;
      auto = value;
      await save();
      publish();
      if (auto) await this.check();
      return view();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
