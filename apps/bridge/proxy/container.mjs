// hardening/11 (ADR 0031 decisions 4 and 5): how the proxy container is started and what an agent container is told about it.
// Imports only node: built-ins and siblings.
import { createHash } from "node:crypto";

export const DUMMY_API_KEY = "den-dummy-key";
const TOKEN_MOUNT = "/run/den-token";
const CODE_MOUNT = "/den-proxy";
const LABEL = "den.proxy.key";

export function agentProxyEnv({ role, session, ports, host = "den-proxy" }) {
  const port = ports?.[role];
  if (!Number.isInteger(port)) throw new Error(`no proxy port for role ${role}`);
  const proxy = `http://${encodeURIComponent(session)}@${host}:${port}`;
  return { ANTHROPIC_BASE_URL: `http://${host}:${port}`, ANTHROPIC_API_KEY: DUMMY_API_KEY, HTTPS_PROXY: proxy, https_proxy: proxy, NO_PROXY: host, no_proxy: host };
}

// The token is mounted as its DIRECTORY: a single-file bind mount keeps the old inode after the refresher's atomic rename.
function runShape({ image, tokenDir, proxyDir, roles, basePort = 8080, name = "den-proxy", network = "den-agents" }) {
  const mounts = [`${tokenDir}:${TOKEN_MOUNT}:ro`, `${proxyDir}:${CODE_MOUNT}:ro`];
  const env = [`DEN_PROXY_TOKEN_FILE=${TOKEN_MOUNT}/access-token`, `DEN_PROXY_ROLES=${JSON.stringify(roles)}`, `DEN_PROXY_BASE_PORT=${basePort}`];
  const cmd = ["node", `${CODE_MOUNT}/den-proxy.mjs`];
  // The key changes with anything that changes the proxy, so a stale allowlist is replaced rather than kept.
  const key = createHash("sha256").update(JSON.stringify({ image, mounts, env, cmd, name, network })).digest("hex").slice(0, 16);
  return { image, name, network, mounts, env, cmd, key };
}

export function proxyRunArgs(opts) {
  const { image, name, network, mounts, env, cmd, key } = runShape(opts);
  return [
    "run", "-d", "--name", name, "--network", network, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--label", `${LABEL}=${key}`,
    ...mounts.flatMap((m) => ["-v", m]),
    ...env.flatMap((e) => ["-e", e]),
    image, ...cmd,
  ];
}

export async function ensureProxy({ docker, ...opts }) {
  const { name, network, key } = runShape(opts);
  const need = async (args) => {
    const r = await docker(args);
    if (!r.ok) throw new Error(`docker ${args[0]} failed: ${r.err}`);
    return r;
  };
  if (!(await docker(["network", "inspect", network])).ok) await need(["network", "create", "--internal", network]);
  const cur = await docker(["inspect", "-f", `{{.State.Running}} {{index .Config.Labels "${LABEL}"}}`, name]);
  if (cur.ok) {
    const [running, have] = cur.out.trim().split(" ");
    if (running === "true" && have === key) return { started: false };
    await need(["rm", "-f", name]);
  }
  await need(proxyRunArgs(opts));
  try { await need(["network", "connect", "bridge", name]); } catch (e) {
    await docker(["rm", "-f", name]); // a proxy with no way out must not look current on the next call
    throw e;
  }
  return { started: true };
}
