// den-revival/03 slice 1b (ADR 0030): the Codex CellRuntime on the host launch path. It starts `codex app-server --stdio` in its own
// resource group, hands the thread a per-role permission profile (compileCodexPermissions) that Codex's own sandbox enforces on every
// tool command, and turns the adapter's events into the host's. The model, effort and instructions come from the role's
// `.codex/agents/<role>.toml`. The login is copied into a private native store the profile denies to tool commands; when the run ends the copy is
// removed, and first written back to the user's file if Codex refreshed it. No tree, no steering, no resume yet. Registration is a flag in server.mjs (DEN_CODEX=1).
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openCodexAppServer } from "./codex-adapter.mjs";
import { findCodexNative } from "./codex-sandbox-plan.mjs";
import { compileCodexPermissions, renderCodexConfig } from "./codex-permissions.mjs";
import { GOVERNED_BASES, ceilingOf, isWorktreePath } from "./claude-adapter.mjs";
import { createChannel } from "./claude-runtime.mjs";
import { slotClassOf } from "./policy.mjs";
import { EnforcementError, createResourceLauncher } from "./resource-group.mjs";

const MODULE_CONTROL_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GROUP_SETTLE_MS = 2000;
const CAPABILITIES = { spawn: true, stop: true, approve: true, send: false, handover: false, resume: false };

/** model, effort and developer instructions of a role's recipe; the recipe is the bridge's own file, never a request's. */
function readRecipe(file) {
  const text = readFileSync(file, "utf8");
  const model = /^model\s*=\s*"([^"\n]+)"/m.exec(text)?.[1];
  const effort = /^model_reasoning_effort\s*=\s*"([^"\n]+)"/m.exec(text)?.[1];
  const instructions = /^developer_instructions\s*=\s*'''\r?\n([\s\S]*?)\r?\n'''/m.exec(text)?.[1];
  if (!model || !effort || !instructions) throw new EnforcementError("the role's Codex recipe lacks a model, an effort or instructions");
  return { model, effort, instructions };
}

/** Codex rotates its refresh token in the copy it runs on; without this the user's own login keeps the spent one. Whole-file only, atomic, private. */
function saveRefreshedLogin({ copy, original, target }) {
  try {
    const now = readFileSync(copy);
    if (!original || now.equals(original)) return;
    JSON.parse(now);
    const next = `${target}.${process.pid}.tmp`;
    writeFileSync(next, now, { mode: 0o600 });
    renameSync(next, target);
  } catch (err) {
    if (err?.code !== "ENOENT" && err?.name !== "SyntaxError") console.error(`bridge: could not save the refreshed Codex login (${err?.code ?? err?.name})`);
  }
}

const privateDir =(dir) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
};

export function createCodexRuntime({ env = process.env, launcher = createResourceLauncher({ env, slice: "den-codex" }), controlRoot = MODULE_CONTROL_ROOT, native, codexArgs = ["app-server", "--stdio"], killGraceMs } = {}) {
  const control = realpathSync(controlRoot);
  const home = typeof env.HOME === "string" ? env.HOME : undefined;
  const authSource = home && `${home}/.codex/auth.json`;
  const stateRoot = home && `${home}/.local/state/den/credentials/codex`;
  const loginProblem = () => (authSource && existsSync(authSource) ? null : "no Codex login was found; run `codex login` on this host");
  const binaries = () => {
    const found = native ?? findCodexNative(env);
    if (found.reason) throw new EnforcementError(found.reason);
    return found;
  };
  return {
    id: "codex",
    capabilities: { ...CAPABILITIES },
    enforced: launcher.enforced === true,
    async preflight() {
      const problem = loginProblem();
      if (problem) return { ok: false, reason: problem };
      try { binaries(); } catch (err) { return { ok: false, reason: err.message }; }
      return launcher.preflight();
    },
    stillRunning: (id) => (typeof launcher.active === "function" ? launcher.active(id) : Promise.resolve(false)),
    resumeCommand: () => null,
    async spawn({ role, cwd, prompt, sessionId, runId, model, ticketFile, mainGit, project, resume } = {}) {
      if (!isWorktreePath(cwd) || typeof prompt !== "string" || prompt.trim() === "") throw new TypeError("codex runtime: a worktree and a prompt are required");
      if (resume === true) throw new TypeError("codex runtime: resume is not supported");
      if (typeof sessionId !== "string" || !/^[0-9a-f-]{36}$/.test(sessionId)) throw new TypeError("codex runtime: sessionId must be the bridge UUID");
      const problem = loginProblem();
      if (problem) throw new EnforcementError(problem);
      if (project === undefined && !(cwd === control || cwd.startsWith(`${control}/`))) throw new TypeError("codex runtime: a spawn with no project must run inside the control checkout");
      const recipeFile = `${control}/.codex/agents/${role}.toml`;
      if (!existsSync(recipeFile) || !/^[a-z][a-z-]*$/.test(role)) throw new EnforcementError(`the ${role} role has no Codex recipe`);
      const recipe = readRecipe(recipeFile);
      if (model !== undefined && model !== recipe.model) throw new TypeError("codex runtime: the model differs from the role's recipe");
      const { codexBin, nativeHelper } = binaries();
      const writes = ceilingOf(role)?.takesGrants === true;
      const session = privateDir(`${stateRoot}/${sessionId}`);
      let original;
      const cleanup = () => {
        saveRefreshedLogin({ copy: `${session}/native/auth.json`, original, target: authSource });
        rmSync(session, { recursive: true, force: true });
      };
      try {
        const nativeStore = privateDir(`${session}/native`);
        const tmp = privateDir(`${session}/tmp`);
        const nodePrefix = realpathSync(path.dirname(path.dirname(process.execPath)));
        const compiled = compileCodexPermissions({
          profileId: `den-${role}`, worktree: cwd, nativeStore,
          policy: {
            version: 1,
            readRoots: [...new Set([nodePrefix, nativeHelper, ...(writes ? [] : [cwd]), recipeFile, ...(isWorktreePath(ticketFile) ? [ticketFile] : []), ...(isWorktreePath(mainGit) ? [mainGit] : [])])],
            writeRoots: writes ? [cwd, tmp] : [],
            readOnlyPaths: writes ? GOVERNED_BASES.map((p) => `${cwd}/${p}`) : [],
            denyPaths: [], denyCommands: [], hosts: [],
          },
        });
        const path_ = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
        const config = { ...compiled.config, model: recipe.model, model_reasoning_effort: recipe.effort, cli_auth_credentials_store: "file",
          shell_environment_policy: { inherit: "none", set: { PATH: path_, HOME: tmp, TMPDIR: tmp } } };
        writeFileSync(`${nativeStore}/config.toml`, renderCodexConfig(config), { mode: 0o600 });
        original = readFileSync(authSource);
        writeFileSync(`${nativeStore}/auth.json`, original, { mode: 0o600 });
        const launched = await launcher.launch({ slotClass: slotClassOf(role), id: runId ?? sessionId, bin: codexBin, args: codexArgs, cwd,
          env: { PATH: path_, HOME: privateDir(`${session}/home`), CODEX_HOME: nativeStore, XDG_CONFIG_HOME: privateDir(`${session}/xdg`), TMPDIR: tmp, LANG: "C.UTF-8" } });
        return await attach({ launched, cwd, prompt, recipe, compiled, killGraceMs, cleanup });
      } catch (err) {
        cleanup();
        throw err;
      }
    },
  };
}

async function attach({ launched, cwd, prompt, recipe, compiled, killGraceMs, cleanup }) {
  const { child, group } = launched;
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  child.stderr.resume();
  const protocol = openCodexAppServer({ child, ...(killGraceMs === undefined ? {} : { killGraceMs }),
    authorizeExecution: async () => ({ profileId: compiled.profileId, cwd, developerInstructions: `${recipe.instructions}\n\nProduct worktree: ${cwd}.` }) });
  const killAll = () => {
    group?.kill();
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group is already gone */ }
  };
  let stopped = false;
  const stop = () => { stopped = true; protocol.close(); killAll(); };
  const exited = new Promise((resolve) => {
    child.once("exit", async (code, signal) => {
      protocol.close();
      killAll();
      if (group && !(await group.settled(GROUP_SETTLE_MS))) console.error(`bridge: processes are still in ${group.unit} after its kill`);
      cleanup();
      resolve({ code, signal });
    });
  });
  // Pumped at once into an unbounded channel: the protocol queue is small and a lagging consumer would close it.
  const channel = createChannel();
  const questions = new Map();
  (async () => {
    for await (const event of protocol.events) {
      if (event.type === "permission-request" && event.tool === "AskUserQuestion") questions.set(event.requestId, event.input.questions);
      channel.push(event);
    }
    channel.end();
  })();
  let runtimeSessionId;
  try {
    runtimeSessionId = await protocol.prepareThread({ model: recipe.model, effort: recipe.effort });
    await protocol.startTurn(prompt);
  } catch (err) {
    stop();
    await exited;
    throw err;
  }
  return {
    handle: String(child.pid), runtimeSessionId, events: channel.iterable, exited,
    closeInput: stop,
    signal(sig) { if (!stopped && (sig === "SIGTERM" || sig === "SIGKILL")) stop(); },
    async decide(id, { allow, answers } = {}) {
      const qs = questions.get(id);
      if (!qs) return;
      questions.delete(id);
      if (!allow) return protocol.rejectQuestion(id);
      if (!Array.isArray(answers) || answers.length !== qs.length) throw new TypeError("Codex question answers do not match the pending questions");
      return protocol.answerQuestion(id, Object.fromEntries(qs.map((q, i) => [q.id, { answers: [answers[i]] }])));
    },
  };
}
