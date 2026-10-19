// den-mvp/85: the den builds the newest release ahead of the user's update and says it is ready. When the newest v* tag is
// newer than the running bridge release, the release of that tag is made in the build box (releases.makeRelease: the box,
// the resource-group launcher, the packages of an installed lockfile) into its staging folder under releases/. No link is
// switched and nothing restarts. A lockfile whose packages are not installed is shown as "needs den:update", not built (only
// den:update uses the network). A failed build is recorded with its reason and is not tried again until a newer tag exists.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ReleaseError, currentRelease, isOlder } from "./releases.mjs";

export const POLL_MS = 5 * 60 * 1000;
const TAG_RE = /^v\d+\.\d+\.\d+$/;
const SHA_RE = /^[0-9a-f]{40,64}$/;
const text = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, max);

/**
 * git: lastTag, tagSha, mergedSince. releases: createReleases' object. stateDir: the den's state folder. The failure record is
 * stateDir/ready-failed.json. snapshot() -> null | { state: "building"|"ready"|"failed"|"needs-update", tag, sha, prs, reason? }
 */
export function createReadyRelease({ git, releases, stateDir, repo, onChange = () => {}, pollMs = POLL_MS }) {
  const file = path.join(stateDir, "ready-failed.json");
  let view = null;
  let letGo = null; // the hold that keeps a ready release from being collected
  let timer = null;
  let polling = null;
  let stopped = false;

  const set = (v) => {
    view = v;
    onChange({ type: "ready-release", readyRelease: view });
  };
  const failure = async () => {
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      return TAG_RE.test(raw?.tag) ? { tag: raw.tag, reason: text(raw.reason, 500) } : null;
    } catch {
      return null;
    }
  };
  const record = async (f) => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(`${file}.tmp`, `${JSON.stringify(f)}\n`);
    await rename(`${file}.tmp`, file);
  };
  const drop = () => {
    letGo?.();
    letGo = null;
  };

  async function once() {
    const tag = await git.lastTag();
    const running = await currentRelease(stateDir, "bridge");
    if (!tag || !running) return drop(), set(null);
    const sha = await git.tagSha(tag);
    if (!SHA_RE.test(sha) || !(await isOlder(repo, running.sha, sha))) return drop(), set(null); // not newer than what runs
    if (view?.state === "ready" && view.tag === tag) return;
    const failed = await failure();
    if (failed?.tag === tag) return set({ state: "failed", tag, sha, prs: [], reason: failed.reason });
    set({ state: "building", tag, sha, prs: [] });
    try {
      await releases.makeRelease(sha, { tag });
    } catch (err) {
      if (err instanceof ReleaseError && err.code === "needs-update") return set({ state: "needs-update", tag, sha, prs: [], reason: "needs den:update" });
      const reason = text(err?.message ?? err, 500) || "the build failed";
      await record({ tag, reason }).catch(() => {});
      return set({ state: "failed", tag, sha, prs: [], reason });
    }
    drop();
    letGo = releases.hold(sha);
    const prs = (await git.mergedSince({ tag: null, sha, base: running.sha }).catch(() => [])).map((p) => ({ number: p.number, title: text(p.title, 200) }));
    set({ state: "ready", tag, sha, prs });
  }

  const poll = () => (polling ??= once().catch((err) => set(view ? { ...view, reason: text(err?.message, 300) } : null)).finally(() => (polling = null)));

  return {
    poll,
    snapshot: () => view,
    start() {
      const tick = () => poll().finally(() => {
        if (stopped) return;
        timer = setTimeout(tick, pollMs);
        timer.unref?.();
      });
      timer = setTimeout(tick, 30000);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
