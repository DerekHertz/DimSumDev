// hardening/10 (ADR 0031 decisions 2 and 3): the `docker run` argv for one agent, built from its ceiling and class limits.
// Pure: no docker call, no disk. The mounts are the boundary; a path not mounted is absent. Every mount is at its host path,
// so paths in the stream and the handoff stay true on the host.
import { isWorktreePath } from "./claude-adapter.mjs";

/** Host-side git in an agent worktree must not run code the agent could plant in the worktree's config (hardening/13 security, M). */
export const SAFE_GIT = Object.freeze(["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null"]);

export const AGENT_NETWORK = "den-agents";
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._/-]{0,100}(?::[A-Za-z0-9._-]{1,100})?$|^sha256:[0-9a-f]{64}$/;
const REF_PART_RE = /^[A-Za-z0-9._-]+$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

const need = (ok, what) => {
  if (!ok) throw new TypeError(`containerRunArgs: ${what}`);
};
const plainPath = (p, what) => need(isWorktreePath(p), `${what} must be a plain absolute path`);

/**
 * The argv (no binary name) of `docker run` for one agent. limits: a limits.json class. refsNamespace: the one branch namespace
 * under refs/heads that a branch-holding agent may write (the bridge's agents are detached and need none). grants: absolute write paths.
 */
export function containerRunArgs({ image, name, worktree, mainGit, refsNamespace, ticketFile, grants = [], limits, env = {}, cliArgs, network = AGENT_NETWORK }) {
  need(typeof image === "string" && IMAGE_RE.test(image), "image must be a plain image reference");
  need(typeof name === "string" && NAME_RE.test(name), "name must be a plain lower-case name");
  need(typeof network === "string" && NAME_RE.test(network), "network must be a plain lower-case name");
  plainPath(worktree, "worktree");
  plainPath(mainGit, "mainGit");
  if (ticketFile !== undefined) plainPath(ticketFile, "ticketFile");
  need(Array.isArray(grants) && grants.length <= 6, "grants must be a short list");
  for (const g of grants) plainPath(g, "a grant");
  need(refsNamespace === undefined || (typeof refsNamespace === "string" && REF_PART_RE.test(refsNamespace) && !/^\.+$/.test(refsNamespace)), "refsNamespace must be one plain name");
  need(limits && int(limits.memoryMiB, 16, 1024 * 1024) && int(limits.cpuPercent, 5, 6400) && int(limits.tasks, 8, 65536), "limits must be a limits.json class");
  need(Array.isArray(cliArgs) && cliArgs.every((a) => typeof a === "string"), "cliArgs must be strings");
  need(Object.entries(env).every(([k, v]) => ENV_NAME_RE.test(k) && typeof v === "string" && !v.includes("\n")), "env must be plain strings");
  const mount = (src, mode) => ["-v", `${src}:${src}:${mode}`];
  const wt = worktree.slice(worktree.lastIndexOf("/") + 1);
  return [
    "run", "--rm", "-i", "--name", name, "--network", network, "--read-only", "--tmpfs", "/tmp:rw,exec,size=512m", "--tmpfs", "/root:rw,size=256m",
    "--user", "0:0", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--memory", `${limits.memoryMiB}m`, "--memory-swap", `${limits.memoryMiB}m`, "--cpus", String(limits.cpuPercent / 100), "--pids-limit", String(limits.tasks),
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...mount(worktree, "rw"), ...mount(mainGit, "ro"),
    ...mount(`${mainGit}/worktrees/${wt}`, "rw"), ...mount(`${mainGit}/objects`, "rw"), ...mount(`${mainGit}/logs`, "rw"),
    ...(refsNamespace === undefined ? [] : mount(`${mainGit}/refs/heads/${refsNamespace}`, "rw")),
    ...(ticketFile === undefined ? [] : mount(ticketFile, "ro")),
    ...grants.flatMap((g) => mount(g, "rw")),
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
