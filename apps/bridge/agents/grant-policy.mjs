// agent-os/07 (ADR 0021 decision 3): grants that could never be safe are refused when a task is created, with a reason the Start
// box can show, instead of being accepted and then denied (or accepted and allowed). This is the first layer; the governance
// denies that compileCeiling emits stay as the second layer for a grant that reaches the adapter by another route.
//
// Refused path grants: on or under a governed path of the main checkout (any case, any symlinked form); on or under a home
// configuration path or a shell startup file; on or under a system directory; and one that contains the home directory.
// Refused host grants: GitHub (the wall is the boundary, and `Bash(*git *push*)` rules do not parse shell quoting).
// den-mvp outcome 1: also refused is a path grant on, under or above a credential store of governance.json; a grant must
// not reopen what every role is denied.
// A reason never echoes the grant value back.
import { readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { CREDENTIAL_PATHS, GOVERNED_BASES, grantContainsWorktrees } from "./claude-adapter.mjs";

// Security's list from 02-security finding 1 (user decision 2026-10-11), by first path segment under the home directory.
const HOME_DIRS = new Set([".ssh", ".claude", ".config", ".local"]);
const RC_FILES = new Set([".bashrc", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".login", ".logout", ".kshrc", ".cshrc", ".tcshrc", ".bash_profile", ".bash_login", ".bash_logout", ".bash_aliases"]);
// `/etc` and `/usr` from the decision, and the other directories a write would change the system through (developer's addition).
const SYSTEM_DIRS = new Set(["etc", "usr", "bin", "sbin", "lib", "lib32", "lib64", "boot", "root", "sys", "proc", "dev", "system", "library"]);
const MAX_HOPS = 16;

const covers = (dir, file) => file === dir || file.startsWith(`${dir}/`);
const homeRefused = (segments) => HOME_DIRS.has(segments[0]) || segments[0].startsWith(".git") || RC_FILES.has(segments[0]);
const systemRefused = (segments) => SYSTEM_DIRS.has(segments[0]) || (segments[0] === "private" && segments[1] === "etc"); // macOS /etc

const REASON_GOVERNED = "a path grant may not be on a governed path of the main checkout";
const REASON_HOME = "a path grant may not be on a home configuration path, a shell startup file or a system directory";
const REASON_HOME_DIR = "a path grant may not contain the home directory";
const REASON_WORKTREE = "a path grant may not contain the agent's worktree";
const REASON_CREDENTIAL = "a path grant may not reach a credential store";
// The stores in "~/" form, lower-cased; `touches` is true for a grant on, under or above one.
const CREDENTIALS = CREDENTIAL_PATHS.map((p) => p.slice(1).toLowerCase());
const touchesCredential = (home, form) => CREDENTIALS.some((c) => covers(`${home}${c}`, form) || covers(form, `${home}${c}`));
const REASON_GITHUB = "a GitHub host cannot be granted yet";

/** The path with every symlink resolved, through the nearest part that exists; what does not exist yet is appended as written. */
export async function resolveReal(p, hops = 0) {
  if (hops > MAX_HOPS) return p;
  try {
    return await realpath(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p;
    try {
      // A dangling symlink: follow it to where it points.
      return await resolveReal(path.resolve(parent, await readlink(p)), hops + 1);
    } catch {
      return path.join(await resolveReal(parent, hops + 1), path.basename(p));
    }
  }
}

/** Why one absolute path (lower-cased) is refused, or undefined. `roots` and `homes` are lower-cased absolute paths. */
function refusalFor(form, { roots, homes }) {
  if (roots.some((r) => GOVERNED_BASES.some((b) => covers(`${r}/${b.toLowerCase()}`, form)))) return REASON_GOVERNED;
  for (const h of homes) {
    if (covers(form, h)) return REASON_HOME_DIR;
    if (covers(h, form) && homeRefused(form.slice(h.length + 1).split("/"))) return REASON_HOME;
    if (touchesCredential(h, form)) return REASON_CREDENTIAL;
  }
  if (systemRefused(form.slice(1).split("/"))) return REASON_HOME;
  return undefined;
}

/**
 * The reason a task's (already shape-checked) grants are refused, or null. `roots` are the main checkout's lexical and resolved
 * paths, `home` the user's home directory when known. Async: a path is checked as written and with its symlinks resolved.
 */
export async function grantRefusal({ hosts, paths }, { roots, home }) {
  if (hosts.some((h) => h.toLowerCase() === "github.com" || h.toLowerCase().endsWith(".github.com"))) return REASON_GITHUB;
  if (paths.length === 0) return null;
  const homeForms = home === undefined ? [] : [...new Set([home, await resolveReal(home)])];
  const ctx = { roots: [...new Set(roots.map((r) => r.toLowerCase()))], homes: homeForms.map((h) => h.toLowerCase()) };
  for (const grant of paths) {
    const absolute = grant.startsWith("~/") ? (home === undefined ? undefined : `${home}${grant.slice(1)}`) : grant;
    // A "~/" grant with no known home is judged by its first segment alone.
    if (absolute === undefined && homeRefused(grant.slice(2).toLowerCase().split("/"))) return REASON_HOME;
    if (absolute === undefined && touchesCredential("~", grant.toLowerCase())) return REASON_CREDENTIAL;
    if (absolute === undefined) continue;
    for (const form of new Set([absolute, await resolveReal(absolute)])) {
      const why = refusalFor(form.toLowerCase(), ctx);
      if (why !== undefined) return why;
      if (roots.some((r) => grantContainsWorktrees(form, { root: r }))) return REASON_WORKTREE;
    }
  }
  return null;
}
