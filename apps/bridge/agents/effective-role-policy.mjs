// Shared role/governance authority. Runtime adapters translate these clauses.
import { readFileSync } from 'node:fs';
import { ROLES, WORKTREES_DIR } from './policy.mjs';
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const WALL_HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const HOST_TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const PRIVATE_TLDS = new Set(["local", "localhost", "localdomain", "internal", "lan", "home", "corp", "intranet", "private", "arpa"]);
const WALL_HOSTS_MAX = 20;
const isDense = (a) => {
  if (!Array.isArray(a)) return false;
  for (let i = 0; i < a.length; i += 1) if (!Object.hasOwn(a, i)) return false; // a hole is not an entry
  return true;
};
export function isWallHost(host) {
  if (typeof host !== "string" || !WALL_HOST_RE.test(host)) return false;
  const tld = host.slice(host.lastIndexOf(".") + 1);
  return HOST_TLD_RE.test(tld) && !PRIVATE_TLDS.has(tld);
}
function isWall(wall) {
  if (!isPlainObject(wall) || Object.keys(wall).length !== 1 || !isDense(wall.hosts)) return false;
  return wall.hosts.length <= WALL_HOSTS_MAX && wall.hosts.every(isWallHost);
}

// agent-os/02: what a ceiling forbids, from governance.json (a guardrail path). Paths are relative to the worktree, plain
// segments with an optional trailing /**; commands are plain words. A deny rule wins over an allow, so no grant lifts one.
const GOVERNANCE = JSON.parse(readFileSync(new URL("./governance.json", import.meta.url), "utf8"));
const FORBID_PATH_RE = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*(?:\/\*\*)?$/;
const FORBID_RUN_RE = /^[A-Za-z0-9._-]+(?: [A-Za-z0-9._-]+)*$/;
const FORBID_MAX = 40;
const isForbidList = (list, re) => isDense(list) && list.length <= FORBID_MAX && list.every((e) => typeof e === "string" && re.test(e));
// den-mvp outcome 1 (spec section 3): where credentials are kept, as ~/ paths of plain segments. No agent reads or writes them.
const CREDENTIAL_RE = /^~(?:\/[A-Za-z0-9._@+-]+)+$/;
const isCredentialList = (list) => isForbidList(list, CREDENTIAL_RE) && list.every((p) => !p.split("/").some((part) => part === "." || part === ".."));
{
  const ok = isPlainObject(GOVERNANCE) && Object.keys(GOVERNANCE).length === 5 && isCredentialList(GOVERNANCE.credentialPaths) &&
    isForbidList(GOVERNANCE.ciPaths, FORBID_PATH_RE) && isForbidList(GOVERNANCE.guardrailPaths, FORBID_PATH_RE) &&
    isForbidList(GOVERNANCE.denyRun, FORBID_RUN_RE) && isDense(GOVERNANCE.ciGrantRoles) && GOVERNANCE.ciGrantRoles.every((r) => ROLES.includes(r));
  if (!ok) throw new Error("governance.json: bad governance data");
}
const isForbid = (f) => isPlainObject(f) && Object.keys(f).length === 2 && isForbidList(f.write, FORBID_PATH_RE) && isForbidList(f.run, FORBID_RUN_RE);
const baseOf = (entry) => entry.replace(/\/\*\*$/, "");
/** The credential stores of governance.json. The runtime passes the ones that exist to compileCeiling: a deny target must exist. */
export const CREDENTIAL_PATHS = Object.freeze([...GOVERNANCE.credentialPaths]);
/** The governed paths of a checkout (guardrail and CI), relative and without a trailing /** (agent-os/07: a path grant on one is a 400). */
export const GOVERNED_BASES = Object.freeze([...new Set([...GOVERNANCE.guardrailPaths, ...GOVERNANCE.ciPaths].map(baseOf))]);

// agent-os/02 (ADR 0021 decision 3): task grants, data in a fixed shape: { kind: "host", value: <host name> } or
// { kind: "path", value: <absolute or ~/ path of plain segments> }, at most six. Nothing else is accepted, and the error
// text never echoes a value back.
const GRANTS_MAX = 6;
const GRANT_PATH_RE = /^~?(?:\/[A-Za-z0-9._@+-]+)+$/;
export function isGrantPath(p) {
  return typeof p === "string" && GRANT_PATH_RE.test(p) && !p.split("/").some((part) => part === "." || part === "..");
}
/** The validated grants as { hosts, paths }, repeats dropped. Anything outside the fixed shape is a TypeError. */
export function parseGrants(grants) {
  const hosts = [];
  const paths = [];
  if (grants === undefined) return { hosts, paths };
  if (!isDense(grants) || grants.length > GRANTS_MAX) throw new TypeError(`grants must be a list of at most ${GRANTS_MAX} grants`);
  for (const g of grants) {
    if (!isPlainObject(g) || Object.keys(g).length !== 2 || !Object.hasOwn(g, "kind") || !Object.hasOwn(g, "value")) throw new TypeError("a grant must be { kind, value }");
    if (g.kind === "host" && isWallHost(g.value)) {
      if (!hosts.includes(g.value)) hosts.push(g.value);
    } else if (g.kind === "path" && isGrantPath(g.value)) {
      if (!paths.includes(g.value)) paths.push(g.value);
    } else {
      throw new TypeError("a grant must be a host name or an absolute (or ~/) path of plain segments");
    }
  }
  return { hosts, paths };
}

// Governed paths of the main checkout that a path grant reaches (compileCeiling's denyAbs): absolute, plain segments, an
// optional trailing /**. A grant list is at most six and the governed list at most 40 a side, so the cap is generous.
const DENY_ABS_RE = /^(?:\/[A-Za-z0-9._@+-]+)+(?:\/\*\*)?$/;
const DENY_ABS_MAX = GRANTS_MAX * 2 * FORBID_MAX;


const isScopeWrites = (scopes) => isDense(scopes) && scopes.length > 0 && scopes.length <= 50 && scopes.every((scope) => isPlainObject(scope) && Object.keys(scope).length === 2 && isWorktreePath(scope.path) && typeof scope.directory === "boolean");
const WORKTREE_RE = /^(?:\/[A-Za-z0-9._@+-]+)+$/;
export function isWorktreePath(dir) {
  return typeof dir === "string" && WORKTREE_RE.test(dir) && !dir.split("/").some((part) => part === "." || part === "..");
}

// ---- role ceilings (agent-os/04, ADR 0021 decisions 2 to 5) --------------------------------
// ceilings.json gives scout, developer, qa and security a ceiling: { write: "none" | "worktree", hosts: [...] }. A role with
// no key has none and starts as before. The data is checked once at load, so a bad edit stops the bridge, not a Start.
const CEILINGS = JSON.parse(readFileSync(new URL("./ceilings.json", import.meta.url), "utf8"));
for (const [role, ceiling] of Object.entries(CEILINGS)) {
  const ok = ROLES.includes(role) && isPlainObject(ceiling) && Object.keys(ceiling).length === 2 && (ceiling.write === "none" || ceiling.write === "worktree") && isWall({ hosts: ceiling.hosts });
  if (!ok) throw new Error(`ceilings.json: bad ceiling for ${JSON.stringify(role)}`);
}

/** Whether a role has a ceiling, and whether it may be given task grants (a role that cannot write takes none). */
// agent-os/05: the Start box's two-sided table, per role. The UI renders these lines and holds no ceiling of its own.
export function wallTables() {
  return Object.fromEntries(Object.entries(CEILINGS).map(([role, c]) => {
    const none = c.write === "none";
    const security = role === "security";
    return [role, {
      takesGrants: !none,
      runs: none ? ["Read the project", "Read the web"] : security ? ["Read the project", "Write its report in its worktree"] : ["Write in its worktree", "Read the project"],
      asks: none ? ["Nothing. It cannot write, push or merge."] : security ? ["Any host", "Any other write"] : ["Any host", "Any path outside"],
    }];
  }));
}
export const ceilingOf = (role) => (Object.hasOwn(CEILINGS, role) ? { takesGrants: CEILINGS[role].write !== "none" } : null);

const covers = (grant, file) => file === grant || file.startsWith(`${grant}/`);

/** What a worktree agent may not write in the main checkout's .git (agent-os/09). `objects` and `worktrees/<own>` stay writable. */
export const MAIN_GIT_DENIED = Object.freeze(["refs", "HEAD", "packed-refs", "index"]);

/** A grant as an absolute path: "~/x" becomes "<home>/x" when home is known; otherwise it is returned as it is. */
const expandHome = (grant, home) => (grant.startsWith("~/") && home !== undefined ? `${home}${grant.slice(1)}` : grant);

/**
 * Whether a path grant contains an agent's worktree: the worktree itself, or the worktrees directory of the main checkout
 * (so the main checkout, its .claude and any parent are included). Such a grant would open the main checkout and the
 * sibling worktrees, where the governance denies do not reach. A "~/" grant is checked when home is given.
 */
/** True when a path grant is on, under or above a credential store of governance.json (any case). */
export function grantTouchesCredential(grant, home) {
  const g = grant.toLowerCase();
  // A "~/" grant is compared in that form; an absolute one against the stores under home, when home is known.
  const base = g.startsWith("~/") ? "~" : home?.toLowerCase();
  if (base === undefined) return false;
  return CREDENTIAL_PATHS.some((c) => {
    const store = `${base}${c.slice(1).toLowerCase()}`;
    return covers(store, g) || covers(g, store);
  });
}

export function grantContainsWorktrees(grant, { root, home, worktree } = {}) {
  const p = expandHome(grant, home);
  if (!p.startsWith("/")) return false;
  return [worktree, root === undefined ? undefined : `${root}/${WORKTREES_DIR}`].some((dir) => dir !== undefined && covers(p, dir));
}

// The governed paths (absolute, in the main checkout) that one path grant reaches: the grant itself when it is inside a governed
// directory, the governed path when the grant is above it. A grant in the agent's own worktree is left to the relative denies.
function governedUnder(grant, root, worktree) {
  if (!grant.startsWith("/") || (worktree !== undefined && covers(worktree, grant))) return [];
  const out = [];
  // Compared in lower case (agent-os/07: macOS volumes are case-insensitive); the grant's own casing is what a deny names.
  const g = grant.toLowerCase();
  for (const entry of [...GOVERNANCE.guardrailPaths, ...GOVERNANCE.ciPaths]) {
    const governed = `${root}/${baseOf(entry)}`;
    const lowered = governed.toLowerCase();
    if (g === lowered) out.push(`${root}/${entry}`, ...(grant === governed ? [] : [`${grant}/**`]));
    else if (covers(lowered, g)) out.push(`${grant}/**`);
    else if (covers(g, lowered)) out.push(`${root}/${entry}`);
  }
  return out;
}

/**
 * The buildClaudeArgs options for a role's ceiling plus its task grants: the wall with the ceiling's hosts and the granted
 * ones, Write and Edit allow rules for the worktree when the role writes and for each granted path, and the governance
 * denies (CI and guardrail paths, and the commands). A way out (a host, or `remote`: a remote connection, which the shell
 * sandbox does not cover) brings a read limit with it, which reopens the worktree, the project's node_modules and main .git, the Node install
 * (toolchain), ~/.gitconfig and the Playwright browsers; one of those that reaches a credential store is a TypeError, so the
 * run is refused rather than started with a store open. Forbid beats permit: no grant lifts
 * a deny, except that a role in governance.json's ciGrantRoles (security) drops the CI-path denies a granted path covers.
 * null for a role with no ceiling. A role that writes and gets a worktree that is not a plain absolute path is a TypeError;
 * worktree undefined leaves the write rules out (the wall stays, the Write request stays). Any grant outside the fixed shape,
 * any grant for a role that cannot write, and a path grant that contains the worktree are TypeErrors.
 */
export function compileEffectiveRolePolicy(role, { worktree, grants, root, home, mainGit, credentials, remote, toolchain, tree, treeReadOnly = false, scopeWrites } = {}) {
  const { hosts: grantHosts, paths } = parseGrants(grants);
  if (credentials !== undefined && !(isDense(credentials) && credentials.every((p) => CREDENTIAL_PATHS.includes(p)))) throw new TypeError("compileCeiling: credentials must be paths from governance.json");
  if (root !== undefined && !isWorktreePath(root)) throw new TypeError("compileCeiling: root must be a plain absolute path");
  if (mainGit !== undefined && !isWorktreePath(mainGit)) throw new TypeError("compileCeiling: mainGit must be a plain absolute path");
  if (home !== undefined && !isWorktreePath(home)) throw new TypeError("compileCeiling: home must be a plain absolute path");
  if (toolchain !== undefined && !isWorktreePath(toolchain)) throw new TypeError("compileCeiling: toolchain must be a plain absolute path");
  if (remote !== undefined && typeof remote !== "boolean") throw new TypeError("compileCeiling: remote must be a boolean");
  if (treeReadOnly && tree !== true) throw new TypeError("compileCeiling: a read-only tree profile needs tree admission");
  if (scopeWrites !== undefined && !(tree === true && role === "runner" && !treeReadOnly && worktree !== undefined && isScopeWrites(scopeWrites))) throw new TypeError("compileCeiling: scoped writes are for an admitted code runner");
  // Runner is a host-admitted tree leaf only; it never becomes a public direct-task role.
  const ceiling = tree === true && (role === "runner" || treeReadOnly) ? { write: "none", hosts: [] } : Object.hasOwn(CEILINGS, role) ? CEILINGS[role] : undefined;
  if (ceiling === undefined) {
    if (grantHosts.length + paths.length > 0) throw new TypeError("compileCeiling: this role takes no grants");
    return null;
  }
  if (ceiling.write === "none" && grantHosts.length + paths.length > 0) throw new TypeError("compileCeiling: this role takes no grants");
  const options = {};
  if (ceiling.write === "worktree" && worktree !== undefined) {
    if (!isWorktreePath(worktree)) throw new TypeError("compileCeiling: worktree must be a plain absolute path");
    options.worktree = worktree;
  }
  // den-mvp outcome 1: a grant on, under or above a credential store would reopen it to the shell; forbid beats permit.
  if (paths.some((p) => grantTouchesCredential(p, home))) throw new TypeError("compileCeiling: a path grant may not reach a credential store");
  // A grant above the worktree would open the main checkout and its sibling worktrees, where the governance denies do not reach.
  if (paths.some((p) => grantContainsWorktrees(p, { root, home, worktree }))) throw new TypeError("compileCeiling: a path grant may not contain the worktree");
  const lifted = (entry) =>
    options.worktree !== undefined && GOVERNANCE.ciGrantRoles.includes(role) && paths.some((p) => p.startsWith("/") && covers(p, `${options.worktree}/${baseOf(entry)}`));
  // A path grant inside the main checkout: the governed paths it reaches are denied in absolute form. The CI exception is not
  // carried over; it is for the role's own worktree only.
  // agent-os/09 (ADR 0021 Amendment 2, decision 17): a worktree agent never writes the main .git's refs, HEAD, packed-refs or index,
  // with or without grants. Fixed names under a path the bridge computed; objects/ and worktrees/ stay writable. Keyed on mainGit, not root.
  const denyAbs = [...new Set([
    ...(root === undefined ? [] : paths.flatMap((g) => governedUnder(expandHome(g, home), root, worktree))),
    ...(mainGit === undefined ? [] : MAIN_GIT_DENIED.map((name) => (name === "refs" ? `${mainGit}/refs/**` : `${mainGit}/${name}`))),
    ...(mainGit === undefined ? [] : [`${mainGit}/den-tree-artifacts/**`]),
    ...(tree === true && (role === "runner" || treeReadOnly) && scopeWrites === undefined && worktree !== undefined ? [`${worktree}/**`] : []),
  ])];
  const hosts = [...new Set([...ceiling.hosts, ...grantHosts])];
  const readLimit = hosts.length > 0 || remote === true;
  // What the work reads outside the worktree: the project's node_modules and main .git, node and npm, git's identity, the browsers.
  // Never the project root itself: it holds the worktree, and reopening it re-mounts the worktree read-only (live probe, 2026-10-18).
  const readOpen = !readLimit ? [] : [...new Set([root === undefined ? undefined : `${root}/node_modules`, mainGit, toolchain, ...(home === undefined ? [] : [`${home}/.gitconfig`, `${home}/.cache/ms-playwright`])].filter((p) => p !== undefined))];
  if (readOpen.some((p) => grantTouchesCredential(p, home))) throw new TypeError("compileCeiling: a path the read limit reopens may not reach a credential store");
  return {
    version: 1,
    network: { hosts },
    filesystem: {
      writeWorktree: options.worktree,
      deniedRelativeWritePatterns: [...GOVERNANCE.guardrailPaths, ...GOVERNANCE.ciPaths.filter((e) => !lifted(e))],
      deniedAbsoluteWritePatterns: denyAbs,
      scopeWrites,
      treeReadRoot: tree === true ? worktree : undefined,
      privatePaths: mainGit === undefined ? [] : [`${mainGit}/den-tree-artifacts`],
      writePaths: paths,
      readMode: readLimit ? 'home-limited' : 'ambient',
      openReadPaths: readOpen,
      credentials: credentials?.length ? [...credentials] : [],
    },
    execution: { deniedCommands: [...GOVERNANCE.denyRun, ...(tree === true && (role === 'runner' || treeReadOnly) ? ['git commit', 'board'] : [])] },
    treeReadOnly,
  };
}

export { isWall, isDense, isForbid, baseOf, GRANTS_MAX, DENY_ABS_RE, DENY_ABS_MAX, isScopeWrites };
