// den-v1 loop S3: the live check, run as spike `Live` of conformance.mjs (`npm run smoke:live`). Unlike the other
// spikes, which drive the CLI directly, this one goes through the production path: startBridge, the Claude runtime,
// the host's worktree and its fixed prompt. A throwaway git repository holds a probe role file for `developer` (a role that takes grants); the role
// file, not the prompt, tells the model to write one file inside its worktree, one in a granted directory and one outside
// both. hardening/01: the host denies the last at once and holds the granted one for the user, so the harness plays the den
// for the granted write only. The harness plays
// the den: it watches GET /state for the held approval, reads the full input, allows it and waits for the end.
// den-v1 loop S5: while that request is held it also sends the agent one message (POST /agents/:id/message), and the
// evaluator checks that the CLI replayed it with the id the bridge gave it and that the bridge marked it received.
//
// Captures (written by conformance.mjs as Live.jsonl, Live-stdin.jsonl, Live-bridge.jsonl):
//   main    the child's stdout lines, as the bridge received them
//   stdin   the lines the bridge wrote to the child: the prompt, then the control_response answers
//   bridge  the bridge's SSE frames ({ type: "sse", event, data }) and the harness's own observations
//           ({ type: "check", check, ... }), in order
// A small recording wrapper (DEN_CLAUDE_BIN) sits between the runtime and the binary to take main and stdin.
// The captures are returned already scrubbed for commit (ADR 0016's fixture scrub step): see scrubLive.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { startBridge } from "../server.mjs";
import { decodeControlRequest } from "./claude-adapter.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";

export const LIVE_REF = "den/01-live-check";
export const LIVE_ROLE = "developer"; // a known role that writes, so it takes a path grant (scout takes none)
export const LIVE_MARKER = "LIVE-CHECK-OK";
const INSIDE_FILE = "inside.txt";
const ENDED = ["done", "failed", "terminated"];
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const BODY_RE = /^[A-Za-z0-9 ._-]{1,80}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the throwaway repository ---------------------------------------------------------------

const roleFile = ({ model, target, outside, body, insideBody, ticket, neighbour }) => `---
name: ${LIVE_ROLE}
description: Live-check probe role (throwaway)
tools: Read, Write
model: ${model}
---
You are a conformance probe in a throwaway repository. There is no board${ticket ? "" : ", no ticket file"} and no team-protocol skill here: skip every claim, hand-off and board step you are asked for, and do not look for them.

Do exactly this, in this order, and nothing else:
${ticket ? `- Use the Read tool to read the file ${ticket}\n- Use the Read tool to read the file ${neighbour}\n` : ""}${insideBody ? `- Use the Write tool to create the file ${INSIDE_FILE} in your current working directory with exactly this content: ${insideBody}\n` : ""}- Use the Write tool to create the file ${target} with exactly this content: ${body}
- Use the Write tool to create the file ${outside} with exactly this content: ${body}

If a tool call is refused, do not retry it and do not try another way. Begin your final reply with the word ${LIVE_MARKER}, then say in one sentence what happened to each write.
`;

/**
 * A git repository with one commit holding the probe role file. `grant` is a second temp dir that the run grants and `target` is in
 * it: outside every agent worktree, and a write the host holds for the user. `outside` is in the repository root: outside every
 * worktree and every grant, so the host denies it. insideBody: null leaves the inside write out.
 */
export function makeLiveRepo({ model = "haiku", body = `LIVE-BODY-${randomBytes(3).toString("hex").toUpperCase()}`, insideBody = null, ticketWord = null } = {}) {
  if (typeof model !== "string" || !MODEL_RE.test(model)) throw new TypeError("makeLiveRepo: model must be a plain model name");
  for (const b of [body, ...(insideBody === null ? [] : [insideBody]), ...(ticketWord === null ? [] : [ticketWord])]) {
    if (typeof b !== "string" || !BODY_RE.test(b)) throw new TypeError("makeLiveRepo: a body is one line of letters, digits, spaces, dots, dashes and underscores");
  }
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "den-live-")));
  const grant = realpathSync(mkdtempSync(path.join(tmpdir(), "den-live-grant-")));
  const target = path.join(grant, "live-check.txt");
  const outside = path.join(dir, "live-outside.txt");
  mkdirSync(path.join(dir, ".claude", "agents"), { recursive: true });
  mkdirSync(path.join(dir, ".scratch"));
  // ticketWord: the probe's own ticket file, where the host says it is (the main checkout's board, outside the worktree).
  const ticket = ticketWord === null ? null : path.join(dir, ".scratch", ...LIVE_REF.split("/").toSpliced(1, 0, "issues")) + ".md";
  const neighbour = ticket ? path.join(path.dirname(ticket), "02-neighbour.md") : null; // the control: not the agent's ticket
  if (ticket) {
    mkdirSync(path.dirname(ticket), { recursive: true });
    writeFileSync(neighbour, "# 02: neighbour\n\n**Status:** ready-for-agent\n");
    writeFileSync(ticket, `# 01: live check\n\n**Status:** ready-for-agent\n\n## What to build\n\n> ${ticketWord}\n`);
  }
  writeFileSync(path.join(dir, ".claude", "agents", `${LIVE_ROLE}.md`), roleFile({ model, target, outside, body, insideBody, ticket, neighbour }));
  const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=live", "-c", "user.email=live@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", `.claude/agents/${LIVE_ROLE}.md`);
  git("commit", "-q", "-m", "live check probe");
  return { dir, grant, target, outside, body, insideBody, ticket, neighbour, cleanup: () => { rmSync(dir, { recursive: true, force: true }); rmSync(grant, { recursive: true, force: true }); } };
}

// ---- the recording wrapper --------------------------------------------------------------------

// An executable that runs realBin with the same argv, cwd and environment, passes stdin, stdout and stderr through
// untouched, and logs every stdin and stdout line with a timestamp. It stays in the runtime's process group.
function makeTee({ dir, realBin, logFile, errFile }) {
  const bin = path.join(dir, "claude-tee.mjs");
  const source = `#!${process.execPath}
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
const O = ${JSON.stringify({ realBin, logFile, errFile })};
const row = (o) => appendFileSync(O.logFile, JSON.stringify({ t: Date.now(), ...o }) + "\\n");
const lines = (dir) => {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const raw = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (raw) row({ dir, raw });
    }
  };
};
const child = spawn(O.realBin, process.argv.slice(2), { stdio: ["pipe", "pipe", "pipe"], shell: false });
child.on("error", (e) => { appendFileSync(O.errFile, "wrapper: could not start the binary: " + e.message + "\\n"); row({ dir: "exit", code: null, signal: null, error: e.message }); process.exit(127); });
child.stdin.on("error", () => {});
const recIn = lines("in");
const recOut = lines("out");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { recIn(c); child.stdin.write(c); });
process.stdin.on("end", () => child.stdin.end());
child.stdout.setEncoding("utf8");
child.stdout.on("data", (c) => { recOut(c); process.stdout.write(c); });
child.stderr.on("data", (c) => { appendFileSync(O.errFile, c); process.stderr.write(c); });
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("close", (code, signal) => { row({ dir: "exit", code, signal }); process.stdout.write("", () => process.exit(code ?? 1)); });
`;
  writeFileSync(bin, source);
  chmodSync(bin, 0o755);
  return bin;
}

function readTee(logFile, errFile) {
  const rows = [];
  for (const line of (existsSync(logFile) ? readFileSync(logFile, "utf8") : "").split("\n")) {
    try {
      if (line) rows.push(JSON.parse(line));
    } catch {
      // a row still being written: the next read has it whole
    }
  }
  const lines = (dir) =>
    rows.filter((r) => r.dir === dir).map(({ t, raw }) => {
      let obj = null;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") obj = parsed;
      } catch {
        // not JSON: kept raw
      }
      return { t, raw, obj };
    });
  const end = rows.find((r) => r.dir === "exit");
  const exit = end ? { code: end.code, signal: end.signal, ...(end.error ? { error: end.error } : {}) } : null;
  return {
    main: { lines: lines("out"), exit, stderr: existsSync(errFile) ? readFileSync(errFile, "utf8") : "" },
    stdin: { lines: lines("in"), exit: null, stderr: "" },
  };
}

// ---- a minimal client for the bridge ------------------------------------------------------------

function call(bridge, method, route, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {
      Origin: bridge.url,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
    };
    const req = http.request(`${bridge.url}${route}`, { method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          // not JSON: status only
        }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function openSse(bridge, onFrame) {
  const req = http.get(`${bridge.url}/events`, { headers: { Accept: "text/event-stream" } }, (res) => {
    let buf = "";
    res.setEncoding("utf8");
    res.on("error", () => {});
    res.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = "message";
        const data = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        try {
          onFrame(event, JSON.parse(data.join("\n")));
        } catch {
          // a frame that is not JSON is not evidence
        }
      }
    });
  });
  req.on("error", () => {});
  return { close: () => req.destroy() };
}

// ---- the scrub step (pure) ------------------------------------------------------------------------

export const FIXTURE_SESSION_ID = "00000000-0000-4000-8000-000000000001";
const INIT_KEEP = ["type", "subtype", "cwd", "tools", "mcp_servers", "model", "permissionMode", "plugins", "session_id"];

/**
 * The captures as they may be committed (ADR 0016, the fixture scrub step): the init line keeps only the keys the
 * checks read (no memory or socket path), thinking text and signatures are emptied, the session id becomes a fixed
 * one everywhere, and a line that is not a JSON object is dropped. conformance.mjs then replaces home paths.
 */
export function scrubLive(captures) {
  const sessionId = (captures?.main?.lines ?? []).map((l) => l.obj).find((o) => o?.type === "system" && o.subtype === "init")?.session_id;
  const fix = ({ t, obj }) => {
    let o = structuredClone(obj);
    if (o.type === "system" && o.subtype === "init") o = Object.fromEntries(INIT_KEEP.filter((k) => k in o).map((k) => [k, o[k]]));
    for (const b of blocks(o)) {
      if (b?.type === "thinking") b.thinking = "";
      if (b && typeof b === "object" && "signature" in b) b.signature = "";
    }
    let raw = JSON.stringify(o);
    if (typeof sessionId === "string" && sessionId.length >= 8) raw = raw.split(sessionId).join(FIXTURE_SESSION_ID);
    return { t, raw, obj: JSON.parse(raw) };
  };
  return Object.fromEntries(Object.entries(captures ?? {}).map(([name, cap]) => [name, { ...cap, lines: cap.lines.filter((l) => l.obj && typeof l.obj === "object").map(fix) }]));
}

// ---- the evaluator (pure: three captures in, go or no-go out) -------------------------------------

const rowsOf = (cap) => (cap?.lines ?? []).map((l, i) => ({ i, o: l.obj })).filter((r) => r.o && typeof r.o === "object");
const blocks = (o) => (Array.isArray(o.message?.content) ? o.message.content : []);
const flat = (c) => (typeof c === "string" ? c : JSON.stringify(c ?? "")).slice(0, 160);

/**
 * Go needs, in the child's own lines and the bridge's: a can_use_tool request for the write outside the worktree,
 * the request held (approval pending, agent waiting on the user, full input served, file absent), the bare allow
 * on the child's stdin, a tool result that is not an error, the file on disk, and an agent that ended done by itself.
 * No request for the write is the slice's stop rule: `stopRule: true`.
 */
export function evaluateLive({ main, stdin, bridge } = {}) {
  const out = rowsOf(main);
  const inn = rowsOf(stdin);
  const obs = rowsOf(bridge).map((r) => r.o);
  const evidence = [];
  let ok = true;
  const good = (line) => evidence.push(line);
  const bad = (line) => {
    ok = false;
    evidence.push(`FAILED: ${line}`);
  };
  const done = (extra = {}) => ({ spike: "Live", verdict: ok ? "go" : "no-go", evidence, ...extra });
  const check = (name) => obs.find((o) => o.type === "check" && o.check === name);
  const setup = check("setup");
  const held = check("held");
  const final = check("final");
  if (!setup) {
    const failed = check("start-failed");
    bad(failed ? `the bridge refused to start the agent: ${failed.status} ${failed.error}` : "the run never started: the harness recorded no setup");
    return done();
  }
  const rel = (p) => path.relative(setup.worktree, path.resolve(setup.worktree, String(p)));
  const uses = out.flatMap((r) => (r.o.type === "assistant" ? blocks(r.o).filter((b) => b.type === "tool_use").map((b) => ({ i: r.i, ...b })) : []));
  const results = out.flatMap((r) => (r.o.type === "user" ? blocks(r.o).filter((b) => b.type === "tool_result").map((b) => ({ i: r.i, ...b })) : []));
  const seen = new Set();
  const requests = out.filter((r) => r.o.type === "control_request").map((r) => ({ i: r.i, toolUseId: r.o.request?.tool_use_id, d: decodeControlRequest(r.o, seen) }));
  const approvals = requests.filter((r) => r.d.kind === "approval");
  const resultFor = (req) => results.find((b) => (typeof req.toolUseId === "string" ? b.tool_use_id === req.toolUseId : b.i > req.i));

  const init = out.find((r) => r.o.type === "system" && r.o.subtype === "init")?.o;
  if (init && init.cwd !== setup.worktree) bad(`init.cwd is ${init.cwd}, not the agent's worktree ${setup.worktree}`);
  else if (init) good(`the child's cwd is its worktree (model ${init.model ?? "?"}, permissionMode ${init.permissionMode ?? "?"})`);

  // The write outside the worktree: the request, the hold, the decision, the result.
  const req = approvals.find((r) => r.d.tool === "Write" && rel(r.d.input.file_path) === rel(setup.target));
  if (!req) {
    ok = false;
    evidence.push(
      `STOP RULE: the CLI raised no can_use_tool control_request for the Write to ${setup.target}. The stubs and the host assume one, so stop and fix this before S1.`,
      `control_request lines seen: ${requests.length} (${requests.map((r) => (r.d.kind === "approval" ? `${r.d.tool} ${flat(r.d.input.file_path ?? r.d.input)}` : r.d.kind)).join("; ") || "none"})`,
      `tool_use lines seen: ${uses.map((u) => `${u.name} ${flat(u.input?.file_path ?? u.input)}`).join("; ") || "none"}`,
      `tool_result lines seen: ${results.map((b) => `${b.is_error ? "error" : "ok"} ${flat(b.content)}`).join("; ") || "none"}`,
      `the target file ${final?.fileExists ? "EXISTS: the write ran without a request" : "does not exist"}; the agent ended ${final?.agentState ?? "?"}`,
    );
    return done({ stopRule: true });
  }
  good(`control_request ${req.d.requestId}: can_use_tool Write ${req.d.input.file_path}, decoded as an approval by the production decoder`);
  if (!rel(setup.target).startsWith("..")) bad(`the requested path is inside the worktree (${rel(setup.target)}): this check needs a write outside it`);
  else good(`the path is outside the agent's worktree (${rel(setup.target)} from it)`);

  const frames = obs.filter((o) => o.type === "sse" && o.data?.type === "approval" && o.data.approval?.id === held?.approvalId).map((o) => o.data.approval.state);
  if (!held) bad("the bridge never showed a pending approval for the request");
  else {
    const before = evidence.length;
    if (held.tool !== "Write" || frames[0] !== "pending") bad(`the approval was not published as a pending Write (tool ${held.tool}, states ${frames.join(", ") || "none"})`);
    if (held.agentState !== "waiting_on_user") bad(`the agent's state was ${held.agentState} while the request was held, not waiting_on_user`);
    if (held.fileExists !== false) bad("the target file already existed while the request was held");
    if (!isDeepStrictEqual(held.input, req.d.input)) bad("GET /approvals/:id did not serve the request's full input");
    if (evidence.length === before) good(`held: approval ${held.approvalId} pending, agent waiting_on_user, full input served, no file on disk`);
  }

  const answers = inn.map((r) => r.o).filter((o) => o.type === "control_response" && o.response?.request_id === req.d.requestId);
  const reply = answers[0]?.response?.response;
  if (!reply) bad(`no control_response for ${req.d.requestId} reached the child's stdin`);
  else if (reply.behavior !== "allow" || !isDeepStrictEqual(reply.updatedInput, req.d.input)) bad(`the answer on stdin was not an allow echoing the request's input (behavior ${reply.behavior})`);
  else if (Object.keys(reply).some((k) => k !== "behavior" && k !== "updatedInput")) bad(`the answer was not a bare decision: it also carries ${Object.keys(reply).filter((k) => k !== "behavior" && k !== "updatedInput").join(", ")}`);
  else good(`decision: POST /approvals/:id allow (${check("decided")?.status ?? "?"}) reached the child's stdin as a bare allow; approval states ${frames.join(" -> ")}`);

  const res = resultFor(req);
  if (!res) bad("no tool_result followed the request");
  else if (res.is_error === true) bad(`the tool_result is an error: ${flat(res.content)}`);
  else if (held && Number.isInteger(held.cliLines) && res.i < held.cliLines) bad("the tool_result was already out before the hold was observed: the request was not what held the tool");
  else good(`tool_result (not an error) came after the hold: ${flat(res.content)}`);
  if (!final?.fileExists || !final?.bodyMatches) bad(`the file is ${final?.fileExists ? "on disk with the wrong content" : "not on disk"} after the allow`);
  else good("the file is on disk with the content asked for");

  // hardening/01: the write outside the worktree and every grant is denied by the host at once: a Write request answered deny
  // on the child's stdin, never held, and no file on disk. A setup with no `outside` (an older capture) is scored as before.
  if (setup.outside) {
    const outReq = approvals.find((r) => r.d.tool === "Write" && rel(r.d.input.file_path) === rel(setup.outside));
    const outReply = outReq ? inn.map((r) => r.o).find((o) => o.type === "control_response" && o.response?.request_id === outReq.d.requestId)?.response?.response : undefined;
    if (!outReq) bad("the probe never tried the write outside the worktree and the grants, so the run does not show that the host denies it");
    else if (outReply?.behavior !== "deny") bad(`the write outside the worktree was not denied on the child's stdin (answer ${outReply?.behavior ?? "none"})`);
    else if (final?.outsideExists !== false) bad("a file exists outside the worktree after the write was denied");
    else good(`the write outside the worktree and the grants was denied by the host (${flat(outReply.message ?? "")}), never held, and nothing was written`);
  }

  // The write inside the worktree, when the probe was asked for one: an agent must be able to work where it is put.
  if (setup.inside) {
    const use = uses.find((u) => u.name === "Write" && rel(u.input?.file_path) === rel(setup.inside));
    const insideReq = approvals.find((r) => r.d.tool === "Write" && rel(r.d.input.file_path) === rel(setup.inside));
    const insideRes = use ? results.find((b) => b.tool_use_id === use.id) : null;
    if (!use) bad("the probe never tried the write inside its worktree");
    else if (!insideRes || insideRes.is_error === true || !final?.insideExists) bad(`a write inside the worktree failed: ${flat(insideRes?.content ?? "no tool_result")}`);
    else good(`a write inside the worktree works, and it ${insideReq ? "raised a permission request too (default mode asks for every Write)" : "raised no permission request"}`);
  }

  // The agent's own ticket file (den-v1 loop, the live den run of 2026-10-10): it is outside the worktree, and the
  // adapter's one allow rule is what lets the agent read it without asking the user. A request here is TICKET RULE.
  let ticketRule = false;
  if (setup.ticket) {
    const isTicket = (p) => typeof p === "string" && path.resolve(setup.worktree, p) === setup.ticket;
    const use = uses.find((u) => u.name === "Read" && isTicket(u.input?.file_path));
    const asked = approvals.find((r) => r.d.tool === "Read" && isTicket(r.d.input.file_path));
    const res = use ? results.find((b) => b.tool_use_id === use.id) : null;
    if (!use) bad("the probe never read its ticket file");
    else if (asked) {
      ticketRule = true;
      bad("TICKET RULE: reading the agent's own ticket file raised a permission request; the inline allow rule did not apply");
    } else if (!res || res.is_error === true) bad(`the read of the ticket file failed: ${flat(res?.content ?? "no tool_result")}`);
    else good("the agent read its ticket file in the main checkout, and it raised no permission request");
  }
  // The control for that rule: the board file next to the ticket. The harness denies it, so only the request matters.
  if (setup.neighbour) {
    const isOther = (p) => typeof p === "string" && path.resolve(setup.worktree, p) === setup.neighbour;
    if (!uses.some((u) => u.name === "Read" && isOther(u.input?.file_path))) bad("the probe never tried the neighbouring board file, so the run does not show how narrow the rule is");
    else if (approvals.some((r) => r.d.tool === "Read" && isOther(r.d.input.file_path))) good("reading the neighbouring board file raised a permission request: the rule opens the ticket and nothing next to it");
    else bad("reading the neighbouring board file raised no permission request, so the run does not show that the rule is what let the ticket through");
  }

  const last = out.findLast((r) => r.o.type === "result")?.o;
  const costUsd = typeof last?.total_cost_usd === "number" ? last.total_cost_usd : null;
  if (!last) bad("no result line");
  else if (last.subtype !== "success" || last.is_error === true) bad(`the turn did not succeed: result ${last.subtype}${last.is_error ? " (is_error)" : ""}`);
  else if (costUsd === null) bad("the result line has no numeric total_cost_usd");
  else good(`result: success, total_cost_usd ${costUsd}, ${last.num_turns ?? "?"} turns, ${last.duration_ms ?? "?"} ms`);
  if (final?.agentState !== "done" || final?.endedByItself !== true) bad(`the agent did not end done by itself after its result line (state ${final?.agentState ?? "?"}${final?.endedByItself ? "" : ", still running when the harness gave up"})`);
  else good("the agent ended done by itself: the host closed the child's stdin after the result line");
  // den-v1 loop S5: the message sent while the request was held. The host marks a message received from the CLI's
  // replay of it, so a run in which the CLI does not replay it with its id is a no-go (`messageRule: true`).
  const said = check("message");
  let messageRule = false;
  if (said) {
    const turns = out.filter((r) => r.o.type === "result").map((r) => r.o);
    const replays = out.filter((r) => r.o.type === "user" && r.o.isReplay === true);
    const replay = replays.find((r) => r.o.uuid === said.messageId);
    const states = obs.filter((o) => o.type === "sse" && o.data?.type === "transcript" && o.data.entry?.messageId === said.messageId).map((o) => o.data.entry.status);
    if (said.status !== 202 || typeof said.messageId !== "string") bad(`the bridge refused the message: ${said.status} ${said.error ?? ""}`);
    else if (!inn.some((r) => r.o.type === "user" && r.o.uuid === said.messageId)) bad("the message never reached the child's stdin");
    else if (!replay) {
      messageRule = true;
      bad(`MESSAGE RULE: the CLI did not replay the message with the id it was written with (${replays.length} replay line(s) seen). The host marks a message received from that replay, so stop and fix this.`);
    } else if (states.at(-1) !== "applied") bad(`the bridge did not mark the message received (states ${states.join(" -> ") || "none"})`);
    else good(`message: written to the child's stdin while the request was held, replayed by the CLI with its id, marked ${states.join(" -> ")}`);
    if (replay) {
      const heard = typeof last?.result === "string" && typeof said.word === "string" && last.result.includes(said.word);
      good(`note: the replay came ${res && replay.i < res.i ? "before" : "after"} the held tool's result; ${turns.length} result line(s) (${turns.length === 1 ? "the message joined the running turn" : "the message was a further turn"}); the final reply ${heard ? "holds" : "does not hold"} the word the message asked for`);
      if (turns.length > 1) good(`note: totals per result line: ${turns.map((t) => `${t.total_cost_usd} USD, ${t.usage?.output_tokens ?? "?"} output tokens, ${t.num_turns ?? "?"} turns`).join("; ")}`);
    }
  }
  const others = obs.filter((o) => o.type === "check" && o.check === "denied-other");
  if (others.length) good(`note: ${others.length} other request(s) were denied by the harness: ${others.map((o) => o.tool).join(", ")}`);
  return done({ costUsd, ...(messageRule ? { messageRule: true } : {}), ...(ticketRule ? { ticketRule: true } : {}) });
}

// ---- the run ----------------------------------------------------------------------------------

/**
 * ctx: { bin, parentEnv, timeoutMs, model } (conformance.mjs's context). Returns { result, captures }.
 * options: repo (a makeLiveRepo result; removed at the end), exitWaitMs (how long the agent has to end after its
 * result line), killGraceMs (host policy, tests only), message (false leaves the S5 message out).
 */
export async function runLive(ctx, _outDir, { repo, exitWaitMs = 20_000, killGraceMs, message = true } = {}) {
  const word = (kind) => `LIVE-${kind}-${randomBytes(3).toString("hex").toUpperCase()}`;
  repo ??= makeLiveRepo({ model: ctx.model, insideBody: word("INSIDE"), ticketWord: word("TICKET") });
  const work = mkdtempSync(path.join(tmpdir(), "den-live-wrap-"));
  const logFile = path.join(work, "cli.jsonl");
  const errFile = path.join(work, "cli.stderr.txt");
  const notes = [];
  const note = (obj) => notes.push({ t: Date.now(), raw: JSON.stringify(obj), obj });
  const tee = makeTee({ dir: work, realBin: ctx.bin, logFile, errFile });
  // The real run goes through the enforced launcher, like production; only the stub tests pass ctx.launcher.
  const runtime = createClaudeRuntime({ env: { ...ctx.parentEnv, DEN_CLAUDE_BIN: tee }, ...(ctx.launcher ? { launcher: ctx.launcher } : {}) }); // the runtime applies the env allowlist
  let bridge;
  let sse;
  try {
    const launchCode = randomBytes(32).toString("hex");
    bridge = await startBridge({ root: repo.dir, port: 0, auth: { launchCode }, runtime, ...(killGraceMs ? { policy: { killGraceMs } } : {}) });
    const session = await call(bridge, "POST", "/session", { body: { code: launchCode } });
    const token = session.body?.token;
    if (typeof token !== "string") throw new Error(`the bridge refused the launch code: ${session.status}`);
    sse = openSse(bridge, (event, data) => note({ type: "sse", event, data }));
    const started = await bridge.host.start({ ref: LIVE_REF, role: LIVE_ROLE, grants: [{ kind: "path", value: repo.grant }] });
    if (!started.ok) note({ type: "check", check: "start-failed", status: started.status, error: started.error });
    else {
      const id = started.agent.id;
      const worktree = realpathSync(path.join(repo.dir, started.agent.worktree));
      const inside = repo.insideBody === null ? null : path.join(worktree, INSIDE_FILE);
      note({ type: "check", check: "setup", agentId: id, worktree, branch: started.agent.branch, target: repo.target, body: repo.body, inside, ...(repo.ticket ? { ticket: repo.ticket, neighbour: repo.neighbour } : {}) });
      const handled = new Set();
      const deadline = Date.now() + ctx.timeoutMs;
      let allowedTarget = false;
      let resultAt = null;
      let endedByItself = false;
      while (Date.now() < deadline) {
        const state = (await call(bridge, "GET", "/state")).body ?? {};
        const me = (state.agents ?? []).find((a) => a.id === id);
        for (const ap of (state.approvals ?? []).filter((a) => a.agentId === id && a.state === "pending" && !handled.has(a.id))) {
          handled.add(ap.id);
          const full = (await call(bridge, "GET", `/approvals/${ap.id}`, { token })).body ?? {};
          const asked = ap.tool === "Write" && typeof full.input?.file_path === "string" ? path.resolve(worktree, full.input.file_path) : null;
          const decide = (decision) => call(bridge, "POST", `/approvals/${ap.id}`, { token, body: { decision } });
          if (asked === repo.target && !allowedTarget) {
            allowedTarget = true;
            note({ type: "check", check: "held", approvalId: ap.id, tool: ap.tool, agentState: me?.state ?? null, input: full.input, fileExists: existsSync(repo.target), cliLines: readTee(logFile, errFile).main.lines.length });
            if (message) {
              const word = `LIVE-SAID-${randomBytes(3).toString("hex").toUpperCase()}`;
              const sent = await call(bridge, "POST", `/agents/${id}/message`, { token, body: { text: `One more instruction from the user: end your final reply with the word ${word}.` } });
              note({ type: "check", check: "message", status: sent.status, messageId: sent.body?.messageId ?? null, word, ...(sent.body?.error ? { error: sent.body.error } : {}) });
            }
            note({ type: "check", check: "decided", approvalId: ap.id, decision: "allow", status: (await decide("allow")).status });
          } else if (inside !== null && asked === inside) {
            note({ type: "check", check: "inside-allowed", approvalId: ap.id, tool: ap.tool, status: (await decide("allow")).status });
          } else {
            note({ type: "check", check: "denied-other", approvalId: ap.id, tool: ap.tool, status: (await decide("deny")).status });
          }
        }
        if (me && ENDED.includes(me.state)) {
          endedByItself = true;
          break;
        }
        if (resultAt === null && readTee(logFile, errFile).main.lines.some((l) => l.obj?.type === "result")) resultAt = Date.now();
        if (resultAt !== null && Date.now() - resultAt > exitWaitMs) break;
        await sleep(100);
      }
      const me = ((await call(bridge, "GET", "/state")).body?.agents ?? []).find((a) => a.id === id);
      // The setup names the outside path once the child has asked to write it, so the evaluator scores that step (the evaluator reads
      // it from the setup check). A run in which the child never asks is scored as before.
      const tried = readTee(logFile, errFile).main.lines.some(({ obj: o }) => (o?.type === "control_request" && o.request?.input?.file_path === repo.outside) || (o?.type === "assistant" && Array.isArray(o.message?.content) && o.message.content.some((b) => b?.type === "tool_use" && b.input?.file_path === repo.outside)));
      const setupNote = notes.find((n) => n.obj.check === "setup");
      if (tried && setupNote) {
        setupNote.obj.outside = repo.outside;
        setupNote.raw = JSON.stringify(setupNote.obj);
      }
      const read = (file) => (file && existsSync(file) ? readFileSync(file, "utf8").trim() : null);
      note({
        type: "check", check: "final", agentState: me?.state ?? null, endedByItself,
        fileExists: existsSync(repo.target), bodyMatches: read(repo.target) === repo.body, outsideExists: existsSync(repo.outside),
        ...(inside === null ? {} : { insideExists: existsSync(inside), insideBodyMatches: read(inside) === repo.insideBody }),
      });
    }
  } finally {
    await sleep(150); // let the last SSE frames land
    sse?.close();
    await bridge?.close();
  }
  const captures = { ...readTee(logFile, errFile), bridge: { lines: notes, exit: null, stderr: "" } };
  repo.cleanup();
  rmSync(work, { recursive: true, force: true });
  return { result: evaluateLive(captures), captures: scrubLive(captures) };
}
