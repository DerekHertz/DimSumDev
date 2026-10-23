// hardening/11 second fix round (security): a port is not an identity (per-role secrets), caps, and a bad token character.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startProxies, roleForSecret } from "./proxy.mjs";
import { SECRETS_FILE_NAME, fileSecretSource, mintSecret, writeSecrets } from "./secrets.mjs";
import { agentProxyEnv, proxyRunArgs } from "./container.mjs";

const TOKEN = ["sk-ant", "oat01-SENTINEL-SECRETS-TOKEN"].join("-"); // built at runtime so the repo secret scan stays clean
const S_DEV = "secret-developer-AAAA";
const S_DEV2 = "secret-developer-run2-BBBB";
const S_QA = "secret-qa-CCCC";
const GRANTED = "granted.test";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const authHeader = (session, secret) => `Proxy-Authorization: Basic ${Buffer.from(`${session}:${secret ?? ""}`).toString("base64")}`;

function connectRaw(port, authority, auth) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let buf = "";
    socket.on("error", reject);
    socket.on("data", function onData(d) {
      buf += d.toString("latin1");
      if (!buf.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      resolve({ status: Number(buf.split(" ")[1]), head: buf, socket });
    });
    socket.write([`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, ...(auth ? [auth] : []), "", ""].join("\r\n"));
  });
}
const front = (port, apiKey, body = "{}") => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/messages", headers: apiKey === undefined ? {} : { "x-api-key": apiKey } }, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
  });
  req.on("error", reject);
  req.end(body);
});

describe("per-role secrets", () => {
  let api, apiPort, seen, fleet, ports, logs, dials, secrets, sockets, token;
  before(async () => {
    seen = [];
    api = http.createServer((req, res) => { seen.push(req.headers.authorization); req.resume(); res.writeHead(200).end("{}"); });
    apiPort = await listen(api);
    logs = [];
    dials = [];
    sockets = [];
    token = TOKEN;
    secrets = { [S_DEV]: "developer", [S_DEV2]: "developer", [S_QA]: "qa" };
    fleet = await startProxies({
      roles: { developer: [GRANTED], qa: [] }, basePort: 0, listenHost: "127.0.0.1",
      tokenSource: { get: async () => token }, secretSource: { get: async () => secrets },
      apiOrigin: `http://127.0.0.1:${apiPort}`, log: (e) => logs.push(e),
      dial: (h, p) => { dials.push({ host: h, port: p }); return net.connect(apiPort, "127.0.0.1"); },
    });
    ports = fleet.ports;
  });
  after(async () => {
    for (const s of sockets) s.destroy();
    await fleet.close();
    api.closeAllConnections?.();
    await new Promise((r) => api.close(r));
  });
  const tunnel = async (...a) => { const r = await connectRaw(...a); sockets.push(r.socket); return r; };

  test("CONNECT: the role's own secret is tunnelled; its secret on another role's port, a wrong secret, and none are 407 with no dial", async () => {
    dials.length = 0;
    assert.equal((await tunnel(ports.developer, `${GRANTED}:443`, authHeader("s1", S_DEV))).status, 200);
    assert.deepEqual(dials, [{ host: GRANTED, port: 443 }]);
    dials.length = 0;
    const other = await tunnel(ports.qa, `${GRANTED}:443`, authHeader("s2", S_DEV));
    assert.equal(other.status, 407);
    assert.match(other.head, /Proxy-Authenticate: Basic/i);
    assert.equal((await tunnel(ports.developer, `${GRANTED}:443`, authHeader("s3", S_QA))).status, 407, "another role's secret on this port");
    assert.equal((await tunnel(ports.developer, `${GRANTED}:443`, authHeader("s4", "guess"))).status, 407);
    assert.equal((await tunnel(ports.developer, `${GRANTED}:443`, authHeader("s5", ""))).status, 407);
    assert.equal((await tunnel(ports.developer, `${GRANTED}:443`)).status, 407);
    assert.deepEqual(dials, []);
  });

  test("the front: the role's secret as x-api-key works; another role's, the dummy key and none are 401 and forward nothing", async () => {
    seen.length = 0;
    assert.equal((await front(ports.developer, S_DEV)).status, 200);
    assert.deepEqual(seen, [`Bearer ${TOKEN}`]);
    seen.length = 0;
    for (const key of [S_QA, "den-dummy-key", undefined]) {
      const r = await front(ports.developer, key);
      assert.equal(r.status, 401);
      assert.ok(!r.body.includes(S_DEV) && !r.body.includes(TOKEN));
    }
    assert.equal((await front(ports.qa, S_DEV)).status, 401);
    assert.deepEqual(seen, []);
  });

  test("a role can hold several secrets at once (one per agent run), and a new one works with no restart", async () => {
    assert.equal((await front(ports.developer, S_DEV2)).status, 200);
    const fresh = mintSecret();
    assert.equal((await front(ports.developer, fresh)).status, 401);
    secrets[fresh] = "developer";
    try { assert.equal((await front(ports.developer, fresh)).status, 200); } finally { delete secrets[fresh]; }
    assert.equal((await front(ports.developer, fresh)).status, 401);
  });

  test("refusals are logged with role and session; no secret or token appears in any log entry", async () => {
    logs.length = 0;
    await tunnel(ports.qa, `${GRANTED}:443`, authHeader("sess-9", S_DEV));
    await front(ports.developer, S_QA);
    await front(ports.developer, S_DEV);
    const refusals = logs.filter((l) => l.kind === "refusal");
    assert.equal(refusals.length, 2);
    assert.deepEqual([refusals[0].role, refusals[0].session, refusals[0].method], ["qa", "sess-9", "CONNECT"]);
    assert.equal(refusals[1].role, "developer");
    const text = JSON.stringify(logs);
    for (const s of [S_DEV, S_DEV2, S_QA, TOKEN]) assert.ok(!text.includes(s), "a secret leaked into the log");
  });

  test("a bad character in the token file is a 502, not a crash", async () => {
    token = "bad\ntoken";
    try { assert.equal((await front(ports.developer, S_DEV)).status, 502); } finally { token = TOKEN; }
    assert.equal((await front(ports.developer, S_DEV)).status, 200, "the proxy is still serving");
  });

  test("unreadable secrets deny everything", async () => {
    const f = await startProxies({ roles: { developer: [GRANTED] }, basePort: 0, listenHost: "127.0.0.1", tokenSource: { get: async () => TOKEN }, secretSource: { get: async () => { throw new Error("gone"); } }, log: () => {} });
    try { assert.equal((await front(f.ports.developer, S_DEV)).status, 401); } finally { await f.close(); }
  });
});

describe("roleForSecret", () => {
  test("matches exactly, ignores non-strings, and does not match a prefix", () => {
    const map = { abc: "developer", abcd: "qa" };
    assert.equal(roleForSecret(map, "abc"), "developer");
    assert.equal(roleForSecret(map, "abcd"), "qa");
    assert.equal(roleForSecret(map, "ab"), null);
    assert.equal(roleForSecret(map, ""), null);
    assert.equal(roleForSecret(map, undefined), null);
    assert.equal(roleForSecret({}, "abc"), null);
  });
});

describe("caps", () => {
  let echo, echoPort;
  const sockets = [];
  before(async () => { echo = net.createServer((s) => { s.on("data", (d) => s.write(d)); s.on("error", () => {}); }); echoPort = await listen(echo); });
  after(async () => { for (const s of sockets) s.destroy(); echo.closeAllConnections?.(); await new Promise((r) => echo.close(r)); });
  const start = (over) => startProxies({ roles: { developer: [GRANTED], qa: [GRANTED] }, basePort: 0, listenHost: "127.0.0.1", tokenSource: { get: async () => TOKEN }, dial: () => net.connect(echoPort, "127.0.0.1"), log: () => {}, ...over });
  const tunnel = async (...a) => { const r = await connectRaw(...a); sockets.push(r.socket); return r; };

  test("a role over its tunnel cap gets 503, another role is unaffected, and closing a tunnel frees a slot", async () => {
    const f = await start({ maxTunnelsPerRole: 1 });
    try {
      const first = await tunnel(f.ports.developer, `${GRANTED}:443`);
      assert.equal(first.status, 200);
      assert.equal((await tunnel(f.ports.developer, `${GRANTED}:443`)).status, 503);
      assert.equal((await tunnel(f.ports.qa, `${GRANTED}:443`)).status, 200);
      first.socket.destroy();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal((await tunnel(f.ports.developer, `${GRANTED}:443`)).status, 200);
    } finally { await f.close(); }
  });

  test("over the overall connection cap a request gets 503", async () => {
    const f = await start({ maxConnections: 1 });
    try {
      assert.equal((await tunnel(f.ports.developer, `${GRANTED}:443`)).status, 200);
      assert.equal((await front(f.ports.qa, undefined)).status, 503);
      assert.equal((await tunnel(f.ports.qa, `${GRANTED}:443`)).status, 503);
    } finally { await f.close(); }
  });
});

describe("secrets files and container args", () => {
  test("writeSecrets / fileSecretSource round-trip, mode 0600, read on every call", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "den-secrets-"));
    try {
      await writeSecrets({ dir, secrets: { a: "developer" } });
      const src = fileSecretSource({ file: path.join(dir, SECRETS_FILE_NAME) });
      assert.deepEqual(await src.get(), { a: "developer" });
      await writeSecrets({ dir, secrets: { b: "qa" } });
      assert.deepEqual(await src.get(), { b: "qa" });
      assert.equal((await import("node:fs")).statSync(path.join(dir, SECRETS_FILE_NAME)).mode & 0o777, 0o600);
      await assert.rejects(fileSecretSource({ file: path.join(dir, "missing") }).get());
    } finally { await rm(dir, { recursive: true, force: true }); }
    assert.notEqual(mintSecret(), mintSecret());
    assert.ok(mintSecret().length >= 40);
  });

  test("agentProxyEnv with a secret makes it the API key and the proxy password; the session stays the username", () => {
    const env = agentProxyEnv({ role: "qa", session: "sess 1", ports: { qa: 8081 }, secret: "s3cr/et" });
    assert.equal(env.ANTHROPIC_API_KEY, "s3cr/et");
    assert.equal(env.HTTPS_PROXY, `http://${encodeURIComponent("sess 1")}:${encodeURIComponent("s3cr/et")}@den-proxy:8081`);
  });

  const opts = { image: "node:22", tokenDir: "/t", proxyDir: "/p", secretsDir: "/s", roles: { developer: [GRANTED] } };
  const values = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

  test("proxyRunArgs mounts the secrets directory read-only, names it by path only, and caps memory, pids and open files", () => {
    const args = proxyRunArgs(opts);
    assert.ok(values(args, "-v").includes("/s:/run/den-secrets:ro"));
    assert.ok(values(args, "-e").includes("DEN_PROXY_SECRETS_FILE=/run/den-secrets/secrets.json"));
    assert.deepEqual(values(args, "--memory"), ["256m"]);
    assert.deepEqual(values(args, "--pids-limit"), ["256"]);
    assert.deepEqual(values(args, "--ulimit"), ["nofile=4096:4096"]);
    const without = proxyRunArgs({ ...opts, secretsDir: undefined, allowNoSecrets: true });
    assert.ok(!values(without, "-e").some((e) => e.startsWith("DEN_PROXY_SECRETS_FILE")));
    const key = (a) => values(a, "--label")[0];
    assert.notEqual(key(args), key(without), "adding the secrets mount replaces a running proxy");
  });
});

describe("den-proxy.mjs with a secrets file", () => {
  let tmp, child, out, ports, exited, api;
  before(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "den-proxy-secret-proc-"));
    api = http.createServer((req, res) => { req.resume(); res.writeHead(200).end("{}"); });
    const apiPort = await listen(api);
    await writeSecrets({ dir: tmp, secrets: { [S_DEV]: "developer" } });
    out = "";
    child = spawn(process.execPath, [new URL("./den-proxy.mjs", import.meta.url).pathname], {
      env: { PATH: process.env.PATH, DEN_PROXY_TOKEN_FILE: path.join(tmp, "nope"), DEN_PROXY_ROLES: JSON.stringify({ developer: [] }), DEN_PROXY_BASE_PORT: "0", DEN_PROXY_LISTEN_HOST: "127.0.0.1", DEN_PROXY_API_ORIGIN: `http://127.0.0.1:${apiPort}`, DEN_PROXY_SECRETS_FILE: path.join(tmp, SECRETS_FILE_NAME) },
      stdio: ["ignore", "pipe", "ignore"],
    });
    exited = new Promise((r) => child.on("exit", r));
    child.stdout.on("data", (d) => { out += d; });
    const end = Date.now() + 8000;
    while (!out.includes("listening") && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    ports = JSON.parse(out.split("\n")[0]).ports;
  });
  after(async () => {
    child.kill("SIGKILL");
    await exited;
    api.closeAllConnections?.();
    await new Promise((r) => api.close(r));
    await rm(tmp, { recursive: true, force: true });
  });

  test("the entrypoint enforces the secrets from the file", async () => {
    assert.equal((await front(ports.developer, "den-dummy-key")).status, 401);
    assert.equal((await front(ports.developer, S_DEV)).status, 503, "authorized, then no token file yet");
    assert.ok(!out.includes(S_DEV));
  });
});
