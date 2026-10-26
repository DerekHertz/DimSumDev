// hardening/11 (ADR 0031 decisions 4 and 5): the allowlist and credential proxy. One listening instance per role, so one allowlist per port.
// Imports only node: built-ins and siblings: this directory is mounted alone into the proxy container.
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const API_HOST = "api.anthropic.com";
const OAUTH_BETA = "oauth-2025-04-20";

// multi-project/02 (design decision 27): the identity of a run in a target project. Its allowlist is empty, so the API front is all it reaches.
export const TARGET_ROLE = "target";

export function roleHosts(ceilings) {
  const out = {};
  for (const [role, c] of Object.entries(ceilings ?? {})) if (c && Array.isArray(c.hosts)) out[role] = c.hosts;
  return out;
}

// Sorted roles take consecutive ports from basePort; basePort 0 means every role gets an ephemeral port.
export function portPlan(roles, basePort = 8080) {
  return Object.fromEntries(Object.keys(roles).sort().map((role, i) => [role, basePort === 0 ? 0 : basePort + i]));
}

const refuse = (sock, status = 403, extra = "") => sock.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);

// "host:port", "[::1]:443" -> { host, port }, or null when there is no usable port.
function parseAuthority(authority) {
  const m = /^(?:\[([^\]]+)\]|([^:\[\]]+)):(\d{1,5})$/.exec(authority ?? "");
  return m ? { host: (m[1] ?? m[2]).toLowerCase(), port: Number(m[3]) } : null;
}

// Proxy-Authorization Basic <session>:<secret>. The session is agent-claimed and can be forged; the role (proved by the secret) is the trusted field.
function credentialsOf(req) {
  const m = /^Basic\s+(\S+)/i.exec(req.headers["proxy-authorization"] ?? "");
  if (!m) return { session: null, secret: null };
  const text = Buffer.from(m[1], "base64").toString("utf8");
  const i = text.indexOf(":");
  const session = (i < 0 ? text : text.slice(0, i)) || null;
  return { session, secret: i < 0 ? null : text.slice(i + 1) || null };
}

const digest = (s) => createHash("sha256").update(String(s)).digest();

// The role a presented secret belongs to, or null. Every entry is compared (no early exit) in constant time over fixed-size digests.
export function roleForSecret(secrets, presented) {
  if (typeof presented !== "string" || !presented) return null;
  const want = digest(presented);
  let role = null;
  for (const [secret, r] of Object.entries(secrets ?? {})) if (timingSafeEqual(digest(secret), want)) role = r;
  return role;
}

// secretSource: { get(): { [secret]: role } } read on every request (so a new agent run's secret needs no restart). Absent: no secret is required.
export async function startProxies({
  roles, basePort = 8080, listenHost = "0.0.0.0", tokenSource, secretSource, apiOrigin = `https://${API_HOST}`,
  dial = (host, port) => net.connect(port, host), log = () => {},
  dialTimeoutMs = 10_000, idleTimeoutMs = 600_000, maxConnections = 256, maxTunnelsPerRole = 64,
}) {
  const upstream = new URL(apiOrigin);
  const upstreamLib = upstream.protocol === "https:" ? https : http;
  const plan = portPlan(roles, basePort);
  const sockets = new Set();
  const clients = new Set();
  const note = (entry) => { try { log({ at: new Date().toISOString(), ...entry }); } catch { /* a logger must not break the proxy */ } };

  // True when this request proves it belongs to `role`.
  async function proves(role, presented) {
    if (!secretSource) return true;
    let secrets = {};
    try { secrets = await secretSource.get(); } catch { /* unreadable secrets deny everything */ }
    return roleForSecret(secrets, presented) === role;
  }

  function serverFor(role, granted) {
    let tunnels = 0;
    const refusal = (host, port, method, reason, session = null) => note({ kind: "refusal", role, session, host, port, method, reason });
    const server = http.createServer(async (req, res) => {
      if (clients.size > maxConnections) {
        refusal(null, null, req.method, "too many connections", credentialsOf(req).session);
        res.writeHead(503).end("busy\n");
        req.resume();
        return;
      }
      if (!req.url.startsWith("/")) { // absolute-form: CONNECT only
        let host = null;
        let port = null;
        try { const u = new URL(req.url); host = u.hostname.toLowerCase(); port = Number(u.port) || (u.protocol === "https:" ? 443 : 80); } catch { /* unparsable */ }
        refusal(host, port, req.method, "plain HTTP proxying is refused; CONNECT only", credentialsOf(req).session);
        res.writeHead(403).end("blocked by den proxy\n");
        req.resume();
        return;
      }
      if (!(await proves(role, req.headers["x-api-key"]))) { // the agent's ANTHROPIC_API_KEY is its role secret
        refusal(API_HOST, 443, req.method, "missing or wrong role secret");
        res.writeHead(401).end("unauthorized\n");
        req.resume();
        return;
      }
      let token;
      try { token = await tokenSource.get(); } catch {
        note({ kind: "token-unavailable", role }); // the cause is not logged: it could quote the token
        res.writeHead(503).end("no API login available\n");
        req.resume();
        return;
      }
      const headers = { ...req.headers, host: upstream.host, authorization: `Bearer ${token}` };
      for (const h of ["x-api-key", "proxy-authorization", "connection"]) delete headers[h];
      headers["anthropic-beta"] = [headers["anthropic-beta"], OAUTH_BETA].filter(Boolean).join(",");
      const failUpstream = (code) => {
        note({ kind: "upstream-error", role, code: code ?? null });
        if (!res.headersSent) res.writeHead(502).end("upstream unreachable\n");
        else res.destroy();
      };
      let up;
      try { // a bad character in the token file makes request() throw; that must not crash the proxy
        up = upstreamLib.request({ hostname: upstream.hostname, port: upstream.port || undefined, path: req.url, method: req.method, headers }, (r) => {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        });
      } catch (e) {
        failUpstream(e.code);
        req.resume();
        return;
      }
      up.on("error", (e) => failUpstream(e.code));
      res.on("close", () => up.destroy());
      req.pipe(up);
    });

    server.on("connection", (s) => { sockets.add(s); clients.add(s); s.on("close", () => { sockets.delete(s); clients.delete(s); }); });
    server.on("connect", async (req, sock, head) => {
      sock.on("error", () => {});
      const { session, secret } = credentialsOf(req);
      const target = parseAuthority(req.url);
      const host = target?.host ?? null;
      const port = target?.port ?? null;
      if (clients.size > maxConnections) { refusal(host, port, "CONNECT", "too many connections", session); return refuse(sock, 503); }
      if (!(await proves(role, secret))) {
        refusal(host, port, "CONNECT", "missing or wrong role secret", session);
        return refuse(sock, 407, 'Proxy-Authenticate: Basic realm="den"\r\n');
      }
      if (!target) { refusal(null, null, "CONNECT", "no host:port in the CONNECT target", session); return refuse(sock, 400); }
      if (port !== 443 || host === API_HOST || !granted.has(host)) {
        refusal(host, port, "CONNECT", port !== 443 ? "only port 443 is tunnelled" : host === API_HOST ? "the API is reachable only through the front" : "host is not granted to this role", session);
        return refuse(sock);
      }
      if (tunnels >= maxTunnelsPerRole) { refusal(host, port, "CONNECT", "too many tunnels for this role", session); return refuse(sock, 503); }
      tunnels += 1;
      let released = false;
      const release = () => { if (!released) { released = true; tunnels -= 1; } };
      sock.on("close", release);
      let dialed;
      let timedOut = false;
      let timer;
      try {
        const up = await Promise.race([
          (async () => {
            const u = await dial(host, port);
            dialed = u;
            if (timedOut) u.destroy(); // shortcut: a dial promise that never settles leaks; upgrade if a dial can hang that way
            if (u.connecting) await new Promise((ok, fail) => { u.once("connect", ok); u.once("error", fail); });
            return u;
          })(),
          new Promise((_, fail) => { timer = setTimeout(() => { timedOut = true; fail(new Error("dial timeout")); }, dialTimeoutMs); }),
        ]);
        clearTimeout(timer);
        for (const s of [sock, up]) s.setTimeout?.(idleTimeoutMs, () => { sock.destroy(); up.destroy(); });
        sockets.add(up);
        up.on("close", () => sockets.delete(up));
        up.on("error", () => sock.destroy());
        sock.on("close", () => up.destroy());
        sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) up.write(head);
        up.pipe(sock);
        sock.pipe(up);
      } catch {
        clearTimeout(timer);
        dialed?.destroy();
        release();
        refuse(sock, timedOut ? 504 : 502);
      }
    });
    return server;
  }

  const servers = Object.entries(roles).map(([role, hosts]) => [role, serverFor(role, new Set(hosts.map((h) => h.toLowerCase())))]);
  const ports = {};
  await Promise.all(servers.map(([role, server]) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(plan[role], listenHost, () => { ports[role] = server.address().port; resolve(); });
  })));

  return {
    ports,
    async close() {
      for (const s of sockets) s.destroy();
      await Promise.all(servers.map(([, server]) => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); })));
    },
  };
}
