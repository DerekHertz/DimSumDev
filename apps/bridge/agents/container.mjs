// hardening/10 (ADR 0031 decisions 2 and 3): the `docker run` argv for one agent, built from its ceiling and class limits.
// Pure: no docker call, no disk. The mounts are the boundary; a path not mounted is absent. Every mount is at its host path,
// so paths in the stream and the handoff stay true on the host.
import { spawn as spawnChild } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { isWorktreePath } from "./claude-adapter.mjs";
import { agentProxyEnv } from "../proxy/container.mjs";
import { EnforcementError, LIMITS } from "./resource-group.mjs";

export const AGENT_NETWORK = "den-agents";
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._/-]{0,100}(?::[A-Za-z0-9._-]{1,100})?$|^sha256:[0-9a-f]{64}$/;
const REF_PART_RE = /^[A-Za-z0-9._-]+$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Where the CLI keeps its sessions with HOME=/root: <HOME>/.claude/projects/<cwd, encoded>/<sessionId>.jsonl. */
export const SESSION_STORE = "/root/.claude/projects";
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

const need = (ok, what) => {
  if (!ok) throw new TypeError(`containerRunArgs: ${what}`);
};
const plainPath = (p, what) => need(isWorktreePath(p), `${what} must be a plain absolute path`);

/**
 * The argv (no binary name) of `docker run` for one agent. limits: a limits.json class. refsNamespace: the one branch namespace
 * under refs/heads that a branch-holding agent may write (the bridge's agents are detached and need none). grants: absolute write paths.
 * sessionStore: the session's persistent folder, mounted at the CLI's session store so a follow-up's --resume finds the conversation.
 * env: plain values put on the argv; passEnv: names docker copies from its own env, for values that must not be on the argv (security M3).
 */
export function containerRunArgs({ image, name, worktree, mainGit, refsNamespace, ticketFile, mcpConfigFile, grants = [], readOnly = [], sessionStore, limits, env = {}, passEnv = [], cliArgs, network = AGENT_NETWORK }) {
  need(typeof image === "string" && IMAGE_RE.test(image), "image must be a plain image reference");
  need(typeof name === "string" && NAME_RE.test(name), "name must be a plain lower-case name");
  need(typeof network === "string" && NAME_RE.test(network), "network must be a plain lower-case name");
  plainPath(worktree, "worktree");
  plainPath(mainGit, "mainGit");
  if (ticketFile !== undefined) plainPath(ticketFile, "ticketFile");
  if (sessionStore !== undefined) plainPath(sessionStore, "sessionStore");
  if (mcpConfigFile !== undefined) plainPath(mcpConfigFile, "mcpConfigFile");
  need(Array.isArray(grants) && grants.length <= 6, "grants must be a short list");
  for (const g of grants) plainPath(g, "a grant");
  need(Array.isArray(readOnly) && readOnly.length <= 64, "readOnly must be a short list");
  for (const r of readOnly) plainPath(r, "a read-only path");
  need(refsNamespace === undefined || (typeof refsNamespace === "string" && REF_PART_RE.test(refsNamespace) && !/^\.+$/.test(refsNamespace)), "refsNamespace must be one plain name");
  need(limits && int(limits.memoryMiB, 16, 1024 * 1024) && int(limits.cpuPercent, 5, 6400) && int(limits.tasks, 8, 65536), "limits must be a limits.json class");
  need(Array.isArray(cliArgs) && cliArgs.every((a) => typeof a === "string"), "cliArgs must be strings");
  need(Object.entries(env).every(([k, v]) => ENV_NAME_RE.test(k) && typeof v === "string" && !v.includes("\n")), "env must be plain strings");
  need(Array.isArray(passEnv) && passEnv.every((k) => typeof k === "string" && ENV_NAME_RE.test(k)), "passEnv must be env names");
  const mount = (src, mode) => ["-v", `${src}:${src}:${mode}`];
  const wt = worktree.slice(worktree.lastIndexOf("/") + 1);
  return [
    // --init reaps orphans before they fill --pids-limit; the stream is not kept in docker's log; the image is never pulled (security L4).
    "run", "--rm", "-i", "--name", name, "--init", "--pull", "never", "--log-driver", "none", "--network", network, "--read-only", "--tmpfs", "/tmp:rw,exec,size=512m", "--tmpfs", "/root:rw,size=256m",
    "--user", "0:0", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--memory", `${limits.memoryMiB}m`, "--memory-swap", `${limits.memoryMiB}m`, "--cpus", String(limits.cpuPercent / 100), "--pids-limit", String(limits.tasks),
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), ...passEnv.flatMap((k) => ["-e", k]),
    ...mount(worktree, "rw"), ...mount(mainGit, "ro"),
    ...mount(`${mainGit}/worktrees/${wt}`, "rw"), ...mount(`${mainGit}/objects`, "rw"), ...mount(`${mainGit}/logs`, "rw"),
    ...(refsNamespace === undefined ? [] : mount(`${mainGit}/refs/heads/${refsNamespace}`, "rw")),
    ...(ticketFile === undefined ? [] : mount(ticketFile, "ro")),
    ...(mcpConfigFile === undefined ? [] : mount(mcpConfigFile, "ro")), // a secured connection's tokens: --mcp-config names it at this path
    ...(sessionStore === undefined ? [] : ["-v", `${sessionStore}:${SESSION_STORE}:rw`]),
    ...grants.flatMap((g) => mount(g, "rw")),
    ...readOnly.flatMap((r) => mount(r, "ro")), // docker mounts a deeper target after its parent, so these sit over the rw mounts
    "-w", worktree, image, "claude", ...cliArgs,
  ];
}

/**
 * The CLI argv as built for the host, made right for the container: the CLI's own sandbox needs bwrap, which the container does not
 * have and does not need (the mounts are the boundary), so its block is dropped and Bash is allowed. Every permission deny stays.
 */
export function containerCliArgs(args) {
  const i = args.indexOf("--settings");
  need(i >= 0 && typeof args[i + 1] === "string", "the argv has no --settings");
  const settings = JSON.parse(args[i + 1]);
  delete settings.sandbox;
  const allow = settings.permissions?.allow ?? [];
  settings.permissions = { ...settings.permissions, allow: allow.includes("Bash") ? allow : [...allow, "Bash"] };
  return args.map((a, j) => (j === i + 1 ? JSON.stringify(settings) : a));
}

const under = (p, dir) => p === dir || p.startsWith(`${dir}/`);
/**
 * Security M1: the CLI sandbox's shell-write denies (the guardrail and CI paths of the worktree, and those a grant reaches, CI lift
 * for ciGrantRoles included) that fall under one of the rw mounts `rw`. The container mounts them read-only in place of the sandbox.
 */
export function governedWrites(args, rw) {
  const i = args.indexOf("--settings");
  const listed = i >= 0 ? JSON.parse(args[i + 1]).sandbox?.filesystem?.denyWrite : undefined;
  return [...new Set((Array.isArray(listed) ? listed : []).filter((p) => typeof p === "string" && isWorktreePath(p) && rw.some((d) => under(p, d))))];
}

const NOFOLLOW_CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const kind = (p) => lstat(p).then((s) => (s.isSymbolicLink() ? "link" : "there"), (e) => { if (e.code === "ENOENT") return "missing"; throw e; });

/**
 * Security N1: walk a governed path from its rw root (the worktree or a grant) down with lstat, and refuse it when the root or any
 * component is a symlink: the bridge's writes and docker's bind source would follow it out of the worktree. With create, a missing
 * component is made one level at a time (mkdir never follows a link it would create) and a missing leaf gets an empty read-only
 * placeholder opened O_EXCL|O_NOFOLLOW. -> { dirs, file }: what it made.
 */
async function walkGoverned(p, roots, create) {
  const root = roots.filter((r) => under(p, r)).sort((a, b) => b.length - a.length)[0];
  const parts = path.relative(root, p).split("/").filter(Boolean);
  const made = { dirs: [], file: null };
  for (let i = 0, c = root; ; c = path.join(c, parts[i++])) {
    const state = await kind(c);
    if (state === "link") throw new EnforcementError(`the governed path ${p} goes through a symlink at ${c}`);
    if (state === "missing") {
      if (!create) return made;
      if (i < parts.length) {
        await mkdir(c);
        made.dirs.push(c);
      } else {
        await (await open(c, NOFOLLOW_CREATE, 0o444)).close();
        made.file = c;
      }
    }
    if (i === parts.length) return made;
  }
}

/**
 * Each governed path ready to be mounted read-only: an existing one as is; a missing one gets an empty read-only placeholder file
 * (the CLI sandbox does the same), with any parent dirs it needs. -> { paths, sweep }: sweep removes the placeholders still empty
 * and read-only, and the dirs made for them. Never throws from sweep. Throws (EnforcementError) on a symlink, after undoing its work.
 */
async function placeGoverned(paths, roots) {
  const made = [];
  const dirs = [];
  const sweep = async () => {
    for (const p of made) {
      try {
        const info = await lstat(p);
        if (info.isFile() && info.size === 0 && (info.mode & 0o222) === 0) await unlink(p);
      } catch { /* gone */ }
    }
    for (const d of [...dirs].reverse()) await rmdir(d).catch(() => {});
  };
  try {
    for (const p of paths) {
      const { dirs: newDirs, file } = await walkGoverned(p, roots, true);
      dirs.push(...newDirs);
      if (file) made.push(file);
    }
  } catch (err) {
    await sweep();
    throw err;
  }
  return { paths, sweep };
}

const DOCKER = "/usr/bin/docker"; // ADR 0031 decision 1: never the first `docker` on PATH, which can be Docker Desktop's
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The launcher the bridge uses with the container flag on (DEN_AGENT_CONTAINERS=1): same shape as createResourceLauncher, so the
 * runtime is unchanged. docker(args) -> { ok, out, err } and spawn are injected. proxy: { ports, mintRunSecret({ role }), retireRunSecret(secret) }.
 * sessionsDir: the den's folder of per-session CLI stores (<denState>/agent-sessions).
 * launch() refuses (EnforcementError) when the daemon, the den-agents network or the proxy is not up, or the container does not start.
 */
export function createContainerLauncher({ env = process.env, limits = LIMITS, image, docker, proxy, spawn = spawnChild, proxyName = "den-proxy", startWaitMs = 8000, sessionsDir }) {
  const containerName = (id) => `den-agent-${id}`;
  const up = async (name) => (await docker(["inspect", "-f", "{{.State.Running}}", name])).out.trim() === "true";
  async function preflight() {
    const net = await docker(["network", "inspect", "-f", "{{.Internal}}", AGENT_NETWORK]);
    if (!net.ok) return { ok: false, reason: `the ${AGENT_NETWORK} network is not there: ${net.err}` };
    // Security M2: a network recreated without --internal gives agents direct egress around the proxy.
    if (net.out.trim() !== "true") return { ok: false, reason: `the ${AGENT_NETWORK} network is not internal, so an agent could reach the internet around the proxy` };
    if (!(await up(proxyName))) return { ok: false, reason: "the credential proxy is not running, so an agent could not reach the API" };
    return { ok: true };
  }
  return {
    enforced: true,
    container: true,
    limits,
    preflight,
    active: (id) => up(containerName(id)),
    async launch({ slotClass, id, args, cwd, container }) {
      const limit = limits.classes[slotClass];
      if (!limit) throw new TypeError("container launcher: unknown slot class");
      if (typeof container.sessionId !== "string" || !UUID_RE.test(container.sessionId)) throw new TypeError("container launcher: the session id must be a UUID");
      plainPath(sessionsDir, "sessionsDir");
      const ready = await preflight();
      if (!ready.ok) throw new EnforcementError(ready.reason);
      // Security L5: a leftover container of this name would answer the start check while this run's `docker run` fails on the name.
      if (await up(containerName(id))) throw new EnforcementError(`a container named ${containerName(id)} is already running`);
      const roots = [cwd, ...(container.grants ?? [])];
      const wanted = governedWrites(args, roots);
      for (const p of wanted) await walkGoverned(p, roots, false); // security N1: refuse a symlinked governed path before the mint
      const { secret } = await proxy.mintRunSecret({ role: container.role });
      // hardening/16 F4: a run's secret is good for that run only.
      const retire = () => Promise.resolve().then(() => proxy.retireRunSecret(secret)).catch(() => {});
      const name = containerName(id);
      let governed;
      let argv;
      // The proxy env carries the secret, so docker copies it from its own env (-e NAME) and it never shows in `ps` or `docker inspect` argv.
      const secretEnv = agentProxyEnv({ role: container.role, session: container.sessionId, ports: proxy.ports, secret });
      try {
        // The user's call (2026-10-23): follow-ups stay under containers, so each session keeps its CLI store between runs.
        const sessionStore = `${sessionsDir}/${container.sessionId}`;
        await mkdir(sessionStore, { recursive: true, mode: 0o700 });
        await chmod(sessionStore, 0o700);
        governed = await placeGoverned(wanted, roots);
        argv = containerRunArgs({
          image, name, worktree: cwd, mainGit: container.mainGit, ticketFile: container.ticketFile, mcpConfigFile: container.mcpConfigFile, grants: container.grants, readOnly: governed.paths, sessionStore, limits: limit, cliArgs: containerCliArgs(args),
          env: { HOME: "/root", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, passEnv: Object.keys(secretEnv),
        });
      } catch (err) {
        await governed?.sweep();
        await retire();
        throw err;
      }
      const host = env.DOCKER_HOST || `unix://${env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`}/docker.sock`;
      const child = spawn(DOCKER, argv, { shell: false, detached: true, cwd: "/", env: { PATH: env.PATH, DOCKER_HOST: host, ...secretEnv }, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr?.on?.("data", (c) => { if (stderr.length < 2048) stderr += String(c); });
      let gone = false;
      child.once("exit", () => { gone = true; governed.sweep(); retire(); });
      child.on("error", () => {});
      let hit = null;
      let reading = null;
      const group = {
        unit: name, dir: null,
        kill: () => { docker(["kill", name]); },
        // Docker sets State.OOMKilled while the container runs; the runtime polls this synchronously, so each call reads the cached
        // answer and starts the next read. A full --pids-limit only fails fork() and docker records nothing, so "processes" is never named.
        exhausted() {
          reading ??= docker(["inspect", "-f", "{{.State.OOMKilled}}", name]).then((r) => { if (r.ok && r.out.trim() === "true") hit = "memory"; }, () => {}).finally(() => (reading = null));
          return hit;
        },
        async settled(ms) {
          for (const until = Date.now() + ms; Date.now() < until; await sleep(50)) if (!(await up(name))) return true;
          return false;
        },
      };
      for (const until = Date.now() + startWaitMs; Date.now() < until && !gone; await sleep(50)) if (await up(name)) return { child, group };
      group.kill();
      await governed.sweep();
      await retire();
      try { if (child.pid > 1) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      throw new EnforcementError(`the container ${name} did not start: ${stderr.trim().slice(-300) || "no output"}`);
    },
  };
}
