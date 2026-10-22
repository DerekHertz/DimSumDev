// hardening/11: the proxy as a process, the way the container runs it: `node /den-proxy/den-proxy.mjs`. Config is env, none of it secret.
//   DEN_PROXY_TOKEN_FILE (required)  DEN_PROXY_ROLES (required, JSON { role: [hosts] })  DEN_PROXY_BASE_PORT (8080)
//   DEN_PROXY_LISTEN_HOST (0.0.0.0)  DEN_PROXY_API_ORIGIN (https://api.anthropic.com)
// stdout is JSON lines: { event: "listening", ports } first, then one line per log entry (a refusal is the entry startProxies logs).
import { startProxies } from "./proxy.mjs";
import { fileTokenSource } from "./token.mjs";

const env = process.env;
const fail = (message) => { process.stderr.write(`den-proxy: ${message}\n`); process.exit(1); };
if (!env.DEN_PROXY_TOKEN_FILE) fail("DEN_PROXY_TOKEN_FILE is not set");
if (!env.DEN_PROXY_ROLES) fail("DEN_PROXY_ROLES is not set");
let roles;
try { roles = JSON.parse(env.DEN_PROXY_ROLES); } catch { fail("DEN_PROXY_ROLES is not valid JSON"); }

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const fleet = await startProxies({
  roles,
  basePort: env.DEN_PROXY_BASE_PORT === undefined ? 8080 : Number(env.DEN_PROXY_BASE_PORT),
  listenHost: env.DEN_PROXY_LISTEN_HOST || "0.0.0.0",
  apiOrigin: env.DEN_PROXY_API_ORIGIN || undefined,
  tokenSource: fileTokenSource({ file: env.DEN_PROXY_TOKEN_FILE }),
  log: out,
});
out({ event: "listening", ports: fleet.ports });

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => { await fleet.close(); process.exit(0); });
