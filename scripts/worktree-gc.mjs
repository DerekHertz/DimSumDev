#!/usr/bin/env node
// organism-infra/05: worktree lifecycle cleanup. Removes clean agent
// worktrees under <root>/.claude/worktrees/ whose HEAD is already on main
// (fast-forward merged, or a detached checkout of an ancestor commit), and
// reports dirty, locked, or unmerged ones without touching them.
//
// Usage: node scripts/worktree-gc.mjs [--root <repoRoot>] [--apply]
//
//   --root <repoRoot>  Path to the main checkout (defaults to cwd). Must be
//                       the main checkout, not one of the worktrees.
//   --apply            Actually remove removable worktrees. Without it, this
//                       is a dry run: reports dispositions, deletes nothing.
//
// See .scratch/organism-infra/issues/05-dispatch-into-existing-branch.md
// ("Scope approved", 2026-09-27) for the rule this implements.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  let root = process.cwd();
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") {
      root = argv[++i];
    } else if (arg === "--apply") {
      apply = true;
    }
  }
  return { root, apply };
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

const DISPOSITIONS = {
  LOCKED: "locked",
  DIRTY: "dirty",
  UNMERGED: "unmerged",
  REMOVABLE: "removable",
};

// Resolves a path to an absolute, forward-slashed form with no trailing
// slash, so paths from git output and from `path.join` compare equal
// regardless of platform separators or trailing slashes.
function normalizedAbsolutePath(p) {
  let resolved = path.resolve(p);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // Missing path (e.g. a prunable worktree): compare the lexical form.
  }
  return resolved.replace(/\\/g, "/").replace(/\/$/, "");
}

// Parses `git worktree list --porcelain` into an array of
// { worktreePath, headSha, branch (or null if detached), locked, lockReason }.
function parseWorktreeList(raw) {
  const blocks = raw.split(/\n\n+/).filter((b) => b.trim().length > 0);
  return blocks.map((block) => {
    const lines = block.split("\n");
    const entry = { worktreePath: null, headSha: null, branch: null, locked: false, lockReason: "" };
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        entry.worktreePath = line.slice("worktree ".length).trim();
      } else if (line.startsWith("HEAD ")) {
        entry.headSha = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        entry.branch = line.slice("branch ".length).trim();
      } else if (line === "detached") {
        entry.branch = null;
      } else if (line.startsWith("locked")) {
        entry.locked = true;
        entry.lockReason = line.slice("locked".length).trim();
      }
    }
    return entry;
  });
}

// Parses `git status --porcelain` into { code, filePath } entries. `code` is
// the two-char XY status ("??" for untracked). Handles the " -> " rename
// arrow by keeping the new path, and strips quoting git adds around paths
// with unusual characters.
function parseStatusEntries(raw) {
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const code = line.slice(0, 2);
      let filePath = line.slice(3);
      const arrow = filePath.indexOf(" -> ");
      if (arrow !== -1) filePath = filePath.slice(arrow + 4);
      if (filePath.startsWith('"') && filePath.endsWith('"')) {
        filePath = filePath.slice(1, -1);
      }
      return { code, filePath };
    });
}

function getStatusEntries(worktreePath) {
  // --untracked-files=all: without it, git collapses an entirely-untracked
  // directory (e.g. a fresh .claude/ or .scratch/handoffs/) into a single
  // "?? dir/" line, which hides the individual files forgiveness needs to
  // inspect.
  const status = git(worktreePath, ["status", "--porcelain", "--untracked-files=all"]);
  return parseStatusEntries(status);
}

// organism-infra/16: a dirty file is forgivable if (a) it is untracked in
// the worktree and its bytes exactly match the file at the same
// repo-relative path in main's tree at mainTip, or (b) its repo-relative
// path lives under .claude/, regardless of content. Only untracked ("??")
// entries are ever forgivable -- a tracked modification is always a real
// dirty change.
function isForgivableEntry(root, worktreePath, mainTip, entry) {
  if (entry.code !== "??") return false;
  const relPath = entry.filePath.replace(/\\/g, "/");
  if (relPath === ".claude" || relPath.startsWith(".claude/")) return true;
  // den-mvp/43: every den worktree carries an untracked copy of .agents/skills/; those files are not work.
  if (relPath === ".agents/skills" || relPath.startsWith(".agents/skills/")) return true;
  let wtBytes;
  try {
    wtBytes = readFileSync(path.join(worktreePath, entry.filePath));
  } catch {
    return false;
  }
  // organism-infra/26: also forgive a copy of a file that exists uncommitted
  // in the main checkout on disk (agents write handoffs there without
  // committing them).
  try {
    const diskBytes = readFileSync(path.join(root, entry.filePath));
    if (Buffer.compare(diskBytes, wtBytes) === 0) return true;
  } catch {
    // not present on disk in main -- fall through to the committed tree
  }
  try {
    // stdio stderr "ignore": a path missing from main makes git print
    // `fatal: path ... does not exist`; that just means "not identical".
    const mainBytes = execFileSync("git", ["show", `${mainTip}:${relPath}`], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return Buffer.compare(mainBytes, wtBytes) === 0;
  } catch {
    return false;
  }
}

// Builds a one-line diff summary for a single non-forgivable dirty entry:
// the file's repo-relative path plus an insertion/deletion count, so the
// gc report names what changed instead of just saying "dirty".
function diffSummaryForEntry(worktreePath, entry) {
  const relPath = entry.filePath;
  if (entry.code === "??") {
    let lineCount = 0;
    try {
      const content = readFileSync(path.join(worktreePath, relPath), "utf8");
      lineCount = content.length === 0 ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    } catch {
      // unreadable (binary, race with deletion, etc.) -- report the name only
    }
    return `${relPath} (+${lineCount} new)`;
  }
  try {
    const out = execFileSync("git", ["diff", "--numstat", "--", relPath], {
      cwd: worktreePath,
      encoding: "utf8",
    }).trim();
    const [ins, del] = out.split("\t");
    return `${relPath} (+${ins ?? "0"}/-${del ?? "0"})`;
  } catch {
    return relPath;
  }
}

function isAncestorOfMain(root, sha, mainTip) {
  try {
    git(root, ["merge-base", "--is-ancestor", sha, mainTip]);
    return true;
  } catch (err) {
    if (err.status === 1) return false;
    throw err;
  }
}

function determineMainTip(root, entries) {
  const rootResolved = normalizedAbsolutePath(root);
  const mainEntry = entries.find((e) => normalizedAbsolutePath(e.worktreePath) === rootResolved);
  let mainBranch = "main";
  if (mainEntry && mainEntry.branch) {
    mainBranch = mainEntry.branch.replace(/^refs\/heads\//, "");
  }
  return git(root, ["rev-parse", mainBranch]).trim();
}

function main() {
  const { root, apply } = parseArgs(process.argv.slice(2));
  const rootResolved = normalizedAbsolutePath(root);

  const raw = git(root, ["worktree", "list", "--porcelain"]);
  const entries = parseWorktreeList(raw);

  // `git worktree list --porcelain` always lists the main checkout first,
  // regardless of which worktree it's run from (see board-service.mjs's
  // resolveRoot, which relies on the same ordering). So the only way to
  // tell "this is the main checkout" from "this is some worktree of the
  // repo" is to compare against entries[0], not to check membership in the
  // whole list -- every worktree, including this one, is always a member.
  const isMainCheckout = entries.length > 0 && normalizedAbsolutePath(entries[0].worktreePath) === rootResolved;
  if (!isMainCheckout) {
    console.error(
      `worktree-gc: --root ${root} is not the main checkout (git worktree list does not list it). Refusing to run from inside a worktree.`
    );
    return 1;
  }

  const mainTip = determineMainTip(root, entries);

  const worktreesRoot = normalizedAbsolutePath(path.join(root, ".claude", "worktrees")) + "/";

  const candidates = entries.filter((e) => {
    const resolved = normalizedAbsolutePath(e.worktreePath);
    if (resolved === rootResolved) return false;
    return (resolved + "/").startsWith(worktreesRoot);
  });

  const lines = [];
  for (const entry of candidates) {
    const name = path.basename(entry.worktreePath);
    let disposition;
    let dirtySummary = "";
    if (entry.locked) {
      disposition = DISPOSITIONS.LOCKED;
    } else {
      const statusEntries = getStatusEntries(entry.worktreePath);
      const unforgivable = statusEntries.filter(
        (e) => !isForgivableEntry(root, entry.worktreePath, mainTip, e)
      );
      if (unforgivable.length > 0) {
        disposition = DISPOSITIONS.DIRTY;
        dirtySummary = unforgivable
          .map((e) => diffSummaryForEntry(entry.worktreePath, e))
          .join(", ");
      } else if (!isAncestorOfMain(root, entry.headSha, mainTip)) {
        disposition = DISPOSITIONS.UNMERGED;
      } else {
        disposition = DISPOSITIONS.REMOVABLE;
      }
    }

    if (disposition === DISPOSITIONS.REMOVABLE && apply) {
      // --force: a "removable" worktree may still carry forgivable dirty
      // files (untracked copies identical to main's, or .claude/ local
      // config), which git itself doesn't know are harmless.
      git(root, ["worktree", "remove", "--force", entry.worktreePath]);
      let branchNote = "";
      if (entry.branch) {
        const branchName = entry.branch.replace(/^refs\/heads\//, "");
        try {
          git(root, ["branch", "-d", branchName]);
          branchNote = `, branch ${branchName} deleted`;
        } catch (err) {
          branchNote = `, branch ${branchName} not deleted (${err.message.trim()})`;
        }
      }
      lines.push(`${name}: removed (was clean, merged into main${branchNote})`);
    } else if (disposition === DISPOSITIONS.DIRTY && dirtySummary) {
      lines.push(`${name}: ${disposition} (${dirtySummary})`);
    } else {
      lines.push(`${name}: ${disposition}${entry.locked && entry.lockReason ? ` (${entry.lockReason})` : ""}`);
    }
  }

  if (lines.length === 0) {
    console.log("no agent worktrees found under .claude/worktrees/");
  } else {
    console.log(lines.join("\n"));
  }

  return 0;
}

process.exit(main());
