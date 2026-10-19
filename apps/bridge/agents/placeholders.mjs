// den-mvp/28: the sandbox mounts an empty read-only file over a denied path that does not exist, and the file outlives the run
// (.git/config.lock in the main checkout, .bash_profile in the worktree). The runtime snapshots which candidates exist before a
// run and removes, after it, the ones the run created that are still empty and read-only. Nothing else is touched.
import { lstat, unlink } from "node:fs/promises";
import path from "node:path";

// The live list (ticket 28, comments): what walled runs left in three worktrees, plus the one lock seen in the main .git.
const GIT_CANDIDATES = ["config.lock"];
const WORKTREE_CANDIDATES = [".bash_profile", ".bashrc", ".profile", ".zshrc", ".zprofile", ".gitconfig", ".gitmodules", ".mcp.json",
  ".ripgreprc", ".vscode", ".idea", "Jenkinsfile", ".gitlab-ci.yml", ".github/CODEOWNERS"];

const present = (p) => lstat(p).then(() => true, () => false);

export async function snapshotPlaceholders({ mainGit, worktree } = {}) {
  const candidates = [
    ...(typeof mainGit === "string" ? GIT_CANDIDATES.map((n) => path.join(mainGit, n)) : []),
    ...(typeof worktree === "string" ? WORKTREE_CANDIDATES.map((n) => path.join(worktree, n)) : []),
  ];
  const existed = new Set();
  await Promise.all(candidates.map(async (p) => { if (await present(p)) existed.add(p); }));
  return { candidates, existed, mainGit: typeof mainGit === "string" ? mainGit : null };
}

/** Removes each candidate (new, or stale in the main .git) that is an empty regular file with no write bit. Never throws. */
export async function sweepPlaceholders({ candidates, existed, mainGit = null }) {
  await Promise.all(candidates.map(async (p) => {
    // A path in the main .git is never tracked content, and a live git lock is writable: an empty read-only file or a
    // read-only file there is a placeholder even if it predates this run (a stale one from an earlier run). The worktree
    // holds tracked files, so only what this run created is eligible there. A bind another live run holds fails to unlink (EBUSY).
    if (existed.has(p) && !(mainGit !== null && p.startsWith(mainGit + path.sep))) return;
    try {
      const info = await lstat(p);
      if (info.isFile() && info.size === 0 && (info.mode & 0o222) === 0) await unlink(p);
    } catch { /* gone, or not ours to remove */ }
  }));
}
