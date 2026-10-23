// hardening/05 spike: the only way out of the agent's internal network. Two jobs:
// 1. CONNECT tunnels, to the hosts in ALLOW only (a granted host such as example.com);
// 2. a plain-HTTP front for the Anthropic API that swaps the agent's dummy key for the real OAuth token, so the
//    token lives in this container and never in the agent's.
import http from "node:http";
import https from "node:https";
import net from "node:net";

const ALLOW = new Set((process.env.ALLOW ?? "").split(",").filter(Boolean));
const TOKEN = process.env.OAUTH_TOKEN;
const log = (...a) => console.log(new Date().toISOString(), ...a);

const server = http.createServer((req, res) => {
  if (!req.url.startsWith("/")) { log("DENY plain", req.url); res.writeHead(403).end("blocked by den proxy\n"); return; }
  const headers = { ...req.headers, host: "api.anthropic.com" };
  delete headers["x-api-key"];
  headers.authorization = `Bearer ${TOKEN}`;
  headers["anthropic-beta"] = [headers["anthropic-beta"], "oauth-2025-04-20"].filter(Boolean).join(",");
  log("API", req.method, req.url);
  const up = https.request({ host: "api.anthropic.com", path: req.url, method: req.method, headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on("error", (e) => { res.writeHead(502).end(String(e)); });
  req.pipe(up);
});
server.on("connect", (req, sock, head) => {
  const [host, port] = req.url.split(":");
  if (!ALLOW.has(host)) { log("DENY connect", req.url); sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
  log("ALLOW connect", req.url);
  const up = net.connect(Number(port) || 443, host, () => { sock.write("HTTP/1.1 200 OK\r\n\r\n"); up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on("error", () => sock.destroy());
  sock.on("error", () => up.destroy());
});
server.listen(8080, () => log("proxy up; allow:", [...ALLOW].join(",")));
