// den-mvp/85: the bridge tags a patch release when a bridge change is merged. It polls the git host, as the CI watch does
// (code, no model). A merge counts when it touches a bridge path (release-paths.mjs). It is tagged only when every such merge
// since the last tag was made by the user's login; the tag goes on the merge commit of the newest of them, and an existing
// tag is never reused or moved. A minor or major bump stays Bao's draft (release-draft.mjs). No agent tool reaches this:
// only the timer in server.mjs calls poll().
import { nextVersion } from "./release-draft.mjs";
import { touchesBridge } from "./release-paths.mjs";

export const POLL_MS = 5 * 60 * 1000;
const errorText = (err) => String(err?.stderr || err?.message || err).replace(/\s+/g, " ").trim().slice(0, 300) || "unknown error";

/**
 * git: mainSha, lastTag, login, tagExists, mergedPrs, publishRelease (delivery/git-host.mjs).
 * mergedPrs({ tag, sha }) -> newest first [{ number, title, sha, mergedBy, files }].
 * -> { poll() -> { tagged: version | null, why? }, snapshot() }
 */
export function createAutoRelease({ git, onChange = () => {}, pollMs = POLL_MS }) {
  let last = null;
  let timer = null;
  let polling = null;
  let stopped = false;

  async function once() {
    const sha = await git.mainSha();
    const tag = await git.lastTag();
    const prs = await git.mergedPrs({ tag, sha });
    const bridge = prs.filter((p) => touchesBridge(p.files));
    if (bridge.length === 0) return { tagged: null, why: "no bridge change since the last tag" };
    const login = await git.login();
    if (!login || bridge.some((p) => p.mergedBy !== login)) return { tagged: null, why: "a bridge change was not merged by the user's login" };
    const newest = bridge[0]; // prs are newest first
    const version = nextVersion(tag, "patch");
    if (await git.tagExists(version)) return { tagged: null, why: `${version} already exists` };
    const upTo = prs.slice(prs.indexOf(newest));
    const notes = `## ${version}\n\n${upTo.map((p) => `- ${String(p.title).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 200)} (#${p.number})`).join("\n")}\n`;
    await git.publishRelease({ version, sha: newest.sha, notes });
    return { tagged: version, sha: newest.sha };
  }

  const poll = () => (polling ??= once().catch((err) => ({ tagged: null, error: `the release tagger could not look: ${errorText(err)}` })).then((r) => {
    last = r;
    onChange({ type: "release-auto", result: r });
    return r;
  }).finally(() => (polling = null)));

  return {
    poll,
    snapshot: () => last,
    start() {
      const tick = () => poll().finally(() => {
        if (stopped) return;
        timer = setTimeout(tick, pollMs);
        timer.unref?.();
      });
      timer = setTimeout(tick, 15000);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
