// organism-infra/143 (ADR 0016 decisions 2, 6.5, 6.6, 6.8; amendment 6): the process half of the Claude adapter.
// createClaudeRuntime({ env }) is the default CellRuntime: it spawns the `claude` binary (env.DEN_CLAUDE_BIN, else "claude")
// as a detached process-group leader over real pipes, decodes stdout through the pure half (claude-adapter.mjs), holds
// permission requests until the host decides, and signals the whole group so no grandchild outlives a kill.
// den-mvp outcome 1: the child is started by a launcher (resource-group.mjs) inside a resource group with hardware
// limits; a kill goes to that group, and a hard limit that is hit ends the run with the limit named.
import { executionSettings } from "./orchestration.mjs";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_LINE_BYTES, buildClaudeArgs, readProjectGuide, mcpConfigWithTokens, buildClaudeEnv, compileCeiling, createLineSplitter, decodeControlRequest, encodeControlResponse, encodeUserMessage, isTicketFilePath, isWorktreePath,
  parseClaudeLine, CREDENTIAL_PATHS, webRefusal,
} from "./claude-adapter.mjs";
import { snapshotPlaceholders, sweepPlaceholders } from "./placeholders.mjs";
import { UUID_RE, slotClassOf, definitionOf } from "./policy.mjs";
import { EnforcementError, createResourceLauncher, watchStorage } from "./resource-group.mjs";

// The Node install this bridge runs from, which an agent's npm and node are too (the den's PATH): reopened under the read limit.
// One the adapter cannot write as a rule is left out, and npm under the read limit then fails visibly rather than reading home.
const NODE_PREFIX = path.dirname(path.dirname(process.execPath));
const TOOLCHAIN = isWorktreePath(NODE_PREFIX) ? NODE_PREFIX : undefined;
const RESOURCE_POLL_MS = 500; // how often a run's control group is asked whether it hit a hard limit
const GROUP_SETTLE_MS = 2000; // how long an exit waits for the group's last process to go

// S8 outcome (c): the approval inbox is on. den-v1 loop S5: so is send, a user message line on the child's stdin
// (spike S7: the child takes it into its running turn once the running tool call ends).
const CAPABILITIES = { spawn: true, stop: true, approve: true, send: true, handover: true, resume: true };

// A queue that is also an async iterable; end() lets queued events drain, then finishes the stream.
export function createChannel() {
  const queue = [];
  const waiting = [];
  let ended = false;
  return {
    push(event) {
      if (ended) return;
      const w = waiting.shift();
      if (w) w({ value: event, done: false });
      else queue.push(event);
    },
    end() {
      ended = true;
      if (!queue.length) for (const w of waiting.splice(0)) w({ value: undefined, done: true });
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
            if (ended) return Promise.resolve({ value: undefined, done: true });
            return new Promise((r) => waiting.push(r));
          },
        };
      },
    },
  };
}

// den-mvp outcome 1: `launcher` starts the child inside its resource group (resource-group.mjs). The default is the
// enforced one and there is no switch for it; only a test passes another.
// den-mvp/37: the CLI reads the user's answers to AskUserQuestion from `answers` in updatedInput, keyed by each
// question's own text (checked live against claude 2.1.293). The original text is used, not the den's cleaned copy.
function withAnswers(input, answers) {
  if (!Array.isArray(answers) || !Array.isArray(input?.questions) || answers.length !== input.questions.length) return input;
  return { ...input, answers: Object.fromEntries(input.questions.map((q, i) => [q.question, answers[i]])) };
}

// den-mvp/49: the control checkout, from where this module sits; the bridge may pass its own root (a release folder runs from elsewhere).
const MODULE_CONTROL_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export function createClaudeRuntime({ env = process.env, launcher = createResourceLauncher({ env }), controlRoot = MODULE_CONTROL_ROOT } = {}) {
  const control = path.resolve(controlRoot);
  const controlReal = (() => { try { return realpathSync(control); } catch { return control; } })(); // a toolchain symlink to the control checkout is compared against this
  const insideControl = (dir) => {
    const rel = path.relative(control, path.resolve(dir));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  return {
    id: "claude",
    capabilities: { ...CAPABILITIES },
    enforced: launcher.enforced === true,
    preflight: () => launcher.preflight(),
    // den-mvp outcome 2: is the resource group of the run started under this id (its runId, else its sessionId) still there?
    stillRunning: (id) => (typeof launcher.active === "function" ? launcher.active(id) : Promise.resolve(false)),
    resumeCommand: (sessionId) => (typeof sessionId === "string" && UUID_RE.test(sessionId) ? `claude --resume ${sessionId}` : null),
    // den-mvp outcome 2: `resume: true` continues the session `sessionId` (the cwd must be the one it ran in); `runId`
    // then names the resource group, so a follow-up never reuses the unit of the run before it. `promptId` gives the
    // first message an id, and a message-applied event with that id follows once the child takes it.
    // den-mvp outcome 4: `connections` are the catalog's targets for this role; a list the adapter cannot write refuses the spawn.
    // den-mvp/38: `runCredential` ({ url, token }) is what a "run" connection's script is given to call the bridge back.
    async spawn({ role, cwd, prompt, sessionId, model, effort, execution, delegate, ticketFile, grants, root, mainGit, resume, runId, promptId, connections, runCredential, project } = {}) {
      if (execution !== undefined) {
        const selected = executionSettings('claude', role, Object.fromEntries(Object.entries(execution).filter(([k]) => k !== 'provider')));
        model = selected.model;
        effort ??= selected.reasoning;
      }
      if (typeof cwd !== "string" || cwd === "") throw new TypeError("claude runtime: cwd must be a path");
      if (typeof prompt !== "string") throw new TypeError("claude runtime: prompt must be a string");
      // den-mvp/49: fail closed. A spawn with no project handle is the den's own, so its cwd must be inside the control checkout;
      // anywhere else it would start with the den's settings loaded from a target's .claude/.
      if (project === undefined && !insideControl(cwd)) throw new TypeError("claude runtime: a spawn with no project must run inside the control checkout");
      // A ticket path the adapter cannot write as a rule is left out: that agent's ticket read stays a request.
      // agent-os/04: a role with a ceiling starts behind the wall, and a role that writes may write in cwd (its worktree).
      // A cwd the adapter cannot write as a rule keeps the wall and leaves the write rules out: the Write request stays.
      // agent-os/02: root (the main checkout) and home let a path grant meet the governance denies there; a path the adapter
      // cannot write as a rule is left out.
      // agent-os/11 (ADR 0021 Amendment 2): the main .git denies fail closed. A mainGit the adapter cannot write as a rule
      // (a space or other character outside the plain set) refuses the spawn; dropping it silently left refs, HEAD,
      // packed-refs and index writable. The host answers a spawn failure with its 502 and cleans up.
      if (mainGit !== undefined && !isWorktreePath(mainGit)) throw new TypeError("claude runtime: mainGit must be a plain absolute path; refusing to start without the main .git denies");
      // den-mvp outcome 1: the credential stores that exist now are closed to reads; a deny target must exist to be applied.
      const home = isWorktreePath(env.HOME) ? env.HOME : undefined;
      const credentials = home === undefined ? [] : CREDENTIAL_PATHS.filter((p) => existsSync(`${home}${p.slice(1)}`));
      // The kernel review (2026-10-18): a remote connection reaches the network outside the wall, so it brings the read limit like a host.
      const remote = Array.isArray(connections) && connections.some((c) => typeof c?.url === "string");
      const ceiling = compileCeiling(role, { worktree: isWorktreePath(cwd) ? cwd : undefined, grants, ...(isWorktreePath(root) ? { root } : {}), ...(mainGit !== undefined ? { mainGit } : {}), ...(home === undefined ? {} : { home }), ...(credentials.length === 0 ? {} : { credentials }), remote, toolchain: TOOLCHAIN, ...(project?.control === false ? { target: true, projectToolchain: project.toolchain ?? [], control: controlReal } : {}) });
      // Every role has a ceiling (ceilings.json); one without would start with no wall, so it does not start.
      if (ceiling === null) throw new EnforcementError(`the ${role} role has no ceiling, so it cannot be started`);
      // den-mvp/33: a connection that holds a credential gets its token from the den's credentials folder (outside every
      // worktree, a governance credential path), and its config goes to a 0600 file there, removed when the run ends.
      // With no token saved the connection is left out and the run still starts.
      let delegationRole;
      if (typeof delegate === 'function') {
        const recipe = readFileSync(path.join(control, '.claude', 'agents', `${definitionOf(role)}.md`), 'utf8');
        const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(recipe);
        if (!front) throw new EnforcementError('the delegating role has no trusted frontmatter');
        const toolsLine = /^tools:[ \t]*(.*)$/m.exec(front[1])?.[1];
        const tools = toolsLine === undefined ? null : toolsLine.split(',').map(t => t.trim()).filter(Boolean);
        const skillsBlock = /^skills:\s*\r?\n((?:[ \t]+-[^\n]*\r?\n?)*)/m.exec(front[1])?.[1] ?? '';
        const skills = [...skillsBlock.matchAll(/^[ \t]+-[ \t]+([^\r\n]+)/gm)].map(m => m[1].trim());
        delegationRole = { description: `Bridge-managed ${definitionOf(role)}`, prompt: recipe.slice(front[0].length), ...(tools ? { tools: [...tools, 'mcp__delegation__delegate'] } : {}), ...(skills.length ? { skills } : {}) };
      }
      const secured = Array.isArray(connections) ? connections.filter((c) => c.credential !== undefined) : [];
      let mcpConfigFile;
      let usable = connections;
      if (secured.length > 0) {
        const dir = home === undefined ? undefined : `${home}/.local/state/den/credentials`;
        const tokens = {};
        for (const c of secured) {
          if (c.credential === "run") {
            if (/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(runCredential?.url ?? "") && /^[A-Za-z0-9_-]{20,255}$/.test(runCredential?.token ?? "")) tokens[c.name] = { url: runCredential.url, token: runCredential.token };
            continue;
          }
          try {
            const t = dir === undefined ? "" : readFileSync(`${dir}/${c.name}.token`, "utf8").trim();
            if (/^[A-Za-z0-9_-]{20,255}$/.test(t)) tokens[c.name] = t;
          } catch {
            // no token saved
          }
        }
        const have = secured.filter((c) => tokens[c.name] !== undefined);
        usable = connections.filter((c) => c.credential === undefined || tokens[c.name] !== undefined);
        if (have.length > 0) {
          const runDir = `${dir}/run`;
          mkdirSync(runDir, { recursive: true, mode: 0o700 });
          mcpConfigFile = `${runDir}/${randomUUID()}.json`;
          writeFileSync(mcpConfigFile, mcpConfigWithTokens(have, tokens), { mode: 0o600 });
        }
      }
      const removeConfig = () => {
        if (mcpConfigFile !== undefined) rmSync(mcpConfigFile, { force: true });
      };
      const args = buildClaudeArgs({ sessionId, ...(delegationRole ? { managedDelegation: true, delegationRole } : {}), ...(effort === undefined ? {} : { effort }), ...(resume === true ? { resume: true } : {}), agent: role, ...(model === undefined ? {} : { model }), ...(isTicketFilePath(ticketFile) ? { ticketFile } : {}), ...(ceiling ?? {}), ...(Array.isArray(usable) && usable.length > 0 ? { connections: usable } : {}), ...(mcpConfigFile === undefined ? {} : { mcpConfigFile }), ...(project === undefined ? {} : { project }) });
      // den-mvp/48: for every project the bridge passes in its CLAUDE.md or AGENTS.md as committed at HEAD of the main checkout.
      const guide = project === undefined ? null : readProjectGuide(project.root);
      const guideText = guide === null ? "" : `Project guide (${guide.file}, committed at HEAD):\n\n${guide.text}`;
      const bin = typeof env.DEN_CLAUDE_BIN === "string" && env.DEN_CLAUDE_BIN !== "" ? env.DEN_CLAUDE_BIN : "claude";
      const placeholders = await snapshotPlaceholders({ mainGit, worktree: isWorktreePath(cwd) ? cwd : undefined });
      // The child is inside its resource group, limits read back, before this resolves; a host that cannot do that starts nothing.
      // hardening/10: what the container launcher mounts. A host launcher gets none of it.
      const container = launcher.container
        ? {
            role, sessionId, mainGit, mcpConfigFile,
            // multi-project/02: a target run's proxy identity has no hosts, and its toolchain is mounted read-only at its host path.
            ...(project?.control === false ? { target: true, toolchain: project.toolchain ?? [] } : {}),
            ticketFile: isTicketFilePath(ticketFile) ? ticketFile : undefined,
            grants: (ceiling.writePaths ?? []).map((p) => (p.startsWith("~/") && home !== undefined ? `${home}${p.slice(1)}` : p)),
          }
        : undefined;
      let launched;
      try {
        launched = await launcher.launch({ slotClass: slotClassOf(role), id: runId ?? sessionId, bin, args, cwd, env: buildClaudeEnv(env), ...(container ? { container } : {}) });
      } catch (err) {
        removeConfig();
        throw err;
      }
      const { child, group } = launched;
      child.once("close", removeConfig);
      child.on("error", () => {});
      child.stdin.on("error", () => {});
      child.stderr.resume(); // drained, never read: a full pipe must not block the child

      const channel = createChannel();
      const splitter = createLineSplitter({ maxLineBytes: MAX_LINE_BYTES });
      const held = new Map(); // requestId -> the held request's input
      const seen = new Set();
      const sent = new Set(); // ids of messages written and not yet replayed by the child
      let exitedFlag = false;
      const write = (line) =>
        new Promise((resolve, reject) => {
          if (!child.stdin.writable) return reject(new Error("the child's stdin is closed"));
          child.stdin.write(line, (err) => (err ? reject(err) : resolve()));
        });
      const signalGroup = (sig) => {
        try {
          process.kill(-child.pid, sig);
        } catch {
          // the group is already gone
        }
      };
      // The resource group's own kill reaches a descendant that left the process group; the signal covers a launcher without one.
      const killAll = () => {
        group?.kill();
        signalGroup("SIGKILL");
      };
      // A hard limit (memory, process count) ends the run with that reason; the host never restarts it.
      let limitHit = null;
      const monitor = group
        ? setInterval(() => {
            if (limitHit !== null || (limitHit = group.exhausted()) === null) return;
            channel.push({ type: "resource-limit", resource: limitHit });
            killAll();
          }, RESOURCE_POLL_MS)
        : null;
      monitor?.unref?.();
      // Job storage: the worktree is measured from outside, and a run that passes the bound ends the same way.
      const stopStorage = group && launcher.limits
        ? watchStorage({
            dir: cwd,
            limitBytes: launcher.limits.storage.jobMiB * 1024 * 1024,
            onOver: () => {
              if (limitHit !== null || exitedFlag) return;
              limitHit = "storage";
              channel.push({ type: "resource-limit", resource: limitHit });
              killAll();
            },
          })
        : null;

      const handleLine = (line) => {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          return;
        }
        if (obj && obj.type === "control_request") {
          const d = decodeControlRequest(obj, seen);
          // A web fetch to a local, private or numeric destination is answered here; it never becomes a question for the user.
          const refusal = d.kind === "approval" ? webRefusal(d.tool, d.input) : null;
          if (refusal !== null) {
            write(encodeControlResponse({ requestId: d.requestId, allow: false, reason: refusal })).catch(() => {});
          } else if (d.kind === "approval") {
            held.set(d.requestId, d.input);
            channel.push({ type: "permission-request", requestId: d.requestId, tool: d.tool, input: d.input });
          } else if (d.kind === "deny") {
            write(encodeControlResponse({ requestId: d.requestId, allow: false })).catch(() => {});
          }
          return;
        }
        for (const event of parseClaudeLine(line)) {
          // Only a message this process wrote, and only once: the prompt's own replay and a repeated id are dropped.
          if (event.type === "message-applied" && !sent.delete(event.id)) continue;
          channel.push(event);
        }
      };
      child.stdout.on("data", (chunk) => {
        for (const line of splitter.push(chunk)) handleLine(line);
      });
      child.stdout.once("close", () => channel.end());

      const exited = new Promise((resolve) => {
        child.once("exit", async (code, signal) => {
          exitedFlag = true;
          clearInterval(monitor);
          stopStorage?.();
          held.clear();
          limitHit ??= group?.exhausted() ?? null;
          killAll(); // the leader is gone: reap any descendant left behind
          if (group && !(await group.settled(GROUP_SETTLE_MS))) console.error(`bridge: processes are still in ${group.unit} after its kill`);
          await sweepPlaceholders(placeholders); // den-mvp/28
          resolve({ code, signal, ...(limitHit === null ? {} : { resourceLimit: limitHit }) });
        });
      });

      try {
        if (promptId !== undefined) sent.add(promptId);
        await write(encodeUserMessage({ text: guideText === "" ? prompt : `${guideText}\n\n${prompt}`, ...(promptId === undefined ? {} : { id: promptId }) }));
      } catch {
        // the child may already be gone; the host sees it through `exited`
      }

      return {
        handle: String(child.pid),
        events: channel.iterable,
        exited,
        closeInput() {
          try {
            child.stdin.end();
          } catch {
            // already closed
          }
        },
        signal(sig) {
          if (exitedFlag || (sig !== "SIGTERM" && sig !== "SIGKILL")) return;
          if (sig === "SIGKILL") killAll();
          else signalGroup(sig);
        },
        async send(messageId, text) {
          if (typeof messageId !== "string") throw new TypeError("claude runtime: a message needs an id");
          const line = encodeUserMessage({ text, id: messageId });
          sent.add(messageId);
          try {
            await write(line);
          } catch (err) {
            sent.delete(messageId);
            throw err;
          }
        },
        async decide(requestId, { allow, reason, answers } = {}) {
          if (!held.has(requestId)) return;
          const input = held.get(requestId);
          held.delete(requestId);
          await write(encodeControlResponse({ requestId, allow: allow === true, reason, input: withAnswers(input, answers) }));
        },
      };
    },
  };
}
