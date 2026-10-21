// den-v1 loop S0 (ADR 0016 decisions 3 and 6.6, amendment 7), amended by agent-os/09 (ADR 0021 Amendment 2, decision 17): the agent
// workspace. Every bridge-started agent gets one git worktree, so its working directory is never the repo root. The worktree is
// created DETACHED: the agent holds no branch, so the sandbox can deny every ref of the main .git. The bridge creates the branch
// (den/<ref>-<short>) at the agent's final commit when the agent ends. The names are a pure function of the validated ref and the
// bridge-minted agent id; git runs through execFile with an argument list, never a shell.
// A worktree is a working-directory convention, not a security boundary: nothing here confines the child.
import { execFile } from "node:child_process";
import { access, appendFile, chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { AGENT_ID_RE, REF_RE, WORKSPACE_BRANCH_PREFIX, WORKTREES_DIR } from "./policy.mjs";

const exists = (p) => access(p).then(() => true, () => false);
const BRIEF_NAMES = ["findings.md", "meeting.md", "ticket.md"]; // the notes the bridge leaves in a worktree's .den/
const execFileP = promisify(execFile);

// The one shape a published branch may have: what workspaceNames derives (a ref's slashes kept, then "-" and 8 hex of the agent id).
export const PUBLISH_BRANCH_RE = new RegExp(`^${WORKSPACE_BRANCH_PREFIX}/[a-z0-9][a-z0-9-]*/\\d{2,}-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$`);

const COMMIT_RE = /^[0-9a-f]{40,64}$/;
const MANAGED_COMMIT_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const safeGitArgs = ["-c", "protocol.allow=never", "-c", "core.fsmonitor=false", "-c", "core.sparseCheckout=false", "-c", "index.sparse=false"];
const managedPath = (name) => typeof name === "string" && !/[:\\\x00-\x1f\x7f\ufffd]/.test(name) && !path.posix.isAbsolute(name) && name.split("/").every((part) => part && ![".", ".."].includes(part) && !/[ .]$/.test(part) && !/^\.git$/i.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) && !/^(?:\.den|\.scratch)(?:\/|$)/.test(name);
const managedGit = (exec, dir, args, options = {}) => exec("git", ["-C", dir, ...safeGitArgs, ...args], { encoding: "utf8", timeout: 30000, maxBuffer: 32 << 20, ...options });
export async function disabledManagedFilters(dir, exec = execFileP) {
  const result = await managedGit(exec, dir, ["config", "--null", "--name-only", "--get-regexp", "^filter\\."]).catch((err) => { if (err.code === 1) return { stdout: "" }; throw err; });
  const keys = String(result.stdout).split("\0").filter(Boolean);
  if (keys.some((key) => !/^filter\.[^\x00-\x20]+\.[a-zA-Z][a-zA-Z0-9-]*$/.test(key))) throw new Error("workspace: unsafe managed filter configuration");
  return keys.filter((key) => /^filter\..+\.(?:clean|smudge|process|required)$/.test(key)).flatMap((key) => ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`]);
}

async function managedHooks(root, exec) {
  const common = String((await managedGit(exec, root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout).trim();
  const store = path.join(await realpath(common), "den-tree-artifacts");
  for (const dir of [store, path.join(store, "empty-hooks")]) {
    await mkdir(dir, { mode: 0o700 }).catch((err) => { if (err.code !== "EEXIST") throw err; });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(dir) !== dir) throw new Error("workspace: managed metadata must be a canonical plain directory");
    await chmod(dir, 0o700);
  }
  const hooks = path.join(store, "empty-hooks");
  if ((await readdir(hooks)).length) throw new Error("workspace: managed hook directory must be empty");
  return hooks;
}

async function managedTree(dir, commit, exec) {
  if (!MANAGED_COMMIT_RE.test(commit ?? "") || String((await managedGit(exec, dir, ["rev-parse", "--verify", `${commit}^{commit}`])).stdout).trim() !== commit) throw new Error("workspace: managed checkout requires an exact commit");
  const text = String((await managedGit(exec, dir, ["ls-tree", "-r", "-l", "-z", "--full-tree", commit])).stdout);
  const storage = JSON.parse(await readFile(new URL("./limits.json", import.meta.url), "utf8")).storage;
  if (!Number.isSafeInteger(storage?.jobMiB) || !Number.isSafeInteger(storage?.outputMiB) || storage.jobMiB <= 0 || storage.outputMiB <= 0) throw new Error("workspace: managed storage limits are unavailable");
  let total = 0;
  const aliases = new Set();
  return text.split("\0").filter(Boolean).map((line) => {
    const entry = /^(100644|100755) blob ([0-9a-f]{40}(?:[0-9a-f]{24})?) +([0-9]+)\t([\s\S]+)$/.exec(line);
    if (!entry || !managedPath(entry[4])) throw new Error("workspace: managed checkout accepts regular files with safe relative paths only");
    const size = Number(entry[3]);
    const alias = entry[4].toLowerCase();
    if (!Number.isSafeInteger(size) || size > storage.outputMiB * 1024 * 1024 || (total += size) > storage.jobMiB * 1024 * 1024 || aliases.has(alias)) throw new Error("workspace: managed checkout exceeds storage limits or aliases a path");
    aliases.add(alias);
    return { mode: entry[1], object: entry[2], size, name: entry[4] };
  });
}

async function pathWithoutLinks(dir, name, { parents = false } = {}) {
  let cursor = dir;
  const parts = name.split("/");
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    let info = await lstat(cursor).catch((err) => { if (["ENOENT", "ENOTDIR"].includes(err.code)) return null; throw err; });
    if (info?.isSymbolicLink()) throw new Error("workspace: managed checkout refuses symbolic-link traversal");
    if (parents && index < parts.length - 1) {
      if (!info) { await mkdir(cursor); info = await lstat(cursor); }
      if (!info.isDirectory()) throw new Error("workspace: managed checkout has a non-directory ancestor");
    }
  }
  return cursor;
}

const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function flushDirectory(dir) {
  if (process.platform === "win32") return;
  const handle = await open(dir, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeTransition(file, record, exclusive = false) {
  const temporary = exclusive ? file : `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); } finally { await handle.close(); }
  if (!exclusive) await rename(temporary, file);
  await flushDirectory(path.dirname(file));
}
async function rawFileState(dir, name, expected, { oldDirectory = false } = {}) {
  const file = await pathWithoutLinks(dir, name);
  const info = await lstat(file).catch((err) => { if (["ENOENT", "ENOTDIR"].includes(err.code)) return null; throw err; });
  if (!info) return null;
  // The recursive inventory already verified every child belongs to the
  // old/new trees. A tracked old directory is absence of the target file until
  // its known children are removed; no unknown directory is treated this way.
  if (info.isDirectory() && oldDirectory) return null;
  if (!info.isFile() || !expected.some((entry) => entry && entry.size === info.size)) throw new Error("workspace: transition contains unknown content or a non-file path");
  const content = await readFile(file);
  const format = expected.find(Boolean).object.length === 64 ? "sha256" : "sha1";
  return { object: createHash(format).update(`blob ${content.length}\0`).update(content).digest("hex"), mode: process.platform === "win32" ? null : info.mode & 0o111 ? "100755" : "100644" };
}
const stateMatches = (state, entry) => entry ? state?.object === entry.object && (state.mode === null || state.mode === entry.mode) : state === null;
async function checkTransitionFiles(dir, before, after, fresh, resume) {
  const names = new Set([...before.keys(), ...after.keys()]);
  const walk = async (base = "") => {
    for (const entry of await readdir(path.join(dir, ...base.split("/").filter(Boolean)), { withFileTypes: true })) {
      if (!base && [".git", ".den", ".scratch"].includes(entry.name)) continue;
      const name = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error("workspace: transition contains a symbolic link");
      if (entry.isDirectory()) {
        if (![...names].some((path) => path.startsWith(`${name}/`))) throw new Error("workspace: transition contains an unexpected extra path");
        await walk(name);
      }
      else if (!entry.isFile() || !names.has(name)) throw new Error("workspace: transition contains an unexpected extra path");
    }
  };
  await walk();
  for (const name of names) {
    const old = before.get(name), next = after.get(name);
    const oldDirectory = !old && next && [...before.keys()].some((path) => path.startsWith(`${name}/`));
    const state = await rawFileState(dir, name, [old, next], { oldDirectory });
    if (!stateMatches(state, old) && !(resume && stateMatches(state, next))) throw new Error(`workspace: transition content differs from its old/new binding: ${name}`);
    if (fresh && !resume && state !== null) throw new Error("workspace: fresh managed checkout is not empty");
  }
}

// Trusted bridge-only raw checkout. Caller holds exclusive ownership and proves
// every process using this private worktree has stopped before changing it.
// Git never populates files: cat-file bytes bypass attributes, filters, encoding,
// autocrlf, smudge/process helpers, and checkout hooks on every platform.
export async function checkoutManagedWorktree({ dir, commit, expectedHead, fresh = false, resume = false, checkpoint = async () => {}, exec = execFileP } = {}) {
  if (!MANAGED_COMMIT_RE.test(expectedHead ?? "")) throw new Error("workspace: managed checkout needs its expected detached HEAD");
  const hooks = await managedHooks(dir, exec);
  const filters = await disabledManagedFilters(dir, exec);
  const run = (args, options) => managedGit(exec, dir, ["-c", `core.hooksPath=${hooks}`, ...filters, ...args], options);
  const head = String((await run(["rev-parse", "HEAD"])).stdout).trim();
  if (!(resume ? [expectedHead, commit].includes(head) : head === expectedHead) || await run(["symbolic-ref", "-q", "HEAD"]).then(() => true, () => false)) throw new Error("workspace: managed checkout expected a private detached HEAD");
  const target = await managedTree(dir, commit, exec);
  const previous = fresh ? [] : await managedTree(dir, expectedHead, exec);
  const before = new Map(previous.map((entry) => [entry.name, entry]));
  const after = new Map(target.map((entry) => [entry.name, entry]));
  await checkTransitionFiles(dir, before, after, fresh, resume);
  if (!fresh) {
    const atBase = String((await run(["diff-index", "--cached", "--name-only", "-z", expectedHead, "--"])).stdout) === "";
    const atCandidate = resume && String((await run(["diff-index", "--cached", "--name-only", "-z", commit, "--"])).stdout) === "";
    if (!atBase && !atCandidate) throw new Error("workspace: private index differs from both transition endpoints");
  }
  const input = { dir: await realpath(dir), base: expectedHead, candidate: commit, fresh, previous: fingerprint(previous), target: fingerprint(target) };
  const inputHash = fingerprint(input);
  const journal = path.join(path.dirname(hooks), `checkout-${inputHash}.json`);
  let transition;
  try { transition = JSON.parse(await readFile(journal, "utf8")); }
  catch (err) { if (err.code !== "ENOENT") throw err; }
  if (transition && (transition.version !== 1 || transition.inputHash !== inputHash || fingerprint(transition.input) !== inputHash || !["intent", "complete"].includes(transition.status))) throw new Error("workspace: transition journal differs from its immutable inputs");
  if (!transition) {
    transition = { version: 1, input, inputHash, status: "intent", done: [] };
    await writeTransition(journal, transition, true);
  } else if (!resume && !fresh) throw new Error("workspace: an existing raw transition needs explicit reconciliation");
  const progress = async (name) => {
    transition.done = [...new Set([...transition.done, name])];
    await writeTransition(journal, transition);
    await checkpoint({ kind: "file", name });
  };
  const changed = target.filter((entry) => fresh || before.get(entry.name)?.object !== entry.object || before.get(entry.name)?.mode !== entry.mode);
  for (const entry of previous.filter((entry) => !after.has(entry.name))) {
    const filename = await pathWithoutLinks(dir, entry.name);
    const state = await rawFileState(dir, entry.name, [entry]);
    if (state !== null && !stateMatches(state, entry)) throw new Error("workspace: deletion changed during transition");
    if (state !== null) { await rm(filename); await flushDirectory(path.dirname(filename)); }
    await progress(entry.name);
  }
  // Remove empty obsolete tracked parents; never remove untracked contents.
  const obsolete = [...new Set(previous.filter((entry) => !after.has(entry.name)).flatMap((entry) => entry.name.split("/").slice(0, -1).map((_, index, all) => all.slice(0, index + 1).join("/"))))].sort((a, b) => b.length - a.length);
  for (const name of obsolete) await rmdir(await pathWithoutLinks(dir, name)).catch((err) => { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(err.code) && !(err.code === "ENOTDIR" && after.has(name))) throw err; });
  for (let start = 0; start < changed.length;) {
    const batch = [];
    let bytes = 0;
    while (start < changed.length && batch.length < 64 && (batch.length === 0 || bytes + changed[start].size < 20 * 1024 * 1024)) { const entry = changed[start++]; batch.push(entry); bytes += entry.size; }
    let blobs;
    if (exec === execFileP) {
      const job = run(["cat-file", "--batch"], { encoding: "buffer", maxBuffer: bytes + batch.length * 160 + 1024 });
      job.child.stdin.on("error", () => {});
      job.child.stdin.end(`${batch.map((entry) => entry.object).join("\n")}\n`);
      const data = (await job).stdout;
      let offset = 0;
      blobs = batch.map((entry) => {
        const newline = data.indexOf(10, offset);
        if (newline < 0 || data.subarray(offset, newline).toString("ascii") !== `${entry.object} blob ${entry.size}`) throw new Error("workspace: managed blob batch differs from its tree");
        const blob = data.subarray(newline + 1, newline + 1 + entry.size);
        offset = newline + entry.size + 2;
        if (blob.length !== entry.size || data[offset - 1] !== 10) throw new Error("workspace: managed blob batch was truncated");
        return blob;
      });
      if (offset !== data.length) throw new Error("workspace: managed blob batch has unexpected data");
    } else {
      // Exec test seams need no stream contract; production execFile takes the
      // bounded batch path above without spawning one process per file.
      blobs = await Promise.all(batch.map(async (entry) => (await run(["cat-file", "blob", entry.object], { encoding: "buffer", maxBuffer: entry.size + 1024 })).stdout));
    }
    for (let index = 0; index < batch.length; index++) {
      const entry = batch[index], blob = blobs[index];
      const format = entry.object.length === 64 ? "sha256" : "sha1";
      if (blob.length !== entry.size || createHash(format).update(`blob ${blob.length}\0`).update(blob).digest("hex") !== entry.object) throw new Error("workspace: raw blob failed its exact tree binding");
      const state = await rawFileState(dir, entry.name, [before.get(entry.name), entry]);
      if (!stateMatches(state, entry)) {
        if (!stateMatches(state, before.get(entry.name))) throw new Error("workspace: file changed during transition");
        const filename = await pathWithoutLinks(dir, entry.name, { parents: true });
        const temporary = path.join(path.dirname(hooks), `blob-${randomBytes(16).toString("hex")}`);
        const handle = await open(temporary, "wx", entry.mode === "100755" ? 0o755 : 0o644);
        try { await handle.writeFile(blob); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, filename);
        await flushDirectory(path.dirname(filename));
      }
      await progress(entry.name);
    }
  }
  await run(["read-tree", "--reset", "-i", commit]);
  if (head !== commit) await run(["update-ref", "--no-deref", "HEAD", commit, expectedHead]);
  transition.status = "complete";
  await writeTransition(journal, transition);
}

export async function isManagedWorktreeClean({ dir, commit, exec = execFileP } = {}) {
  const entries = await managedTree(dir, commit, exec);
  const names = new Set(entries.map((entry) => entry.name));
  for (const entry of entries) {
    const file = await pathWithoutLinks(dir, entry.name);
    const info = await lstat(file).catch((err) => { if (err.code === "ENOENT") return null; throw err; });
    if (!info?.isFile() || info.size !== entry.size || process.platform !== "win32" && (info.mode & 0o111 ? "100755" : "100644") !== entry.mode) return false;
    const content = await readFile(file);
    if (createHash(entry.object.length === 64 ? "sha256" : "sha1").update(`blob ${content.length}\0`).update(content).digest("hex") !== entry.object) return false;
  }
  const files = String((await managedGit(exec, dir, ["ls-files", "-c", "-o", "--exclude-standard", "-z"])).stdout).split("\0").filter(Boolean);
  if (files.some((name) => !names.has(name))) return false;
  return String((await managedGit(exec, dir, ["diff-index", "--cached", "--name-only", "-z", commit, "--"])).stdout) === "";
}

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
    async create({ ref, agentId, base, managed = false } = {}) {
      const { worktree, branch } = workspaceNames({ ref, agentId });
      if (base !== undefined && (typeof base !== "string" || !COMMIT_RE.test(base))) throw new TypeError("workspace: base must be a full commit id");
      if (typeof managed !== "boolean") throw new TypeError("workspace: managed must be boolean");
      const target = path.join(root, ...worktree.split("/"));
      if (managed) {
        const hooks = await managedHooks(root, exec);
        const filters = await disabledManagedFilters(root, exec);
        const exact = base ?? String((await managedGit(exec, root, ["rev-parse", "HEAD"])).stdout).trim();
        await managedTree(root, exact, exec);
        await pathWithoutLinks(root, worktree);
        await managedGit(exec, root, ["-c", `core.hooksPath=${hooks}`, ...filters, "worktree", "add", "--detach", "--no-checkout", target, exact]);
        try { await checkoutManagedWorktree({ dir: target, commit: exact, expectedHead: exact, fresh: true, exec }); }
        catch (err) {
          // No agent has started in this new worktree. Remove only the exact
          // worktree we just registered; preserve the protected failure journal.
          await managedGit(exec, root, ["-c", `core.hooksPath=${hooks}`, ...filters, "worktree", "remove", "--force", target]).catch((cleanup) => { err.cleanup = cleanup.message; });
          throw err;
        }
      } else await git("worktree", "add", "--detach", target, base ?? "HEAD");
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
    async reopen({ ref, agentId, origin, catchUp = false, managed = false } = {}) {
      const { worktree } = workspaceNames({ ref, agentId: origin });
      const { branch } = workspaceNames({ ref, agentId });
      const dir = await realpath(path.join(root, ...worktree.split("/")));
      const listed = String((await git("worktree", "list", "--porcelain")).stdout).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
      const resolved = await Promise.all(listed.map((p) => realpath(p).catch(() => p)));
      if (!resolved.includes(dir)) throw new Error("workspace: the earlier run's directory is no longer a worktree of this repository");
      if (typeof managed !== "boolean") throw new TypeError("workspace: managed must be boolean");
      if (managed) {
        await pathWithoutLinks(root, worktree);
        const current = String((await managedGit(exec, dir, ["rev-parse", "HEAD"])).stdout).trim();
        if (!(await isManagedWorktreeClean({ dir, commit: current, exec }))) throw new Error("workspace: managed reopen requires clean raw candidate bytes");
        if (catchUp) {
          const main = String((await managedGit(exec, root, ["rev-parse", "HEAD"])).stdout).trim();
          if (current !== main && await managedGit(exec, root, ["merge-base", "--is-ancestor", current, main]).then(() => true, () => false)) await checkoutManagedWorktree({ dir, commit: main, expectedHead: current, exec });
        }
      } else if (catchUp) await moveUp(dir);
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
