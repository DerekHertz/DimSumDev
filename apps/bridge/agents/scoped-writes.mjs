// A scoped launch mounts already-open inodes, never paths that can be swapped after validation.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

const prepared = new WeakSet();
const MAX_SCOPES = 50;
const MAX_ENTRIES = 10_000;
const MAX_DEPTH = 40;
const governance = JSON.parse(readFileSync(new URL("./governance.json", import.meta.url), "utf8"));
const protectedPaths = [...governance.guardrailPaths, ...governance.ciPaths, ".codex", ".agents", ".den", ".scratch"]
  .filter((p) => !p.startsWith("~")).map((p) => p.replace(/\/\*\*$/, "").toLowerCase());
const under = (child, parent) => child === parent || child.startsWith(`${parent}/`);
const relative = (root, file) => path.relative(root, file).split(path.sep).join("/");
const fail = (reason) => { throw new Error(`scoped writes: ${reason}`); };

/** Existing plain files/directories only; a caller creating a new file scopes an existing parent directory. */
export function canonicalWriteScopes({ worktree, paths }) {
  if (typeof worktree !== "string" || !path.isAbsolute(worktree) || worktree.includes("\0") || !Array.isArray(paths) || paths.length > MAX_SCOPES || paths.some((p) => typeof p !== "string" || !path.isAbsolute(p) || p.includes("\0"))) fail("expected a worktree and at most fifty absolute scope paths");
  const root = realpathSync(worktree);
  if (root !== path.resolve(worktree) || !lstatSync(root).isDirectory()) fail("the worktree must be a canonical plain directory");
  const scopes = [...new Set(paths.map((p) => path.resolve(p)))].sort();
  for (const file of scopes) {
    const rel = relative(root, file);
    if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(path.relative(root, file))) fail("a write scope must be strictly inside its worktree");
    const lowered = rel.toLowerCase();
    if (protectedPaths.some((p) => under(lowered, p) || under(p, lowered))) fail("a write scope reaches protected configuration or git state");
    let current = root;
    for (const segment of rel.split("/")) {
      current = path.join(current, segment);
      let stat;
      try { stat = lstatSync(current); } catch { fail("a scope must exist; scope its existing parent directory to add files"); }
      if (stat.isSymbolicLink()) fail("a scope path contains a symbolic link");
    }
    if (realpathSync(file) !== file) fail("a scope path is not canonical");
  }
  const minimal = scopes.filter((file, i) => !scopes.slice(0, i).some((parent) => under(relative(root, file), relative(root, parent))));
  let entries = 0;
  const inspect = (file, depth) => {
    if (++entries > MAX_ENTRIES || depth > MAX_DEPTH) fail("the scope is too broad to inspect; declare narrower paths");
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) fail("a scoped directory contains a symbolic link");
    if (stat.isFile()) {
      if (stat.nlink !== 1) fail("a scoped file has another hard link");
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(file)) inspect(path.join(file, name), depth + 1);
    } else fail("a scope contains a special filesystem entry");
  };
  for (const file of minimal) inspect(file, 0);
  return { worktree: root, paths: minimal };
}

export function prepareWriteScope(scope, { fdBase = 4 } = {}) {
  if (!Number.isInteger(fdBase) || fdBase < 4) fail("invalid descriptor offset");
  const checked = canonicalWriteScopes(scope);
  const opened = [];
  try {
    for (const file of [checked.worktree, ...checked.paths]) {
      const before = lstatSync(file);
      const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      opened.push(fd);
      const actual = fstatSync(fd);
      if (actual.dev !== before.dev || actual.ino !== before.ino || (!actual.isDirectory() && !actual.isFile()) || (actual.isFile() && actual.nlink !== 1)) fail("a scope changed while its inode was opened");
      if (process.platform === "linux" && realpathSync(`/proc/self/fd/${fd}`) !== file) fail("a scope moved while its inode was opened");
    }
    let closed = false;
    const result = {
      worktree: checked.worktree,
      paths: Object.freeze(checked.paths.slice()),
      stdio: Object.freeze(opened.slice()),
      binds: Object.freeze([checked.worktree, ...checked.paths].map((destination, index) => Object.freeze({ descriptor: fdBase + index, destination, readonly: index === 0 }))),
      close() {
        if (closed) return;
        closed = true;
        prepared.delete(result);
        for (const fd of opened) closeSync(fd);
      },
    };
    Object.freeze(result);
    prepared.add(result);
    return result;
  } catch (err) {
    for (const fd of opened) closeSync(fd);
    throw err;
  }
}

/** Only a launcher-prepared descriptor capability can become mount arguments. */
export function scopedWriteBindArgs(scope) {
  if (!prepared.has(scope)) fail("the mount capability is absent or closed");
  return scope.binds.flatMap(({ descriptor, destination, readonly }) => [readonly ? "--ro-bind-fd" : "--bind-fd", String(descriptor), destination]);
}
