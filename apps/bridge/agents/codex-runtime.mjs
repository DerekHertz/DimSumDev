// Disabled production integration: trusted callers can inject this CellRuntime
// into the existing host. Normal server startup never imports/registers it.
import { accessSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexProtocol, validateCodexTurnInput } from "./codex-adapter.mjs";
import { compileEffectiveRolePolicy, CREDENTIAL_PATHS, isWorktreePath } from "./effective-role-policy.mjs";
import { compileCodexPermissions, renderCodexConfig } from "./codex-permissions.mjs";
import { createResourceLauncher, EnforcementError, watchStorage, measureTree } from "./resource-group.mjs";
import { treeExecutionProfile, treePrivateDirectories } from "./claude-runtime.mjs";
import { resolveTreeRole } from "./tree-models.mjs";
import { TREE_TOOLS } from "./tree-tools.mjs";
import { AGENT_ID_RE, ROLES, UUID_RE, slotClassOf } from "./policy.mjs";
import { prepareCodexTools } from "./codex-connections.mjs";

const CONTROL = fileURLToPath(new URL("../../..", import.meta.url));
const within = (file, parent) => file === parent || file.startsWith(`${parent}/`);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const base = value => value.replace(/\/\*\*$/, "");
function directory(dir) {
  if (!isWorktreePath(dir)) throw new TypeError("codex runtime: a plain absolute directory is required");
  let ancestor = dir;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (!lstatSync(ancestor).isDirectory() || realpathSync(ancestor) !== ancestor) throw new TypeError("codex runtime: protected parent directory is not canonical");
  if (existsSync(dir) && (!lstatSync(dir).isDirectory() || realpathSync(dir) !== dir)) throw new TypeError("codex runtime: protected directory is not canonical");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (realpathSync(dir) !== dir || !lstatSync(dir).isDirectory()) throw new TypeError("codex runtime: protected directory is not canonical");
  chmodSync(dir, 0o700);
  return dir;
}
function executable(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new TypeError("codex runtime: an explicit installed executable is required");
  const resolved = realpathSync(file);
  if (!isWorktreePath(resolved) || !lstatSync(resolved).isFile()) throw new TypeError("codex runtime: executable must resolve to a regular file");
  accessSync(resolved, constants.X_OK);
  return resolved;
}
function protectedFile(file, maximum = 1_000_000) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || realpathSync(file) !== file || info.size > maximum || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new TypeError("codex runtime: protected file ownership or permissions are unsafe");
  return info;
}
function writePrivate(file, value) {
  if (existsSync(file)) protectedFile(file);
  writeFileSync(file, value, { mode: 0o600 });
  chmodSync(file, 0o600);
}
function configurationMasks(cwd) {
  const masks = [];
  for (let dir = cwd;; dir = path.dirname(dir)) {
    for (const name of [".codex", ".agents"]) {
      const target = path.join(dir, name);
      if (!existsSync(target)) continue;
      if (!lstatSync(target).isDirectory() || realpathSync(target) !== target) throw new EnforcementError("project configuration directory is not canonical");
      masks.push(target);
    }
    if (path.dirname(dir) === dir) break;
  }
  return masks;
}
function detachedGitWrites(cwd, mainGit) {
  const file = `${cwd}/.git`;
  if (!mainGit || !existsSync(file)) return [];
  const info = lstatSync(file);
  if (!info.isFile() || info.nlink !== 1 || info.size > 4096) throw new EnforcementError("the detached worktree git identity is unsafe");
  const dir = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readFileSync(file, "utf8"))?.[1];
  if (!isWorktreePath(dir) || path.dirname(dir) !== `${mainGit}/worktrees` || realpathSync(dir) !== dir || !/^[0-9a-f]{40,64}\s*$/.test(readFileSync(`${dir}/HEAD`, "utf8"))) throw new EnforcementError("only this worktree's exact detached git metadata is writable");
  const objects = `${mainGit}/objects`;
  if (realpathSync(objects) !== objects || !lstatSync(objects).isDirectory()) throw new EnforcementError("the shared git object directory is not canonical");
  return [objects, dir];
}

// This is a narrower, explicit representation of the shared read ceiling.
// Network grants cannot be represented by this offline profile and refuse.
function nativeProfile({ role, cwd, root, home, mainGit, grants, profile, nativeStore, scratch, skills, binaries, authFile, taskReads }) {
  const policy = compileEffectiveRolePolicy(role, { worktree: cwd, root, home, mainGit, grants, credentials: CREDENTIAL_PATHS,
    ...(profile ? { tree: true, treeReadOnly: profile.readonly, scopeWrites: profile.scopeWrites } : {}) });
  if (!policy) throw new EnforcementError("the role has no shared launch policy");
  const f = policy.filesystem;
  const expand = p => p.startsWith("~/") ? `${home}/${p.slice(2)}` : p;
  const readable = [cwd, scratch, skills, ...taskReads, ...binaries, ...f.openReadPaths.filter(existsSync), ...(mainGit ? [mainGit] : [])];
  const writes = [scratch, ...(f.writeWorktree ? [f.writeWorktree, ...(!profile ? detachedGitWrites(cwd, mainGit) : [])] : []), ...f.writePaths.map(expand), ...(f.scopeWrites ?? []).map(scope => scope.path)];
  for (const file of [...readable, ...writes]) if (existsSync(file) && realpathSync(file) !== file) throw new EnforcementError("an admitted filesystem root is not canonical");
  return compileCodexPermissions({ profileId: "bridge-role", worktree: cwd, nativeStore,
    policy: { version: 1, readRoots: [...new Set(readable)], writeRoots: [...new Set(writes)],
      readOnlyPaths: [...new Set([...taskReads, ...f.deniedRelativeWritePatterns.map(p => `${cwd}/${base(p)}`), ...f.deniedAbsoluteWritePatterns.map(base), ...[".codex", ".agents", ".den", ".scratch"].map(p => `${cwd}/${p}`)])],
      denyPaths: [...new Set([...f.credentials.map(expand), ...f.privatePaths, authFile, nativeStore])],
      denyCommands: policy.execution.deniedCommands.map(command => command.split(" ")), hosts: policy.network.hosts } });
}

/** Constructor arguments are trusted bridge configuration, never request data.
 * authFile is an explicitly authorized read-only credential mount: its contents
 * are never copied, parsed, logged, sent to a tool, or exposed as an RPC method.
 */
export function createCodexRuntime({ env = process.env, launcher = createResourceLauncher({ env }), controlRoot = CONTROL,
  stateRoot = typeof env.HOME === "string" ? `${env.HOME}/.local/state/den/credentials/codex` : null,
  scratchRoot, codexBin = env.DEN_CODEX_BIN, bwrapBin = "/usr/bin/bwrap", authFile, toolBroker = prepareCodexTools, fetcher = fetch } = {}) {
  const control = realpathSync(controlRoot);
  const shellRoot = scratchRoot ?? `${control}/.scratch/_run/codex-shell`;
  const activeSessions = new Set();
  const uncertainLocks = new Map();
  const enforce = () => {
    if (launcher.enforced !== true || launcher.scopedWrites !== true) throw new EnforcementError("Codex requires the protected resource/scoped-write launcher");
    if (typeof authFile !== "string") throw new EnforcementError("protected authentication must be explicitly configured and authorized");
    protectedFile(authFile);
    // A system-managed configuration may constrain the adapter, but this first
    // integration cannot safely inherit arbitrary startup tools/providers. Hold
    // rather than hiding or overriding an administrator's configuration.
    if (["/etc/codex/config.toml", "/etc/codex/managed_config.toml"].some(existsSync)) throw new EnforcementError("external managed Codex startup configuration needs supported protection review");
  };
  return {
    id: "codex", enforced: launcher.enforced === true && launcher.scopedWrites === true,
    capabilities: { spawn: true, stop: true, approve: true, send: true, handover: true, resume: true, treeDelegation: true, artifactStoreProtection: launcher.enforced === true && launcher.scopedWrites === true },
    validateModel: selection => [...ROLES, "runner"].some(role => { const configured = resolveTreeRole({ controlRoot: control, role, runtime: "codex" }); return configured.model === selection?.model && configured.effort === selection?.effort; }),
    async preflight() { try { enforce(); return await launcher.preflight(); } catch (error) { return { ok: false, reason: error.message }; } },
    validatePrompt: validateCodexTurnInput,
    async stillRunning(id) {
      if (typeof launcher.active !== "function") throw new EnforcementError("native resource liveness is unavailable");
      const active = await launcher.active(id);
      if (active === false) { uncertainLocks.get(id)?.(); uncertainLocks.delete(id); }
      return active;
    },
    // Resuming requires this protected runtime/store, rather than the user's
    // personal CLI state. Do not suggest a misleading personal `codex resume`.
    resumeCommand: () => null,
    async spawn(input = {}) {
      const { role, cwd, project, sessionId, runId, prompt, mainGit, tree, treeCredential, grants, resume, runtimeSessionId, promptId } = input;
      if (!UUID_RE.test(sessionId ?? "") || !AGENT_ID_RE.test(runId ?? "") || !isWorktreePath(cwd) || realpathSync(cwd) !== cwd || typeof prompt !== "string" || !prompt.trim()) throw new TypeError("codex runtime: invalid trusted run identity, worktree or prompt");
      validateCodexTurnInput(prompt); // Full rendered review/dependency input, before stores or launch.
      const configured = resolveTreeRole({ controlRoot: control, role, runtime: "codex" });
      const recipe = `${control}/.codex/agents/${role}.toml`;
      const taskReads = [recipe];
      if (input.ticketFile !== undefined) {
        const ticket = input.ticketFile;
        if (!isWorktreePath(ticket) || !within(ticket, `${project?.root ?? control}/.scratch`) || realpathSync(ticket) !== ticket) throw new EnforcementError("the trusted task ticket is not canonical");
        const info = lstatSync(ticket);
        if (!info.isFile() || info.nlink !== 1 || info.size > 256_000) throw new EnforcementError("the trusted task ticket is not a bounded regular file");
        taskReads.push(ticket);
      }
      if (project?.recipeFile !== undefined && project.recipeFile !== recipe || input.model !== undefined && input.model !== configured.model || input.effort !== undefined && input.effort !== configured.effort) throw new TypeError("codex runtime: model or recipe differs from the trusted role");
      if (!project && !within(cwd, control)) throw new TypeError("codex runtime: a target run needs its trusted project");
      if ((tree !== undefined) !== (treeCredential !== undefined)) throw new TypeError("codex runtime: managed trees require a scoped bridge credential");
      let profile;
      if (tree !== undefined) {
        if (!tree || !Number.isInteger(tree.depth) || tree.depth < 0 || tree.depth > 2 || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(treeCredential.url ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(treeCredential.token ?? "") || grants !== undefined && (!Array.isArray(grants) || grants.length)) throw new TypeError("codex runtime: invalid managed tree admission");
        profile = treeExecutionProfile({ role, tree, resume, cwd });
      }
      enforce();
      const bin = executable(codexBin), wrapper = executable(bwrapBin);
      if (!isWorktreePath(stateRoot) || within(stateRoot, cwd) || within(cwd, stateRoot)) throw new EnforcementError("the native store must be protected and separate from the worktree");
      directory(stateRoot);
      const session = directory(`${stateRoot}/${sessionId}`);
      if (!isWorktreePath(shellRoot) || within(shellRoot, stateRoot) || within(stateRoot, shellRoot)) throw new EnforcementError("model scratch must be separate from protected native state");
      directory(shellRoot);
      const shellSession = directory(`${shellRoot}/${sessionId}`);
      const nativeStore = directory(`${session}/native`), scratch = directory(`${shellSession}/scratch`), home = directory(`${session}/home`);
      const skills = directory(`${shellSession}/skills`);
      const xdg = directory(`${session}/xdg`), temp = directory(`${scratch}/tmp`);
      const recordFile = `${session}/session.json`, lockFile = `${session}/active.lock`;
      if (activeSessions.has(sessionId)) throw new EnforcementError("this native session already has an active resource group");
      let lock;
      try { lock = openSync(lockFile, "wx", 0o600); } catch { throw new EnforcementError("the native session has an active or unconfirmed resource group"); }
      activeSessions.add(sessionId);
      let launched, cleanupConfirmed = false, processInfo, stopStorage, monitor, broker;
      const unlock = () => { if (lock === undefined) return; closeSync(lock); lock = undefined; unlinkSync(lockFile); activeSessions.delete(sessionId); };
      try {
        const nodePrefix = realpathSync(path.dirname(path.dirname(process.execPath)));
        const installedPrefix = realpathSync(path.dirname(path.dirname(bin)));
        const root = project?.root ?? control;
        const compiled = nativeProfile({ role, cwd, root, home: env.HOME, mainGit, grants, profile, nativeStore, scratch, skills, binaries: [...new Set([nodePrefix, installedPrefix, realpathSync("/usr")])], authFile, taskReads });
        broker = toolBroker ? await toolBroker({ ...input, controlRoot: control, credentialRoot: `${env.HOME}/.local/state/den/credentials`, fetcher, profile }) : null;
        if (input.connections?.length && !broker) throw new EnforcementError("approved connections require protected bridge interposition");
        const treeTools = tree ? TREE_TOOLS.filter(tool => profile.review ? ["status", "review"].includes(tool.name) : tree.depth === 2 ? ["status", "complete"].includes(tool.name) : tool.name !== "review") : [];
        const dynamicTools = [...treeTools.map(tool => ({ ...tool, type: "function", name: `mcp__tree__${tool.name}` })), ...(broker?.tools ?? [])];
        const treeCall = async (name, args, context) => {
          if (context.signal.aborted) throw new Error("the tree call was cancelled");
          const response = await fetcher(`${treeCredential.url}/tree-tools/${name.slice("mcp__tree__".length)}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: treeCredential.url, Authorization: `Bearer ${treeCredential.token}` }, body: JSON.stringify(args), redirect: "error", signal: AbortSignal.any([context.signal, AbortSignal.timeout(30000)]) });
          const body = await boundedJson(response);
          return { content: [{ type: "text", text: String(body.text ?? (response.ok ? JSON.stringify(body) : "Tree request refused.")) }], isError: !response.ok };
        };
        const binding = { role, cwd, model: configured.model, effort: configured.effort, profile: hash(compiled), tools: hash(dynamicTools), recipe: hash(readFileSync(recipe, "utf8")) };
        let recorded;
        if (existsSync(recordFile)) { protectedFile(recordFile); recorded = JSON.parse(readFileSync(recordFile, "utf8")); }
        if (resume === true ? !recorded || recorded.threadId !== runtimeSessionId || hash(recorded.binding) !== hash(binding) : recorded !== undefined || runtimeSessionId !== undefined) throw new EnforcementError("recorded native identity or protected policy does not match this run");
        const config = { ...compiled.config, model: configured.model, model_reasoning_effort: configured.effort, cli_auth_credentials_store: "file", sqlite_home: nativeStore,
          shell_environment_policy: { inherit: "none", set: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: scratch, TMPDIR: temp } },
          projects: { [cwd]: { trust_level: "untrusted" }, [scratch]: { trust_level: "untrusted" } }, agents: { enabled: false }, analytics: { enabled: false } };
        // Numeric/array keys are emitted explicitly because the permission
        // renderer intentionally accepts only its original simple vocabulary.
        const configText = "project_doc_max_bytes = 0\nproject_doc_fallback_filenames = []\n" + renderCodexConfig(config);
        directory(`${nativeStore}/rules`);
        writePrivate(`${nativeStore}/config.toml`, configText);
        writePrivate(`${nativeStore}/rules/bridge.rules`, compiled.execPolicy);
        writePrivate(`${nativeStore}/auth.json`, ""); // read-only bind target only
        const masks = [...new Set([...configurationMasks(cwd), ...configurationMasks(scratch)])];
        const trustedSkills = realpathSync(`${control}/.agents/skills`);
        if (!within(trustedSkills, control)) throw new EnforcementError("trusted skills leave the control checkout");
        const args = ["--dev-bind", "/", "/", "--ro-bind", trustedSkills, skills, ...masks.flatMap(dir => ["--tmpfs", dir, "--remount-ro", dir]), "--ro-bind", `${nativeStore}/config.toml`, `${nativeStore}/config.toml`, "--ro-bind", `${nativeStore}/rules`, `${nativeStore}/rules`, "--ro-bind", authFile, `${nativeStore}/auth.json`, "--die-with-parent", "--", bin, "app-server", "--strict-config", "--stdio"];
        const privateDirs = mainGit ? treePrivateDirectories(mainGit) : [];
        launched = await launcher.launch({ slotClass: slotClassOf(role), id: runId, bin: wrapper, args, cwd: scratch,
          env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, CODEX_HOME: nativeStore, CODEX_SQLITE_HOME: nativeStore, XDG_CONFIG_HOME: xdg, TMPDIR: temp, LANG: "C.UTF-8" },
          ...(privateDirs.length ? { privateDirs } : {}), ...(profile ? { writeScope: profile.code ? profile.writeScope : { worktree: cwd, paths: [] } } : {}) });
        const { child, group } = launched;
        let finished = false, resourceLimit = null, outputBytes = 0;
        let finish;
        const exited = new Promise(resolve => { finish = async (code, signal) => {
          if (finished) return; finished = true;
          clearInterval(monitor); stopStorage?.();
          protocol.close(); group.kill();
          try { cleanupConfirmed = await group.settled(3000) === true; } catch { cleanupConfirmed = false; }
          if (cleanupConfirmed) unlock();
          else uncertainLocks.set(runId, unlock);
          await broker?.close?.();
          resolve({ code, signal, cleanupConfirmed, ...(resourceLimit ? { resourceLimit } : {}) });
        }; });
        const protocol = createCodexProtocol({
          write: line => new Promise((resolve, reject) => { if (!child.stdin.writable) return reject(new Error("native stdin is closed")); child.stdin.write(line, error => error ? reject(error) : resolve()); }),
          close: () => group.kill(),
          authorizeExecution: async () => ({ profileId: compiled.profileId, cwd, dynamicTools, developerInstructions: trustedInstructions(control, recipe) + `\n\nTrusted skills are mounted read-only at ${skills}. When a role names a skill, read ${skills}/<skill>/SKILL.md. Use the actual Codex command/patch tools and the exposed mcp__ tools; native child spawning, inherited plugins and native MCP are disabled. Product worktree: ${cwd}. Private scratch: ${scratch}.` }),
          executeTool: (name, args, context) => name.startsWith("mcp__tree__") ? treeCall(name, args, context) : broker.call(name, args, context),
        });
        child.on("error", () => { void finish(null, null); });
        child.stdin.on("error", () => protocol.end());
        child.once("exit", (code, signal) => { void finish(code, signal); });
        child.stdout.on("data", chunk => { outputBytes += chunk.length; if (outputBytes > (launcher.limits?.storage.outputMiB ?? 20) * 1024 * 1024) { resourceLimit = "output"; protocol.close(); } else protocol.feed(chunk); });
        child.stderr.on("data", chunk => { outputBytes += chunk.length; if (outputBytes > (launcher.limits?.storage.outputMiB ?? 20) * 1024 * 1024) { resourceLimit = "output"; protocol.close(); } });
        child.stdout.once("end", () => { if (!finished) protocol.end(); });
        monitor = setInterval(() => { const hit = group.exhausted(); if (hit) { resourceLimit = hit; protocol.close(); } }, 500); monitor.unref?.();
        if (launcher.limits?.storage.jobMiB) {
          // Preserve the configured job allowance, counting both product and
          // persistent native state. This is the existing operational monitor.
          stopStorage = watchStorage({ dir: cwd, limitBytes: launcher.limits.storage.jobMiB * 1024 * 1024,
            measure: async () => { const values = await Promise.all([measureTree(cwd), measureTree(session), measureTree(shellSession)]); return values.every(value => value !== null) ? values.reduce((sum, value) => sum + value, 0) : null; },
            onOver: () => { resourceLimit = "storage"; protocol.close(); } });
        }
        processInfo = { exited, protocol };
        const nativeId = await protocol.prepareThread({ model: configured.model, effort: configured.effort, ...(resume ? { resumeThreadId: runtimeSessionId } : {}) });
        writePrivate(`${recordFile}.tmp`, JSON.stringify({ version: 1, sessionId, threadId: nativeId, binding }));
        renameSync(`${recordFile}.tmp`, recordFile);
        await protocol.startTurn(prompt);
        const questions = new Map();
        const events = { async *[Symbol.asyncIterator]() { if (promptId) yield { type: "message-applied", id: promptId }; for await (const event of protocol.events) { if (event.type === "permission-request" && event.tool === "AskUserQuestion") questions.set(event.requestId, event.input.questions); yield event; } } };
        return {
          handle: String(child.pid), runtimeSessionId: nativeId, events, exited,
          closeInput() { try { child.stdin.end(); } catch {} },
          signal(sig) { if (!finished && (sig === "SIGTERM" || sig === "SIGKILL")) { void protocol.interrupt().catch(() => {}); group.kill(); } },
          async send(id, text) { protocol.enqueueMessage(id, text); await protocol.flushMessage(id); },
          async cancel(id) { return protocol.cancelMessage(id); },
          async decide(id, decision = {}) {
            const qs = questions.get(id);
            if (!qs) return protocol.decideTool(id, decision);
            questions.delete(id);
            if (!decision.allow) return protocol.rejectQuestion(id);
            if (!Array.isArray(decision.answers) || decision.answers.length !== qs.length) throw new TypeError("Codex question answers do not match the pending questions");
            return protocol.answerQuestion(id, Object.fromEntries(qs.map((q, i) => [q.id, { answers: [decision.answers[i]] }])));
          },
        };
      } catch (error) {
        stopStorage?.(); clearInterval(monitor);
        if (launched) { launched.group.kill(); if (processInfo) await processInfo.exited; else { try { cleanupConfirmed = await launched.group.settled(3000) === true; } catch {} } }
        if (!launched || cleanupConfirmed) unlock();
        if (launched) {
          error.resourceId = runId;
          error.cleanupConfirmed = cleanupConfirmed;
          if (!cleanupConfirmed) uncertainLocks.set(runId, unlock);
        }
        await broker?.close?.();
        throw error;
      }
    },
  };
}

function trustedInstructions(control, recipe) {
  if (realpathSync(recipe) !== recipe) throw new EnforcementError("trusted role recipe is not canonical");
  const text = readFileSync(recipe, "utf8");
  const instructions = /^developer_instructions\s*=\s*'''\r?\n([\s\S]*?)\r?\n'''\s*$/m.exec(text)?.[1];
  if (!instructions) throw new EnforcementError("trusted Codex role instructions are missing");
  return `${readFileSync(`${control}/.codex/runtime-guidance.md`, "utf8")}\n\n${instructions}`;
}

async function boundedJson(response) {
  if (!response.body) throw new Error("empty protected response");
  const reader = response.body.getReader(); let total = 0; const chunks = [];
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; if ((total += value.length) > 64000) throw new Error("protected response exceeds bound"); chunks.push(value); } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  finally { await reader.cancel().catch(() => {}); }
}
