// den-mvp/49 (ADR 0021 Amendment 5): the project registry. The den is the `control` root; an onboarded project is a second
// root a run can be made under. The registry file <denState>/projects.json is written only by addProject/removeProject (the
// user's terminal, `npm run den:project`); the bridge reads it. The active project is a separate file the bridge writes.
// The start check (git repo, a real .git directory, a plain path, origin and main) runs at registration, at activation and
// at get(), so a repository that changed since onboarding is refused rather than trusted.
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isWorktreePath } from "./agents/claude-adapter.mjs";
import { DESK_REF, WORKTREES_DIR } from "./agents/policy.mjs";
import { createWorkspaces } from "./agents/workspace.mjs";

const execFileP = promisify(execFile);
export const DEN = "den";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const BOARD_KINDS = ["markdown", "github-issues"];
const ENDED = ["done", "failed", "terminated"];
const REGISTRY = "projects.json";
const ACTIVE = "active-project";

/** The start check. -> { ok: true, root } (the resolved path) or { ok: false, reason }. */
export async function checkProject(dir, { exec = execFileP } = {}) {
  if (!isWorktreePath(dir)) return { ok: false, reason: "the path must be a plain absolute path (letters, digits and . _ @ + - only)" };
  let root;
  try {
    root = await realpath(dir);
  } catch {
    return { ok: false, reason: "the path does not exist" };
  }
  if (!isWorktreePath(root)) return { ok: false, reason: "the path must resolve to a plain absolute path" };
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

async function readRegistry(denState) {
  try {
    const data = JSON.parse(await readFile(path.join(denState, REGISTRY), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}
async function writeRegistry(denState, data) {
  await mkdir(denState, { recursive: true });
  const file = path.join(denState, REGISTRY);
  await writeFile(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/** Onboards a project. -> { ok: true } or { ok: false, reason }. */
export async function addProject(denState, { slug, path: dir, board, toolchain = [] } = {}, { exec } = {}) {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) return { ok: false, reason: "the slug must be 1 to 32 characters of a-z, 0-9 and -, starting with a letter or digit" };
  if (slug === DEN) return { ok: false, reason: `the slug "${DEN}" is reserved for the den itself` };
  if (!board || !BOARD_KINDS.includes(board.kind)) return { ok: false, reason: `the board kind must be one of: ${BOARD_KINDS.join(", ")}` };
  if (board.kind === "github-issues" && !(typeof board.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(board.repo))) return { ok: false, reason: "a github-issues board needs repo as owner/name" };
  if (!Array.isArray(toolchain) || !toolchain.every(isWorktreePath)) return { ok: false, reason: "toolchain must be a list of plain absolute paths" };
  const checked = await checkProject(dir, { exec });
  if (!checked.ok) return checked;
  const registry = await readRegistry(denState);
  if (registry[slug]) return { ok: false, reason: `the slug "${slug}" is already onboarded` };
  await excludeWorktrees(checked.root);
  registry[slug] = { path: checked.root, board: board.kind === "github-issues" ? { kind: board.kind, repo: board.repo } : { kind: board.kind }, toolchain };
  await writeRegistry(denState, registry);
  return { ok: true };
}

export async function removeProject(denState, slug) {
  const registry = await readRegistry(denState);
  if (!registry[slug]) return { ok: false, reason: `"${slug}" is not onboarded` };
  delete registry[slug];
  await writeRegistry(denState, registry);
  return { ok: true };
}

export function createProjects({ control, denState, exec = execFileP }) {
  const handles = new Map(); // root -> handle
  let cache = { mtimeMs: -1, data: {} };
  async function registry() {
    const st = await stat(path.join(denState, REGISTRY)).catch(() => null);
    if (st === null) return {};
    if (st.mtimeMs !== cache.mtimeMs) cache = { mtimeMs: st.mtimeMs, data: await readRegistry(denState) };
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
    return reg[slug] ? slug : DEN;
  }
  const active = async () => activeSlug(await registry());
  // -> the handle, or null for a slug that is not onboarded (or whose start check now fails).
  async function get(slug) {
    if (slug === DEN) return handleFor(DEN, control, { kind: "markdown" }, [], createGit);
    const p = (await registry())[slug];
    if (!p) return null;
    const checked = await checkProject(p.path, { exec });
    if (!checked.ok) return null;
    await excludeWorktrees(checked.root);
    return handleFor(slug, checked.root, p.board, p.toolchain ?? [], createGit);
  }
  async function activate(slug, { runs = [] } = {}) {
    const reg = await registry();
    if (slug !== DEN && !reg[slug]) return { refused: true, reason: `"${slug}" is not onboarded`, blocking: [] };
    if (slug !== DEN) {
      const checked = await checkProject(reg[slug].path, { exec });
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
    return reg[await activeSlug(reg)]?.path ?? control;
  }
  return { list, active, activeRoot, get, activate };
}
