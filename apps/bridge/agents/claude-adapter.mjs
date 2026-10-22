// organism-infra/142 (ADR 0016 decisions 2, 6.5, 6.6, 6.8; amendment 5): the pure half of the Claude adapter.
// Everything here is a pure function of its arguments: no spawn, no fs, no clock. The impure half (143) spawns the child and wires these in.
//   buildClaudeArgs   a fixed argv template; the only variable parts are a UUID, a role and an optional model from a fixed list
//   buildClaudeEnv    the child's environment as an allowlist, never a copy
//   createLineSplitter / parseClaudeLine   stdout bytes to lines to CellEvents; agent output is untrusted text
//                     (den-v1 loop S2: also the transcript events text, tool-result and reply;
//                      S4: the model, tokens by tier, and the result line's own cost, duration and turns)
//   decodeControlRequest / encodeControlResponse   the can_use_tool permission channel, bare decisions only
//   encodeUserMessage a user message as one stdin line: the prompt, or (den-v1 loop S5) a message to a running child,
//                     whose id comes back on the child's replay of it and reads as message-applied
import { execFileSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { cleanText, safeToolInput } from "../../shared/safe-text.mjs";
import { COST_MAX_USD, MODEL_RE, REQUEST_ID_MAX, REQUEST_IDS_PER_AGENT, ROLES, UUID_RE } from "./policy.mjs";

import { compileEffectiveRolePolicy, isWallHost, isWorktreePath, isGrantPath, CREDENTIAL_PATHS, isWall, isDense, isForbid, baseOf, GRANTS_MAX, DENY_ABS_RE, DENY_ABS_MAX, isScopeWrites } from './effective-role-policy.mjs';
export { isWallHost, isWorktreePath, isGrantPath, parseGrants, CREDENTIAL_PATHS, GOVERNED_BASES, wallTables, ceilingOf, MAIN_GIT_DENIED, grantTouchesCredential, grantContainsWorktrees } from './effective-role-policy.mjs';

export const MAX_LINE_BYTES = 1_000_000; // ADR 0016 6.8: a stdout line over about 1 MB is dropped
export const CLAUDE_MODELS = Object.freeze(["opus", "sonnet", "haiku"]); // the CLI's own aliases; nothing else reaches --model

const SUMMARY_MAX = 200;
const INVOCATION_ID_MAX = 200;
export const BODY_MAX = 16_000; // characters of one text block, tool result or reply handed on; the host clips for display
const DENY_REASON_DEFAULT = "Denied by the owner.";
const DENY_REASON_MAX = 500; // APPROVAL_NOTE_MAX; the message is a short note, not a channel

// The bridge's own inline --settings value (ADR 0016 6.10, a partial measure): agents cannot write to .claude/, and
// (den-v1 loop decision 2) cannot push or open a PR, which the project settings would otherwise auto-allow. A deny
// rule wins over an allow. It matches the command as the CLI reads it, so it is a guard against the plain case and
// not a boundary: the user still does every push and merge.
const DENY_RULES = ["Write(.claude/**)", "Edit(.claude/**)", "Bash(git push:*)", "Bash(gh pr create:*)"];

// The one allow the inline settings may carry (den-v1 loop, the live den run of 2026-10-10): Read on the agent's own
// ticket file. The board is in the main checkout, outside the agent's worktree, so without it the CLI asks the user
// before the agent can read its task. A rule is a pattern, so the path must be nothing but plain segments: absolute,
// ending .scratch/<feature>/issues/<name>.md, with no character a rule could read as a glob, a separator or an end.
const TICKET_FILE_RE = /^(?:\/[A-Za-z0-9._@+-]+)*\/\.scratch\/[A-Za-z0-9._-]+\/issues\/[A-Za-z0-9._-]+\.md$/;
export function isTicketFilePath(file) {
  return typeof file === "string" && TICKET_FILE_RE.test(file) && !file.split("/").some((part) => part === "." || part === "..");
}
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// The wall (agent-os/01 spike, ADR 0021 decision 2): the CLI's own sandbox around the agent's shell commands. Strict:
// the CLI refuses to start if the sandbox cannot run, a blocked command cannot be retried outside it, and a host that
// is not listed is refused, not asked about. A sandboxed command then runs with no permission request. Hosts are plain
// lower-case dotted names: no wildcard, port, scheme or path. The runtime passes it for a role with a ceiling (agent-os/04).
//
// agent-os/02 (security review of agent-os/01): names only. The last label must be letters (or an xn-- label), so every IP
// literal in any dotted-number form fails, and the labels that mean a private or local network are refused by name.
const sandboxFor = (wall, worktree, forbid, writePaths, readLimit, readOpen, ticketFile, denyAbs, credentials, scopeWrites, readRoot, privatePaths) => {
  // Shell writes: the sandbox's own deny list, in the absolute form when the worktree is known, plus the governed paths of the
  // main checkout that a path grant reaches.
  const denyWrite = [...new Set([...(forbid?.write ?? []).map((p) => (worktree === undefined ? baseOf(p) : `${worktree}/${baseOf(p)}`)), ...(denyAbs ?? []).map(baseOf)])];
  const allowedWrites = [...(writePaths ?? []), ...(scopeWrites ?? []).map((scope) => scope.path)];
  const filesystem = { ...(denyWrite.length === 0 ? {} : { denyWrite }), ...(allowedWrites.length ? { allowWrite: allowedWrites } : {}),
    // The read limit for a shell command (live check, agent-os/02): the home directory is closed, the worktree, the ticket and granted paths re-opened,
    // and (the kernel review) the project and toolchain compileCeiling names.
    ...(readLimit === true ? { denyRead: ["~/", ...(privatePaths ?? [])], allowRead: [...(worktree === undefined ? [] : [worktree]), ...(readRoot === undefined ? [] : [readRoot]), ...(ticketFile === undefined ? [] : [`/${ticketFile}`.slice(1)]), ...(writePaths ?? []), ...(readOpen ?? [])] } : credentials?.length || privatePaths?.length ? { denyRead: [...(credentials ?? []), ...(privatePaths ?? [])] } : {}) };
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    network: { allowedDomains: [...wall.hosts], strictAllowlist: true },
    ...(Object.keys(filesystem).length === 0 ? {} : { filesystem }),
  };
};
// A file tool's rule for a path: `//abs` for an absolute one (the adapter's form), `~/x` for a home one.
const ruleForm = (p) => (p.startsWith("/") ? `/${p}` : p);
const settingsFor = ({ ticketFile, wall, worktree, forbid, writePaths, readLimit, readOpen, denyAbs, credentials, scopeWrites, readRoot, privatePaths }) => {
  const allow = [
    // den-mvp/27: behind the wall every shell command is sandboxed and an unsandboxed one is refused, yet the CLI still asked
    // for some (a heredoc written after a cd, a write to $TMPDIR) despite autoAllowBashIfSandboxed. The request protected
    // nothing, so Bash is allowed; the deny rules below still win, and the sandbox still refuses writes outside the worktree.
    ...(wall === undefined ? [] : ["Bash"]),
    // A host the ceiling or a grant names may be fetched without a question; any other fetch is one (or is refused, see webRefusal).
    ...(wall?.hosts ?? []).map((h) => `WebFetch(domain:${h})`),
    ...(ticketFile === undefined ? [] : [`Read(/${ticketFile})`]),
    ...(worktree === undefined ? [] : [`Write(/${worktree}/**)`, `Edit(/${worktree}/**)`]),
    ...(writePaths ?? []).flatMap((p) => [`Write(${ruleForm(p)}/**)`, `Edit(${ruleForm(p)}/**)`]),
    ...(scopeWrites ?? []).flatMap(({ path: file, directory }) => [`Write(${ruleForm(file)}${directory ? "/**" : ""})`, `Edit(${ruleForm(file)}${directory ? "/**" : ""})`]),
    ...(readRoot === undefined ? [] : [`Read(${ruleForm(readRoot)}/**)`]),
  ];
  const denyPaths = (forbid?.write ?? []).flatMap((p) => [p, ...(worktree === undefined ? [] : [`/${worktree}/${p}`])]);
  const deny = [
    ...DENY_RULES,
    ...denyPaths.flatMap((p) => [`Write(${p})`, `Edit(${p})`]),
    ...(denyAbs ?? []).flatMap((p) => [`Write(${ruleForm(p)})`, `Edit(${ruleForm(p)})`]),
    ...(credentials ?? []).flatMap((p) => [`Read(${p})`, `Read(${p}/**)`, `Edit(${p})`, `Edit(${p}/**)`]),
    ...(privatePaths ?? []).flatMap((p) => [`Read(${ruleForm(p)})`, `Read(${ruleForm(p)}/**)`, `Write(${ruleForm(p)}/**)`, `Edit(${ruleForm(p)}/**)`]),
    // An infix rule, so a command wrapped in a newline, $(...), backticks or <(...) is still caught. Words are joined by "*",
    // so `git -C dir push` and a doubled space match too.
    ...(forbid?.run ?? []).map((words) => `Bash(*${words.split(" ").join(" *")}*)`),
  ];
  return JSON.stringify({
    // den-mvp/03 (live probe, 2026-10-13): the CLI runs the hooks and the status line of the worktree's own settings,
    // outside the sandbox, from scripts in that worktree, which the agent can write. A bridge agent runs none of them.
    disableAllHooks: true,
    permissions: { deny: [...new Set(deny)], ...(allow.length === 0 ? {} : { allow }), ...(readLimit === true ? { blockReadsOutsideWorkingDirectories: true, ...(ticketFile === undefined ? {} : { additionalDirectories: [ticketFile.slice(0, ticketFile.lastIndexOf("/"))] }) } : {}) },
    ...(wall === undefined ? {} : { sandbox: sandboxFor(wall, worktree, forbid, writePaths, readLimit, readOpen, ticketFile, denyAbs, credentials, scopeWrites, readRoot, privatePaths) }),
  });
};

// A worktree the write rules may name (agent-os/04): absolute, plain segments only, no "." or ".." and not the root, so the
// rule Write(/<worktree>/**) cannot read as a glob, a separator or a wider path.
/** Translate shared clauses into the existing Claude argv contract, preserving order and omissions. */
export function compileCeiling(role, options = {}) {
  const policy = compileEffectiveRolePolicy(role, options);
  if (policy === null) return null;
  const f = policy.filesystem;
  return {
    wall: { hosts: policy.network.hosts },
    ...(f.writeWorktree === undefined ? {} : { worktree: f.writeWorktree }),
    forbid: { write: f.deniedRelativeWritePatterns, run: policy.execution.deniedCommands },
    ...(f.scopeWrites === undefined ? {} : { scopeWrites: f.scopeWrites }),
    ...(f.treeReadRoot === undefined ? {} : { readRoot: f.treeReadRoot }),
    ...(policy.treeReadOnly ? { treeReadOnly: true } : {}),
    ...(f.privatePaths.length ? { privatePaths: f.privatePaths } : {}),
    ...(f.deniedAbsoluteWritePatterns.length ? { denyAbs: f.deniedAbsoluteWritePatterns } : {}),
    ...(f.writePaths.length ? { writePaths: f.writePaths } : {}),
    ...(f.readMode === 'home-limited' ? { readLimit: true } : {}),
    ...(f.openReadPaths.length ? { readOpen: f.openReadPaths } : {}),
    ...(f.credentials.length ? { credentials: f.credentials } : {}),
  };
}

// ---- argv ----------------------------------------------------------------------------------

// ---- connections (den-mvp outcome 4, spec section 3) -------------------------------------------
// A connection the child is started with: a name and either the https address of a remote server or the path of a
// script in the den that the child runs with this process's own node. Nothing else is expressible: no command line, no
// header, no environment value, so no secret and no arbitrary program reaches argv. The catalog (library/catalog.mjs)
// decides which role gets which; this only checks the shape. An address is a public host name, as for the wall.
export const CONNECTION_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CONNECTION_NAME_MAX = 32;
const CONNECTION_URL_RE = /^https:\/\/([a-z0-9.-]+)((?:\/[A-Za-z0-9._~-]+)*\/?)$/;
const CONNECTION_SCRIPT_RE = /^(?:\/[A-Za-z0-9._@+-]+)+\.mjs$/;
const CONNECTIONS_MAX = 20;
export const CONNECTION_STATES = Object.freeze(["connected", "failed", "needs-auth", "pending", "disabled"]); // the CLI's own words
export function isConnectionTarget(target) {
  if (!isPlainObject(target)) return false;
  const extra = Object.keys(target).filter((k) => !["name", "url", "script"].includes(k));
  if (Object.keys(target).length - extra.length !== 2) return false;
  if (extra.some((k) => k !== "credential" && k !== "headers")) return false;
  if (target.credential !== undefined && !((target.credential === "den" && typeof target.url === "string") || (target.credential === "run" && typeof target.script === "string"))) return false;
  if (target.headers !== undefined && (typeof target.url !== "string" || !isPlainObject(target.headers) || !Object.entries(target.headers).every(([k, v]) => /^X-MCP-[A-Za-z-]{1,40}$/.test(k) && typeof v === "string" && /^[A-Za-z0-9_,.-]{1,200}$/.test(v)))) return false;
  if (typeof target.name !== "string" || target.name.length > CONNECTION_NAME_MAX || !CONNECTION_NAME_RE.test(target.name)) return false;
  if (typeof target.url === "string") {
    const m = CONNECTION_URL_RE.exec(target.url);
    return m !== null && target.url.length <= 300 && isWallHost(m[1]) && !m[2].split("/").some((part) => part === "." || part === "..");
  }
  return typeof target.script === "string" && CONNECTION_SCRIPT_RE.test(target.script) && !target.script.split("/").some((part) => part === "." || part === "..");
}
// den-mvp/38: a "run" script's token is { url, token }: the bridge's own address and that run's token, given to the
// script in its environment (from the 0600 config file, never argv).
const serverOf = (c, token) => (c.url !== undefined
  ? { type: "http", url: c.url, ...(c.headers || token !== undefined ? { headers: { ...(c.headers ?? {}), ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) } } : {}) }
  : { command: process.execPath, args: [c.script], ...(token === undefined ? {} : { env: { DEN_BRIDGE_URL: token.url, DEN_RUN_TOKEN: token.token } }) });
const mcpConfigFor = (connections) => JSON.stringify({ mcpServers: Object.fromEntries(connections.map((c) => [c.name, serverOf(c)])) });
/**
 * den-mvp/33: the MCP config of the connections that hold a credential, with each one's token (`tokens`: name -> token).
 * It is written to a 0600 file the agent cannot read, never put in argv.
 */
export const mcpConfigWithTokens = (connections, tokens) => JSON.stringify({ mcpServers: Object.fromEntries(connections.map((c) => [c.name, serverOf(c, tokens[c.name])])) });
const MCP_CONFIG_FILE_RE = /^\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*\.json$/;


/**
 * The whole argv (no binary name) for one child. Rejects anything outside { sessionId, agent, model?, ticketFile?,
 * wall?, worktree? }. No passthrough parameter exists, so no permission-broadening flag can be constructed; ticketFile adds
 * the one Read rule above, wall adds the sandbox block above, and worktree adds Write and Edit rules for that one directory.
 */
export function buildClaudeArgs(options) {
  if (!isPlainObject(options)) throw new TypeError("buildClaudeArgs needs { sessionId, agent, model?, ticketFile?, wall?, worktree? }");
  for (const key of Object.keys(options)) {
    if (!["sessionId", "resume", "agent", "model", "effort", "tree", "treeReadOnly", "treeReview", "scopeWrites", "readRoot", "privatePaths", "ticketFile", "wall", "worktree", "forbid", "writePaths", "readLimit", "readOpen", "denyAbs", "credentials", "connections", "mcpConfigFile", "project"].includes(key)) throw new TypeError(`buildClaudeArgs: unknown option ${JSON.stringify(key)}`);
  }
  const { sessionId, resume, agent, model, effort, tree, treeReadOnly, treeReview, scopeWrites, readRoot, privatePaths, ticketFile, wall, worktree, forbid, writePaths, readLimit, readOpen, denyAbs, credentials, connections, mcpConfigFile, project } = options;
  if (tree !== undefined && tree !== true) throw new TypeError("buildClaudeArgs: tree must be true");
  if (effort !== undefined && !(tree === true && ["low", "medium", "high", "xhigh", "max"].includes(effort))) throw new TypeError("buildClaudeArgs: effort must be a configured tree effort");
  if (treeReadOnly !== undefined && !(tree === true && treeReadOnly === true)) throw new TypeError("buildClaudeArgs: treeReadOnly needs admitted tree mode");
  if (treeReview !== undefined && !(tree === true && typeof treeReview === "boolean")) throw new TypeError("buildClaudeArgs: treeReview needs an admitted tree phase");
  if (scopeWrites !== undefined && !(tree === true && agent === "runner" && !treeReadOnly && worktree === undefined && isScopeWrites(scopeWrites))) throw new TypeError("buildClaudeArgs: scoped file writes need an admitted code runner without a broad worktree allow");
  if (readRoot !== undefined && !(tree === true && isWorktreePath(readRoot))) throw new TypeError("buildClaudeArgs: readRoot needs a plain admitted tree worktree");
  if (privatePaths !== undefined && !(wall !== undefined && isDense(privatePaths) && privatePaths.length <= 4 && privatePaths.every(isWorktreePath))) throw new TypeError("buildClaudeArgs: privatePaths need plain protected paths with the wall");
  const target = project !== undefined && project.control === false;
  if (project !== undefined && (!isPlainObject(project) || typeof project.control !== "boolean")) throw new TypeError("buildClaudeArgs: project must be { control: boolean, root, pluginDir? }");
  if (target && !isWorktreePath(project.pluginDir)) throw new TypeError("buildClaudeArgs: a target project needs pluginDir, a plain absolute path");
  if (mcpConfigFile !== undefined && (typeof mcpConfigFile !== "string" || !MCP_CONFIG_FILE_RE.test(mcpConfigFile) || mcpConfigFile.split("/").some((p) => p === "." || p === ".."))) throw new TypeError("buildClaudeArgs: mcpConfigFile must be a plain absolute .json path");
  const inline = connections?.filter((c) => c.credential === undefined);
  if (connections !== undefined && !(isDense(connections) && connections.length > 0 && connections.length <= CONNECTIONS_MAX && connections.every(isConnectionTarget) && new Set(connections.map((c) => c.name)).size === connections.length)) throw new TypeError("buildClaudeArgs: connections must be catalog targets, each name once");
  if (resume !== undefined && resume !== true) throw new TypeError("buildClaudeArgs: resume must be true");
  if (credentials !== undefined && !(wall !== undefined && isDense(credentials) && credentials.every((p) => CREDENTIAL_PATHS.includes(p)))) throw new TypeError("buildClaudeArgs: credentials must be paths from governance.json, with the wall");
  if (wall !== undefined && !isWall(wall)) throw new TypeError("buildClaudeArgs: wall must be { hosts: [plain host names] }");
  // agent-os/02: the governance denies, task-granted write paths and the read limit all come from compileCeiling and need the wall.
  if (forbid !== undefined && !isForbid(forbid)) throw new TypeError("buildClaudeArgs: forbid must be { write: [plain paths], run: [plain words] }");
  if (writePaths !== undefined && !(isDense(writePaths) && writePaths.length <= GRANTS_MAX && writePaths.every(isGrantPath))) throw new TypeError("buildClaudeArgs: writePaths must be plain absolute or ~/ paths");
  if (readLimit !== undefined && readLimit !== true) throw new TypeError("buildClaudeArgs: readLimit must be true");
  if (readOpen !== undefined && !(readLimit === true && isDense(readOpen) && readOpen.length <= 8 && readOpen.every(isWorktreePath))) throw new TypeError("buildClaudeArgs: readOpen must be plain absolute paths, with the read limit");
  if (denyAbs !== undefined && !(isDense(denyAbs) && denyAbs.length <= DENY_ABS_MAX && denyAbs.every((p) => typeof p === "string" && DENY_ABS_RE.test(p) && !p.split("/").some((part) => part === "." || part === "..")))) throw new TypeError("buildClaudeArgs: denyAbs must be plain absolute paths");
  if (wall === undefined && (forbid !== undefined || writePaths !== undefined || readLimit !== undefined || denyAbs !== undefined)) throw new TypeError("buildClaudeArgs: forbid, writePaths, readLimit and denyAbs need the wall");
  if (worktree !== undefined && !isWorktreePath(worktree)) throw new TypeError("buildClaudeArgs: worktree must be a plain absolute path");
  if (ticketFile !== undefined && !isTicketFilePath(ticketFile)) throw new TypeError("buildClaudeArgs: ticketFile must be a plain absolute path to a board ticket");
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) throw new TypeError("buildClaudeArgs: sessionId must be a UUID");
  if (typeof agent !== "string" || !(ROLES.includes(agent) || (tree === true && agent === "runner"))) throw new TypeError("buildClaudeArgs: agent must be a known role");
  if (model !== undefined && (typeof model !== "string" || !CLAUDE_MODELS.includes(model))) throw new TypeError("buildClaudeArgs: model must be one of the fixed list");
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--replay-user-messages", // den-v1 loop S5: the child re-emits each stdin user message once it takes it
    "--permission-prompt-tool", "stdio",
    // den-mvp outcome 2: a follow-up continues the earlier session under the same id; everything else is built afresh.
    ...(resume === true ? ["--resume", sessionId] : ["--session-id", sessionId]),
    "--agent", target ? `den:${agent}` : agent,
    ...(model === undefined ? [] : ["--model", model]),
    ...(effort === undefined ? [] : ["--effort", effort]),
    // Every tree spawn goes through the bridge; native children would bypass its depth, ownership and capacity checks.
    ...(tree === true ? ["--disallowedTools", treeReadOnly || (agent === "runner" && scopeWrites === undefined) ? "Agent,Task,Write,Edit,NotebookEdit" : "Agent,Task,NotebookEdit"] : []),
    ...(treeReadOnly && (treeReview ?? true) && agent !== "runner" ? ["--allowedTools", "mcp__tree__status,mcp__tree__review"] : []),
    // den-mvp/48: a target project loads nothing from its own .claude/: no settings, and the den's role definitions come in as a plugin.
    "--setting-sources", target ? "" : "project,local",
    ...(target ? ["--plugin-dir", project.pluginDir] : []),
    // den-mvp outcome 4: only what --mcp-config names is loaded, and it names only the catalog's connections for this role.
    "--strict-mcp-config",
    ...(inline === undefined || inline.length === 0 ? [] : ["--mcp-config", mcpConfigFor(inline)]),
    ...(mcpConfigFile === undefined ? [] : ["--mcp-config", mcpConfigFile]),
    "--settings", settingsFor({ ticketFile, wall, worktree, forbid, writePaths, readLimit, readOpen, denyAbs, credentials, scopeWrites, readRoot, privatePaths }),
  ];
}

// ---- web destinations (den-mvp outcome 1, spec section 3) -------------------------------------
// The shell sandbox does not cover the CLI's own web tools, so their permission requests are checked here. A fetch whose
// destination is not a public host name (an IP literal, localhost, a private or single-label name, a non-http scheme) is
// refused outright; anything else stays a question for the user unless an allow rule above already covers its host.
const WEB_REFUSAL = "The den refuses web requests to local, private or numeric destinations.";
/** The deny reason for a web tool's request, or null when the request may go on to the user. */
export function webRefusal(tool, input) {
  if (tool !== "WebFetch") return null;
  let url;
  try {
    url = new URL(input?.url);
  } catch {
    return WEB_REFUSAL;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return WEB_REFUSAL;
  if (url.username !== "" || url.password !== "") return WEB_REFUSAL;
  return isWallHost(url.hostname.replace(/\.$/, "")) ? null : WEB_REFUSAL;
}

// ---- environment ---------------------------------------------------------------------------

const ENV_EXACT = ["PATH", "HOME", "LANG", "DEN_CLAUDE_BIN"];
const ENV_LOCALE = /^LC_[A-Z]+$/;

/** The child's environment: PATH, HOME, locale and DEN_CLAUDE_BIN only. The owner's login is on disk, not in env (ADR 0001). */
export function buildClaudeEnv(parentEnv) {
  const env = {};
  if (!isPlainObject(parentEnv)) return env;
  for (const name of Object.keys(parentEnv)) {
    if (!ENV_EXACT.includes(name) && !ENV_LOCALE.test(name)) continue;
    const value = parentEnv[name];
    if (typeof value === "string") env[name] = value;
  }
  return env;
}

// ---- stdout lines --------------------------------------------------------------------------

/**
 * Chunks (string or Buffer) to complete lines. A line over maxLineBytes is dropped and the stream
 * resyncs at the next newline; the buffer never holds more than the cap while waiting for one.
 */
export function createLineSplitter({ maxLineBytes = MAX_LINE_BYTES } = {}) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let pendingBytes = 0;
  let dropping = false;

  function finishLine(segment, out) {
    const wasDropping = dropping;
    const line = pending + segment;
    const bytes = pendingBytes + Buffer.byteLength(segment);
    pending = "";
    pendingBytes = 0;
    dropping = false;
    if (wasDropping || bytes > maxLineBytes) return;
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.trim() !== "") out.push(trimmed);
  }

  return {
    push(chunk) {
      const out = [];
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      const parts = text.split("\n");
      for (let i = 0; i < parts.length - 1; i += 1) finishLine(parts[i], out);
      const tail = parts[parts.length - 1];
      if (dropping) return out;
      const bytes = pendingBytes + Buffer.byteLength(tail);
      if (bytes > maxLineBytes) {
        pending = "";
        pendingBytes = 0;
        dropping = true;
      } else {
        pending += tail;
        pendingBytes = bytes;
      }
      return out;
    },
  };
}

// ---- stream decode -------------------------------------------------------------------------

function clip(text, max) {
  const flat = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) : flat;
}

// The collapsed preview is extracted from sanitized recorded input, then shortened.
function summarise(input) {
  if (!isPlainObject(input)) return "";
  // den-mvp/55: a den tool's row names what it acts on (Bao's board_file batch, a ticket ref, a title).
  if (Array.isArray(input.tickets) && input.tickets.length > 0) {
    const n = input.tickets.length;
    return clip(`file ${n} ticket${n === 1 ? "" : "s"}${typeof input.feature === "string" ? ` in ${input.feature}` : ""}`, SUMMARY_MAX);
  }
  for (const key of ["command", "file_path", "path", "pattern", "url", "description", "ref", "title"]) {
    if (typeof input[key] === "string" && input[key].trim() !== "") return clip(input[key], SUMMARY_MAX);
  }
  return "";
}

// Clean the complete text before clipping; the host also cleans before exposure and persistence.
function body(type, text, extra = {}) {
  text = cleanText(text);
  if (text.length <= BODY_MAX) return { type, ...extra, text };
  return { type, ...extra, text: text.slice(0, BODY_MAX), more: text.length - BODY_MAX };
}

// A tool_result's content is a string or a list of blocks; a block that is not text is named by its type.
function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isPlainObject)
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : `[${clip(String(block.type ?? "block"), 40)}]`))
    .join("\n");
}

const whole = (n) => Number.isSafeInteger(n) && n >= 0;
const count = (n) => (whole(n) ? n : 0);

// A usage block as the four billed tiers, or null when it has no usable output count.
function tiersOf(usage) {
  if (!isPlainObject(usage) || !whole(usage.output_tokens)) return null;
  return {
    input: count(usage.input_tokens), cacheWrite: count(usage.cache_creation_input_tokens),
    cacheRead: count(usage.cache_read_input_tokens), output: usage.output_tokens,
  };
}

// One message's usage. The CLI writes a message as several lines that repeat the same id and usage, so the id goes
// along and the host counts each message once. Per-message output is a partial count; the result line has the totals.
function usageEvent(message) {
  const tiers = tiersOf(message?.usage);
  if (!tiers) return null;
  // Input is the context the model read: plain input plus cache creation and cache reads.
  const input = tiers.input + tiers.cacheWrite + tiers.cacheRead;
  return { type: "usage", input, output: tiers.output, message: typeof message.id === "string" ? clip(message.id, SUMMARY_MAX) : "", tiers };
}

// The result line's own totals (den-v1 loop S4), each kept only if it is a plain number in range.
function totalsOf(obj) {
  const tiers = tiersOf(obj.usage);
  return {
    ...(typeof obj.total_cost_usd === "number" && obj.total_cost_usd >= 0 && obj.total_cost_usd <= COST_MAX_USD ? { costUsd: obj.total_cost_usd } : {}),
    ...(whole(obj.duration_ms) ? { durationMs: obj.duration_ms } : {}),
    ...(whole(obj.num_turns) ? { turns: obj.num_turns } : {}),
    ...(tiers ? { tiers } : {}),
  };
}

function contentBlocks(message) {
  return isPlainObject(message) && Array.isArray(message.content) ? message.content.filter(isPlainObject) : [];
}

// Correlation is an exact identity, never a shortened or sanitized display string.
// Reject the original before any transformation can leak a fragment or create a collision.
const invocationId = id => typeof id === "string" && id.length > 0 && id.length <= INVOCATION_ID_MAX && cleanText(id) === id ? id : "";

/** One stdout line to zero or more CellEvents. Never throws. control_request lines belong to decodeControlRequest. */
export function parseClaudeLine(line) {
  try {
    if (typeof line !== "string") return [];
    if (line.length * 3 > MAX_LINE_BYTES && Buffer.byteLength(line) > MAX_LINE_BYTES) return [];
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return [];
    const obj = JSON.parse(trimmed);
    if (!isPlainObject(obj)) return [];
    if (obj.type === "assistant") {
      const events = [];
      for (const block of contentBlocks(obj.message)) {
        if (block.type === "text") {
          if (typeof block.text === "string" && block.text.trim() !== "") events.push(body("text", block.text));
          continue;
        }
        if (block.type !== "tool_use") continue;
        if (typeof block.name !== "string" || block.name === "") continue;
        const id = invocationId(block.id);
        const input = safeToolInput(block.input);
        events.push({ type: "tool-start", id, name: cleanText(block.name), summary: summarise(input), ...(input === undefined ? {} : { input }) });
      }
      const usage = usageEvent(obj.message);
      if (usage) events.push(usage);
      return events;
    }
    if (obj.type === "user") {
      // The child's replay of a stdin user message (den-v1 loop S5): it took the message. Never read as a tool result.
      if (obj.isReplay === true) return typeof obj.uuid === "string" && UUID_RE.test(obj.uuid) ? [{ type: "message-applied", id: obj.uuid }] : [];
      return contentBlocks(obj.message)
        .filter((block) => block.type === "tool_result" && typeof block.tool_use_id === "string")
        .flatMap((block) => {
          const id = invocationId(block.tool_use_id);
          return [body("tool-result", resultText(block.content), { id, ok: block.is_error !== true }), { type: "tool-end", id }];
        });
    }
    if (obj.type === "system" && obj.subtype === "init") {
      const events = typeof obj.model === "string" && MODEL_RE.test(obj.model) ? [{ type: "model", model: obj.model }] : [];
      // den-mvp outcome 4: how each connection stood when the child started. Only a name and one of the known words are kept.
      const servers = (Array.isArray(obj.mcp_servers) ? obj.mcp_servers.slice(0, CONNECTIONS_MAX) : [])
        .filter((m) => isPlainObject(m) && typeof m.name === "string" && m.name.length <= CONNECTION_NAME_MAX && CONNECTION_NAME_RE.test(m.name))
        .map((m) => ({ name: m.name, status: CONNECTION_STATES.includes(m.status) ? m.status : "unknown" }));
      if (servers.length > 0) events.push({ type: "connections", servers });
      return events;
    }
    if (obj.type === "result") {
      const done = { type: "done", ok: obj.subtype === "success" && obj.is_error !== true, ...totalsOf(obj) };
      return typeof obj.result === "string" && obj.result.trim() !== "" ? [body("reply", obj.result), done] : [done];
    }
    return [];
  } catch {
    return [];
  }
}

// ---- permission channel --------------------------------------------------------------------

const validRequestId = (id) => typeof id === "string" && id.length > 0 && id.length <= REQUEST_ID_MAX;

/**
 * A control_request line, decoded. Only can_use_tool with a named tool and a plain-object input is an approval;
 * permission_suggestions is never read. Anything else with a usable id is answered deny, a repeat of an id is
 * answered deny, and a request with no usable id is dropped (nothing to answer). `seen` is the caller's per-child set.
 */
export function decodeControlRequest(obj, seen) {
  if (!isPlainObject(obj) || obj.type !== "control_request") return { kind: "drop" };
  const requestId = obj.request_id;
  if (!validRequestId(requestId)) return { kind: "drop" };
  const deny = { kind: "deny", requestId };
  if (seen.has(requestId)) return deny;
  if (seen.size >= REQUEST_IDS_PER_AGENT) return deny;
  seen.add(requestId);
  const request = obj.request;
  if (!isPlainObject(request) || request.subtype !== "can_use_tool") return deny;
  if (typeof request.tool_name !== "string" || request.tool_name === "") return deny;
  if (!isPlainObject(request.input)) return deny;
  return { kind: "approval", requestId, tool: request.tool_name, input: request.input };
}

// U+2028 and U+2029 are legal inside JSON strings but split lines in some readers; escape them so the line stays one line.
const oneLine = (value) => `${JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}\n`;

/**
 * The stdin line that answers a control_request: a bare decision, never updatedPermissions or a rule.
 * Only an explicit `allow: true` allows (and then echoes the original input); everything else is deny.
 */
export function encodeControlResponse({ requestId, allow, reason, input } = {}) {
  if (!validRequestId(requestId)) throw new TypeError("encodeControlResponse: requestId must be a string of 1 to 128 characters");
  let body;
  if (allow === true) {
    if (!isPlainObject(input)) throw new TypeError("encodeControlResponse: an allow needs the request's plain-object input");
    body = { behavior: "allow", updatedInput: input };
  } else {
    const message = typeof reason === "string" && reason !== "" ? reason.slice(0, DENY_REASON_MAX) : DENY_REASON_DEFAULT;
    body = { behavior: "deny", message };
  }
  return oneLine({ type: "control_response", response: { subtype: "success", request_id: requestId, response: body } });
}

/**
 * A user message as one stdin line: the first prompt (no id), or a message to a running child (den-v1 loop S5).
 * The id rides as the line's uuid, and the child's replay of the line carries it back.
 */
export function encodeUserMessage({ text, id } = {}) {
  if (typeof text !== "string") throw new TypeError("encodeUserMessage: text must be a string");
  if (id !== undefined && (typeof id !== "string" || !UUID_RE.test(id))) throw new TypeError("encodeUserMessage: id must be a UUID");
  return oneLine({ type: "user", message: { role: "user", content: text }, ...(id === undefined ? {} : { uuid: id }) });
}

// ---- the project's guide (den-mvp/48) ---------------------------------------------------------
/**
 * The text of the project's CLAUDE.md, else AGENTS.md, as committed at the main checkout's HEAD. The worktree and any
 * uncommitted edit are never read. `exec` is a test seam: (file, args) -> string, throwing when the path is not in HEAD.
 * -> { file, text } or null.
 */
export function readProjectGuide(root, { exec = (file, args) => execFileSync(file, args, { encoding: "utf8", maxBuffer: 1 << 20, stdio: ["ignore", "pipe", "ignore"] }) } = {}) {
  if (!isWorktreePath(root)) throw new TypeError("readProjectGuide: root must be a plain absolute path");
  for (const file of ["CLAUDE.md", "AGENTS.md"]) {
    try {
      return { file, text: String(exec("git", ["-C", root, "show", `HEAD:${file}`])) };
    } catch {
      // not committed at HEAD
    }
  }
  return null;
}
