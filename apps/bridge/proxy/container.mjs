// hardening/11 (ADR 0031 decisions 4 and 5): how the proxy container is started and what an agent container is told about it.
// Imports only node: built-ins and siblings.
import { createHash } from "node:crypto";

export const DUMMY_API_KEY = "den-dummy-key";
const TOKEN_MOUNT = "/run/den-token";
const SECRETS_MOUNT = "/run/den-secrets";
const CODE_MOUNT = "/den-proxy";
// Caps on what the proxy container can take from the host (a stuck or hostile agent must not starve it).
const LIMIT_FLAGS = ["--memory", "256m", "--pids-limit", "256", "--ulimit", "nofile=4096:4096"];
const LABEL = "den.proxy.key";

// secret: the role secret the bridge minted (secrets.mjs). It is the agent's API key and the proxy password, so the proxy can tell roles apart;
// it is a proxy credential, not the login. Without it the key is the dummy and the proxy must be running without secrets.
export function agentProxyEnv({ role, session, ports, host = "den-proxy", secret }) {
  const port = ports?.[role];
  if (!Number.isInteger(port)) throw new Error(`no proxy port for role ${role}`);
  const userinfo = secret ? `${encodeURIComponent(session)}:${encodeURIComponent(secret)}` : encodeURIComponent(session);
  const proxy = `http://${userinfo}@${host}:${port}`;
  return { ANTHROPIC_BASE_URL: `http://${host}:${port}`, ANTHROPIC_API_KEY: secret ?? DUMMY_API_KEY, HTTPS_PROXY: proxy, https_proxy: proxy, NO_PROXY: host, no_proxy: host };
}

// The token is mounted as its DIRECTORY: a single-file bind mount keeps the old inode after the refresher's atomic rename.
// secretsDir (the directory secrets.mjs writes) is mounted read-only as a directory too; the map is never an env value or an argument.
// Without it the proxy requires no role secret: the wiring must pass it.
function runShape({ image, tokenDir, proxyDir, secretsDir, roles, basePort = 8080, name = "den-proxy", network = "den-agents" }) {
  const mounts = [`${tokenDir}:${TOKEN_MOUNT}:ro`, `${proxyDir}:${CODE_MOUNT}:ro`, ...(secretsDir ? [`${secretsDir}:${SECRETS_MOUNT}:ro`] : [])];
  const env = [`DEN_PROXY_TOKEN_FILE=${TOKEN_MOUNT}/access-token`, `DEN_PROXY_ROLES=${JSON.stringify(roles)}`, `DEN_PROXY_BASE_PORT=${basePort}`, ...(secretsDir ? [`DEN_PROXY_SECRETS_FILE=${SECRETS_MOUNT}/secrets.json`] : [])];
  const cmd = ["node", `${CODE_MOUNT}/den-proxy.mjs`];
  // The key changes with anything that changes the proxy, so a stale allowlist is replaced rather than kept.
  const key = createHash("sha256").update(JSON.stringify({ image, mounts, env, cmd, name, network })).digest("hex").slice(0, 16);
  return { image, name, network, mounts, env, cmd, key };
}

export function proxyRunArgs(opts) {
  const { image, name, network, mounts, env, cmd, key } = runShape(opts);
  return [
    "run", "-d", "--name", name, "--network", network, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", ...LIMIT_FLAGS,
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
