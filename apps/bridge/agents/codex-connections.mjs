// Native MCP configuration remains empty. These dynamic tools call approved
// connections from the trusted bridge process after the host's ordinary decision.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createLibrary } from "../library/library.mjs";
import { DEN_TOOLS } from "../library/servers/den.mjs";
import { hasSecret } from "../../../scripts/exposure.mjs";

const OBJECT = value => value !== null && typeof value === "object" && !Array.isArray(value);
const MAX_BYTES = 256000;
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
function credential(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.nlink !== 1 || realpathSync(file) !== file || info.size > 1024 || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) throw new Error("unsafe protected connection credential");
  const token = readFileSync(file, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{20,255}$/.test(token)) throw new Error("invalid protected connection credential");
  return token;
}
async function body(response) {
  if (!response.body) throw new Error("empty connection response");
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; if ((bytes += value.length) > MAX_BYTES) throw new Error("connection response exceeds bound"); chunks.push(value); }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); }
}

async function httpClient(target, token, fetcher) {
  let sequence = 0, session = null, closed = false;
  const headers = () => ({ "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2024-11-05", ...target.headers,
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(session ? { "Mcp-Session-Id": session } : {}) });
  async function rpc(method, params, signal, notification = false) {
    if (closed) throw new Error("protected connection is closed");
    signal?.throwIfAborted();
    const id = notification ? undefined : `codex-bridge-${++sequence}`;
    const payload = JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, params });
    if (Buffer.byteLength(payload) > MAX_BYTES) throw new Error("connection input exceeds bound");
    const response = await fetcher(target.url, { method: "POST", headers: headers(), body: payload, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("protected connection refused the call"); }
    const nextSession = response.headers.get("Mcp-Session-Id");
    if (nextSession) { if (!/^[A-Za-z0-9_.:-]{1,255}$/.test(nextSession) || session && session !== nextSession) throw new Error("connection session identity changed"); session = nextSession; }
    if (notification) { await response.body?.cancel(); return; }
    const raw = await body(response);
    const messages = response.headers.get("content-type")?.includes("text/event-stream")
      ? raw.split(/\r?\n\r?\n/).flatMap(event => { const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n"); return data ? [JSON.parse(data)] : []; }) : [JSON.parse(raw)];
    const replies = messages.filter(message => message?.id === id);
    if (replies.length !== 1 || messages.some(message => message?.method && message?.id !== undefined) || !OBJECT(replies[0].result) || replies[0].error) throw new Error("invalid protected connection response");
    return replies[0].result;
  }
  try {
    const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "dim-sum-codex-bridge", version: "1" } });
    if (initialized.protocolVersion !== "2024-11-05") throw new Error("unsupported protected connection protocol");
    await rpc("notifications/initialized", {}, undefined, true);
  } catch (error) { closed = true; throw error; }
  return {
    rpc,
    async close() { if (closed) return; closed = true; if (session) { try { const response = await fetcher(target.url, { method: "DELETE", headers: headers(), redirect: "error", signal: AbortSignal.timeout(3000) }); await response.body?.cancel(); } catch {} } },
  };
}

/** All options are supplied by the trusted runtime/host, never native RPC. */
export async function prepareCodexTools({ role, connections = [], runCredential, controlRoot, library = createLibrary({ denRoot: controlRoot }),
  credentialRoot = `${process.env.HOME}/.local/state/den/credentials`, fetcher = fetch } = {}) {
  const approved = await library.connectionsFor(role);
  if (!Array.isArray(connections) || connections.length > 20 || new Set(connections.map(c => c?.name)).size !== connections.length || connections.some(target => !approved.some(candidate => isDeepStrictEqual(candidate, target)))) throw new Error("connection differs from the approved catalog and role");
  const tools = [], routes = new Map(), clients = [];
  try {
    for (const target of connections) {
      const catalog = library.catalog.connections.find(connection => connection.name === target.name);
      let discovered, call;
      if (target.script) {
        // No arbitrary catalog program is spawned by this adapter. The existing
        // den connection has a protected direct route with the same schemas.
        if (target.name !== "den" || target.credential !== "run" || target.script !== path.join(controlRoot, "apps/bridge/library/servers/den.mjs") || !LOOPBACK.test(runCredential?.url ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(runCredential?.token ?? "")) throw new Error("unsupported protected run connection");
        discovered = DEN_TOOLS;
        call = async (name, args, signal) => {
          const response = await fetcher(`${runCredential.url}/den-tools/${name}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: runCredential.url, Authorization: `Bearer ${runCredential.token}` }, body: JSON.stringify(args), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
          const result = JSON.parse(await body(response));
          return { content: [{ type: "text", text: String(result.text ?? (response.ok ? "done" : "Run connection refused.")) }], isError: !response.ok };
        };
      } else {
        const token = target.credential === "den" ? credential(`${credentialRoot}/${target.name}.token`) : null;
        const client = await httpClient(target, token, fetcher); clients.push(client);
        const result = await client.rpc("tools/list", {});
        if (!Array.isArray(result.tools) || result.tools.length > 100 || result.nextCursor != null) throw new Error("unsupported protected tool inventory");
        discovered = result.tools;
        call = (name, args, signal) => client.rpc("tools/call", { name, arguments: args }, signal);
      }
      const seen = new Set();
      for (const tool of discovered) {
        if (typeof tool?.name !== "string" || seen.has(tool.name)) throw new Error("invalid protected tool inventory");
        seen.add(tool.name);
        if (!Object.hasOwn(catalog.tools, tool.name)) continue;
        if (!OBJECT(tool.inputSchema) || typeof tool.description !== "string" || tool.description.length > 8192) throw new Error("unsupported protected tool schema");
        const name = `mcp__${target.name}__${tool.name}`;
        tools.push({ type: "function", name, description: tool.description, inputSchema: tool.inputSchema });
        routes.set(name, { tool: tool.name, call });
      }
    }
  } catch (error) { await Promise.all(clients.map(client => client.close())); throw error; }
  return {
    tools,
    async call(name, args, { signal } = {}) {
      signal?.throwIfAborted();
      const route = routes.get(name);
      if (!route) throw new Error("tool is not approved for this run");
      if (!OBJECT(args) || hasSecret(JSON.stringify(args)) || library.decide(role, name, args)?.kind === "refuse") throw new Error("protected connection input refused");
      // Host authorization has already applied ordinary ask/read/input budgets.
      // Rechecking here prevents an explicit Allow from lifting a hard refusal.
      return route.call(route.tool, args, signal ?? AbortSignal.timeout(30000));
    },
    async close() { await Promise.all(clients.map(client => client.close())); },
  };
}
