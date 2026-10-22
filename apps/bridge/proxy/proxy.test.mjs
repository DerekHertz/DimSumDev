// hardening/11 (ADR 0031 decisions 4 and 5): the allowlist and credential proxy. qa specify. Red until apps/bridge/proxy/proxy.mjs exists.
// Offline: a fake Anthropic API and an echo server on 127.0.0.1, no Docker, no real token.
//
// The seam, in apps/bridge/proxy/proxy.mjs:
//   roleHosts(ceilings)                 { developer: { hosts: [...] }, ... } -> { developer: [...], ... }   (the shape of apps/bridge/agents/ceilings.json)
//   portPlan(roles, basePort = 8080)    { role: port }: roles sorted by name get basePort, basePort+1, ...; basePort 0 means every role gets 0 (ephemeral). Pure.
//   startProxies({ roles, basePort, listenHost = "0.0.0.0", tokenSource, apiOrigin = "https://api.anthropic.com", dial, log })
//       roles:       { role: [granted hostnames] }: one listening instance per role, so one allowlist per port
//       tokenSource: { get(): string | Promise<string> }   called once per API request, never cached
//       apiOrigin:   where the API front forwards (tests point it at a fake over http)
//       dial(host, port) -> net.Socket (or a promise of one): how a granted CONNECT reaches its target. Called only for a granted host.
//       log(entry):  called with a plain object per event
//     -> Promise<{ ports: { role: actualPort }, close(): Promise<void> }>. close() also tears down open tunnels.
//
// Behaviour pinned here (decisions the developer follows):
//   - CONNECT is tunnelled only when the host (case-insensitive, an exact match: no suffix or wildcard) is on THIS role's list AND the port is 443. Else 403, dial never called.
//   - api.anthropic.com is never tunnelled (CONNECT 403 for every role): the API is reachable only through the plain-HTTP front.
//   - The plain-HTTP front is any origin-form request ("/v1/messages"). An absolute-form request ("GET http://host/") is refused 403: CONNECT only.
//   - The front drops the agent's x-api-key and authorization, sends `authorization: Bearer <token>`, and adds oauth-2025-04-20 to anthropic-beta (keeping the agent's values).
//   - Every refusal calls log({ kind: "refusal", at: <ISO time>, role, session, host, port, method, reason }). session comes from the Proxy-Authorization
//     Basic username (HTTPS_PROXY=http://<session>@den-proxy:<port>); with none it is null. Nothing logged or returned ever contains the token.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { startProxies, portPlan, roleHosts } from "./proxy.mjs";

const TOKEN = "sk-ant-oat01-SENTINEL-PROXY-TOKEN";
const TOKEN2 = "sk-ant-oat01-SENTINEL-PROXY-TOKEN-ROTATED";
const GRANTED = "granted.test";
const OTHER = "other.test";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const closeServer = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });

function fakeApi() {
  const requests = [];
  const state = { handler: null };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rec = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
      requests.push(rec);
      if (state.handler) return state.handler(rec, res);
      res.writeHead(200, { "content-type": "application/json", "x-fake-upstream": "yes" });
      res.end(JSON.stringify({ ok: true, echoed: rec.body }));
    });
  });
  return { server, requests, state };
}

function echoServer() {
  const server = net.createServer((s) => { s.on("data", (d) => s.write(d)); s.on("error", () => {}); });
  return server;
}

// A raw CONNECT through a proxy port: resolves { status, socket, head }.
function connectVia(port, authority, { session, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let buf = "";
    socket.on("error", reject);
    socket.on("data", function onData(d) {
      buf += d.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      resolve({ status: Number(buf.split(" ")[1]), socket, head: buf.slice(end + 4) });
    });
    socket.on("close", () => resolve({ status: 0, socket, head: buf }));
    const auth = session === undefined ? [] : [`Proxy-Authorization: Basic ${Buffer.from(`${session}:`).toString("base64")}`];
    const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
    socket.write([`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, ...auth, ...extra, "", ""].join("\r\n"));
  });
}

function httpVia(port, { method = "GET", path, headers = {}, body, onFirstChunk } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => { chunks.push(c); if (onFirstChunk && chunks.length === 1) onFirstChunk(c.toString()); });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("the proxy fleet", () => {
  let api, echo, echoPort, apiPort, fleet, ports, logs, dials, token, sockets;
  const refusals = () => logs.filter((l) => l.kind === "refusal");
  const tunnel = async (role, authority, opts) => { const r = await connectVia(ports[role], authority, opts); sockets.push(r.socket); return r; };

  before(async () => {
    api = fakeApi();
    echo = echoServer();
    [apiPort, echoPort] = await Promise.all([listen(api.server), listen(echo)]);
    logs = [];
    dials = [];
    sockets = [];
    token = TOKEN;
    fleet = await startProxies({
      roles: { developer: [GRANTED], qa: [], security: [OTHER] },
      basePort: 0,
      listenHost: "127.0.0.1",
      tokenSource: { get: async () => token },
      apiOrigin: `http://127.0.0.1:${apiPort}`,
      dial: (host, port) => { dials.push({ host, port }); return net.connect(echoPort, "127.0.0.1"); },
      log: (entry) => logs.push(entry),
    });
    ports = fleet.ports;
  });
  after(async () => {
    for (const s of sockets) s.destroy();
    await fleet?.close();
    await Promise.all([closeServer(api.server), closeServer(echo)]);
  });

  test("one instance per role, each on its own port", () => {
    assert.deepEqual(Object.keys(ports).sort(), ["developer", "qa", "security"]);
    assert.equal(new Set(Object.values(ports)).size, 3);
    assert.ok(Object.values(ports).every((p) => Number.isInteger(p) && p > 0));
  });

  describe("CONNECT allowlist (a role reaches only its granted hosts)", () => {
    test("a granted host is tunnelled: 200, then bytes flow to the dialled target", async () => {
      dials.length = 0;
      const r = await tunnel("developer", `${GRANTED}:443`, { session: "s-granted" });
      assert.equal(r.status, 200);
      const echoed = new Promise((resolve) => r.socket.once("data", (d) => resolve(d.toString())));
      r.socket.write("ping");
      assert.equal(await echoed, "ping");
      assert.deepEqual(dials, [{ host: GRANTED, port: 443 }]);
    });

    test("the list is per role: another role's host, and every host for a role with an empty list, is 403 with no dial", async () => {
      dials.length = 0;
      assert.equal((await tunnel("developer", `${OTHER}:443`)).status, 403);
      assert.equal((await tunnel("security", `${GRANTED}:443`)).status, 403);
      assert.equal((await tunnel("qa", `${GRANTED}:443`)).status, 403);
      assert.equal((await tunnel("qa", `${OTHER}:443`)).status, 403);
      assert.equal((await tunnel("security", `${OTHER}:443`)).status, 200, "the same host is open to the role that was granted it");
      assert.deepEqual(dials, [{ host: OTHER, port: 443 }]);
    });

    test("lookalike hosts are refused: no suffix, prefix, subdomain or wildcard matching", async () => {
      dials.length = 0;
      for (const host of [`x.${GRANTED}`, `${GRANTED}.evil.test`, `evil-${GRANTED}`, `${GRANTED}x`, "test", "127.0.0.1", "[::1]", `${GRANTED}.`]) {
        const r = await tunnel("developer", `${host}:443`);
        assert.equal(r.status, 403, `${host} must be refused`);
      }
      assert.deepEqual(dials, []);
    });

    test("host matching ignores case", async () => {
      dials.length = 0;
      assert.equal((await tunnel("developer", `${GRANTED.toUpperCase()}:443`)).status, 200);
      assert.deepEqual(dials.map((d) => d.host.toLowerCase()), [GRANTED]);
    });

    test("only port 443 is tunnelled: a granted host on another port is 403", async () => {
      dials.length = 0;
      for (const port of [22, 80, 8443, 25]) assert.equal((await tunnel("developer", `${GRANTED}:${port}`)).status, 403, `port ${port}`);
      assert.deepEqual(dials, []);
    });

    test("api.anthropic.com is never tunnelled, even for a role that lists it: the API is reachable only through the front", async () => {
      dials.length = 0;
      for (const role of ["developer", "qa", "security"]) assert.equal((await tunnel(role, "api.anthropic.com:443")).status, 403);
      const odd = await startProxies({ roles: { odd: ["api.anthropic.com"] }, basePort: 0, listenHost: "127.0.0.1", tokenSource: { get: async () => token }, dial: (h, p) => { dials.push({ host: h, port: p }); return net.connect(echoPort, "127.0.0.1"); }, log: () => {} });
      try {
        const r = await connectVia(odd.ports.odd, "api.anthropic.com:443");
        sockets.push(r.socket);
        assert.equal(r.status, 403);
      } finally { await odd.close(); }
      assert.deepEqual(dials, []);
    });

    test("an absolute-form HTTP request (a proxied GET to a granted host) is 403: CONNECT only, and nothing is forwarded", async () => {
      dials.length = 0;
      const before = api.requests.length;
      const res = await httpVia(ports.developer, { path: `http://${GRANTED}/`, headers: { host: GRANTED } });
      assert.equal(res.status, 403);
      assert.equal(api.requests.length, before);
      assert.deepEqual(dials, []);
    });

    test("a CONNECT with no port is refused (4xx) and dials nothing", async () => {
      dials.length = 0;
      const r = await tunnel("developer", GRANTED);
      assert.ok(r.status >= 400 && r.status < 500, `status ${r.status}`);
      assert.deepEqual(dials, []);
    });
  });

  describe("the Anthropic front (the login lives here, never in the agent)", () => {
    const send = (role = "developer", over = {}) => httpVia(ports[role], {
      method: "POST",
      path: "/v1/messages?beta=true",
      headers: { "x-api-key": "den-dummy-key", authorization: "Bearer agent-smuggled", "anthropic-beta": "claude-code-20250219", "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "m", messages: [] }),
      ...over,
    });

    test("swaps the dummy key for the OAuth bearer token plus the oauth beta header, and forwards path, method and body", async () => {
      const res = await send();
      assert.equal(res.status, 200);
      const up = api.requests.at(-1);
      assert.equal(up.method, "POST");
      assert.equal(up.url, "/v1/messages?beta=true");
      assert.equal(up.headers.authorization, `Bearer ${TOKEN}`, "only the proxy's token; the agent's own authorization is dropped");
      assert.equal(up.headers["x-api-key"], undefined);
      const betas = String(up.headers["anthropic-beta"]).split(",").map((s) => s.trim());
      assert.ok(betas.includes("oauth-2025-04-20") && betas.includes("claude-code-20250219"));
      assert.equal(up.headers["anthropic-version"], "2023-06-01");
      assert.deepEqual(JSON.parse(up.body), { model: "m", messages: [] });
      assert.equal(res.headers["x-fake-upstream"], "yes", "response headers pass back");
      assert.equal(JSON.parse(res.body).ok, true);
    });

    test("the front is open to every role, including one with no granted hosts", async () => {
      assert.equal((await send("qa")).status, 200);
      assert.equal((await send("security")).status, 200);
    });

    test("reads the token for every request: a rotation reaches the next request with no restart", async () => {
      token = TOKEN2;
      try {
        await send();
        assert.equal(api.requests.at(-1).headers.authorization, `Bearer ${TOKEN2}`);
      } finally { token = TOKEN; }
      await send();
      assert.equal(api.requests.at(-1).headers.authorization, `Bearer ${TOKEN}`);
    });

    test("streams the response: the first chunk reaches the agent before the upstream finishes", async () => {
      let releaseUpstream;
      const gate = new Promise((r) => { releaseUpstream = r; });
      api.state.handler = async (_rec, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: one\n\n");
        await gate;
        res.end("data: two\n\n");
      };
      try {
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("first chunk never arrived: the proxy buffers the response")), 4000).unref());
        const done = send("developer", { onFirstChunk: (c) => { assert.match(c, /data: one/); releaseUpstream(); } });
        const res = await Promise.race([done, timeout]);
        assert.equal(res.body, "data: one\n\ndata: two\n\n");
      } finally { api.state.handler = null; releaseUpstream(); }
    });

    test("with no token available the front answers 503 and forwards nothing", async () => {
      const failing = await startProxies({ roles: { developer: [] }, basePort: 0, listenHost: "127.0.0.1", tokenSource: { get: async () => { throw new Error(`no token (was ${TOKEN})`); } }, apiOrigin: `http://127.0.0.1:${apiPort}`, dial: () => { throw new Error("no dial"); }, log: (e) => logs.push(e) });
      try {
        const before = api.requests.length;
        const res = await httpVia(failing.ports.developer, { method: "POST", path: "/v1/messages", headers: { "x-api-key": "den-dummy-key" }, body: "{}" });
        assert.equal(res.status, 503);
        assert.equal(api.requests.length, before);
        assert.ok(!JSON.stringify(res).includes(TOKEN));
      } finally { await failing.close(); }
    });

    test("an unreachable upstream is a 502 whose body quotes no token", async () => {
      const dead = net.createServer();
      const deadPort = await listen(dead);
      await closeServer(dead);
      const broken = await startProxies({ roles: { developer: [] }, basePort: 0, listenHost: "127.0.0.1", tokenSource: { get: async () => TOKEN }, apiOrigin: `http://127.0.0.1:${deadPort}`, dial: () => { throw new Error("no dial"); }, log: (e) => logs.push(e) });
      try {
        const res = await httpVia(broken.ports.developer, { method: "POST", path: "/v1/messages", headers: { "x-api-key": "den-dummy-key" }, body: "{}" });
        assert.equal(res.status, 502);
        assert.ok(!JSON.stringify(res).includes(TOKEN));
      } finally { await broken.close(); }
    });
  });

  describe("refusal log (the den shows these)", () => {
    test("each refused CONNECT logs kind, role, session, host, port and method", async () => {
      logs.length = 0;
      await tunnel("developer", `${OTHER}:443`, { session: "sess-42" });
      await tunnel("qa", `${GRANTED}:443`, { session: "sess-43" });
      const rs = refusals();
      assert.equal(rs.length, 2);
      assert.deepEqual(rs.map((r) => [r.role, r.session, r.host, r.port, r.method]), [
        ["developer", "sess-42", OTHER, 443, "CONNECT"],
        ["qa", "sess-43", GRANTED, 443, "CONNECT"],
      ]);
      for (const r of rs) {
        assert.equal(r.kind, "refusal");
        assert.ok(!Number.isNaN(Date.parse(r.at)), "at is a time");
        assert.equal(typeof r.reason, "string");
        assert.ok(r.reason.length > 0);
      }
    });

    test("a refusal with no Proxy-Authorization has session null; a non-443 port logs the host and port asked for", async () => {
      logs.length = 0;
      await tunnel("developer", `${GRANTED}:22`);
      const [r] = refusals();
      assert.equal(r.session, null);
      assert.equal(r.host, GRANTED);
      assert.equal(r.port, 22);
    });

    test("a refused absolute-form request is logged with the host it asked for", async () => {
      logs.length = 0;
      await httpVia(ports.developer, { path: `http://${GRANTED}/x`, headers: { host: GRANTED } });
      const [r] = refusals();
      assert.equal(r.role, "developer");
      assert.equal(r.host, GRANTED);
    });

    test("allowed tunnels and API calls are not refusals", async () => {
      logs.length = 0;
      await tunnel("developer", `${GRANTED}:443`, { session: "ok" });
      await httpVia(ports.developer, { method: "POST", path: "/v1/messages", headers: { "x-api-key": "den-dummy-key" }, body: "{}" });
      assert.deepEqual(refusals(), []);
    });

    test("no log entry from any event contains the token", async () => {
      await httpVia(ports.developer, { method: "POST", path: "/v1/messages", headers: { "x-api-key": "den-dummy-key" }, body: "{}" });
      await tunnel("developer", `${OTHER}:443`, { session: "s" });
      assert.ok(logs.length > 0);
      assert.ok(!JSON.stringify(logs).includes(TOKEN) && !JSON.stringify(logs).includes(TOKEN2));
    });
  });

  test("close() resolves promptly even with a tunnel still open, and frees the ports", async () => {
    const f = await startProxies({ roles: { developer: [GRANTED] }, basePort: 0, listenHost: "127.0.0.1", tokenSource: { get: async () => TOKEN }, dial: () => net.connect(echoPort, "127.0.0.1"), log: () => {} });
    const r = await connectVia(f.ports.developer, `${GRANTED}:443`);
    assert.equal(r.status, 200);
    const t = Date.now();
    await f.close();
    assert.ok(Date.now() - t < 3000);
    await assert.rejects(connectVia(f.ports.developer, `${GRANTED}:443`), "nothing listens after close");
    r.socket.destroy();
  });
});

describe("roleHosts and portPlan", () => {
  test("roleHosts reads the per-role lists from the ceilings shape", () => {
    assert.deepEqual(roleHosts({ developer: { write: "worktree", hosts: ["a.test"] }, scout: { write: "none", hosts: [] } }), { developer: ["a.test"], scout: [] });
  });

  test("roleHosts covers every role in the real apps/bridge/agents/ceilings.json", async () => {
    const { readFileSync } = await import("node:fs");
    const ceilings = JSON.parse(readFileSync(new URL("../agents/ceilings.json", import.meta.url), "utf8"));
    const plan = roleHosts(ceilings);
    for (const [role, c] of Object.entries(ceilings)) {
      if (c && typeof c === "object" && Array.isArray(c.hosts)) assert.deepEqual(plan[role], c.hosts, role);
    }
    assert.ok("developer" in plan && "qa" in plan);
  });

  test("portPlan is deterministic: roles sorted by name take consecutive ports from the base, whatever the key order", () => {
    assert.deepEqual(portPlan({ qa: [], developer: [], security: [] }, 8080), { developer: 8080, qa: 8081, security: 8082 });
    assert.deepEqual(portPlan({ security: [], developer: [], qa: [] }, 8080), { developer: 8080, qa: 8081, security: 8082 });
    assert.deepEqual(portPlan({ a: [] }), { a: 8080 }, "the default base is 8080");
    assert.deepEqual(portPlan({ a: [], b: [] }, 0), { a: 0, b: 0 }, "base 0 means ephemeral for every role");
  });
});
