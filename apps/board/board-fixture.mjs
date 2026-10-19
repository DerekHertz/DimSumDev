// Test-only helper for organism-infra/02 (board CLI) acceptance tests.
// Builds a disposable git repo (the "main checkout") plus a linked worktree,
// so tests can exercise the real `board` CLI as a child process against real
// git-worktree resolution, without ever touching this repo's own .scratch/.
//
// Not a test file itself (no *.test.mjs suffix) so `npm test` skips it.
import { mkdtemp, mkdir, writeFile, rm, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const CLI = path.join(REPO_ROOT, "apps", "board", "board.mjs");

// Pinned convention for the write lock this ticket introduces (ADR 0008 decision 2
// specifies the JSON content {pid, host, createdAt} but not a path). QA pins this
// path as part of the CLI's on-disk contract so stale/live-lock behavior can be
// tested at the file seam; the developer's implementation must use it, or say so
// in their handoff if they pick a different convention.
export function writeLockPath(root, feature, ticket) {
  return path.join(root, ".scratch", feature, "issues", `${ticket}.write-lock.json`);
}

export function claimLockPath(root, feature, ticket) {
  return path.join(root, ".scratch", feature, "issues", `${ticket}.lock`);
}

export function ticketPath(root, feature, ticket) {
  return path.join(root, ".scratch", feature, "issues", `${ticket}.md`);
}

export function eventsPath(root) {
  return path.join(root, ".scratch", "events.jsonl");
}

// organism-infra/18: `release --status in-review|resolved` now requires a
// valid handoff State block (docs/adr/0009-mechanical-checks-for-most-skipped-rules.md
// decision 4). Tests written before that gate existed release to in-review
// purely to exercise locking/concurrency/formatting behavior unrelated to the
// handoff itself, so they use this helper to satisfy the gate without
// duplicating board-cli-hardening.test.mjs's own State-block fixtures.
export function validStateJson(overrides = {}) {
  return {
    ticket: "sample/01-do-thing",
    current_step: "test setup",
    artifacts: [],
    decisions: [],
    failures: [],
    pending: [],
    ...overrides,
  };
}

// organism-infra/18 fix-1 (security HIGH #1): release now only considers a
// handoff (a) whose filename starts with the released ticket's "NN-" prefix
// and (b) whose State block `ticket` field names that exact ticket -- so the
// default filename and `ticket` field here are both derived from `fx.ticket`
// (or the `ticket` override, for a fixture exercising several tickets in one
// feature) instead of a fixed "00-setup.md" / "sample/01-do-thing". Every
// existing caller that doesn't pass `ticket` uses `fx`'s own default ticket,
// so for them this is a setup-only rename, not a behavior change.
export async function writeValidHandoff(fx, { filename, ticket = fx.ticket, overrides = {} } = {}) {
  const dir = path.join(fx.root, ".scratch", fx.feature, "handoffs");
  await mkdir(dir, { recursive: true });
  const nn = /^(\d{2,})-/.exec(ticket)?.[1] ?? "00";
  const name = filename ?? `${nn}-setup.md`;
  // organism-infra/35: the gate binds a handoff to the releasing role (and
  // mode) and to the current claim, so infer both from the live claim lock
  // (callers claim before writing); fall back to "developer".
  const lock = await readFile(
    path.join(fx.root, ".scratch", fx.feature, "issues", `${ticket}.lock`),
    "utf8"
  ).catch(() => "");
  const toks = lock.trim().split(/\s+/);
  const lockRole = toks[0] || undefined;
  const lockMode = toks[2];
  const identity = { role: lockRole ?? "developer", ...(lockMode ? { mode: lockMode } : {}) };
  const body =
    "```json\n" +
    JSON.stringify(validStateJson({ ticket: `${fx.feature}/${ticket}`, ...identity, ...overrides })) +
    "\n```\n\n## Summary\n\nfixture handoff\n";
  const p = path.join(dir, name);
  await writeFile(p, body, "utf8");
  // Written "after the claim": push mtime ahead so same-ms/earlier claims pass.
  const later = new Date(Date.now() + 60_000);
  await utimes(p, later, later);
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

let counter = 0;

export async function makeBoardFixture({
  feature = "sample",
  ticket = "01-do-thing",
  status = "ready-for-agent",
  content, // optional full ticket markdown, e.g. a real ticket copied verbatim
} = {}) {
  counter += 1;
  const root = await mkdtemp(path.join(tmpdir(), `board-main-${counter}-`));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "qa@example.com"]);
  git(root, ["config", "user.name", "QA Fixture"]);

  const issuesDir = path.join(root, ".scratch", feature, "issues");
  await mkdir(issuesDir, { recursive: true });
  const tpath = ticketPath(root, feature, ticket);
  await writeFile(
    tpath,
    content ?? `# ${ticket}\n\nStatus: ${status}\n\n- [ ] acceptance criterion\n\n## Comments\n`
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed fixture ticket"]);

  const worktreeParent = await mkdtemp(path.join(tmpdir(), `board-wt-parent-${counter}-`));
  const worktree = path.join(worktreeParent, "wt");
  git(root, ["worktree", "add", "-q", "-b", `wt-${counter}`, worktree, "main"]);

  return {
    root,
    worktree,
    feature,
    ticket,
    ticketRelPath: `${feature}/${ticket}`,
    ticketPath: tpath,
    ticketPathInWorktree: ticketPath(worktree, feature, ticket),
    claimLockPath: claimLockPath(root, feature, ticket),
    writeLockPath: writeLockPath(root, feature, ticket),
    eventsPath: eventsPath(root),
    async readTicket() {
      return readFile(tpath, "utf8");
    },
    async cleanup() {
      try {
        git(root, ["worktree", "remove", "--force", worktree]);
      } catch {
        /* best effort */
      }
      await rm(root, { recursive: true, force: true }).catch(() => {});
      await rm(worktreeParent, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// Spawns `node board.mjs <args>` for real, against a temp fixture.
// On timeout the child is killed and {code: null, timedOut: true} is resolved
// (not thrown) so tests asserting "must not hang forever" can inspect state
// instead of failing with an opaque timeout error.
export function runBoard(args, { cwd, env = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      resolve({ code: null, timedOut: true, stdout, stderr });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.once("exit", (code) => {
      if (settled) return;
      clearTimeout(timer);
      resolve({ code, timedOut: false, stdout, stderr });
    });
    child.once("error", (err) => {
      if (settled) return;
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Spawns a short-lived child process and returns its pid after it has exited,
// so tests get a real pid guaranteed dead (not a guessed/reused number).
export async function deadPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const { pid } = child;
    child.once("exit", () => resolve(pid));
    child.once("error", reject);
  });
}
