#!/usr/bin/env node
// organism-infra/34: prepare an agent's worktree at the previous hop's commit.
//
//   node scripts/agent-start.mjs --base <sha> (--branch <name> | --detach)
//                               [--ticket <ref> --role <role> [--mode <m>]]
//                               [--force | --continue]
//
// Run first, inside the worktree. Refuses in the main checkout or a dirty
// worktree; otherwise switches to a new branch at <sha> (or detaches there),
// then runs `npm ci`. An existing branch is checked out and fast-forwarded to <sha>.
// organism-infra/60: with --ticket, it then runs `board claim` and exits
// non-zero, with the board's message, if the claim is refused.
// organism-infra/119: before anything else it reads the orchestrator's context (context.mjs, which
// an agent sees through the shared CLAUDE_CODE_SESSION_ID). At the orchestrator's warn
// number (70k) it warns that the orchestrator should start no new tickets; at its stop number (80k)
// it refuses (exit 1) unless --force. --continue (a fix round or later hop of a ticket already in
// flight) gets the warning, never the refusal. A null reading never blocks.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHIEF_OF_STAFF, budgetFor } from "./context-budget.mjs";
import { normalizeLegacyFlags } from "../apps/board/legacy-terms.mjs";

const CONTEXT = fileURLToPath(new URL("./context.mjs", import.meta.url));
// organism-infra/145: the orchestrator's warn and refuse numbers come from scripts/context-budget.json.
const { warn: WARN_AT, stop: REFUSE_AT } = budgetFor(CHIEF_OF_STAFF);
const BOARD = fileURLToPath(new URL("../apps/board/board.mjs", import.meta.url));

function fail(msg) {
  process.stderr.write(`agent-start: ${msg}\n`);
  process.exit(1);
}

function git(args) {
  return spawnSync("git", args, { encoding: "utf8" });
}

function parseArgs(argv) {
  const opts = { base: null, branch: null, detach: false, ticket: null, role: null, mode: null, force: false, continue: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--detach") opts.detach = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--continue") opts.continue = true;
    else if (["--base", "--branch", "--ticket", "--role", "--mode"].includes(a)) {
      const v = argv[++i];
      if (!v || v.startsWith("--")) fail(`${a} needs a value`);
      opts[a.slice(2)] = v;
    } else fail(`unknown argument ${a}`);
  }
  if (!opts.base) fail("--base <sha> is required");
  if (opts.branch && opts.detach) fail("use either --branch <name> or --detach, not both");
  if (!opts.branch && !opts.detach) fail("one of --branch <name> or --detach is required");
  if (opts.ticket && !opts.role) fail("--ticket needs --role <role>");
  if (!opts.ticket && (opts.role || opts.mode)) fail("--role and --mode only apply with --ticket <ref>");
  return opts;
}

const opts = parseArgs(normalizeLegacyFlags(process.argv.slice(2), "agent-start"));

// organism-infra/119: orchestrator context gate. Runs before the claim and the switch, so a refusal
// leaves the board and the worktree untouched.
function orchestratorContext() {
  const r = spawnSync(process.execPath, [CONTEXT], { encoding: "utf8", timeout: 15000 });
  if (r.status !== 0) return null;
  try {
    const n = JSON.parse(r.stdout).context_tokens;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
const ctx = orchestratorContext();
if (ctx !== null && ctx >= WARN_AT) {
  const k = Math.floor(ctx / 1000);
  if (ctx >= REFUSE_AT && !opts.force && !opts.continue) {
    fail(`orchestrator context ${k}k ≥ ${REFUSE_AT / 1000}k: write the session handoff and ask the user to /compact (--force overrides; --continue is for a ticket already in flight)`);
  }
  process.stdout.write(`agent-start: warning: orchestrator context ${k}k (≥ ${WARN_AT / 1000}k): start no new tickets; finish the relay in flight, then hand off and /compact\n`);
}

const top = git(["rev-parse", "--show-toplevel"]);
if (top.status !== 0) fail("not inside a git worktree");
const toplevel = realpathSync(top.stdout.trim());

const list = git(["worktree", "list", "--porcelain", "-z"]);
if (list.status !== 0) fail(`git worktree list failed: ${list.stderr.trim()}`);
const first = list.stdout.split("\0").find((l) => l.startsWith("worktree "));
if (!first) fail("git worktree list reported no worktrees");
if (realpathSync(first.slice("worktree ".length)) === toplevel) {
  fail("this is the main checkout; run agent-start only inside an agent worktree");
}

const status = git(["status", "--porcelain"]);
if (status.status !== 0) fail(`git status failed: ${status.stderr.trim()}`);
if (status.stdout.trim()) fail("worktree is dirty (uncommitted or untracked files); commit or remove them first");

const sha = git(["rev-parse", "--verify", "--quiet", `${opts.base}^{commit}`]);
if (sha.status !== 0) fail(`unknown base commit ${opts.base}`);
const base = sha.stdout.trim();

// organism-infra/51: an existing branch (the developer after qa specify) is checked
// out and fast-forwarded to --base; anything that isn't a fast-forward is refused.
let existingBranch = false;
if (opts.branch) {
  existingBranch = git(["show-ref", "--verify", "--quiet", `refs/heads/${opts.branch}`]).status === 0;
  if (existingBranch) {
    const ff = git(["merge-base", "--is-ancestor", `refs/heads/${opts.branch}`, base]);
    if (ff.status !== 0) fail(`branch ${opts.branch} cannot be fast-forwarded to ${base.slice(0, 12)} (diverged or ahead of it); refusing`);
  }
}

// npm finds its project root by walking up from cwd; a base with no root
// package.json would make it reinstall in the main checkout that nests this worktree.
const hasPkg = git(["cat-file", "-e", `${base}:package.json`]);
if (hasPkg.status !== 0) fail(`base ${base.slice(0, 12)} has no root package.json; refusing (npm ci would climb out of the worktree)`);

const sw = git(
  existingBranch ? ["switch", "-q", opts.branch] : opts.branch ? ["switch", "-q", "-c", opts.branch, base] : ["switch", "-q", "--detach", base],
);
if (sw.status !== 0) fail(`git switch failed: ${sw.stderr.trim()}`);
if (existingBranch) {
  const ffm = git(["merge", "-q", "--ff-only", base]);
  if (ffm.status !== 0) fail(`fast-forward to ${base.slice(0, 12)} failed: ${ffm.stderr.trim()}`);
}

const npm = spawnSync("npm", ["ci"], { stdio: "inherit", cwd: toplevel });
if (npm.status !== 0) fail(`npm ci failed (exit ${npm.status ?? npm.signal})`);

if (opts.ticket) {
  const claimArgs = [BOARD, "claim", opts.ticket, opts.role, ...(opts.mode ? ["--mode", opts.mode] : [])];
  const claim = spawnSync(process.execPath, claimArgs, { cwd: toplevel, encoding: "utf8" });
  if (claim.status !== 0) {
    fail(`claim refused, do no work on ${opts.ticket}: ${(claim.stderr || claim.stdout).trim()}`);
  }
  process.stdout.write(claim.stdout);
}
process.stdout.write(`agent-start: at ${base.slice(0, 12)} (${opts.branch ?? "detached"})\n`);
