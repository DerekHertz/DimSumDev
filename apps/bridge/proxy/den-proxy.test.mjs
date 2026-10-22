// hardening/11: the proxy as a process, the way the container runs it (`node /den-proxy/den-proxy.mjs`). qa specify.
// Red until apps/bridge/proxy/den-proxy.mjs exists. Offline: a fake API on 127.0.0.1, a temp token directory, a fake credential store.
//
// The entrypoint contract, apps/bridge/proxy/den-proxy.mjs (config by env; none of it secret):
//   DEN_PROXY_TOKEN_FILE   path of the access-token file (required: exit non-zero and name the variable on stderr when missing)
//   DEN_PROXY_ROLES        JSON { role: [hosts] } (required)
//   DEN_PROXY_BASE_PORT    default 8080; 0 means ephemeral
//   DEN_PROXY_LISTEN_HOST  default 0.0.0.0
//   DEN_PROXY_API_ORIGIN   default https://api.anthropic.com
// stdout is JSON lines: first { "event": "listening", "ports": { role: port } }, then one line per log entry (a refusal is the same object startProxies logs).
// It starts when the token file does not exist yet (the bridge writes it a moment later); the API front answers 503 until it does.
// SIGTERM closes the listeners and exits 0.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTokenRefresher, TOKEN_FILE_NAME } from "./token.mjs";

const ENTRY = new URL("./den-proxy.mjs", import.meta.url).pathname;
const TOKEN = ["sk-ant", "oat01-SENTINEL-PROCESS-ONE"].join("-"); // built at runtime so the repo secret scan stays clean
const TOKEN_B = ["sk-ant", "oat01-SENTINEL-PROCESS-TWO"].join("-"); // built at runtime so the repo secret scan stays clean
const REFRESH = ["sk-ant", "ort01-SENTINEL-PROCESS-REFRESH"].join("-"); // built at runtime so the repo secret scan stays clean
const HOUR = 3_600_000;

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const request = (port, opts = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/messages", headers: { "x-api-key": "den-dummy-key" }, ...opts }, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
  });
  req.on("error", reject);
  req.end("{}");
});
const connect = (port, authority, session) => new Promise((resolve, reject) => {
  const s = net.connect(port, "127.0.0.1");
  s.on("error", reject);
  s.once("data", (d) => { s.destroy(); resolve(Number(d.toString().split(" ")[1])); });
  s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${Buffer.from(`${session}:`).toString("base64")}\r\n\r\n`);
});

describe("den-proxy.mjs as a process", () => {
  let tmp, tokenDir, upstream, upstreamPort, seen, child, out, err, ports, exited;
  const lines = () => out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { unparsed: l }; } });
  const until = async (pred, what) => {
    const end = Date.now() + 8000;
    while (Date.now() < end) { if (pred()) return; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error(`timed out waiting for ${what}; stdout: ${out}; stderr: ${err}`);
  };

  before(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "den-proxy-proc-"));
    tokenDir = path.join(tmp, "token");
    seen = [];
    upstream = http.createServer((req, res) => { seen.push(req.headers.authorization); req.resume(); res.writeHead(200).end("{}"); });
    upstreamPort = await listen(upstream);
    out = "";
    err = "";
    child = spawn(process.execPath, [ENTRY], {
      env: {
        PATH: process.env.PATH,
        DEN_PROXY_TOKEN_FILE: path.join(tokenDir, TOKEN_FILE_NAME), // the directory does not exist yet: the bridge has not written a token
        DEN_PROXY_ROLES: JSON.stringify({ developer: ["granted.test"], qa: [] }),
        DEN_PROXY_BASE_PORT: "0",
        DEN_PROXY_LISTEN_HOST: "127.0.0.1",
        DEN_PROXY_API_ORIGIN: `http://127.0.0.1:${upstreamPort}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    await until(() => lines().some((l) => l.event === "listening"), "the listening line");
    ports = lines().find((l) => l.event === "listening").ports;
  });
  after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    upstream.closeAllConnections?.();
    await new Promise((r) => upstream.close(r));
    await rm(tmp, { recursive: true, force: true });
  });

  test("announces one port per role on stdout", () => {
    assert.deepEqual(Object.keys(ports).sort(), ["developer", "qa"]);
    assert.ok(Object.values(ports).every((p) => Number.isInteger(p) && p > 0));
  });

  test("with no token yet the API front is 503 and forwards nothing; once the bridge writes one it answers 200 (start order does not matter)", async () => {
    assert.equal((await request(ports.developer)).status, 503);
    assert.deepEqual(seen, []);
    const clock = { t: 1_000_000 };
    const store = { load: async () => ({ accessToken: TOKEN, refreshToken: REFRESH, expiresAt: clock.t + 8 * HOUR }), save: async () => {} };
    await createTokenRefresher({ store, refresh: async () => { throw new Error("not due"); }, dir: tokenDir, now: () => clock.t }).tick();
    assert.equal((await request(ports.developer)).status, 200);
    assert.deepEqual(seen, [`Bearer ${TOKEN}`]);
  });

  test("a refresh by the bridge's refresher reaches the next request: same proxy process, no restart", async () => {
    const pid = child.pid;
    const clock = { t: 2_000_000 };
    let creds = { accessToken: TOKEN, refreshToken: REFRESH, expiresAt: clock.t + 60_000 }; // about to expire
    const store = { load: async () => ({ ...creds }), save: async (c) => { creds = { ...c }; } };
    const refresh = async () => ({ accessToken: TOKEN_B, refreshToken: `${REFRESH}-2`, expiresAt: clock.t + 8 * HOUR });
    const r = await createTokenRefresher({ store, refresh, dir: tokenDir, now: () => clock.t }).tick();
    assert.equal(r.refreshed, true);
    seen.length = 0;
    assert.equal((await request(ports.qa)).status, 200);
    assert.deepEqual(seen, [`Bearer ${TOKEN_B}`]);
    assert.equal(child.pid, pid);
    assert.equal(child.exitCode, null);
  });

  test("a refusal appears on stdout as a JSON line with role, session and host", async () => {
    assert.equal(await connect(ports.developer, "not-granted.test:443", "sess-proc-1"), 403);
    await until(() => lines().some((l) => l.kind === "refusal"), "a refusal line");
    const r = lines().find((l) => l.kind === "refusal");
    assert.equal(r.role, "developer");
    assert.equal(r.session, "sess-proc-1");
    assert.equal(r.host, "not-granted.test");
  });

  test("neither stdout nor stderr ever contains a token", () => {
    for (const s of [TOKEN, TOKEN_B, REFRESH]) {
      assert.ok(!out.includes(s) && !err.includes(s), `${s} leaked`);
    }
  });

  test("SIGTERM closes it and exits 0", async () => {
    child.kill("SIGTERM");
    const r = await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error("did not exit on SIGTERM")), 5000).unref())]);
    assert.equal(r.code, 0);
    await assert.rejects(connect(ports.developer, "granted.test:443", "x"), "the port is free again");
  });
});

describe("den-proxy.mjs configuration", () => {
  test("a missing DEN_PROXY_TOKEN_FILE exits non-zero and names the variable", async () => {
    const child = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH, DEN_PROXY_ROLES: "{}", DEN_PROXY_BASE_PORT: "0", DEN_PROXY_LISTEN_HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    const code = await new Promise((resolve) => child.on("exit", resolve));
    clearTimeout(timer);
    assert.notEqual(code, 0);
    assert.match(err, /DEN_PROXY_TOKEN_FILE/);
  });
});
