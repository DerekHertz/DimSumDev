// hardening/11 (ADR 0031 decisions 4 and 5): the allowlist and credential proxy. One listening instance per role, so one allowlist per port.
// Imports only node: built-ins and siblings: this directory is mounted alone into the proxy container.
import http from "node:http";
import https from "node:https";
import net from "node:net";

const API_HOST = "api.anthropic.com";
const OAUTH_BETA = "oauth-2025-04-20";

export function roleHosts(ceilings) {
  const out = {};
  for (const [role, c] of Object.entries(ceilings ?? {})) if (c && Array.isArray(c.hosts)) out[role] = c.hosts;
  return out;
}

// Sorted roles take consecutive ports from basePort; basePort 0 means every role gets an ephemeral port.
export function portPlan(roles, basePort = 8080) {
  return Object.fromEntries(Object.keys(roles).sort().map((role, i) => [role, basePort === 0 ? 0 : basePort + i]));
}

const refuse = (sock, status = 403) => sock.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);

// "host:port", "[::1]:443" -> { host, port }, or null when there is no usable port.
function parseAuthority(authority) {
  const m = /^(?:\[([^\]]+)\]|([^:\[\]]+)):(\d{1,5})$/.exec(authority ?? "");
  return m ? { host: (m[1] ?? m[2]).toLowerCase(), port: Number(m[3]) } : null;
}

// The session comes from the agent's own Proxy-Authorization, so it is agent-claimed and can be forged; the role (from the port) is the trusted field.
function sessionOf(req) {
  const m = /^Basic\s+(\S+)/i.exec(req.headers["proxy-authorization"] ?? "");
  return m ? Buffer.from(m[1], "base64").toString("utf8").split(":")[0] || null : null;
}

export async function startProxies({ roles, basePort = 8080, listenHost = "0.0.0.0", tokenSource, apiOrigin = `https://${API_HOST}`, dial = (host, port) => net.connect(port, host), log = () => {}, dialTimeoutMs = 10_000, idleTimeoutMs = 600_000 }) {
  const upstream = new URL(apiOrigin);
  const upstreamLib = upstream.protocol === "https:" ? https : http;
  const plan = portPlan(roles, basePort);
  const sockets = new Set();
  const note = (entry) => { try { log({ at: new Date().toISOString(), ...entry }); } catch { /* a logger must not break the proxy */ } };

  function serverFor(role, granted) {
    const refusal = (req, host, port, method, reason) => note({ kind: "refusal", role, session: sessionOf(req), host, port, method, reason });
    const server = http.createServer(async (req, res) => {
      if (!req.url.startsWith("/")) { // absolute-form: CONNECT only
        let host = null;
        let port = null;
        try { const u = new URL(req.url); host = u.hostname.toLowerCase(); port = Number(u.port) || (u.protocol === "https:" ? 443 : 80); } catch { /* unparsable */ }
        refusal(req, host, port, req.method, "plain HTTP proxying is refused; CONNECT only");
        res.writeHead(403).end("blocked by den proxy\n");
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
      const up = upstreamLib.request({ hostname: upstream.hostname, port: upstream.port || undefined, path: req.url, method: req.method, headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on("error", (e) => {
        note({ kind: "upstream-error", role, code: e.code ?? null });
        if (!res.headersSent) res.writeHead(502).end("upstream unreachable\n");
        else res.destroy();
      });
      res.on("close", () => up.destroy());
      req.pipe(up);
    });

    server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
    server.on("connect", async (req, sock, head) => {
      sock.on("error", () => {});
      const target = parseAuthority(req.url);
      if (!target) { refusal(req, null, null, "CONNECT", "no host:port in the CONNECT target"); return refuse(sock, 400); }
      const { host, port } = target;
      if (port !== 443 || host === API_HOST || !granted.has(host)) {
        refusal(req, host, port, "CONNECT", port !== 443 ? "only port 443 is tunnelled" : host === API_HOST ? "the API is reachable only through the front" : "host is not granted to this role");
        return refuse(sock);
      }
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
