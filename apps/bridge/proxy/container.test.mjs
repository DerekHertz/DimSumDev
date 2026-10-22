// hardening/11 (ADR 0031 decisions 4 and 5): how the proxy is started and what the agent is told about it. qa specify.
// Red until apps/bridge/proxy/container.mjs exists. Offline: docker is a fake; nothing here starts a container.
//
// The seam, in apps/bridge/proxy/container.mjs (pure functions of their arguments, plus one injected docker):
//   DUMMY_API_KEY                       the placeholder the agent holds as ANTHROPIC_API_KEY. Not a secret and not token-shaped.
//   agentProxyEnv({ role, session, ports, host = "den-proxy" })
//       ports is portPlan(...)'s result. Returns the env the bridge adds to that agent's container (hardening/10 calls it):
//         ANTHROPIC_BASE_URL = http://<host>:<ports[role]>     ANTHROPIC_API_KEY = DUMMY_API_KEY
//         HTTPS_PROXY and https_proxy = http://<encodeURIComponent(session)>@<host>:<ports[role]>   (the userinfo is how the proxy learns the session)
//         NO_PROXY and no_proxy include <host>   (the API front is plain http and must not loop through the proxy)
//       Throws for a role with no port. Never carries a token of any kind.
//   proxyRunArgs({ image, tokenDir, proxyDir, roles, basePort = 8080, name = "den-proxy", network = "den-agents" }) -> string[]   (argv after `docker`)
//       ["run","-d", ...flags..., image, "node", "/den-proxy/den-proxy.mjs"]
//       - `--name <name>`, `--network <network>`, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`
//       - mounts ONLY as `-v <host>:<container>:ro`: tokenDir -> /run/den-token and proxyDir -> /den-proxy. The token is mounted as its DIRECTORY, never
//         the single file (a bind-mounted file keeps pointing at the old inode after the refresher's atomic rename).
//       - env ONLY as `-e K=V`: DEN_PROXY_TOKEN_FILE=/run/den-token/access-token, DEN_PROXY_ROLES=<JSON of roles>, DEN_PROXY_BASE_PORT=<basePort>.
//         The token itself is never an argument: a path is, a value is not.
//       - `--label den.proxy.key=<key>`: a hash that changes when roles, basePort, image or mounts change (so a stale allowlist is replaced)
//   ensureProxy({ docker, ...same options as proxyRunArgs }) -> Promise<{ started: boolean }>
//       docker(args) -> Promise<{ ok, out, err }>. The calls it may make, exactly:
//         ["network","inspect",network]                                   ok false when the network is absent
//         ["network","create","--internal",network]
//         ["inspect","-f",'{{.State.Running}} {{index .Config.Labels "den.proxy.key"}}',name]   out "true <key>\n"; ok false when there is no such container
//         ["rm","-f",name]
//         ["run", ...proxyRunArgs(...).slice(1)] i.e. exactly proxyRunArgs(...)
//         ["network","connect","bridge",name]                             the proxy sits on den-agents AND the default bridge (ADR 0031 decision 4)
//       Idempotent: a running proxy with the current key makes no create, rm, run or connect call. A stopped one, or one with another key, is removed and run again.
//       A failed docker call rejects with an Error that quotes docker's stderr.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DUMMY_API_KEY, agentProxyEnv, proxyRunArgs, ensureProxy } from "./container.mjs";
import { portPlan } from "./proxy.mjs";

const SENTINEL = "sk-ant-oat01-SENTINEL-CONTAINER-TOKEN";
const roles = { developer: ["granted.test"], qa: [], security: ["other.test"] };
const opts = { image: "node:22-bookworm-slim", tokenDir: "/home/u/.local/state/den/proxy-token", proxyDir: "/home/u/.local/state/den/releases/abc123def456/apps/bridge/proxy", roles };
const flagValues = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

describe("agentProxyEnv (what the agent container is given)", () => {
  const ports = portPlan(roles, 8080);
  const env = agentProxyEnv({ role: "qa", session: "sess 7/a", ports });

  test("points the API and the tunnel at the role's own port, with the session as the proxy userinfo", () => {
    assert.equal(env.ANTHROPIC_BASE_URL, "http://den-proxy:8081");
    assert.equal(env.ANTHROPIC_API_KEY, DUMMY_API_KEY);
    assert.equal(env.HTTPS_PROXY, `http://${encodeURIComponent("sess 7/a")}@den-proxy:8081`);
    assert.equal(env.https_proxy, env.HTTPS_PROXY);
    assert.match(env.NO_PROXY, /den-proxy/);
    assert.match(env.no_proxy, /den-proxy/);
  });

  test("another role gets another port; an unknown role throws", () => {
    assert.equal(agentProxyEnv({ role: "developer", session: "s", ports }).ANTHROPIC_BASE_URL, "http://den-proxy:8080");
    assert.throws(() => agentProxyEnv({ role: "nobody", session: "s", ports }));
  });

  test("carries no token: the key is a dummy, and no env name or value looks like a credential", () => {
    assert.ok(!/^sk-ant-o(at|rt)/.test(DUMMY_API_KEY), "the dummy key is not token-shaped");
    for (const [k, v] of Object.entries(env)) {
      assert.ok(!/OAUTH|AUTH_TOKEN|REFRESH/i.test(k), `env name ${k}`);
      assert.ok(!/sk-ant-o(at|rt)/.test(String(v)), `env value of ${k}`);
    }
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  });
});

describe("proxyRunArgs (what `docker inspect` of the proxy will show)", () => {
  const args = proxyRunArgs(opts);

  test("a detached, named, locked-down container on the agents network", () => {
    assert.deepEqual(args.slice(0, 2), ["run", "-d"]);
    assert.deepEqual(flagValues(args, "--name"), ["den-proxy"]);
    assert.deepEqual(flagValues(args, "--network"), ["den-agents"]);
    assert.ok(args.includes("--read-only"));
    assert.deepEqual(flagValues(args, "--cap-drop"), ["ALL"]);
    assert.deepEqual(flagValues(args, "--security-opt"), ["no-new-privileges"]);
    assert.deepEqual(args.slice(-3), [opts.image, "node", "/den-proxy/den-proxy.mjs"]);
  });

  test("every mount is read-only; the token is mounted as its directory, never the single file", () => {
    const mounts = flagValues(args, "-v");
    assert.ok(mounts.length >= 2);
    assert.ok(mounts.every((m) => m.endsWith(":ro")), `all read-only: ${mounts}`);
    assert.ok(mounts.includes(`${opts.tokenDir}:/run/den-token:ro`));
    assert.ok(mounts.includes(`${opts.proxyDir}:/den-proxy:ro`));
    assert.ok(!mounts.some((m) => m.includes("access-token")), "a file mount would keep the old inode after a refresh");
    assert.ok(!args.includes("--mount") && !args.includes("--volume"), "one form, so a reviewer greps one flag");
  });

  test("env carries the token's path and the role lists, never a token", () => {
    const env = Object.fromEntries(flagValues(args, "-e").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
    assert.equal(env.DEN_PROXY_TOKEN_FILE, "/run/den-token/access-token");
    assert.deepEqual(JSON.parse(env.DEN_PROXY_ROLES), roles);
    assert.equal(env.DEN_PROXY_BASE_PORT, "8080");
    assert.ok(!args.includes("--env") && !args.includes("--env-file"));
    assert.ok(!/sk-ant-o(at|rt)/.test(JSON.stringify(args)));
  });

  test("the key label changes with the allowlist, the base port and the image, and not otherwise", () => {
    const key = (o) => flagValues(proxyRunArgs(o), "--label").find((l) => l.startsWith("den.proxy.key=")).slice("den.proxy.key=".length);
    const base = key(opts);
    assert.ok(base.length >= 8);
    assert.equal(key({ ...opts }), base);
    assert.notEqual(key({ ...opts, roles: { ...roles, qa: ["new.test"] } }), base);
    assert.notEqual(key({ ...opts, basePort: 9000 }), base);
    assert.notEqual(key({ ...opts, image: "node:22.1" }), base);
  });
});

describe("ensureProxy (started with the den)", () => {
  function fakeDocker(state) {
    const calls = [];
    const docker = async (args) => {
      calls.push(args);
      const [a, b] = args;
      if (a === "network" && b === "inspect") return state.network ? { ok: true, out: "[]" } : { ok: false, err: "No such network" };
      if (a === "network" && b === "create") { state.network = true; return { ok: true, out: "id" }; }
      if (a === "inspect") return state.container ? { ok: true, out: `${state.container.running} ${state.container.key}\n` } : { ok: false, err: "No such object" };
      if (a === "rm") { state.container = null; return { ok: true, out: "" }; }
      if (a === "run") {
        if (state.runFails) return { ok: false, err: "docker: image pull denied for SOMEIMAGE" };
        state.container = { running: true, key: flagValues(args, "--label").find((l) => l.startsWith("den.proxy.key=")).slice(14) };
        return { ok: true, out: "cid" };
      }
      if (a === "network" && b === "connect") return { ok: true, out: "" };
      return { ok: false, err: `unexpected docker ${args.join(" ")}` };
    };
    return { docker, calls };
  }
  const verbs = (calls) => calls.map((c) => (c[0] === "network" ? `network ${c[1]}` : c[0]));

  test("on a fresh host: creates the internal network, runs the proxy with proxyRunArgs, then connects it to the default bridge", async () => {
    const f = fakeDocker({ network: false, container: null });
    const r = await ensureProxy({ docker: f.docker, ...opts });
    assert.equal(r.started, true);
    const create = f.calls.find((c) => c[0] === "network" && c[1] === "create");
    assert.deepEqual(create, ["network", "create", "--internal", "den-agents"]);
    assert.deepEqual(f.calls.find((c) => c[0] === "run"), proxyRunArgs(opts));
    assert.deepEqual(f.calls.find((c) => c[0] === "network" && c[1] === "connect"), ["network", "connect", "bridge", "den-proxy"]);
    const order = verbs(f.calls);
    assert.ok(order.indexOf("network create") < order.indexOf("run") && order.indexOf("run") < order.indexOf("network connect"));
  });

  test("a second call with the proxy already up and current changes nothing", async () => {
    const state = { network: false, container: null };
    const f = fakeDocker(state);
    await ensureProxy({ docker: f.docker, ...opts });
    f.calls.length = 0;
    const r = await ensureProxy({ docker: f.docker, ...opts });
    assert.equal(r.started, false);
    assert.ok(!verbs(f.calls).some((v) => ["network create", "rm", "run", "network connect"].includes(v)), `calls: ${verbs(f.calls)}`);
  });

  test("a changed allowlist replaces the running proxy (a role's removed host must stop working)", async () => {
    const f = fakeDocker({ network: false, container: null });
    await ensureProxy({ docker: f.docker, ...opts });
    f.calls.length = 0;
    const changed = { ...opts, roles: { ...roles, developer: [] } };
    const r = await ensureProxy({ docker: f.docker, ...changed });
    assert.equal(r.started, true);
    const order = verbs(f.calls);
    assert.ok(order.indexOf("rm") >= 0 && order.indexOf("rm") < order.indexOf("run"));
    assert.deepEqual(f.calls.find((c) => c[0] === "run"), proxyRunArgs(changed));
    assert.deepEqual(f.calls.find((c) => c[0] === "rm"), ["rm", "-f", "den-proxy"]);
  });

  test("a stopped proxy is removed and run again", async () => {
    const f = fakeDocker({ network: true, container: { running: "false", key: "whatever" } });
    const r = await ensureProxy({ docker: f.docker, ...opts });
    assert.equal(r.started, true);
    assert.ok(verbs(f.calls).includes("rm") && verbs(f.calls).includes("run"));
  });

  test("a failed run rejects with docker's stderr in the message", async () => {
    const f = fakeDocker({ network: true, container: null, runFails: true });
    await assert.rejects(ensureProxy({ docker: f.docker, ...opts }), /image pull denied/);
  });
});

describe("the proxy directory is self-contained (it is mounted alone into a container)", () => {
  test("no non-test file in apps/bridge/proxy imports anything but node: built-ins and its own siblings", () => {
    const dir = new URL(".", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));
    assert.ok(files.includes("proxy.mjs") && files.includes("token.mjs") && files.includes("container.mjs") && files.includes("den-proxy.mjs"), `files: ${files}`);
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), "utf8");
      for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
        const spec = m[1] ?? m[2];
        assert.ok(spec.startsWith("node:") || /^\.\/[\w.-]+\.mjs$/.test(spec), `${f} imports ${spec}`);
      }
    }
  });
});
