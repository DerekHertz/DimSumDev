// Bridge-only Git objects and receipts. No method publishes a branch or accepts
// agent-supplied review authority; integration asks the host about each receipt.
// The host holds its exclusive task-tree lease, hides commonGit/den-tree-artifacts
// from every model before launch, and supplies trusted lifecycle callbacks:
// canCapture means ALL workspace resource groups settled, canMaterialize means
// the private parent is stopped, and canReconcile additionally means explicit
// recovery authority. Process exit alone is not a resource-group settlement.
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createAdmission } from "./admission.mjs";
import { LIMITS } from "./resource-group.mjs";
import { checkoutManagedWorktree, disabledManagedFilters } from "./workspace.mjs";

const execFileP = promisify(execFile);
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const INTERNAL = /^(?:\.git|\.scratch|\.den)(?:\/|$)/;
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const stable = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => order(a, b))) : item);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const within = (file, scope) => file === scope || file.startsWith(`${scope}/`);
const relative = (value) => typeof value === "string" && value !== "" && !/[:\\\x00-\x1f\x7f]/.test(value) && !path.posix.isAbsolute(value) && !value.split("/").some((part) => !part || part === "." || part === "..") && !INTERNAL.test(value);
const fields = (object, allowed) => object && typeof object === "object" && !Array.isArray(object) && Object.keys(object).every((key) => allowed.includes(key));
const clone = (value) => structuredClone(value);
const processLocks = new Map();

export function createTreeArtifacts({ root, checkReturned, verifyAccepted = async () => false, canCapture = async () => false, canMaterialize = async () => false, canReconcile = async () => false, checkout = checkoutManagedWorktree, exec = execFileP } = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new TypeError("tree artifacts need an absolute project root");
  const admission = checkReturned ? null : createAdmission({ root });
  const check = checkReturned ?? admission.checkReturned;
  const locks = processLocks;
  let stateDirectory;
  const run = async (dir, args, options = {}) => {
    const result = await exec("git", ["-C", dir, "-c", "protocol.allow=never", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", timeout: 30000, maxBuffer: 16 << 20, ...options });
    return String(result.stdout ?? "");
  };
  const sha = async (dir, revision) => {
    if (!SHA.test(revision ?? "")) throw new Error("an artifact revision must be a full commit ID");
    const found = (await run(dir, ["rev-parse", "--verify", `${revision}^{commit}`])).trim();
    if (found !== revision) throw new Error("the exact artifact commit is unavailable");
    return found;
  };
  const directory = async () => {
    if (stateDirectory) {
      const info = await lstat(stateDirectory);
      if (info.isSymbolicLink() || !info.isDirectory() || await realpath(stateDirectory) !== stateDirectory) throw new Error("the artifact store must be a canonical plain directory");
      await chmod(stateDirectory, 0o700);
      return stateDirectory;
    }
    const common = (await run(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    const candidate = path.join(await realpath(common), "den-tree-artifacts");
    await mkdir(candidate, { mode: 0o700 }).catch((err) => { if (err.code !== "EEXIST") throw err; });
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(candidate) !== candidate) throw new Error("the artifact store must be a canonical plain directory");
    await chmod(candidate, 0o700);
    stateDirectory = candidate;
    return stateDirectory;
  };
  const fileFor = async (operationId) => path.join(await directory(), `${hash(operationId)}.json`);
  async function read(operationId) {
    if (!ID.test(operationId ?? "")) throw new Error("an artifact operation ID is required");
    try {
      const record = JSON.parse(await readFile(await fileFor(operationId), "utf8"));
      if (record.version !== 1 || record.operationId !== operationId || record.inputHash !== hash(stable(record.input)) || !["intent", "complete", "blocked"].includes(record.status)) throw new Error("the artifact receipt is invalid");
      return record;
    } catch (err) { if (err.code === "ENOENT") return null; throw err; }
  }
  async function write(record, exclusive = false) {
    const target = await fileFor(record.operationId);
    const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
    const handle = await open(exclusive ? target : temporary, "wx", 0o600);
    try { await handle.writeFile(`${stable(record)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    if (!exclusive) await rename(temporary, target);
    // File fsync precedes the atomic receipt replacement. Directory fsync is not
    // available on Windows; no code treats a missing receipt as a completed op.
    if (process.platform !== "win32") {
      const dir = await open(await directory(), "r");
      try { await dir.sync(); } finally { await dir.close(); }
    }
  }
  const serial = (key, action) => {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    locks.set(key, next);
    return next.finally(() => { if (locks.get(key) === next) locks.delete(key); });
  };
  async function materializationLease(dir, operationId, action) {
    const lease = path.join(await directory(), `workspace-${hash(dir)}.lease`);
    const owner = { workspace: dir, operationId, pid: process.pid, nonce: randomBytes(16).toString("hex") };
    const handle = await open(lease, "wx", 0o600).catch((err) => {
      if (err.code === "EEXIST") throw new Error("private workspace has an active or uncertain materialization lease; explicit reconciliation is required");
      throw err;
    });
    try {
      await handle.writeFile(stable(owner)); await handle.sync();
      return await action();
    } finally {
      await handle.close();
      // A crashed bridge leaves the lease for explicit owner/group/HEAD
      // reconciliation. Never break a lease based on age or caller claims.
      if (await readFile(lease, "utf8") === stable(owner)) await rm(lease);
      else throw new Error("private workspace lease ownership changed; preserve it for reconciliation");
    }
  }
  async function workspaceOf(workspace) {
    if (!workspace || typeof workspace.dir !== "string") throw new Error("a private artifact worktree is required");
    const dir = await realpath(workspace.dir);
    const project = await realpath(root);
    const rel = path.relative(path.join(project, ".claude", "worktrees"), dir);
    if (dir === project || rel === "" || rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel) || !path.basename(dir).startsWith("den-")) throw new Error("artifacts use only private den worktrees, never the project checkout");
    const listed = (await run(root, ["worktree", "list", "--porcelain"])).split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
    if (!(await Promise.all(listed.map((item) => realpath(item).catch(() => null)))).includes(dir)) throw new Error("the artifact directory is not a registered project worktree");
    if ((await run(dir, ["symbolic-ref", "-q", "HEAD"]).then(() => true, () => false))) throw new Error("an artifact worktree must have detached HEAD");
    return dir;
  }
  const names = (text) => [...new Set(text.split("\0").filter(Boolean))].sort();
  async function changedAt(dir, base, candidate) {
    if (!candidate) throw new Error("working files must be compared without Git clean filters");
    return names(await run(dir, ["diff", "--no-renames", "--name-only", "-z", base, ...(candidate ? [candidate] : []), "--"]));
  }
  async function snapshotAt(dir, base) {
    const format = (await run(dir, ["rev-parse", "--show-object-format"])).trim();
    if (!["sha1", "sha256"].includes(format)) throw new Error("the repository uses an unsupported object format");
    const entries = new Map((await run(dir, ["ls-tree", "-r", "-z", "--full-tree", base])).split("\0").filter(Boolean).map((entry) => {
      const matched = /^(\d+) (?:blob|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
      if (!matched) throw new Error("the candidate tree contains an invalid path entry");
      return [matched[3], { mode: matched[1], object: matched[2] }];
    }));
    const all = [...new Set([...entries.keys(), ...names(await run(dir, ["ls-files", "-c", "-o", "--exclude-standard", "-z"]))])].sort();
    const snapshots = [];
    let bytes = 0;
    for (const name of all) {
      if (!relative(name)) throw new Error("an artifact tree contains an internal or unsafe path");
      const before = entries.get(name);
      let cursor = dir;
      for (const component of name.split("/")) {
        cursor = path.join(cursor, component);
        const componentInfo = await lstat(cursor).catch((err) => { if (err.code === "ENOENT") return null; throw err; });
        if (componentInfo?.isSymbolicLink()) throw new Error("artifact paths may not traverse or create symbolic links");
      }
      const filename = path.join(dir, ...name.split("/"));
      const info = await lstat(filename).catch((err) => { if (err.code === "ENOENT") return null; throw err; });
      if (!info) { if (before) snapshots.push({ path: name, mode: null, content: null, contentHash: null }); continue; }
      if (!info.isFile()) throw new Error("artifact snapshots contain regular files only");
      const mode = process.platform === "win32" ? before?.mode === "100755" ? "100755" : "100644" : info.mode & 0o111 ? "100755" : "100644";
      const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const digest = createHash(format).update(`blob ${info.size}\0`);
        const buffer = Buffer.alloc(128 * 1024);
        let offset = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) break;
          digest.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
        }
        if (offset !== info.size) throw new Error("an artifact file changed during capture");
        const observed = digest.digest("hex");
        if (observed === before?.object && mode === before?.mode) continue;
        if ((bytes += info.size) > LIMITS.storage.outputMiB * 1024 * 1024) throw new Error("the artifact snapshot exceeds the configured output storage budget");
        const content = await handle.readFile();
        const current = createHash(format).update(`blob ${content.length}\0`).update(content).digest("hex");
        // readFile starts at offset zero: positional reads above did not move it.
        if (content.length !== info.size || current !== observed) throw new Error("an artifact file changed during capture");
        snapshots.push({ path: name, mode, content, contentHash: hash(content) });
      } finally { await handle.close(); }
    }
    return snapshots;
  }
  async function cleanAt(dir, base) {
    return (await snapshotAt(dir, base)).length === 0 && names(await run(dir, ["diff-index", "--cached", "--name-only", "-z", base, "--"])).length === 0;
  }
  async function checkedPaths(dir, scopes, changed) {
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 50 || !scopes.every(relative)) throw new Error("artifact scopes must be explicit paths inside the worktree");
    if (!changed.every((name) => relative(name) && scopes.some((scope) => within(name, scope)))) throw new Error("the artifact changed a path outside its admitted scope");
    for (const name of changed) {
      let cursor = dir;
      for (const part of name.split("/")) {
        cursor = path.join(cursor, part);
        const info = await lstat(cursor).catch((err) => { if (err.code === "ENOENT") return null; throw err; });
        if (info?.isSymbolicLink()) throw new Error("artifact paths may not traverse or create symbolic links");
      }
    }
    const failures = await check({ scopes, changed });
    if (!Array.isArray(failures) || failures.length > 0) throw new Error("the artifact failed the admitted-scope/governance check");
  }
  async function checkTree(dir, tree, changed) {
    if (changed.length === 0) return;
    const entries = (await run(dir, ["--literal-pathspecs", "ls-tree", "-r", "-z", tree, "--", ...changed])).split("\0").filter(Boolean);
    if (entries.some((entry) => !entry.startsWith("100644 ") && !entry.startsWith("100755 "))) throw new Error("artifact changes must be regular files, not links or submodules");
  }
  async function start(kind, operationId, input) {
    if (!ID.test(operationId ?? "")) throw new Error("an artifact operation ID is required");
    const inputHash = hash(stable(input));
    let have = await read(operationId);
    if (!have) {
      have = { version: 1, kind, operationId, input, inputHash, createdAt: new Date().toISOString(), status: "intent" };
      try { await write(have, true); } catch (err) { if (err.code !== "EEXIST") throw err; have = await read(operationId); }
    }
    if (!have || have.kind !== kind || have.inputHash !== inputHash) throw new Error("the operation ID is already bound to another artifact input");
    if (have.status === "blocked") throw new Error(`the artifact operation is blocked: ${have.reason}`);
    return have;
  }
  async function committed(record, tree, parents, suffix = "") {
    const env = { ...process.env, GIT_AUTHOR_NAME: "den", GIT_AUTHOR_EMAIL: "den@localhost", GIT_COMMITTER_NAME: "den", GIT_COMMITTER_EMAIL: "den@localhost", GIT_AUTHOR_DATE: record.createdAt, GIT_COMMITTER_DATE: record.createdAt };
    return (await run(root, ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", `den internal ${record.kind} ${record.operationId}${suffix}`], { env })).trim();
  }
  async function complete(record, data) {
    const result = { ...record, ...data, status: "complete" };
    await write(result);
    return clone(result);
  }
  async function validateReceipt(receipt) {
    if (!receipt || !ID.test(receipt.operationId ?? "")) throw new Error("a stored artifact receipt is required");
    const record = await read(receipt.operationId);
    if (!record || record.status !== "complete" || !["capture", "adopt", "integrate"].includes(record.kind) || record.candidate !== receipt.candidate) throw new Error("the candidate differs from its completed artifact receipt");
    await sha(root, record.candidate);
    if ((await run(root, ["rev-parse", `${record.candidate}^{tree}`])).trim() !== record.tree) throw new Error("the candidate tree does not match its receipt");
    const diffHash = hash(await run(root, ["diff", "--binary", "--no-ext-diff", "--no-textconv", record.input.base, record.candidate, "--"]));
    if (diffHash !== record.diffHash) throw new Error("the candidate diff does not match its receipt");
    return record;
  }
  function capture(input) {
    return serial(input?.operationId, async () => {
      if (!fields(input, ["workspace", "base", "scopes", "nodeId", "attemptId", "operationId"]) || !ID.test(input.nodeId ?? "") || !ID.test(input.attemptId ?? "")) throw new Error("capture needs a bridge node, attempt and exact input");
      const dir = await workspaceOf(input.workspace);
      if (await canCapture({ workspace: { dir }, nodeId: input.nodeId, attemptId: input.attemptId }) !== true) throw new Error("the host has not confirmed capture's entire workspace resource group is stopped");
      await sha(dir, input.base);
      if ((await run(dir, ["rev-parse", "HEAD"])).trim() !== input.base) throw new Error("a runner changed HEAD instead of leaving capture to the bridge");
      const snapshots = await snapshotAt(dir, input.base);
      const changed = snapshots.map((entry) => entry.path);
      await checkedPaths(dir, input.scopes, changed);
      // Persist the exact in-memory snapshot fingerprint before writing any Git
      // object. Capturing bytes through our own files avoids repository clean
      // filters executing privileged commands in the bridge.
      const bound = { workspace: dir, base: input.base, scopes: [...new Set(input.scopes)].sort(), nodeId: input.nodeId, attemptId: input.attemptId, snapshot: snapshots.map(({ path, mode, contentHash }) => ({ path, mode, contentHash })) };
      const record = await start("capture", input.operationId, bound);
      if (record.status === "complete") return clone(await validateReceipt(record));
      const state = await directory();
      const temporary = await mkdtemp(path.join(state, "snapshot-"));
      const index = path.join(temporary, "index");
      const env = { ...process.env, GIT_INDEX_FILE: index };
      let tree;
      try {
        await run(dir, ["read-tree", input.base], { env });
        for (let i = 0; i < snapshots.length; i++) {
          const snapshot = snapshots[i];
          if (snapshot.content === null) await run(dir, ["--literal-pathspecs", "update-index", "--force-remove", "--", snapshot.path], { env });
          else {
            const file = path.join(temporary, String(i));
            await writeFile(file, snapshot.content, { mode: 0o600, flag: "wx" });
            const blob = (await run(dir, ["hash-object", "-w", "--no-filters", "--", file])).trim();
            await run(dir, ["--literal-pathspecs", "update-index", "--add", "--cacheinfo", `${snapshot.mode},${blob},${snapshot.path}`], { env });
          }
        }
        tree = (await run(dir, ["write-tree"], { env })).trim();
      } finally {
        if (path.dirname(temporary) !== state || !path.basename(temporary).startsWith("snapshot-")) throw new Error("refusing unexpected artifact cleanup path");
        await rm(temporary, { recursive: true, force: true });
      }
      await checkTree(dir, tree, changed);
      const baseTree = (await run(dir, ["rev-parse", `${input.base}^{tree}`])).trim();
      const candidate = tree === baseTree ? input.base : await committed(record, tree, [input.base]);
      return complete(record, { candidate, tree, changed, diffHash: hash(await run(dir, ["diff", "--binary", "--no-ext-diff", "--no-textconv", input.base, candidate, "--"])) });
    });
  }
  function adoptCandidate(input) {
    return serial(input?.operationId, async () => {
      if (!fields(input, ["workspace", "base", "candidate", "scopes", "nodeId", "attemptId", "operationId"]) || !ID.test(input.nodeId ?? "") || !ID.test(input.attemptId ?? "")) throw new Error("adoption needs a bridge node, attempt and exact input");
      const dir = await workspaceOf(input.workspace);
      if (await canCapture({ workspace: { dir }, nodeId: input.nodeId, attemptId: input.attemptId }) !== true) throw new Error("the host has not confirmed adoption's entire workspace resource group is stopped");
      await sha(dir, input.base); await sha(dir, input.candidate);
      if ((await run(dir, ["rev-parse", "HEAD"])).trim() !== input.candidate || !(await cleanAt(dir, input.candidate))) throw new Error("the committed candidate worktree must be clean at its exact candidate");
      await run(dir, ["merge-base", "--is-ancestor", input.base, input.candidate]);
      const changed = await changedAt(dir, input.base, input.candidate);
      // Inspect all introduced history, including a change later reverted, before
      // retaining that history as a parent of private integration commits.
      const history = [];
      for (const commit of (await run(dir, ["rev-list", `${input.base}..${input.candidate}`])).trim().split("\n").filter(Boolean)) {
        const introduced = names(await run(dir, ["diff-tree", "--root", "-m", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", commit, "--"]));
        await checkTree(dir, commit, introduced);
        history.push(...introduced);
      }
      await checkedPaths(dir, input.scopes, [...new Set([...changed, ...history])]);
      const tree = (await run(dir, ["rev-parse", `${input.candidate}^{tree}`])).trim();
      await checkTree(dir, tree, changed);
      const bound = { workspace: dir, base: input.base, candidate: input.candidate, scopes: [...new Set(input.scopes)].sort(), nodeId: input.nodeId, attemptId: input.attemptId, tree };
      const record = await start("adopt", input.operationId, bound);
      if (record.status === "complete") return clone(await validateReceipt(record));
      return complete(record, { candidate: input.candidate, tree, changed, diffHash: hash(await run(dir, ["diff", "--binary", "--no-ext-diff", "--no-textconv", input.base, input.candidate, "--"])) });
    });
  }
  function integrate(input) {
    return serial(input?.operationId, async () => {
      if (!fields(input, ["workspace", "base", "scopes", "parentId", "attemptId", "operationId", "children"]) || !ID.test(input.parentId ?? "") || !ID.test(input.attemptId ?? "") || !Array.isArray(input.children) || input.children.length > 4) throw new Error("integration needs a parent and at most four accepted child receipts");
      const dir = await workspaceOf(input.workspace);
      await sha(dir, input.base);
      const children = [];
      for (const supplied of input.children) {
        const child = await validateReceipt(supplied);
        if (await verifyAccepted(clone(child)) !== true) throw new Error("the child has no independent acceptance for this exact candidate");
        await run(root, ["merge-base", "--is-ancestor", child.input.base, input.base]);
        children.push(child);
      }
      children.sort((a, b) => order(a.input.nodeId, b.input.nodeId));
      if (new Set(children.map((child) => child.input.nodeId)).size !== children.length) throw new Error("integration children must be distinct logical nodes");
      const bound = { workspace: dir, base: input.base, scopes: [...new Set(input.scopes ?? [])].sort(), nodeId: input.parentId, attemptId: input.attemptId, children: children.map((child) => ({ operationId: child.operationId, nodeId: child.input.nodeId, base: child.input.base, candidate: child.candidate })) };
      const record = await start("integrate", input.operationId, bound);
      if (record.status === "complete") return clone(await validateReceipt(record));
      let candidate = input.base;
      try {
        for (let index = 0; index < children.length; index++) {
          const child = children[index];
          // A repository attribute may select a configured external merge
          // driver. Disable those commands; a selected driver fails closed.
          const driverKeys = (await run(root, ["config", "--name-only", "--get-regexp", "^merge\\..*\\.driver$"]).catch((err) => { if (err.code === 1) return ""; throw err; })).trim().split("\n").filter(Boolean);
          if (driverKeys.some((key) => !/^merge\.[^\x00-\x20]+\.driver$/.test(key))) throw new Error("an unsafe merge-driver configuration requires reconciliation");
          const drivers = driverKeys.flatMap((key) => ["-c", `${key}=false`]);
          const filters = await disabledManagedFilters(root, exec);
          // Explicit merge-base requires Git 2.40 or newer. This object-only
          // operation never reads/writes the parent's worktree or index.
          const tree = (await run(root, ["-c", "merge.default=text", "-c", "merge.renormalize=false", ...drivers, ...filters, "merge-tree", "--write-tree", `--merge-base=${child.input.base}`, candidate, child.candidate])).split("\n")[0].trim();
          if (!SHA.test(tree)) throw new Error("integration produced no trusted tree");
          candidate = await committed(record, tree, [...new Set([candidate, child.candidate])], ` child ${index}`);
        }
        const changed = await changedAt(dir, input.base, candidate);
        await checkedPaths(dir, input.scopes, changed);
        const tree = (await run(root, ["rev-parse", `${candidate}^{tree}`])).trim();
        await checkTree(dir, tree, changed);
        return complete(record, { candidate, tree, changed, diffHash: hash(await run(root, ["diff", "--binary", "--no-ext-diff", "--no-textconv", input.base, candidate, "--"])) });
      } catch (err) {
        if (err.code === 1) {
          await write({ ...record, status: "blocked", reason: "integration conflicted or could not verify its candidate" });
          throw new Error("private integration blocked; the parent worktree was not changed", { cause: err });
        }
        // Losing an object-write acknowledgement may leave an unreachable Git
        // object, never a published ref. Repeating the same persisted intent
        // reconstructs the same deterministic commits rather than duplicating.
        throw new Error("private integration interrupted; retry its exact operation after reconciliation", { cause: err });
      }
    });
  }
  async function materialize(input) {
    if (!fields(input, ["workspace", "receipt", "expectedHead", "operationId"])) throw new Error("materialization needs an exact receipt and expected private HEAD");
    const dir = await workspaceOf(input.workspace);
    return serial(`workspace:${dir}`, () => materializationLease(dir, input.operationId, async () => {
      const receipt = await validateReceipt(input.receipt);
      if (receipt.input.workspace !== dir) throw new Error("an artifact may be materialized only into its own private parent worktree");
      if (input.expectedHead !== receipt.input.base) throw new Error("private materialization's expected HEAD must be its artifact base");
      await sha(dir, input.expectedHead);
      if (await canMaterialize({ workspace: { dir }, receipt: clone(receipt) }) !== true) throw new Error("the host has not confirmed this private parent is stopped");
      const record = await start("materialize", input.operationId, { workspace: dir, receipt: receipt.operationId, base: input.expectedHead, candidate: receipt.candidate });
      const head = (await run(dir, ["rev-parse", "HEAD"])).trim();
      const dirty = !(await cleanAt(dir, head));
      if (dirty || (head !== input.expectedHead && head !== receipt.candidate)) throw new Error("private materialization is uncertain or HEAD changed; preserve it for reconciliation");
      if (head === input.expectedHead && head !== receipt.candidate) {
        await checkout({ dir, commit: receipt.candidate, expectedHead: input.expectedHead, exec });
      }
      if ((await run(dir, ["rev-parse", "HEAD"])).trim() !== receipt.candidate || !(await cleanAt(dir, receipt.candidate))) throw new Error("private materialization did not reach a clean exact candidate");
      return record.status === "complete" ? clone(record) : complete(record, { candidate: receipt.candidate });
    }));
  }
  async function reconcileMaterialization(input) {
    if (!fields(input, ["workspace", "operationId"]) || !ID.test(input.operationId ?? "")) throw new Error("reconciliation needs an exact workspace and operation");
    const dir = await workspaceOf(input.workspace);
    return serial(`workspace:${dir}`, async () => {
      const lease = path.join(await directory(), `workspace-${hash(dir)}.lease`);
      const contents = await readFile(lease, "utf8").catch((err) => { if (err.code === "ENOENT") return null; throw err; });
      const owner = contents === null ? null : JSON.parse(contents);
      const record = await read(input.operationId);
      if (!record || record.kind !== "materialize" || record.input.workspace !== dir || owner && (owner.workspace !== dir || owner.operationId !== input.operationId || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !/^[0-9a-f]{32}$/.test(owner.nonce ?? ""))) throw new Error("the uncertain materialization lease does not match the operation");
      if (await canReconcile({ workspace: { dir }, owner: clone(owner), record: clone(record) }) !== true) throw new Error("explicit host recovery authority is required to reconcile a materialization lease");
      if (owner) {
        let absent = false;
        try { process.kill(owner.pid, 0); } catch (err) { if (err.code === "ESRCH") absent = true; else throw err; }
        if (!absent) throw new Error("the materialization lease owner is still live or uncertain");
      }
      const artifact = await validateReceipt({ operationId: record.input.receipt, candidate: record.input.candidate });
      if (artifact.input.workspace !== dir || artifact.input.base !== record.input.base) throw new Error("recovery artifact differs from the exact private materialization");
      const head = (await run(dir, ["rev-parse", "HEAD"])).trim();
      if (![record.input.base, record.input.candidate].includes(head)) throw new Error("the uncertain materialization is not at an expected HEAD");
      // The host recovery callback holds the exclusive task-tree host lease.
      // Check the exact nonce again; ordinary operations cannot acquire this
      // workspace until this lease is removed. No age-based recovery occurs.
      if (contents !== null) {
        if (await readFile(lease, "utf8") !== contents) throw new Error("the materialization lease changed during reconciliation");
        await rm(lease);
      }
      return materializationLease(dir, input.operationId, async () => {
        if (head !== artifact.candidate || !(await cleanAt(dir, artifact.candidate))) await checkout({ dir, commit: artifact.candidate, expectedHead: record.input.base, resume: true, exec });
        if ((await run(dir, ["rev-parse", "HEAD"])).trim() !== artifact.candidate || !(await cleanAt(dir, artifact.candidate))) throw new Error("recovery did not reach the exact clean candidate");
        if (record.status !== "complete") await complete(record, { candidate: artifact.candidate });
        return { operationId: input.operationId, reconciled: true, head: artifact.candidate, alreadyComplete: record.status === "complete" };
      });
    });
  }
  async function isClean({ workspace, candidate } = {}) {
    const dir = await workspaceOf(workspace);
    const head = (await run(dir, ["rev-parse", "HEAD"])).trim();
    if (candidate !== undefined && candidate !== head) return false;
    const base = candidate ?? head;
    await sha(dir, base);
    return cleanAt(dir, base);
  }
  return { capture, adoptCandidate, integrate, materialize, reconcileMaterialization, isClean, receipt: async (operationId) => clone(await read(operationId)), validateReceipt: async (receipt) => clone(await validateReceipt(receipt)) };
}
