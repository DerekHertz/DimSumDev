// den-mvp outcome 4 (spec section 3, ADR 0025): the catalog of connections, and what a role may do with one.
// A connection is a Model Context Protocol server the den has listed in connections.json: its purpose, where it is,
// who holds its credential, which roles get it, and what each of its tools does (read, change or publish). Everything
// here is a pure function of the catalog. The bridge reads the catalog from its own checkout, never from a worktree.
//   parseCatalog      the file's value, checked field by field; anything unknown is an error, so nothing rides along
//   connectionsFor    the connections one role is started with, as the adapter takes them
//   decideTool        the answer to one tool call: not a connection's tool, refuse, allow (a read) or ask the user
//   toolsOfRoleFile   which connections a role file's `tools:` line lets through (the CLI hides the rest)
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROLES } from "../agents/policy.mjs";
import { isConnectionTarget, CONNECTION_NAME_RE } from "../agents/claude-adapter.mjs";

// den-mvp/38: "board" is a write to the den's own board that the role's ceiling already allows (Bao's desk): no ask.
export const CAPABILITIES = Object.freeze(["read", "board", "change", "publish"]);
// "none": the service needs no credential. "den": the bridge holds a token the user saved once in
// ~/.local/state/den/credentials/<name>.token (ADR 0025 Amendment 1); the catalog never holds the secret itself.
// "run" (den-mvp/38): a den script that calls the bridge back; the bridge mints a token for each run and puts it, with
// the bridge's address, in that run's 0600 MCP config. Only a script connection holds one.
export const CREDENTIAL_OWNERS = Object.freeze(["none", "den", "run"]);
const HEADER_NAME_RE = /^X-MCP-[A-Za-z]+(?:-[A-Za-z]+)*$/;
const HEADER_VALUE_RE = /^[A-Za-z0-9_,.-]{1,200}$/;
const HEADERS_MAX = 4;
const CONNECTIONS_MAX = 20;
const TOOLS_MAX = 40;
const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TEXT_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;
// A local connection's script runs outside the shell sandbox, as the user, so only one directory of the den can hold one.
const SCRIPT_RE = /^apps\/bridge\/library\/servers\/[A-Za-z0-9][A-Za-z0-9._-]*\.mjs$/;
const KEYS = ["name", "title", "purpose", "url", "script", "credential", "headers", "roles", "tools"];
/** The den's own checkout: where this file is, three levels up. A connection's script is resolved against it. */
export const DEN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const fail = (what) => {
  throw new Error(`connections.json: ${what}`);
};

/** The catalog, checked and frozen: `{ connections: [{ name, title, purpose, target, host, credential, roles, tools }] }`. */
export function parseCatalog(value, { denRoot = DEN_ROOT } = {}) {
  if (!isPlainObject(value) || Object.keys(value).length !== 1 || !Array.isArray(value.connections)) fail("it must be { connections: [...] }");
  if (value.connections.length > CONNECTIONS_MAX) fail(`at most ${CONNECTIONS_MAX} connections`);
  const names = new Set();
  const connections = value.connections.map((c, i) => {
    const at = `connection ${i + 1}`;
    if (!isPlainObject(c)) fail(`${at} must be an object`);
    for (const key of Object.keys(c)) if (!KEYS.includes(key)) fail(`${at} has an unknown field ${JSON.stringify(key)}`);
    if (typeof c.name !== "string" || !CONNECTION_NAME_RE.test(c.name)) fail(`${at} needs a name of lower-case letters, digits and hyphens`);
    if (names.has(c.name)) fail(`the name ${c.name} is used twice`);
    names.add(c.name);
    for (const key of ["title", "purpose"]) if (typeof c[key] !== "string" || !TEXT_RE.test(c[key])) fail(`${c.name}: ${key} must be one line of text`);
    if ((c.url === undefined) === (c.script === undefined)) fail(`${c.name}: give a url or a script, not both`);
    let target;
    if (c.headers !== undefined) {
      if (c.url === undefined || !isPlainObject(c.headers) || Object.keys(c.headers).length === 0 || Object.keys(c.headers).length > HEADERS_MAX) fail(`${c.name}: headers must be a few X-MCP-* headers of a remote connection`);
      for (const [k, v] of Object.entries(c.headers)) if (!HEADER_NAME_RE.test(k) || typeof v !== "string" || !HEADER_VALUE_RE.test(v)) fail(`${c.name}: header ${JSON.stringify(k)} is not a plain X-MCP-* header`);
    }
    if (c.credential === "den" && c.url === undefined) fail(`${c.name}: a credential needs a remote url`);
    if (c.credential === "run" && c.script === undefined) fail(`${c.name}: a run credential is for a den script`);
    if (c.url !== undefined) target = { name: c.name, url: c.url, ...(c.credential === "den" ? { credential: "den" } : {}), ...(c.headers !== undefined ? { headers: Object.freeze({ ...c.headers }) } : {}) };
    else {
      if (typeof c.script !== "string" || !SCRIPT_RE.test(c.script) || c.script.split("/").some((part) => part === "." || part === "..")) fail(`${c.name}: script must be a .mjs file in apps/bridge/library/servers/ in the den`);
      target = { name: c.name, script: path.join(denRoot, c.script), ...(c.credential === "run" ? { credential: "run" } : {}) };
    }
    if (!isConnectionTarget(target)) fail(`${c.name}: ${c.url !== undefined ? "url must be a plain https address of a public host, with no sign-in, query or fragment" : "the script's path is not a plain path"}`);
    if (!CREDENTIAL_OWNERS.includes(c.credential)) fail(`${c.name}: credential must be one of ${CREDENTIAL_OWNERS.join(", ")}`);
    if (!Array.isArray(c.roles) || c.roles.length === 0 || new Set(c.roles).size !== c.roles.length || !c.roles.every((r) => ROLES.includes(r))) fail(`${c.name}: roles must be a list of the den's roles, each once`);
    if (!isPlainObject(c.tools) || Object.keys(c.tools).length === 0 || Object.keys(c.tools).length > TOOLS_MAX) fail(`${c.name}: tools must name 1 to ${TOOLS_MAX} tools`);
    for (const [tool, capability] of Object.entries(c.tools)) {
      if (!TOOL_NAME_RE.test(tool) || tool.includes("__")) fail(`${c.name}: ${JSON.stringify(tool)} is not a tool name`);
      if (!CAPABILITIES.includes(capability)) fail(`${c.name}: the tool ${tool} must be one of ${CAPABILITIES.join(", ")}`);
    }
    return Object.freeze({
      name: c.name, title: c.title, purpose: c.purpose, target: Object.freeze(target),
      host: c.url !== undefined ? new URL(c.url).hostname : null,
      credential: c.credential, roles: Object.freeze([...c.roles]), tools: Object.freeze({ ...c.tools }),
    });
  });
  return Object.freeze({ connections: Object.freeze(connections) });
}

/** The den's own catalog. A bad file throws: the bridge does not start with a catalog it cannot read. */
export function loadCatalog() {
  return parseCatalog(JSON.parse(readFileSync(new URL("./connections.json", import.meta.url), "utf8")));
}

/** The connections `role` is started with, as buildClaudeArgs takes them. */
export function connectionsFor(catalog, role) {
  return catalog.connections.filter((c) => c.roles.includes(role)).map((c) => c.target);
}

const REFUSE_ROLE = "The den's catalog does not give this role that connection.";
const REFUSE_TOOL = "The den's catalog does not list that tool, so it is not used.";
/**
 * The answer to one tool call. null: not a connection's tool (the caller goes on as before). Otherwise
 * `{ kind: "refuse", reason }`, `{ kind: "allow" }` for a tool the catalog marks read, or `{ kind: "ask" }` for one
 * that changes or publishes. A tool the server offers and the catalog does not name is refused: being discovered
 * is not being allowed.
 */
export function decideTool(catalog, role, tool) {
  if (typeof tool !== "string" || !tool.startsWith("mcp__")) return null;
  const rest = tool.slice(5);
  const cut = rest.indexOf("__");
  const name = cut === -1 ? rest : rest.slice(0, cut);
  const connection = catalog.connections.find((c) => c.name === name);
  const base = { connection: connection ? name : null, tool: cut === -1 ? null : rest.slice(cut + 2) };
  if (!connection || !connection.roles.includes(role)) return { kind: "refuse", reason: REFUSE_ROLE, ...base, tool: null };
  if (base.tool === null || !Object.hasOwn(connection.tools, base.tool)) return { kind: "refuse", reason: REFUSE_TOOL, ...base, tool: null };
  const capability = connection.tools[base.tool];
  return { kind: capability === "read" || capability === "board" ? "allow" : "ask", capability, ...base };
}

/**
 * The connection names a role file lets through. A role file's `tools:` line is a whole list: the CLI hides every
 * connection tool it does not name, by tool (`mcp__name__tool`) or by connection (`mcp__name`). A file with no such
 * line hides nothing, which reads as null.
 */
export function toolsOfRoleFile(text) {
  if (typeof text !== "string") return new Set();
  const front = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, "\n"));
  const line = front ? /^tools:[ \t]*(.*)$/m.exec(front[1]) : null;
  if (!line) return null;
  const names = new Set();
  for (const entry of line[1].split(",")) {
    const m = /^mcp__([a-z][a-z0-9-]*)(?:__.*)?$/.exec(entry.trim());
    if (m) names.add(m[1]);
  }
  return names;
}
