// den-v1 loop S0 (ADR 0016 decisions 3 and 6.6, amendment 7), amended by agent-os/09 (ADR 0021 Amendment 2, decision 17): the agent
// workspace. Every bridge-started agent gets one git worktree, so its working directory is never the repo root. The worktree is
// created DETACHED: the agent holds no branch, so the sandbox can deny every ref of the main .git. The bridge creates the branch
// (den/<ref>-<short>) at the agent's final commit when the agent ends. The names are a pure function of the validated ref and the
// bridge-minted agent id; git runs through execFile with an argument list, never a shell.
// A worktree is a working-directory convention, not a security boundary: nothing here confines the child.
import { execFile } from "node:child_process";
import { access, appendFile, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { AGENT_ID_RE, REF_RE, WORKSPACE_BRANCH_PREFIX, WORKTREES_DIR } from "./policy.mjs";

const exists = (p) => access(p).then(() => true, () => false);
const BRIEF_NAMES = ["findings.md", "meeting.md", "ticket.md"]; // the notes the bridge leaves in a worktree's .den/
const execFileP = promisify(execFile);

// The one shape a published branch may have: what workspaceNames derives (a ref's slashes kept, then "-" and 8 hex of the agent id).
export const PUBLISH_BRANCH_RE = new RegExp(`^${WORKSPACE_BRANCH_PREFIX}/[a-z0-9][a-z0-9-]*/\\d{2,}-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$`);

const COMMIT_RE = /^[0-9a-f]{40,64}$/;

/** { worktree, branch } for one agent: the worktree's repo-relative path and its branch. Throws on a bad ref or id. */
export function workspaceNames({ ref, agentId } = {}) {
  if (typeof ref !== "string" || !REF_RE.test(ref)) throw new TypeError("workspace: ref must look like <feature>/<NN>-<slug>");
  if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) throw new TypeError("workspace: agentId must be a bridge-minted agent id");
  const short = agentId.slice(2, 10); // 32 of the id's 64 random bits: unique per agent, so a ticket's second run gets a new worktree
  return {
    worktree: `${WORKTREES_DIR}/${WORKSPACE_BRANCH_PREFIX}-${ref.replace("/", "-")}-${short}`,
    branch: `${WORKSPACE_BRANCH_PREFIX}/${ref}-${short}`,
  };
}

// exec is a test seam with execFile's promise shape: (file, args) -> Promise<{ stdout }>.
export function createWorkspaces(root, { exec = execFileP } = {}) {
  const git = (...args) => exec("git", ["-C", root, ...args]);
  const out = async (dir, ...args) => String((await exec("git", ["-C", dir, ...args])).stdout).trim();
  async function moveUp(dir) {
    const [here, main] = [await out(dir, "rev-parse", "HEAD"), await out(root, "rev-parse", "HEAD")];
    if (here === main || (await out(dir, "status", "--porcelain", "--untracked-files=no")) !== "") return;
    const behind = await exec("git", ["-C", root, "merge-base", "--is-ancestor", here, main]).then(() => true, () => false);
    if (behind) await exec("git", ["-C", dir, "checkout", "-q", "--detach", main]);
  }
  return {
    // -> { dir, worktree, branch }: `dir` is the resolved absolute path the child runs in. `branch` is only the name to publish to.
    // den-mvp outcome 3: `base` is the commit a delivery step starts from (a full commit id the bridge recorded); without it, HEAD.
    async create({ ref, agentId, base } = {}) {
      const { worktree, branch } = workspaceNames({ ref, agentId });
      if (base !== undefined && (typeof base !== "string" || !COMMIT_RE.test(base))) throw new TypeError("workspace: base must be a full commit id");
      await git("worktree", "add", "--detach", path.join(root, ...worktree.split("/")), base ?? "HEAD");
      return { dir: await realpath(path.join(root, ...worktree.split("/"))), worktree, branch };
    },
    // The commit a worktree is at now. -> a full commit id.
    async head({ dir } = {}) {
      const sha = String((await exec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout).trim();
      if (!COMMIT_RE.test(sha)) throw new Error("workspace: the worktree has no commit");
      return sha;
    },
    // den-mvp outcome 3: the bridge's note to a delivery step (a review's findings for a fix round), written to
    // <worktree>/.den/findings.md. `.den/` is added once to the repository's own exclude file, so no commit carries it.
    // den-mvp outcome 4: a meeting run's note (the topic, the takes) is written the same way, as .den/meeting.md.
    async brief({ dir } = {}, text, name = "findings.md") {
      if (!BRIEF_NAMES.includes(name)) throw new TypeError("workspace: unknown note name");
      const common = String((await exec("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout).trim();
      const exclude = path.join(common, "info", "exclude");
      const current = await readFile(exclude, "utf8").catch(() => "");
      if (!current.split("\n").includes(".den/")) {
        await mkdir(path.dirname(exclude), { recursive: true });
        await appendFile(exclude, `${current === "" || current.endsWith("\n") ? "" : "\n"}.den/\n`);
      }
      // The worktree is at a commit an agent made, which may carry its own `.den`, a link out of the worktree included.
      // Whatever is there is removed without being followed, and the file is created new, never opened through a link.
      const den = path.join(dir, ".den");
      await rm(den, { recursive: true, force: true });
      await mkdir(den);
      await writeFile(path.join(den, name), text, { mode: 0o600, flag: "wx" });
    },
    // den-mvp outcome 2: the worktree of an earlier run (`origin`), reopened for a follow-up by a new run. Nothing is created:
    // the directory must still be a worktree of this repository at the derived path, or this rejects. `base` is its HEAD
    // now, so publish can tell whether the follow-up committed anything. -> { dir, worktree, branch, base, reopened: true }.
    // `catchUp` (Bao's desk, which reopens one worktree for every message): a worktree with no change of its own whose
    // HEAD is behind the root's moves up to it first, so the run reads today's repository, its role file included.
    async reopen({ ref, agentId, origin, catchUp = false } = {}) {
      const { worktree } = workspaceNames({ ref, agentId: origin });
      const { branch } = workspaceNames({ ref, agentId });
      const dir = await realpath(path.join(root, ...worktree.split("/")));
      const listed = String((await git("worktree", "list", "--porcelain")).stdout).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
      const resolved = await Promise.all(listed.map((p) => realpath(p).catch(() => p)));
      if (!resolved.includes(dir)) throw new Error("workspace: the earlier run's directory is no longer a worktree of this repository");
      if (catchUp) await moveUp(dir);
      const base = String((await exec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout).trim();
      return { dir, worktree, branch, base, reopened: true };
    },
    // Creates `branch` in the main checkout at the worktree's current HEAD (the agent's final commit). Never moves a branch that
    // already exists (git branch refuses), and only a derived den/ name is accepted. -> { branch, sha }, or null for a reopened
    // worktree whose HEAD has not moved (a follow-up that committed nothing publishes nothing).
    async publish({ dir, branch, base } = {}) {
      if (typeof branch !== "string" || !PUBLISH_BRANCH_RE.test(branch)) throw new TypeError("workspace: not a den agent branch name");
      if (typeof dir !== "string" || dir === "") throw new TypeError("workspace: publish needs the worktree directory");
      const sha = String((await exec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout).trim();
      if (!COMMIT_RE.test(sha)) throw new Error("workspace: the worktree has no commit to publish");
      if (base !== undefined && sha === base) return null;
      await git("branch", branch, sha);
      return { branch, sha };
    },
    // den-mvp/43: removes a finished run's worktree and its published den/ branch. Nothing is lost: a change in the worktree
    // is committed to wip/<ref>-<short> first, and a HEAD that is not on main (and not merged on the host) is kept there too. Untracked files
    // under .agents/skills/ (the copies every worktree carries) and ignored files are not changes.
    // -> { removed, saved }: `saved` is the wip branch or null. A worktree that is already gone removes nothing.
    async retire({ ref, agentId, merged = false } = {}) {
      const { worktree, branch } = workspaceNames({ ref, agentId });
      const dir = path.join(root, ...worktree.split("/"));
      const short = agentId.slice(2, 10);
      const wip = `wip/${ref.replace("/", "-")}-${short}`;
      let saved = null;
      let removed = false;
      if (await exists(dir)) {
        const status = await out(dir, "status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).agents/skills", ":(exclude).den");
        const author = ["-c", "user.name=den", "-c", "user.email=den@localhost"];
        if (status !== "") {
          await exec("git", ["-C", dir, "checkout", "-q", "-b", wip]);
          await exec("git", ["-C", dir, "add", "-A", "--", ".", ":(exclude).agents/skills", ":(exclude).den"]);
          await exec("git", ["-C", dir, ...author, "commit", "-q", "--no-verify", "-m", `den: unsaved work of ${ref} (${short})`]);
          saved = wip;
        } else {
          const here = await out(dir, "rev-parse", "HEAD");
          // `merged`: the delivery's pull request was merged on the git host, so the commit is there even though the
          // checkout's HEAD has not moved (and a squash merge makes a new commit): nothing is left to keep.
          const onMain = merged || await exec("git", ["-C", root, "merge-base", "--is-ancestor", here, "HEAD"]).then(() => true, () => false);
          if (!onMain) {
            await git("branch", wip, here);
            saved = wip;
          }
        }
        await git("worktree", "remove", "--force", dir);
        removed = true;
      }
      // The branch's commit is on main or on the wip branch, so deleting it loses nothing; a branch that was never made is fine.
      await git("branch", "-D", branch).catch(() => {});
      return { removed, saved };
    },
    // Undoes a create whose agent never started. Best effort: a leftover is reported by scripts/worktree-gc.mjs.
    // A reopened worktree belongs to an earlier run and is never removed here.
    async remove({ dir, branch, reopened }) {
      if (reopened) return;
      await git("worktree", "remove", "--force", dir).catch(() => {});
      await git("branch", "-D", branch).catch(() => {});
    },
  };
}

// agent-os/09: the main .git's deny targets must exist before the spawn, because the CLI's sandbox binds a deny on a path that is
// missing and git then fails in the worktree. A repo that was never packed has no packed-refs: the bridge makes one (no refs lost,
// nothing pruned). `refs` and `HEAD` exist in any repository. A missing index cannot be made safely, so the spawn is refused.
const GIT_TARGETS = ["refs", "HEAD", "packed-refs", "index"];

/** Makes every deny target of the main .git exist, or rejects. -> { mainGit }: the resolved <root>/.git the host hands to the runtime. */
export async function prepareMainGit(root, { exec = execFileP } = {}) {
  const mainGit = path.join(await realpath(root), ".git");
  const info = await lstat(mainGit).catch(() => null);
  if (info === null || !info.isDirectory()) throw new Error("the main checkout's .git is not a directory");
  const missing = async () => {
    const out = [];
    for (const target of GIT_TARGETS) if (!(await exists(path.join(mainGit, target)))) out.push(target);
    return out;
  };
  let lacking = await missing();
  if (lacking.includes("packed-refs")) {
    // A failed attempt (another spawn holds the lock) is judged by whether the file is there afterwards.
    await exec("git", ["-C", root, "pack-refs", "--all", "--no-prune"]).catch(() => {});
    lacking = await missing();
  }
  if (lacking.length > 0) throw new Error(`the main checkout's .git lacks ${lacking.join(", ")}`);
  return { mainGit };
}
