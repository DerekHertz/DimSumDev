// den-mvp/49 (ADR 0021 Amendment 5): the project registry. The den is the `control` root; an onboarded project is a second
// root a run can be made under. The registry file <denState>/projects.json is written only by addProject/removeProject (the
// user's terminal, `npm run den:project`); the bridge reads it. The active project is a separate file the bridge writes.
// The start check (git repo, a real .git directory, a plain path, origin and main) runs at registration, at activation and
// at get(), so a repository that changed since onboarding is refused rather than trusted.
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { grantTouchesCredential, isWorktreePath, toolchainRefusal } from "./agents/claude-adapter.mjs";
import { DESK_REF, WORKTREES_DIR } from "./agents/policy.mjs";
import { createWorkspaces } from "./agents/workspace.mjs";

const execFileP = promisify(execFile);
export const DEN = "den";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const BOARD_KINDS = ["markdown", "github-issues"];
const ENDED = ["done", "failed", "terminated"];
const REGISTRY = "projects.json";
const ACTIVE = "active-project";

const covers = (a, b) => a === b || b.startsWith(`${a}/`);

/** The start check. -> { ok: true, root } (the resolved path) or { ok: false, reason }. `control`, when given, is the den's checkout: no root may be, hold or sit in it. */
export async function checkProject(dir, { exec = execFileP, control } = {}) {
  if (!isWorktreePath(dir)) return { ok: false, reason: "the path must be a plain absolute path (letters, digits and . _ @ + - only)" };
  let root;
  try {
    root = await realpath(dir);
  } catch {
    return { ok: false, reason: "the path does not exist" };
  }
  if (!isWorktreePath(root)) return { ok: false, reason: "the path must resolve to a plain absolute path" };
  if (typeof control === "string") {
    const realControl = await realpath(control).catch(() => control);
    if (covers(realControl, root) || covers(root, realControl)) return { ok: false, reason: "the path is, holds or sits in the control checkout" };
  }
  const git = (...args) => exec("git", ["-C", root, ...args]).then((r) => String(r.stdout).trim());
  let top;
  try {
    top = await git("rev-parse", "--show-toplevel");
  } catch {
    return { ok: false, reason: "the path is not a git repo" };
  }
  if ((await realpath(top).catch(() => top)) !== root) return { ok: false, reason: "the path is inside a git repo but is not its top folder" };
  const info = await lstat(path.join(root, ".git")).catch(() => null);
  if (info === null || !info.isDirectory()) return { ok: false, reason: "the .git of the path is a file, not a directory (a linked worktree or submodule)" };
  if ((await lstat(path.join(root, ".scratch")).catch(() => null))?.isSymbolicLink()) return { ok: false, reason: "the .scratch of the path is a symlink, which the den does not follow" };
  if (await git("remote", "get-url", "origin").then(() => false, () => true)) return { ok: false, reason: "the repo has no origin remote" };
  if (await git("rev-parse", "--verify", "--quiet", "refs/heads/main").then(() => false, () => true)) return { ok: false, reason: "the repo has no main branch" };
  if ((await git("ls-files", "--", WORKTREES_DIR)) !== "") return { ok: false, reason: `the repo tracks files under ${WORKTREES_DIR}/, where the agents' worktrees go` };
  return { ok: true, root };
}

// Worktrees stay under the target; the folder is kept out of its status with the repo's own exclude file, not a commit.
async function excludeWorktrees(root) {
  const file = path.join(root, ".git", "info", "exclude");
  const line = `${WORKTREES_DIR}/`;
  const text = await readFile(file, "utf8").catch(() => "");
  if (text.split("\n").includes(line)) return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`);
}

/** The registry, {} when there is no file. A file that is not a JSON object throws: an empty answer would let the next add wipe it. */
export async function readRegistry(denState) {
  let text;
  try {
    text = await readFile(path.join(denState, REGISTRY), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`the project registry ${path.join(denState, REGISTRY)} is not a JSON object; fix or remove it`);
  return data;
}
const own = (registry, slug) => (Object.hasOwn(registry, slug) ? registry[slug] : undefined);

// add and remove are read-modify-write of one file, from any terminal: an exclusive lock file holds the pid, and one whose process is gone is taken over.
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};
async function withRegistryLock(denState, fn) {
  await mkdir(denState, { recursive: true });
  const lock = path.join(denState, `${REGISTRY}.lock`);
  for (let tries = 0; ; tries++) {
    try {
      const h = await open(lock, "wx");
      await h.writeFile(`${process.pid}\n`);
      await h.close();
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const pid = Number((await readFile(lock, "utf8").catch(() => "")).trim());
      if (Number.isInteger(pid) && pid > 0 && !alive(pid)) await rm(lock, { force: true });
      else if (tries > 100) throw new Error("the project registry is locked by another process");
      else await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}
const locked = (denState, fn) => withRegistryLock(denState, fn).catch((err) => ({ ok: false, reason: err.message }));
async function writeRegistry(denState, data) {
  await mkdir(denState, { recursive: true });
  const file = path.join(denState, REGISTRY);
  await writeFile(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/** Onboards a project. -> { ok: true } or { ok: false, reason }. */
const CHECK_RE = /^[\w. /-]{1,64}$/;
const MAX_TOOLCHAIN = 8;
const repoOfOrigin = (url) => /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url)?.slice(1, 3).join("/") ?? null;

/** An origin URL as it may be printed: any user:token@ part is dropped. */
const withoutCredentials = (url) => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1");

/** Each toolchain entry must exist; the real path is stored, and checked by the run-time rules and the credential guard. */
async function resolveToolchain(toolchain, control) {
  const out = [];
  for (const entry of toolchain) {
    let real;
    try {
      real = await realpath(entry);
    } catch {
      return { reason: `the toolchain path ${entry} does not exist` };
    }
    if (!isWorktreePath(real)) return { reason: `the toolchain path ${entry} must resolve to a plain absolute path` };
    const refusal = toolchainRefusal(real, control);
    if (refusal) return { reason: refusal };
    if (grantTouchesCredential(real, homedir())) return { reason: `the toolchain path ${entry} resolves to or holds a credential store` };
    out.push(real);
  }
  return { toolchain: out };
}

export async function addProject(denState, { slug, path: dir, board, toolchain = [], checks = [], control = process.cwd() } = {}, { exec = execFileP } = {}) {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) return { ok: false, reason: "the slug must be 1 to 32 characters of a-z, 0-9 and -, starting with a letter or digit" };
  if (slug in Object.prototype) return { ok: false, reason: `the slug "${slug}" is not allowed` };
  if (slug === DEN) return { ok: false, reason: `the slug "${DEN}" is reserved for the den itself` };
  if (!board || !BOARD_KINDS.includes(board.kind)) return { ok: false, reason: `the board kind must be one of: ${BOARD_KINDS.join(", ")}` };
  if (board.kind === "github-issues" && !(typeof board.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(board.repo))) return { ok: false, reason: "a github-issues board needs repo as owner/name" };
  if (!Array.isArray(toolchain) || !toolchain.every(isWorktreePath)) return { ok: false, reason: "toolchain must be a list of plain absolute paths" };
  if (toolchain.length > MAX_TOOLCHAIN) return { ok: false, reason: `the toolchain takes at most ${MAX_TOOLCHAIN} paths` };
  if (!Array.isArray(checks) || !checks.every((c) => typeof c === "string" && CHECK_RE.test(c))) return { ok: false, reason: "checks must be a list of check names" };
  const checked = await checkProject(dir, { exec, control });
  if (!checked.ok) return checked;
  if (board.kind === "github-issues") {
    let origin;
    try {
      origin = String((await exec("git", ["-C", checked.root, "remote", "get-url", "origin"])).stdout).trim();
    } catch {
      return { ok: false, reason: `board.repo ${board.repo} needs the path to have an origin remote` };
    }
    if (repoOfOrigin(origin)?.toLowerCase() !== board.repo.toLowerCase()) return { ok: false, reason: `board.repo ${board.repo} is not the origin of the path (${withoutCredentials(origin)})` };
  }
  const resolved = await resolveToolchain(toolchain, await realpath(control).catch(() => control));
  if (resolved.reason) return { ok: false, reason: resolved.reason };
  return locked(denState, async () => {
  const registry = await readRegistry(denState);
  if (own(registry, slug)) return { ok: false, reason: `the slug "${slug}" is already onboarded` };
  await excludeWorktrees(checked.root);
  registry[slug] = { path: checked.root, board: board.kind === "github-issues" ? { kind: board.kind, repo: board.repo } : { kind: board.kind }, toolchain: resolved.toolchain, ...(checks.length > 0 ? { checks } : {}) };
  await writeRegistry(denState, registry);
  return { ok: true };
  });
}

export async function removeProject(denState, slug) {
  return locked(denState, async () => {
    const registry = await readRegistry(denState);
    if (!own(registry, slug)) return { ok: false, reason: `"${slug}" is not onboarded` };
    delete registry[slug];
    await writeRegistry(denState, registry);
    return { ok: true };
  });
}

export function createProjects({ control, denState, exec = execFileP }) {
  const handles = new Map(); // root -> handle
  let cache = { mtimeMs: -1, data: {} };
  async function registry() {
    const st = await stat(path.join(denState, REGISTRY)).catch(() => null);
    if (st === null) return {};
    if (st.mtimeMs !== cache.mtimeMs) {
      // A corrupt file is reported and read as empty here; only add and remove write it, and they refuse it.
      const data = await readRegistry(denState).catch((err) => { console.error(`bridge: ${err.message}`); return {}; });
      cache = { mtimeMs: st.mtimeMs, data };
    }
    return cache.data;
  }
  const handleFor = async (slug, root, board, toolchain, createGit) => {
    let h = handles.get(root);
    if (!h) {
      h = { slug, root, control, board, git: await createGit(root), workspaces: createWorkspaces(root, { exec }), toolchain };
      handles.set(root, h);
    }
    return h;
  };
  // The git host is the delivery's; loaded on first use so this module stays free of the delivery code in tests.
  const createGit = async (root) => (await import("./delivery/git-host.mjs")).createGitHost(root);
  async function list() {
    const reg = await registry();
    const active = await activeSlug(reg);
    return [{ slug: DEN, path: control, board: { kind: "markdown" }, active: active === DEN }, ...Object.entries(reg).map(([slug, p]) => ({ slug, path: p.path, board: p.board, active: active === slug }))];
  }
  async function activeSlug(reg) {
    const slug = (await readFile(path.join(denState, ACTIVE), "utf8").catch(() => "")).trim();
    return own(reg, slug) ? slug : DEN;
  }
  const active = async () => activeSlug(await registry());
  // -> the handle, or null for a slug that is not onboarded (or whose start check now fails).
  async function get(slug) {
    if (slug === DEN) return handleFor(DEN, control, { kind: "markdown" }, [], createGit);
    const p = own(await registry(), slug);
    if (!p) return null;
    const checked = await checkProject(p.path, { exec, control });
    if (!checked.ok) return null;
    await excludeWorktrees(checked.root);
    return handleFor(slug, checked.root, p.board, p.toolchain ?? [], createGit);
  }
  async function activate(slug, { runs = [] } = {}) {
    const reg = await registry();
    if (slug !== DEN && !own(reg, slug)) return { refused: true, reason: `"${slug}" is not onboarded`, blocking: [] };
    if (slug !== DEN) {
      const checked = await checkProject(reg[slug].path, { exec, control });
      if (!checked.ok) return { refused: true, reason: checked.reason, blocking: [] };
      await excludeWorktrees(checked.root);
    }
    const current = await activeSlug(reg);
    const blocking = runs
      .filter((r) => !ENDED.includes(r.state) && !r.control && r.role !== "orchestrator" && r.ref !== DESK_REF && !r.meeting && (r.project ?? DEN) === current)
      .map((r) => ({ id: r.id, role: r.role, ref: r.ref }));
    if (blocking.length > 0 && slug !== current) return { refused: true, reason: "runs are active on the current project", blocking };
    await mkdir(denState, { recursive: true });
    await writeFile(path.join(denState, ACTIVE), `${slug}\n`);
    return { ok: true };
  }
  // The active project's root without the start check (the hub asks every refresh); the den's own when none is active.
  async function activeRoot() {
    const reg = await registry();
    return own(reg, await activeSlug(reg))?.path ?? control;
  }
  return { list, active, activeRoot, get, activate };
}
