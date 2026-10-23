#!/usr/bin/env node
// Manual conformance script for the bridge's Claude adapter (ADR 0016, spikes S1 to S7; ticket
// organism-infra/105). It runs a real headless `claude -p` stream-json child per spike on the
// owner's login, so it is NOT a CI test: an agent's sandbox has no login. Each spike prints go or
// no-go with evidence; raw stdout lines are saved as fixtures for the adapter's parser tests.
//
// Usage: node apps/bridge/agents/conformance.mjs [--spike S1,S3] [--out <dir>] [--model <m>]
//          [--timeout <seconds>] [--extra-env NAME]... [--dry-run] [--help]
//
// Every child runs in a throwaway temp directory (S6b: a throwaway worktree of --repo; its comparison
// probe also runs once in --repo itself, restoring .claude/settings.local.json) with a generated role file
// `probe` (agents are chosen with `--agent <role>`), on a cheap model by default. The child's
// environment is the adapter's allowlist (decision 6.6), never a copy of this process's.
//
// Written for the new vocabulary (agent, role): the role is what `--agent` selects.
import { spawn, execFile, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID, randomBytes } from "node:crypto";
import net from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir, homedir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runLive } from "./conformance-live.mjs";
import { runContainer } from "./conformance-container.mjs";
import { runLimits, runWall } from "./conformance-wall.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE_SCRIPT = path.resolve(HERE, "../../../scripts/usage-claude.mjs");

// ---- Pure builders -------------------------------------------------------------------------

// ADR 0016 decision 3: the adapter never constructs a permission-broadening flag. `--permission-mode`
// is listed whole because its only broadening value is `bypassPermissions` and the adapter has no
// use for any other.
export const FORBIDDEN_FLAGS = ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--permission-mode"];

const ENV_ALLOW = ["PATH", "HOME", "DEN_CLAUDE_BIN"];

// The child's environment: an allowlist (PATH, HOME, locale, DEN_CLAUDE_BIN), never a copy.
export function buildChildEnv(parentEnv, extraNames = []) {
  const env = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (ENV_ALLOW.includes(key) || key === "LANG" || key.startsWith("LC_") || extraNames.includes(key)) env[key] = value;
  }
  return env;
}

export function buildArgs({ sessionId, resume, agent, permissionPromptTool, settings, allowedTools, model, extraArgs = [] } = {}) {
  for (const arg of extraArgs) {
    if (FORBIDDEN_FLAGS.some((f) => arg === f || arg.startsWith(`${f}=`))) throw new Error(`forbidden flag: ${arg}`);
  }
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  if (resume) args.push("--resume", resume);
  else if (sessionId) args.push("--session-id", sessionId);
  if (agent) args.push("--agent", agent);
  if (model) args.push("--model", model);
  if (permissionPromptTool) args.push("--permission-prompt-tool", permissionPromptTool);
  if (settings) args.push("--settings", settings);
  if (allowedTools?.length) args.push("--allowedTools", allowedTools.join(","));
  return [...args, ...extraArgs];
}

// Hypothesised shapes (ADR 0016: undocumented, unverified). S1 and S3 confirm or refute them.
export function userMessageLine(text) {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

export function controlResponseLine(requestId, decision, updatedInput) {
  if (decision !== "allow" && decision !== "deny") throw new Error("decision must be allow or deny");
  const response =
    decision === "allow"
      ? { behavior: "allow", updatedInput: updatedInput ?? {} }
      : { behavior: "deny", message: "Denied by the conformance script" };
  return JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } }) + "\n";
}

export function parseCaptureLines(rawLines) {
  return rawLines.map(({ t, raw }) => {
    let obj = null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") obj = parsed;
    } catch {
      // not JSON: kept raw
    }
    return { t, raw, obj };
  });
}

// Fixtures are committed, so the owner's home paths and username must not survive in them. Homes are
// replaced longest first (a home contains the username), then the username; neither replacement holds
// a quote or backslash, so JSON lines stay valid. A username under 3 characters is left alone: replacing
// it everywhere would mangle unrelated text.
export function scrubText(text, { homes = [], username } = {}) {
  let out = text;
  const roots = homes
    .filter((h) => typeof h === "string")
    .map((h) => h.replace(/\/+$/, ""))
    .filter((h) => h.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const h of new Set(roots)) out = out.split(h).join("~");
  if (typeof username === "string" && username.length >= 3) out = out.split(username).join("<user>");
  return out;
}

// ---- Capture accessors ---------------------------------------------------------------------

const objs = (cap) => cap.lines.filter((l) => l.obj).map((l) => ({ t: l.t, ...l.obj, obj: l.obj }));
const blocks = (o) => (Array.isArray(o.message?.content) ? o.message.content : []);
const initOf = (cap) => objs(cap).find((o) => o.type === "system" && o.subtype === "init");
const resultsOf = (cap) => objs(cap).filter((o) => o.type === "result");
const toolUses = (cap) =>
  objs(cap).flatMap((o) => (o.type === "assistant" ? blocks(o).filter((b) => b.type === "tool_use").map((b) => ({ t: o.t, ...b, parent: o.parent_tool_use_id ?? null })) : []));
const toolResults = (cap) =>
  objs(cap).flatMap((o) => (o.type === "user" ? blocks(o).filter((b) => b.type === "tool_result").map((b) => ({ t: o.t, ...b, parent: o.parent_tool_use_id ?? null })) : []));
const controlRequests = (cap) => objs(cap).filter((o) => o.type === "control_request");
const flat = (c) => (typeof c === "string" ? c : JSON.stringify(c ?? ""));
const verdict = (spike, ok, evidence, extra = {}) => ({ spike, verdict: ok ? "go" : "no-go", evidence, ...extra });

// ---- Evaluators (pure: captured output in, go or no-go out) ---------------------------------

export function evaluateS1(cap, { sessionId, canary, marker, exitedOnEof }) {
  const ev = [];
  const init = initOf(cap);
  const results = resultsOf(cap);
  const last = results.at(-1);
  const resultText = flat(last?.result);
  let ok = true;
  const check = (pass, good, bad) => {
    ev.push(pass ? good : bad);
    if (!pass) ok = false;
  };
  check(Boolean(init), "system/init emitted after the first stdin user message", "no system/init line on stdout");
  if (init) {
    check(init.session_id === sessionId, `init.session_id equals the --session-id (${sessionId})`, `init.session_id is ${init.session_id}, not the --session-id ${sessionId}`);
    if (init.agent !== undefined) ev.push(`init reports agent: ${JSON.stringify(init.agent)}`);
  }
  const loggedOut = last && (last.is_error || /not logged in|\/login/i.test(resultText)) && /login/i.test(resultText);
  check(Boolean(last) && !last.is_error, "a result line arrived without an error (logged in, first stdin message accepted)", loggedOut ? "child is not logged in (result mentions login)" : `no successful result line${last ? `: ${resultText.slice(0, 160)}` : ""}`);
  check(resultText.includes(marker), `reply carries the role marker ${marker}: --agent was honoured under -p`, `reply lacks the role marker ${marker}: --agent not shown to take effect`);
  const leaked = cap.lines.some((l) => canary && (l.raw ?? JSON.stringify(l.obj ?? "")).includes(canary));
  check(!leaked, "canary variable did not reach the child", "canary value appeared in the child's output: the environment allowlist leaked");
  check(exitedOnEof === true, "child exited on stdin EOF", "child did not exit on stdin EOF");
  return verdict("S1", ok, ev);
}

export function evaluateS2(cap, { sleepMs, subagentCapture }) {
  const ev = [];
  const use = toolUses(cap).find((u) => !u.parent);
  const res = use && toolResults(cap).find((r) => r.tool_use_id === use.id);
  let ok = false;
  if (!use || !res) {
    ev.push("no tool_use and tool_result pair on the stdout stream");
  } else {
    const gap = res.t - use.t;
    const latency = sleepMs - gap;
    ok = latency < 1000;
    ev.push(`tool_use line arrived ${gap} ms before its tool_result for a ${sleepMs} ms command, so delivery latency is about ${latency} ms (go needs under 1000)`);
  }
  let tailerNeeded = null;
  if (!subagentCapture) {
    ev.push("subagent activity: not tested");
  } else if (!toolUses(subagentCapture).some((u) => !u.parent && /^(Task|Agent)$/.test(u.name))) {
    ev.push("subagent activity: not exercised (the model never started a subagent); rerun if the tailer decision matters");
  } else if (objs(subagentCapture).some((o) => o.parent_tool_use_id)) {
    tailerNeeded = false;
    ev.push("subagent activity: visible on stdout (lines carry parent_tool_use_id); the transcript tailer is not needed");
  } else {
    tailerNeeded = true;
    ev.push("subagent activity: not visible on stdout; the transcript tailer is needed");
  }
  return verdict("S2", ok, ev, { tailerNeeded });
}

export function evaluateS3({ allow, deny }, { allowBody, denyBody, allowFileExists, denyFileExists }) {
  const ev = [];
  let ok = true;
  const check = (pass, good, bad) => {
    ev.push(pass ? good : bad);
    if (!pass) ok = false;
  };
  const reqA = controlRequests(allow).find((r) => r.request?.tool_name === "Write");
  const reqD = controlRequests(deny).find((r) => r.request?.tool_name === "Write");
  check(Boolean(reqA), "allow run: a control_request was emitted for a tool outside the allowlist", "allow run: no control_request on stdout");
  check(Boolean(reqD), "deny run: a control_request was emitted", "deny run: no control_request on stdout");
  if (reqA) {
    const input = reqA.request?.input;
    check(flat(input).includes(allowBody), "control_request carries the full tool input (the written content is present)", "control_request input lacks the written content: input is not complete");
    ev.push(`request.subtype: ${reqA.request?.subtype ?? "absent"}`);
    ev.push(`control_request shape: ${JSON.stringify({ type: reqA.type, request_id: reqA.request_id, subtype: reqA.request?.subtype, tool_name: reqA.request?.tool_name, input_keys: Object.keys(input ?? {}) })}`);
  }
  if (reqD) check(flat(reqD.request?.input).includes(denyBody), "deny run: control_request carries the full input", "deny run: control_request input lacks the content");
  check(allowFileExists === true, "allow was honoured: the file was written", "allow was not honoured: the file does not exist");
  check(denyFileExists === false, "deny was honoured: the file was not written", "deny was not honoured: the file exists");
  return verdict("S3", ok, ev, { shapes: { controlRequest: reqA ?? null, requestSubtype: reqA?.request?.subtype ?? null } });
}

export function evaluateS4({ killed, resumed }, { killedAt, transcriptFound, sessionId }) {
  const ev = [];
  let ok = true;
  const check = (pass, good, bad) => {
    ev.push(pass ? good : bad);
    if (!pass) ok = false;
  };
  const ended = killed.exit ?? null;
  const took = ended ? ended.t - killedAt : null;
  check(Boolean(ended) && took < 5000, `SIGTERM ended the running child in ${took} ms (${ended?.signal ?? `code ${ended?.code}`})`, `child did not end within 5 s of SIGTERM${ended ? ` (took ${took} ms)` : ""}`);
  check(transcriptFound === true, `transcript ${sessionId}.jsonl is on disk after the kill`, "no transcript file found after the kill");
  const r = resultsOf(resumed).at(-1);
  check(Boolean(r) && !r.is_error, "--resume reopened the session and answered", `--resume did not work: ${flat(r?.result).slice(0, 160) || "no result line"}`);
  const init = initOf(resumed);
  if (init) ev.push(`resumed init.session_id ${init.session_id === sessionId ? "equals" : `differs from (${init.session_id} vs)`} the original ${sessionId}`);
  if (r) ev.push(`resumed reply mentions the interrupted command: ${/sleep/i.test(flat(r.result))}`);
  return verdict("S4", ok, ev);
}

// Billing is never a no-go by measurement: a reading that did not move proves nothing (integer
// percent, a trivial run). The user confirms on the account's usage page either way.
export function evaluateS5({ before, after, costUsd }) {
  const ev = [];
  const b = before?.["5-hour"];
  const a = after?.["5-hour"];
  let moved = false;
  if (!b || !a) {
    ev.push("a usage reading was unavailable (before or after): cannot compare");
  } else if (b.resets_at !== a.resets_at) {
    ev.push(`the 5-hour window rolled over between readings (${b.resets_at} to ${a.resets_at}): not comparable`);
  } else {
    ev.push(`5-hour plan usage: ${b.percent}% -> ${a.percent}%`);
    moved = a.percent > b.percent;
    if (!moved) ev.push("the reading did not move; a trivial run can fall under the integer rounding, so this does not show separate billing");
  }
  if (costUsd !== undefined && costUsd !== null) ev.push(`the result line reports total_cost_usd ${costUsd}`);
  ev.push("the account's usage page must still be checked by the user (decision 2); until then the billing question stays unconfirmed in the ADR");
  return { spike: "S5", verdict: moved ? "go" : "unconfirmed", evidence: ev };
}

export function evaluateS6(cap, { allowedExists, deniedExists }) {
  const ev = [];
  const writes = toolUses(cap).filter((u) => u.name === "Write");
  const deniedAttempt = writes.some((u) => String(u.input?.file_path ?? "").endsWith(".claude/probe.txt"));
  const allowedAttempt = writes.some((u) => String(u.input?.file_path ?? "").endsWith("allowed.txt"));
  ev.push(`attempted writes: allowed.txt ${allowedAttempt}, .claude/probe.txt ${deniedAttempt}`);
  ev.push(`on disk: allowed.txt ${allowedExists}, .claude/probe.txt ${deniedExists}`);
  if (deniedExists) {
    ev.push("the --settings deny did NOT outrank the project allow (or was ignored)");
    return verdict("S6", false, ev);
  }
  if (!deniedAttempt) {
    ev.push("the model never attempted the denied write, so precedence is untested");
    return { spike: "S6", verdict: "unconfirmed", evidence: ev };
  }
  if (!allowedExists) {
    ev.push("the project's allow did not apply: --settings replaced the project permissions instead of merging, or the allow rule did not match");
    return verdict("S6", false, ev);
  }
  ev.push("--settings merged with the project settings, and its deny outranked the project allow");
  return verdict("S6", true, ev);
}

// The UI wording depends on the behaviour, so the result names it. Go means the message is not
// lost and does not break the running tool call; the exact behaviour is recorded either way.
export function evaluateS7(cap, { sentAt }) {
  const ev = [];
  const use = toolUses(cap)[0];
  const res = use && toolResults(cap).find((r) => r.tool_use_id === use.id);
  const results = resultsOf(cap);
  const mentionsSecond = results.some((r) => /second/i.test(flat(r.result)));
  const interrupted = res && (res.is_error || /interrupt/i.test(flat(res.content)));
  let behavior;
  if (interrupted) behavior = "interrupted";
  else if (results.length >= 2 && /second/i.test(flat(results.at(-1).result))) behavior = "queued-new-turn";
  else if (results.length === 1 && mentionsSecond) behavior = "merged-into-running-turn";
  else behavior = "dropped";
  if (res) ev.push(`running tool call: result at ${res.t} ms (message written at ${sentAt} ms), error ${Boolean(res.is_error)}`);
  ev.push(`result lines: ${results.length}; a later reply mentions the second message: ${mentionsSecond}`);
  ev.push(`behaviour: ${behavior}`);
  return verdict("S7", behavior === "queued-new-turn" || behavior === "merged-into-running-turn", ev, { behavior });
}

// S8 (ADR 0016 decision 7): the child's own messaging socket must not be a second way to answer a
// permission request. Outcome a: no socket advertised. b: it exists but nothing on it takes effect.
// c: messages or interrupts take effect (residual risk, recorded). d: a control_response over the
// socket answers a pending request (no-go). A disable candidate counts only when the socket is gone
// and the child still logs in.
export function evaluateS8({ init, stat, connect, probes = [], disable = [] }) {
  const ev = [];
  const socketPath = init?.socketPath ?? null;
  let dirForeign = false;
  ev.push(`init.messaging_socket_path: ${socketPath ?? "absent"}`);
  ev.push(`init.capabilities: ${(init?.capabilities ?? []).join(", ") || "none listed"}`);
  if (socketPath) {
    if (stat) {
      // Reaching a socket needs read or write on it; reaching its directory needs any group or other bit.
      const open = (stat.mode & 0o066) !== 0 || (stat.dirMode & 0o077) !== 0;
      ev.push(`socket stat: type ${stat.type}, mode ${(stat.mode & 0o777).toString(8).padStart(4, "0")}, uid ${stat.uid} (this process ${stat.ownUid}), directory uid ${stat.dirUid ?? "unknown"}, directory mode ${(stat.dirMode & 0o777).toString(8).padStart(4, "0")}`);
      ev.push(open ? "access for group or others: OPEN (the socket or its directory is reachable by group members or other users)" : "access for group or others: none (owner only)");
      dirForeign = typeof stat.dirUid === "number" && typeof stat.ownUid === "number" && stat.dirUid !== stat.ownUid;
    } else {
      ev.push("socket stat: unavailable; access for others unknown");
    }
    if (!connect) ev.push("connect: not attempted");
    else ev.push(connect.connected ? "connect: accepted" : `connect: refused (${connect.error ?? "no error given"})`);
    if (connect?.unsolicited) ev.push(`unsolicited bytes on the socket right after connecting (event leak): ${JSON.stringify(connect.unsolicited.slice(0, 300))}`);
    for (const p of probes) ev.push(`probe ${p.name}: sent ${p.shape}; reply ${p.reply === null || p.reply === undefined ? "none (silence)" : JSON.stringify(String(p.reply).slice(0, 200))}; effect ${p.effect ? "YES" : "no"}`);
  }
  let outcome;
  let verdictName;
  if (!socketPath) {
    outcome = "a";
    verdictName = "go";
    ev.push("outcome a: the child advertises no messaging socket");
  } else if (!connect) {
    outcome = null;
    verdictName = "unconfirmed";
    ev.push("no connection attempt was recorded, so the socket is untested");
  } else if (!connect.connected) {
    outcome = "b";
    verdictName = "go";
    ev.push("outcome b: the socket refuses connections");
  } else if (probes.some((p) => p.name.startsWith("control-response") && p.effect)) {
    outcome = "d";
    verdictName = "no-go";
    ev.push(`outcome d: a control_response over the socket answered a pending permission request (${probes.filter((p) => p.name.startsWith("control-response") && p.effect).map((p) => p.name).join(", ")})`);
  } else if (probes.some((p) => p.effect)) {
    outcome = "c";
    verdictName = "residual";
    ev.push(`outcome c: ${probes.filter((p) => p.effect).map((p) => p.name).join(", ")} took effect over the socket; a control_response did not (residual risk)`);
  } else if (connect.unsolicited) {
    outcome = "c";
    verdictName = "residual";
    ev.push("outcome c: no probe took effect, but the socket streams unsolicited bytes (an event leak), so it is not a plain go");
  } else if (probes.length === 0 || probes.every((p) => p.reply === null || p.reply === undefined)) {
    outcome = null;
    verdictName = "unconfirmed";
    ev.push("the socket accepted a connection but stayed silent and no probe showed an effect: the shapes tried may simply be wrong");
  } else {
    outcome = "b";
    verdictName = "go";
    ev.push("outcome b: the socket answers every probe with an error and no probe took effect");
  }
  if (verdictName === "go" && dirForeign) {
    verdictName = "no-go";
    ev.push(`the socket directory is owned by uid ${stat.dirUid}, not this process's uid ${stat.ownUid}: its owner could swap the socket, so this is not a go`);
  }
  const result = { spike: "S8", verdict: verdictName, outcome, evidence: ev };
  if (verdictName !== "go") {
    const hit = disable.find((c) => c.socketGone && c.loggedIn);
    for (const c of disable) ev.push(`disable candidate ${c.via}: socket gone ${Boolean(c.socketGone)}, child still logs in ${Boolean(c.loggedIn)}`);
    if (hit) {
      result.verdict = "go";
      result.disabledBy = hit.via;
      ev.push(`go because ${hit.via} removes the socket and the child still works`);
    }
  }
  return result;
}

// S4b: does ending the child (stdin EOF, SIGTERM, SIGKILL) in the middle of a tool call leave the
// tool's process running? Survivors are counts of the in-flight tool's processes (runS4b). When the child-only signals
// leave survivors the adapter must signal the process group, so the group step decides group-kill;
// survivors even after the group signals are a no-go (the tool escaped its group).
export function evaluateS4b({ eof, term, kill, group = null, unstarted = [], notes = [] }) {
  const ev = [];
  ev.push(`stdin EOF mid-call: child ${eof.exited ? "exited" : "did NOT exit"}, ${eof.survivors} tool process(es) left`);
  ev.push(`SIGTERM: child ${term.exited ? `exited after ${term.exitMs} ms` : "did not exit"}, tool processes left at 2 s ${term.survivorsAt2s}, at 10 s ${term.survivorsAt10s}`);
  ev.push(`SIGKILL: ${kill.survivors} tool process(es) left`);
  if (unstarted.length) {
    ev.push(`the tool call was not shown in flight in: ${unstarted.join(", ")} (survivor counts there prove nothing)`);
    ev.push(...notes);
    ev.push("setup-invalid: no go or no-go is possible until a run shows the tool really running when the signal lands");
    return { spike: "S4b", verdict: "setup-invalid", decision: null, evidence: ev };
  }
  if (!eof.exited) {
    ev.push("the child did not exit on stdin EOF in the middle of a tool call: closing stdin is not a safe way to end it");
    return { spike: "S4b", verdict: "no-go", decision: null, evidence: ev };
  }
  const left = eof.survivors > 0 || term.survivorsAt2s > 0 || term.survivorsAt10s > 0 || kill.survivors > 0 || !term.exited;
  let result;
  if (!left) {
    ev.push("no tool process outlived any child-only signal: ending the child alone is enough");
    result = { spike: "S4b", verdict: "go", decision: "plain" };
  } else if (!group) {
    ev.push("a tool process outlived a child-only signal and the group signal was not tried");
    result = { spike: "S4b", verdict: "no-go", decision: "group-kill" };
  } else {
    ev.push(`process-group SIGTERM left ${group.term.survivors}, then SIGKILL left ${group.kill.survivors}`);
    const cleared = group.kill.survivors === 0;
    ev.push(cleared ? "a process-group signal clears the tool process: the adapter signals the group (group-kill)" : "a tool process outlived the group signals: it left its process group");
    result = { spike: "S4b", verdict: cleared ? "go" : "no-go", decision: "group-kill" };
  }
  return { ...result, evidence: ev };
}

// The S6b deny target: a path in the worktree and outside .claude/, so the result shows our deny rule
// and not the CLI's built-in safetyCheck (which refuses any .claude/ path whatever the rules say).
export const S6B_DENY_TARGET = "denied.txt";

// S6b: --setting-sources project,local in a real worktree (the production shape). Go needs the
// project-local allow to apply, the inline deny to outrank it, and no user-scope MCP server or
// plugin to load. A "not trusted" complaint with the allow unapplied is unconfirmed, not no-go.
export function evaluateS6b(cap, { allowedExists, deniedExists }) {
  const ev = [];
  const writes = toolUses(cap).filter((u) => u.name === "Write");
  const deniedAttempt = writes.some((u) => String(u.input?.file_path ?? "").endsWith(`/${S6B_DENY_TARGET}`));
  ev.push(`on disk: allowed.txt ${allowedExists}, ${S6B_DENY_TARGET} ${deniedExists}`);
  const init = initOf(cap);
  const badMcp = (init?.mcp_servers ?? []).filter((s) => s.source === "user" || s.source === "claudeai");
  const badPlugins = (init?.plugins ?? []).filter((p) => p.path !== "builtin");
  for (const s of badMcp) ev.push(`MCP server from the owner's config loaded: ${s.name} (source ${s.source})`);
  for (const p of badPlugins) ev.push(`plugin loaded from outside the project: ${p.name} (${p.path})`);
  const trustBlame = /not trusted|untrusted/i.test(cap.stderr ?? "");
  const out = (v, ...more) => {
    ev.push(...more);
    return { spike: "S6b", verdict: v, evidence: ev };
  };
  if (deniedExists) return out("no-go", "the inline --settings deny did NOT outrank the allow (or was ignored)");
  if (!init) return out("unconfirmed", "no init line: the child did not start, so the setting sources are unchecked");
  if (badMcp.length || badPlugins.length) return out("no-go", "--setting-sources project,local did not keep user and plugin config out");
  if (!allowedExists) {
    if (trustBlame) return out("unconfirmed", "stderr says the worktree workspace is not trusted, so project settings may be ignored there: trust in the worktree is unverified");
    return out("no-go", "the project-local allow did not apply, so --settings replaced it or the rule did not match");
  }
  if (!deniedAttempt) return out("unconfirmed", "the model never attempted the denied write, so precedence is untested");
  return out("go", "the project-local allow applied, the inline deny outranked it, and no user or plugin config loaded");
}

// S3b is optional and never gating: three open questions about --permission-prompt-tool stdio.
export function evaluateS3b({ subagent, wait, omitted }, { waitMs, omittedFileExists }) {
  const ev = [];
  const subReqs = controlRequests(subagent);
  const identified = subReqs.some((r) => r.parent_tool_use_id);
  const sawTask = toolUses(subagent).some((u) => u.name === "Task" || u.name === "Agent");
  const subagentRequest = !subReqs.length ? "absent" : identified ? "reaches-parent-identified" : "reaches-parent-unidentified";
  ev.push(`subagent permission request: ${subagentRequest}${subReqs.length ? ` (parent_tool_use_id ${identified ? "present" : "absent"})` : ""}`);
  const waitReq = controlRequests(wait)[0];
  let waitBehavior = null;
  if (waitReq) {
    const after = wait.lines.filter((l) => l.obj && l.t >= waitReq.t && l.obj !== waitReq.obj);
    const answered = after.some((l) => l.obj.type === "result" || (l.obj.type === "user" && Array.isArray(l.obj.message?.content) && l.obj.message.content.some((b) => b.type === "tool_result")));
    waitBehavior = answered ? "denied" : wait.exit ? "exited" : "hung";
    ev.push(`unanswered request, waited ${waitMs} ms: ${waitBehavior}`);
  } else {
    ev.push("held request: no control_request was raised, so the question stays open");
  }
  const omittedReq = controlRequests(omitted)[0];
  let omittedBehavior = null;
  if (omittedReq) {
    omittedBehavior = omittedFileExists ? "honoured" : "rejected";
    ev.push(`allow without updatedInput: ${omittedBehavior}`);
  } else {
    ev.push("updatedInput omitted: no control_request was raised, so the question stays open");
  }
  const open = !waitReq || !omittedReq || (subagentRequest === "absent" && !sawTask);
  return { spike: "S3b", verdict: open ? "unconfirmed" : "go", behavior: { subagentRequest, wait: waitBehavior, updatedInputOmitted: omittedBehavior }, evidence: ev };
}

// ---- Production shape (ADR 0016 6.10) and the setup guard ------------------------------------

// Every child keeps the owner's user-scope settings, MCP servers and plugins out. The inline
// --settings deny (the bridge's own) rides only on the spikes that measure it: S4b, S8 and S6b. The
// control run is the same spike with --settings left off, to show the CLI's own behaviour.
const SOURCE_FLAGS = ["--setting-sources", "project,local", "--strict-mcp-config"];
export const PROD_SETTINGS = JSON.stringify({ permissions: { deny: ["Write(.claude/**)", "Edit(.claude/**)"] } });

function argsFor(ctx, { prod = false, settings, extraArgs = [], ...rest }) {
  return buildArgs({ ...rest, settings: settings ?? (prod && !ctx.control ? PROD_SETTINGS : undefined), extraArgs: [...SOURCE_FLAGS, ...extraArgs] });
}

// Before scoring, the child's init must show a default permission mode and no MCP server: otherwise
// the run measured the owner's setup, not ours. Returns one line per failed field (empty when valid).
// An absent init is not a setup failure here: the evaluators already report a child that never started.
// Captures with no init by design: the S8 socket log, the S3 deny slice, and the Live spike's stdin and bridge logs. A child that never started
// (spawn error) stays the evaluator's no-go. hook_started is skipped for S6b, whose worktree has its own hooks.
export function setupProblems(captures, { spike } = {}) {
  const out = [];
  for (const [name, cap] of Object.entries(captures ?? {})) {
    if (name === "socket" || name === "deny" || name === "stdin" || name === "bridge") continue;
    const where = Object.keys(captures).length > 1 ? ` (${name} run)` : "";
    const init = initOf(cap);
    if (!init) {
      if (!cap.exit?.error) out.push(`init: no system/init line${where}: the child ran but its setup (permissionMode, mcp_servers, plugins) was not checked`);
      continue;
    }
    for (const p of (Array.isArray(init.plugins) ? init.plugins : []).filter((x) => x?.path !== "builtin")) out.push(`init.plugins has a plugin from outside the builtin set${where}: ${p?.name ?? "?"} (${p?.path ?? "?"})`);
    if (spike !== "S6b" && objs(cap).some((o) => o.type === "system" && o.subtype === "hook_started")) out.push(`hook_started event${where}: a hook ran in the child, so the run measured the owner's setup`);
    if (init.permissionMode !== "default") out.push(`init.permissionMode is ${JSON.stringify(init.permissionMode ?? null)}, not "default"${where}: tools may run without a permission prompt`);
    const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
    if (servers.length) out.push(`init.mcp_servers is not empty${where}: ${servers.map((m) => `${m.name ?? "?"} (source ${m.source ?? "?"})`).join(", ")}`);
  }
  return [...new Set(out)];
}

// ---- Child process harness -----------------------------------------------------------------

class Child extends EventEmitter {
  constructor({ bin, args, env, cwd, detached = false }) {
    super();
    this.t0 = Date.now();
    this.lines = [];
    this.stderr = "";
    this.exit = null;
    this.buf = "";
    this.proc = spawn(bin, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], shell: false, detached });
    this.pid = this.proc.pid;
    this.proc.stdin.on("error", () => {});
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const raw = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (raw) this.#line(raw);
      }
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (c) => {
      this.stderr += c;
    });
    this.proc.on("error", (e) => {
      this.exit = { code: null, signal: null, t: this.now(), error: e.message };
      this.emit("activity");
    });
    this.proc.on("close", (code, signal) => {
      if (this.buf.trim()) this.#line(this.buf.trim());
      this.exit ??= { code, signal, t: this.now() };
      this.emit("activity");
    });
  }
  now() {
    return Date.now() - this.t0;
  }
  #line(raw) {
    const [entry] = parseCaptureLines([{ t: this.now(), raw }]);
    this.lines.push(entry);
    this.emit("activity");
  }
  send(line) {
    if (!this.exit) this.proc.stdin.write(line);
  }
  endStdin() {
    this.proc.stdin.end();
  }
  kill(signal) {
    this.proc.kill(signal);
  }
  // Signals the child's whole process group (the child must have been started detached).
  killGroup(signal) {
    try {
      process.kill(-this.pid, signal);
    } catch {
      /* the group is already gone */
    }
  }
  // Resolves with the first line at or after index `from` that satisfies `pred`, or null on timeout or exit.
  waitFor(pred, ms, from = 0) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), ms);
      const check = () => {
        const hit = this.lines.slice(from).find((l) => l.obj && pred(l.obj));
        if (hit) done(hit);
        else if (this.exit) done(null);
      };
      const done = (v) => {
        clearTimeout(timer);
        this.off("activity", check);
        resolve(v);
      };
      this.on("activity", check);
      check();
    });
  }
  async waitExit(ms) {
    if (this.exit) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(false), ms);
      const check = () => this.exit && done(true);
      const done = (v) => {
        clearTimeout(timer);
        this.off("activity", check);
        resolve(v);
      };
      this.on("activity", check);
    });
  }
  capture() {
    return { lines: this.lines.slice(), exit: this.exit, stderr: this.stderr };
  }
}

const isResult = (o) => o.type === "result";
const isToolUse = (o) => o.type === "assistant" && Array.isArray(o.message?.content) && o.message.content.some((b) => b.type === "tool_use");
const isControlRequest = (o) => o.type === "control_request";

const PROBE_MARKER = "PROBE-ROLE-OK";
const PROBE_ROLE = `---
name: probe
description: Conformance probe role (throwaway)
tools: Bash, Read, Write, Edit, Task
model: haiku
---
You are a conformance probe. Do exactly what the user asks and nothing more. Begin your final reply with the word ${PROBE_MARKER}.
`;

function makeWorkdir(projectSettings) {
  const dir = mkdtempSync(path.join(tmpdir(), "den-conformance-"));
  mkdirSync(path.join(dir, ".claude", "agents"), { recursive: true });
  writeFileSync(path.join(dir, ".claude", "agents", "probe.md"), PROBE_ROLE);
  writeFileSync(path.join(dir, "notes.txt"), "hello from notes\n");
  if (projectSettings) writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify(projectSettings));
  return dir;
}

function readUsage(env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [USAGE_SCRIPT], { env, timeout: 20_000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Spike runners (each returns { result, captures }) --------------------------------------

function makeCtx(opts) {
  const canary = opts.env?.DEN_CONFORMANCE_CANARY ?? `canary-${randomBytes(8).toString("hex")}`;
  const parentEnv = { ...opts.env, DEN_CONFORMANCE_CANARY: canary };
  const childEnv = buildChildEnv(parentEnv, opts.extraEnv ?? []);
  const bin = opts.claudeBin ?? "claude";
  return {
    canary,
    parentEnv,
    timeoutMs: opts.timeoutMs ?? 120_000,
    model: opts.model ?? "haiku",
    bin,
    s8DisableFlags: opts.s8DisableFlags ?? [],
    s8DisableEnv: opts.s8DisableEnv ?? {},
    repo: opts.repo ?? null,
    scrub: { homes: [opts.env?.HOME, homedir()], username: userInfo().username },
    s3bWaitMs: opts.s3bWaitMs ?? 90_000,
    timing: { settleMs: 1500, eofPollMs: 15_000, termCheckMs: [2000, 10_000], ...opts.timing },
    start(args, cwd, extraEnv = {}, { detached = false, bin: wrapper } = {}) {
      return new Child({ bin: wrapper ?? bin, args, env: { ...childEnv, ...extraEnv }, cwd, detached });
    },
  };
}

async function runTurn(child, text, timeoutMs, from = 0) {
  child.send(userMessageLine(text));
  return child.waitFor(isResult, timeoutMs, from);
}

async function finish(child) {
  child.endStdin();
  const exited = await child.waitExit(10_000);
  if (!exited) child.kill("SIGKILL");
  return exited;
}

async function runS1(ctx) {
  const dir = makeWorkdir();
  const sessionId = randomUUID();
  const child = ctx.start(argsFor(ctx, { sessionId, agent: "probe", model: ctx.model, allowedTools: ["Bash(printenv DEN_CONFORMANCE_CANARY)"] }), dir);
  await runTurn(child, `Run the Bash command "printenv DEN_CONFORMANCE_CANARY" and tell me only whether it printed anything. Begin your reply with ${PROBE_MARKER}.`, ctx.timeoutMs);
  const exitedOnEof = await finish(child);
  const capture = child.capture();
  return { result: evaluateS1(capture, { sessionId, canary: ctx.canary, marker: PROBE_MARKER, exitedOnEof }), captures: { main: capture } };
}

async function runS2(ctx) {
  const dir = makeWorkdir();
  const sleepMs = 3000;
  const a = ctx.start(argsFor(ctx, { sessionId: randomUUID(), agent: "probe", model: ctx.model, allowedTools: ["Bash(sleep 3)"] }), dir);
  await runTurn(a, `Run the Bash command "sleep 3", then reply done. Begin your reply with ${PROBE_MARKER}.`, ctx.timeoutMs);
  await finish(a);
  const b = ctx.start(argsFor(ctx, { sessionId: randomUUID(), agent: "probe", model: ctx.model, allowedTools: ["Task", "Agent", "Read"] }), dir);
  await runTurn(b, `Use the Task tool to start a general-purpose subagent that reads notes.txt and returns its text, then reply with that text. Begin your reply with ${PROBE_MARKER}.`, ctx.timeoutMs);
  await finish(b);
  const main = a.capture();
  const sub = b.capture();
  return { result: evaluateS2(main, { sleepMs, subagentCapture: sub }), captures: { main, subagent: sub } };
}

async function runS3(ctx) {
  const dir = makeWorkdir();
  const child = ctx.start(argsFor(ctx, { sessionId: randomUUID(), agent: "probe", model: ctx.model, permissionPromptTool: "stdio" }), dir);
  let phase = "allow";
  let answered = 0;
  child.on("activity", () => {
    for (; answered < child.lines.length; answered += 1) {
      const o = child.lines[answered].obj;
      if (o && isControlRequest(o)) {
        const allowed = phase === "allow" && o.request?.subtype === "can_use_tool" && o.request.tool_name === "Write";
        child.send(controlResponseLine(o.request_id, allowed ? "allow" : "deny", allowed ? o.request.input : undefined));
      }
    }
  });
  const allowBody = `BODY-ALLOW${randomBytes(3).toString("hex").toUpperCase()}`;
  const denyBody = `BODY-DENY${randomBytes(3).toString("hex").toUpperCase()}`;
  const allowFile = path.join(dir, "s3-allow.txt");
  const denyFile = path.join(dir, "s3-deny.txt");
  await runTurn(child, `Use the Write tool to create the file ${allowFile} with exactly this content: ${allowBody}. Do nothing else. Begin your reply with ${PROBE_MARKER}.`, ctx.timeoutMs);
  const split = child.lines.length;
  phase = "deny";
  await runTurn(child, `Use the Write tool to create the file ${denyFile} with exactly this content: ${denyBody}. Do nothing else. Begin your reply with ${PROBE_MARKER}.`, ctx.timeoutMs, split);
  await finish(child);
  const all = child.capture();
  const allow = { ...all, lines: all.lines.slice(0, split) };
  const deny = { ...all, lines: all.lines.slice(split) };
  const result = evaluateS3({ allow, deny }, { allowBody, denyBody, allowFileExists: existsSync(allowFile), denyFileExists: existsSync(denyFile) });
  return { result, captures: { allow, deny } };
}

function findTranscript(home, sessionId) {
  const root = path.join(home, ".claude", "projects");
  try {
    return readdirSync(root).some((d) => existsSync(path.join(root, d, `${sessionId}.jsonl`)));
  } catch {
    return false;
  }
}

async function runS4(ctx) {
  const dir = makeWorkdir();
  const sessionId = randomUUID();
  const tools = ["Bash(sleep 20)"];
  const first = ctx.start(argsFor(ctx, { sessionId, agent: "probe", model: ctx.model, allowedTools: tools }), dir);
  first.send(userMessageLine(`Run the Bash command "sleep 20", then reply done. Begin your reply with ${PROBE_MARKER}.`));
  await first.waitFor(isToolUse, ctx.timeoutMs);
  const killedAt = first.now();
  first.kill("SIGTERM");
  await first.waitExit(10_000);
  if (!first.exit) first.kill("SIGKILL");
  const transcriptFound = findTranscript(ctx.parentEnv.HOME ?? homedir(), sessionId);
  const second = ctx.start(argsFor(ctx, { resume: sessionId, agent: "probe", model: ctx.model, allowedTools: tools }), dir);
  await runTurn(second, `In one short line, which Bash command were you running when you were interrupted? Begin your reply with ${PROBE_MARKER}.`, ctx.timeoutMs);
  await finish(second);
  const killed = first.capture();
  const resumed = second.capture();
  return { result: evaluateS4({ killed, resumed }, { killedAt, transcriptFound, sessionId }), captures: { killed, resumed } };
}

async function runS5(ctx) {
  const dir = makeWorkdir();
  const before = await readUsage(ctx.parentEnv);
  const child = ctx.start(argsFor(ctx, { sessionId: randomUUID(), agent: "probe", model: ctx.model }), dir);
  await runTurn(child, `Reply with the single word ${PROBE_MARKER}.`, ctx.timeoutMs);
  await finish(child);
  await sleep(5000);
  const after = await readUsage(ctx.parentEnv);
  const capture = child.capture();
  const costUsd = resultsOf(capture).at(-1)?.total_cost_usd ?? null;
  return { result: evaluateS5({ before, after, costUsd }), captures: { main: capture } };
}

async function runS6(ctx, outDir) {
  const dir = makeWorkdir({ permissions: { allow: ["Write(allowed.txt)", "Write(.claude/**)"] } });
  mkdirSync(outDir, { recursive: true });
  const settings = path.join(outDir, "s6-deny.settings.json");
  writeFileSync(settings, JSON.stringify({ permissions: { deny: ["Write(.claude/**)"] } }));
  const child = ctx.start(argsFor(ctx, { sessionId: randomUUID(), agent: "probe", model: ctx.model, settings }), dir);
  await runTurn(child, `Use the Write tool to create allowed.txt containing "ok", then use the Write tool to create .claude/probe.txt containing "ok". Report what happened. Begin your reply with ${PROBE_MARKER}.`, ctx.timeoutMs);
  await finish(child);
  const capture = child.capture();
  return { result: evaluateS6(capture, { allowedExists: existsSync(path.join(dir, "allowed.txt")), deniedExists: existsSync(path.join(dir, ".claude", "probe.txt")) }), captures: { main: capture } };
}

async function runS7(ctx) {
  const dir = makeWorkdir();
  const child = ctx.start(argsFor(ctx, { sessionId: randomUUID(), agent: "probe", model: ctx.model, allowedTools: ["Bash(sleep 8)"] }), dir);
  child.send(userMessageLine(`Run the Bash command "sleep 8", then reply with exactly: first done. Begin your reply with ${PROBE_MARKER}.`));
  await child.waitFor(isToolUse, ctx.timeoutMs);
  const sentAt = child.now();
  child.send(userMessageLine("Also, in your reply, add a final line containing the word second."));
  const firstResult = await child.waitFor(isResult, ctx.timeoutMs);
  if (firstResult && !/second/i.test(flat(firstResult.obj.result))) {
    await child.waitFor(isResult, 20_000, child.lines.indexOf(firstResult) + 1);
  }
  await finish(child);
  const capture = child.capture();
  return { result: evaluateS7(capture, { sentAt }), captures: { main: capture } };
}

function openSocket(socketPath) {
  const sock = net.createConnection(socketPath);
  const client = { sock, buf: "", connected: false, error: null, log: [], t0: Date.now() };
  client.ready = new Promise((resolve) => {
    sock.once("connect", () => {
      client.connected = true;
      resolve();
    });
    sock.once("error", (e) => {
      client.error = e.code ?? e.message;
      resolve();
    });
  });
  sock.on("error", () => {});
  sock.setEncoding("utf8");
  sock.on("data", (c) => {
    client.buf += c;
    client.log.push({ t: Date.now() - client.t0, dir: "recv", data: c });
  });
  client.write = (text) => {
    client.log.push({ t: Date.now() - client.t0, dir: "sent", data: text });
    if (client.connected) sock.write(text);
  };
  return client;
}

const socketCapture = (client) => ({
  lines: client.log.map((e) => ({ t: e.t, raw: JSON.stringify(e), obj: e })),
  exit: null,
  stderr: "",
});

function statSocket(socketPath) {
  try {
    const st = statSync(socketPath);
    const dir = statSync(path.dirname(socketPath));
    return { type: st.isSocket() ? "socket" : st.isFile() ? "file" : "other", mode: st.mode & 0o777, uid: st.uid, ownUid: process.getuid?.() ?? null, dirUid: dir.uid, dirMode: dir.mode & 0o777 };
  } catch {
    return null;
  }
}

// Candidate ways to switch the socket off: flags the child's own --help mentions near socket or
// messaging words, plus the ones the user names on the command line.
function helpFlags(bin) {
  return new Promise((resolve) => {
    execFile(bin, ["--help"], { timeout: 20_000 }, (err, stdout) => {
      if (err && !stdout) return resolve([]);
      const flags = new Set();
      for (const line of String(stdout).split("\n")) {
        if (!/socket|messaging|inbound/i.test(line)) continue;
        for (const m of line.match(/--[a-z][a-z0-9-]*/g) ?? []) flags.add(m);
      }
      resolve([...flags].filter((f) => !FORBIDDEN_FLAGS.includes(f)));
    });
  });
}

async function tryDisable(ctx, dir, via, { flag, env }) {
  const child = ctx.start(argsFor(ctx, { prod: true, sessionId: randomUUID(), agent: "probe", model: ctx.model, extraArgs: flag ? [flag] : [] }), dir, env);
  try {
    const last = await runTurn(child, `Reply with the single word ${PROBE_MARKER}.`, ctx.timeoutMs);
    const init = initOf(child.capture());
    const socketGone = !init?.messaging_socket_path || !existsSync(init.messaging_socket_path);
    return { via, socketGone, loggedIn: Boolean(last) && !last.obj.is_error };
  } finally {
    child.endStdin();
    child.kill("SIGKILL");
  }
}

async function runS8(ctx) {
  const dir = makeWorkdir();
  const child = ctx.start(argsFor(ctx, { prod: true, sessionId: randomUUID(), agent: "probe", model: ctx.model, permissionPromptTool: "stdio", allowedTools: ["Bash(sleep 15)"] }), dir);
  let client = null;
  let nonceSeen = () => false;
  let msgFrom = 0;
  const input = { init: { socketPath: null, capabilities: [] }, stat: null, connect: null, probes: [], disable: [] };
  try {
    child.send(userMessageLine('Run the Bash command "sleep 15", then reply done.'));
    await child.waitFor(isToolUse, ctx.timeoutMs);
    const init = initOf(child.capture());
    input.init = { socketPath: init?.messaging_socket_path ?? null, capabilities: init?.capabilities ?? [] };
    if (input.init.socketPath) {
      input.stat = statSocket(input.init.socketPath);
      client = openSocket(input.init.socketPath);
      await client.ready;
      input.connect = { connected: client.connected, error: client.error ?? undefined, unsolicited: "", greeting: null };
      if (client.connected) {
        await sleep(2000);
        input.connect.unsolicited = client.buf;
        const nonce = `NONCE${randomBytes(4).toString("hex")}`;
        nonceSeen = (lines) => lines.some((l) => l.obj.type !== "system" && JSON.stringify(l.obj).includes(nonce));
        const wires = {
          "user-message": JSON.stringify({ type: "user", message: { role: "user", content: nonce } }),
          "interrupt-control-request": JSON.stringify({ type: "control_request", request_id: "s8-int", request: { subtype: "interrupt" } }),
          "interrupt-bare": JSON.stringify({ type: "interrupt" }),
        };
        for (const [name, wire] of Object.entries(wires)) {
          const fromLine = child.lines.length;
          const fromBuf = client.buf.length;
          client.write(wire + "\n");
          await sleep(2000);
          const fresh = child.lines.slice(fromLine).filter((l) => l.obj);
          const interrupted = (l) =>
            (l.obj.type === "user" && blocks(l.obj).some((b) => b.type === "tool_result" && (b.is_error || /interrupt/i.test(flat(b.content))))) ||
            (l.obj.type === "result" && (l.obj.is_error || /interrupt/i.test(flat(l.obj.result))));
          const effect = name === "user-message" ? nonceSeen(fresh) : fresh.some(interrupted);
          input.probes.push({ name, shape: wire.replace(nonce, "<nonce>"), reply: client.buf.slice(fromBuf).trim() || null, effect });
          if (name === "user-message") msgFrom = fromLine;
        }
      }
    }
    await child.waitFor(isResult, ctx.timeoutMs);
    const msgProbe = input.probes.find((p) => p.name === "user-message");
    if (msgProbe && !msgProbe.effect) {
      // The CLI queues a peer message until the running tool call ends, so look again up to the turn's result.
      const late = () => nonceSeen(child.lines.slice(msgFrom).filter((l) => l.obj));
      for (let waited = 0; !late() && waited < ctx.timing.settleMs; waited += 100) await sleep(100);
      if (late()) {
        msgProbe.effect = true;
        msgProbe.late = true;
      }
    }
    if (client?.connected) {
      // The control_response probe needs a real pending request, so it runs on a second turn.
      const file = path.join(dir, "s8.txt");
      const from = child.lines.length;
      child.send(userMessageLine(`Use the Write tool to create ${file} with content x.`));
      const req = await child.waitFor(isControlRequest, ctx.timeoutMs, from);
      const shape = JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "<id>", response: { behavior: "allow" } } });
      if (req) {
        const fromBuf = client.buf.length;
        client.write(controlResponseLine(req.obj.request_id, "allow", req.obj.request?.input));
        await sleep(3000);
        input.probes.push({ name: "control-response", shape, reply: client.buf.slice(fromBuf).trim() || null, effect: existsSync(file) });
        const shape2 = JSON.stringify({ type: "control_response", request_id: "<id>", response: { behavior: "allow" } });
        const fromBuf2 = client.buf.length;
        client.write(JSON.stringify({ type: "control_response", request_id: req.obj.request_id, response: { behavior: "allow", updatedInput: req.obj.request?.input ?? {} } }) + "\n");
        await sleep(3000);
        input.probes.push({ name: "control-response-2", shape: shape2, reply: client.buf.slice(fromBuf2).trim() || null, effect: existsSync(file) });
        child.send(controlResponseLine(req.obj.request_id, "deny"));
        await child.waitFor(isResult, ctx.timeoutMs, from);
      } else {
        input.probes.push({ name: "control-response", shape, reply: null, effect: false });
        input.probes.push({ name: "control-response-2", shape: '{"type":"control_response","request_id":"<id>","response":{"behavior":"allow"}}', reply: null, effect: false });
      }
    }
    if (input.init.socketPath) {
      const flags = new Set([...(await helpFlags(ctx.bin)), ...ctx.s8DisableFlags]);
      // One candidate failing to run must not skip the rest: record it as not logged in.
      const attempt = async (via, opts) => {
        try {
          input.disable.push(await tryDisable(ctx, dir, via, opts));
        } catch {
          input.disable.push({ via, socketGone: false, loggedIn: false });
        }
      };
      for (const flag of flags) await attempt(flag, { flag });
      for (const [name, value] of Object.entries(ctx.s8DisableEnv)) await attempt(`${name}=${value}`, { env: { [name]: value } });
    }
    await finish(child);
  } finally {
    client?.sock.destroy();
    child.kill("SIGKILL");
  }
  const captures = { main: child.capture() };
  if (client) captures.socket = socketCapture(client);
  return { result: evaluateS8(input), captures };
}

// ---- S4b: no orphaned tool process after the child ends ------------------------------------

// The in-flight tool is `tail -f <unique file>`: a long-running process that is not a sleep (a guard
// may refuse a sleep, as ADR 0016 round 2 found). The file sits inside the child's cwd and is named by a
// relative path, because the CLI refuses `tail -f` on a path outside the cwd (round 3, security 143
// finding 1). The allow rule is a wildcard (`Bash(tail -f *)`), so the unique file name is in the prompt
// and the tool's command line only, never in the child's argv: ps finds the tool by that name.
const holdCommand = (name) => `tail -f ${name}`;
const HOLD_ALLOW = "Bash(tail -f *)";

// Pids of running processes whose command line carries `marker` (the tool call's process, a descendant of
// the child; a wrapping shell that also carries the marker counts too), never one in `exclude` (the child).
function toolPids(marker, exclude = []) {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,command="], { timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve([]);
      const pids = [];
      for (const line of stdout.split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (m && m[2].includes(marker) && Number(m[1]) !== process.pid && !exclude.includes(Number(m[1]))) pids.push(Number(m[1]));
      }
      resolve(pids);
    });
  });
}

function killPid(pid, signal = "SIGKILL") {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

const isPermissionDenied = (o) => o.type === "system" && o.subtype === "permission_denied";

async function runS4b(ctx) {
  const { settleMs, eofPollMs, termCheckMs } = ctx.timing;
  const captures = {};
  const unstarted = [];
  const notes = [];
  const children = [];
  const markers = [];
  let current = null;
  const survivors = async () => (await toolPids(current.marker, [current.child.pid])).length;
  const reap = async () => {
    for (const p of await toolPids(current.marker, [current.child.pid])) killPid(p);
    current.child.killGroup("SIGKILL");
    current.child.kill("SIGKILL");
  };
  // Starts a child, asks for the long-running command and waits until its process is really running.
  // The tool counts as in flight only with a tool_use, no permission_denied, no result yet (the turn
  // has not ended) and a process other than the child itself carrying the marker.
  const begin = async (name, detached = false) => {
    const dir = makeWorkdir();
    const marker = `hold-${randomBytes(6).toString("hex")}.txt`;
    writeFileSync(path.join(dir, marker), "");
    markers.push(marker);
    const child = ctx.start(argsFor(ctx, { prod: true, sessionId: randomUUID(), agent: "probe", model: ctx.model, allowedTools: [HOLD_ALLOW] }), dir, {}, { detached });
    children.push(child);
    current = { child, marker };
    child.send(userMessageLine(`Run the Bash command "${holdCommand(marker)}", then reply done. Begin your reply with ${PROBE_MARKER}.`));
    const sawTool = Boolean(await child.waitFor(isToolUse, ctx.timeoutMs));
    const seen = (pred) => child.lines.some((l) => l.obj && pred(l.obj));
    let running = false;
    for (let waited = 0; sawTool && waited < settleMs * 10 && !running && !seen(isPermissionDenied) && !seen(isResult); waited += 100) {
      running = (await survivors()) > 0;
      if (!running) await sleep(100);
    }
    await sleep(settleMs);
    running = running && (await survivors()) > 0;
    let why = null;
    if (!sawTool) why = "no tool_use line arrived";
    else if (seen(isPermissionDenied)) why = "the CLI refused the tool call (permission_denied)";
    else if (seen(isResult)) why = "the turn already ended (result line) before the signal";
    else if (!running) why = `no process other than the child carries the marker ${marker}`;
    if (why) {
      unstarted.push(name);
      notes.push(`${name}: ${why}`);
    }
    return child;
  };
  try {
    let child = await begin("eof");
    child.endStdin();
    const eofExited = await child.waitExit(eofPollMs);
    await sleep(settleMs);
    const eof = { exited: eofExited, survivors: await survivors() };
    captures.eof = child.capture();
    await reap();

    child = await begin("term");
    const signalAt = child.now();
    child.kill("SIGTERM");
    await sleep(termCheckMs[0]);
    const at2 = await survivors();
    await sleep(Math.max(0, termCheckMs[1] - termCheckMs[0]));
    const at10 = await survivors();
    const term = { exited: Boolean(child.exit), exitMs: child.exit ? child.exit.t - signalAt : null, survivorsAt2s: at2, survivorsAt10s: at10 };
    captures.term = child.capture();
    await reap();

    child = await begin("kill");
    child.kill("SIGKILL");
    await sleep(settleMs);
    const kill = { survivors: await survivors() };
    captures.kill = child.capture();
    await reap();

    let group = null;
    if (eof.survivors > 0 || at2 > 0 || at10 > 0 || kill.survivors > 0 || !term.exited) {
      child = await begin("group", true);
      child.killGroup("SIGTERM");
      await sleep(termCheckMs[0]);
      const termLeft = await survivors();
      child.killGroup("SIGKILL");
      await sleep(settleMs);
      group = { term: { survivors: termLeft }, kill: { survivors: await survivors() } };
      captures.group = child.capture();
      await reap();
    }
    return { result: evaluateS4b({ eof, term, kill, group, unstarted, notes }), captures };
  } finally {
    // Whatever happened, no tool process and no child may outlive the spike.
    for (const m of markers) for (const p of await toolPids(m)) killPid(p);
    for (const c of children) {
      c.killGroup("SIGKILL");
      c.kill("SIGKILL");
    }
  }
}

// ---- S6b: setting sources in a real worktree -------------------------------------------------

// One Write probe for allowed.txt, run in `cwd`; returns whether the file appeared. The capture is
// saved to <outDir>/S6b-<name>.jsonl as evidence only (it is not scored or setup-checked).
async function s6bAllowProbe(ctx, cwd, name, outDir, { agent } = {}) {
  const child = ctx.start(argsFor(ctx, { sessionId: randomUUID(), agent, model: ctx.model }), cwd);
  try {
    await runTurn(child, `Use the Write tool to create allowed.txt containing "ok". Do nothing else. Begin your reply with ${PROBE_MARKER}.`, ctx.timeoutMs);
    await finish(child);
  } finally {
    child.kill("SIGKILL");
  }
  if (outDir) writeCaptures(outDir, "S6b", { [name]: child.capture() }, ctx.scrub);
  return existsSync(path.join(cwd, "allowed.txt"));
}

// S6b comparisons when the control's allow did not apply: (1) the worktree with an absolute //path
// allow, (2) the main checkout (ctx.repo) as the cwd with a relative allow and no --agent. The main
// checkout's settings.local.json, allowed.txt and the deny target are each put back byte for byte if they
// existed (the probe may overwrite them), or deleted if they did not, so `git status` stays as it was.
async function compareS6bAllow(ctx, wt, outDir) {
  const lines = [];
  const absRule = `Write(/${realpathSync(wt)}/allowed.txt)`;
  writeFileSync(path.join(wt, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: [absRule] } }));
  const absWritten = await s6bAllowProbe(ctx, wt, "compare-abs", outDir, { agent: "probe" });
  lines.push(`comparison 1 (worktree cwd, allow ${absRule}): allowed.txt ${absWritten ? "WAS written" : "was NOT written"}`);

  const local = path.join(ctx.repo, ".claude", "settings.local.json");
  const before = existsSync(local) ? readFileSync(local) : null;
  // Every probe output in the checkout is backed up first (bytes, or null when absent) and put back in the finally.
  const outputs = ["allowed.txt", S6B_DENY_TARGET].map((n) => path.join(ctx.repo, n));
  const backups = outputs.map((f) => [f, existsSync(f) ? readFileSync(f) : null]);
  let repoWritten = false;
  try {
    let base = {};
    try {
      base = before ? JSON.parse(before.toString("utf8")) : {};
    } catch {
      base = {};
    }
    const allow = [...(Array.isArray(base.permissions?.allow) ? base.permissions.allow : []), "Write(allowed.txt)"];
    mkdirSync(path.dirname(local), { recursive: true });
    writeFileSync(local, JSON.stringify({ ...base, permissions: { ...base.permissions, allow } }));
    repoWritten = await s6bAllowProbe(ctx, ctx.repo, "compare-repo", outDir);
  } finally {
    // Each restore is guarded on its own, so one that fails does not skip the others. Failures are reported after all ran.
    const failed = [];
    const restore = (f, bytes) => {
      try {
        if (bytes) writeFileSync(f, bytes);
        else rmSync(f, { force: true });
      } catch (e) {
        failed.push(`${f}: ${e.message}`);
      }
    };
    restore(local, before);
    for (const [f, bytes] of backups) restore(f, bytes);
    if (failed.length) throw new Error(`S6b could not restore the main checkout: ${failed.join("; ")}`);
  }
  lines.push(`comparison 2 (main checkout ${ctx.repo} as cwd, allow Write(allowed.txt), no --agent): allowed.txt ${repoWritten ? "WAS written" : "was NOT written"}`);
  return lines;
}

async function runS6b(ctx, outDir) {
  const notRun = (why) => ({ result: { spike: "S6b", verdict: "unconfirmed", evidence: [why] }, captures: {} });
  if (!ctx.repo) return notRun("no --repo given: S6b needs the path of a git repository to add a throwaway worktree to");
  const gitIn = (...a) => execFileSync("git", ["-C", ctx.repo, ...a], { stdio: "pipe", encoding: "utf8" });
  try {
    gitIn("rev-parse", "--git-dir");
  } catch (e) {
    return notRun(`--repo ${ctx.repo} is not a git repository: ${String(e.stderr ?? e.message).trim().slice(0, 200)}`);
  }
  const wt = path.join(ctx.repo, ".claude", "worktrees", `s6b-${randomBytes(4).toString("hex")}`);
  try {
    try {
      gitIn("worktree", "add", "--detach", wt, "HEAD");
    } catch (e) {
      return notRun(`git worktree add failed: ${String(e.stderr ?? e.message).trim().slice(0, 200)}`);
    }
    mkdirSync(path.join(wt, ".claude", "agents"), { recursive: true });
    writeFileSync(path.join(wt, ".claude", "agents", "probe.md"), PROBE_ROLE);
    // The project-local allow and the inline deny name the same target, so the deny must outrank a real allow.
    writeFileSync(path.join(wt, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Write(allowed.txt)", `Write(${S6B_DENY_TARGET})`] } }));
    const args = argsFor(ctx, {
      sessionId: randomUUID(),
      agent: "probe",
      model: ctx.model,
      settings: ctx.control ? undefined : JSON.stringify({ permissions: { deny: [`Write(${S6B_DENY_TARGET})`] } }),
    });
    const child = ctx.start(args, wt);
    await runTurn(child, `Use the Write tool to create allowed.txt containing "ok", then use the Write tool to create ${S6B_DENY_TARGET} containing "ok". Report what happened. Begin your reply with ${PROBE_MARKER}.`, ctx.timeoutMs);
    await finish(child);
    const capture = child.capture();
    const deniedExists = existsSync(path.join(wt, S6B_DENY_TARGET));
    const allowedExists = existsSync(path.join(wt, "allowed.txt"));
    const result = evaluateS6b(capture, { allowedExists, deniedExists });
    if (ctx.control) result.evidence.unshift(`control run (no --settings): ${S6B_DENY_TARGET} ${deniedExists ? "WAS written, so in the spike run only our inline deny stopped it" : "was NOT written even without our deny: the CLI's own rules refused it"}`);
    if (ctx.control && !allowedExists) {
      // The control's own project allow did not apply, so the spike cannot show our deny outranking it.
      if (outDir) writeFileSync(path.join(outDir, "S6b-control.stderr.txt"), scrubText(capture.stderr ?? "", ctx.scrub));
      result.controlAllowAbsent = true;
      result.comparisons = await compareS6bAllow(ctx, wt, outDir);
    }
    return { result, captures: { main: capture } };
  } finally {
    try {
      gitIn("worktree", "remove", "--force", wt);
    } catch {
      rmSync(wt, { recursive: true, force: true });
    }
    try {
      gitIn("worktree", "prune");
    } catch {
      /* best effort */
    }
  }
}

// ---- S3b: subagent request, held request, updatedInput omitted -------------------------------

// An allow with no updatedInput key at all (controlResponseLine always adds one).
const allowWithoutInputLine = (requestId) =>
  JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { behavior: "allow" } } }) + "\n";

async function runS3b(ctx) {
  const stdioArgs = () => argsFor(ctx, { sessionId: randomUUID(), agent: "probe", model: ctx.model, permissionPromptTool: "stdio" });
  // Answers every control_request with `reply(request)`; returns the stop function.
  const answerWith = (child, reply) => {
    let seen = 0;
    child.on("activity", () => {
      for (; seen < child.lines.length; seen += 1) {
        const o = child.lines[seen].obj;
        if (o && isControlRequest(o)) child.send(reply(o));
      }
    });
  };
  const writeAsk = (file, body) => `Use the Write tool to create the file ${file} with exactly this content: ${body}. Do nothing else. Begin your reply with ${PROBE_MARKER}.`;

  const children = [];
  const startChild = (dir) => {
    const c = ctx.start(stdioArgs(), dir);
    children.push(c);
    return c;
  };
  try {
    const subDir = makeWorkdir();
    const sub = startChild(subDir);
    answerWith(sub, (o) => controlResponseLine(o.request_id, "allow", o.request?.input));
    await runTurn(sub, `Use the Task tool to start a subagent. The subagent must use the Write tool to create the file ${path.join(subDir, "s3b-sub.txt")} with exactly this content: SUBAGENT-BODY. Reply done when it finishes. Begin your reply with ${PROBE_MARKER}.`, ctx.timeoutMs);
    await finish(sub);

    const waitDir = makeWorkdir();
    const held = startChild(waitDir);
    held.send(userMessageLine(writeAsk(path.join(waitDir, "s3b-wait.txt"), "WAIT-BODY")));
    const requested = await held.waitFor(isControlRequest, ctx.timeoutMs);
    if (requested) await held.waitFor((o) => isResult(o) || isToolResultLine(o), ctx.s3bWaitMs, held.lines.indexOf(requested) + 1);
    const wait = held.capture();
    held.endStdin();
    held.kill("SIGKILL");

    const omitDir = makeWorkdir();
    const omitFile = path.join(omitDir, "s3b-omitted.txt");
    const omit = startChild(omitDir);
    answerWith(omit, (o) => allowWithoutInputLine(o.request_id));
    await runTurn(omit, writeAsk(omitFile, "OMIT-BODY"), ctx.timeoutMs);
    await finish(omit);

    const captures = { subagent: sub.capture(), wait, omitted: omit.capture() };
    return { result: evaluateS3b(captures, { waitMs: ctx.s3bWaitMs, omittedFileExists: existsSync(omitFile) }), captures };
  } finally {
    for (const c of children) c.kill("SIGKILL");
  }
}

const isToolResultLine = (o) => o.type === "user" && Array.isArray(o.message?.content) && o.message.content.some((b) => b.type === "tool_result");

// turns: user turns the spike sends (each is a few API calls on a cheap model).
export const SPIKES = {
  S1: { title: "child starts logged in under the env allowlist; --session-id, --agent, stdin message, init, exit on EOF; canary absent", turns: 1, run: runS1 },
  S2: { title: "tool event latency on stdout (go: under 1 s) and whether subagent activity appears (tailer decision)", turns: 2, run: runS2 },
  S3: { title: "--permission-prompt-tool stdio: control_request with full input; allow and deny honoured; capture shapes", turns: 2, run: runS3 },
  S4: { title: "SIGTERM ends a running child, transcript kept, --resume reopens it", turns: 2, run: runS4 },
  S5: { title: "billing: plan usage reading before and after one trivial headless run (user confirms on the usage page)", turns: 1, run: runS5 },
  S6: { title: "--settings merge and deny precedence over a project allow", turns: 1, run: runS6 },
  S7: { title: "a user message written mid-turn: queued, merged, dropped or interrupting", turns: 1, run: runS7 },
  S8: { title: "the child's messaging socket: no second way to answer a permission request (outcomes a to d)", turns: 3, control: true, run: runS8 },
  S4b: { title: "SIGTERM, stdin EOF and process-group kill leave no orphaned tool process", turns: 2, control: true, run: runS4b },
  S6b: { title: "--setting-sources project,local in a worktree: allow applies, user and plugin config does not", turns: 1, control: true, run: runS6b },
  S3b: { title: "a subagent permission request reaches the parent; a held request; updatedInput omitted", turns: 3, run: runS3b },
  Live: { title: "one agent through the bridge itself (den-v1 loop S3): worktree cwd, a held Write outside it, allow over HTTP, tool result, done", turns: 1, run: runLive },
  Wall: { title: "the wall (agent-os/01): the CLI sandbox under the bridge's argv; writes and hosts outside it, the file tools, an escape attempt", turns: 20, run: runWall },
  Limits: { title: "systemd-run limits (agent-os/01 question 5): the CLI in a scope with a memory and a CPU limit; a sandboxed command over each", turns: 3, run: runLimits },
  Container: { title: "a container per agent (hardening/13, ADR 0031): the seven wall answers from one agent in a rootless Docker container behind the proxy, with the network, limits and .git checks", turns: 16, run: runContainer },
};

// ---- Runner and CLI ------------------------------------------------------------------------

function writeCaptures(outDir, spike, captures, scrub) {
  for (const [name, cap] of Object.entries(captures ?? {})) {
    const file = path.join(outDir, name === "main" ? `${spike}.jsonl` : `${spike}-${name}.jsonl`);
    writeFileSync(file, scrubText(cap.lines.map((l) => l.raw).join("\n") + (cap.lines.length ? "\n" : ""), scrub));
  }
}

// The same spike again with --settings left off, scored by the same evaluator, so the spike's verdict can
// be read against what the CLI does by itself. It never changes the spike's own verdict.
async function runControl(id, ctx, out, scrub) {
  let run;
  try {
    run = await SPIKES[id].run({ ...ctx, control: true }, out);
  } catch (e) {
    return { spike: id, verdict: "unconfirmed", evidence: [`could not run the control: ${e.message}`] };
  }
  writeCaptures(out, `${id}-control`, run.captures, scrub);
  const setup = setupProblems(run.captures, { spike: id });
  if (setup.length) return { spike: id, verdict: "setup-invalid", evidence: setup.map((l) => `setup-invalid: ${l}`) };
  const evidence = [`control run without --settings: ${run.result.verdict}`, ...run.result.evidence, ...(run.result.comparisons ?? [])];
  return { spike: id, verdict: run.result.verdict, evidence, allowAbsent: Boolean(run.result.controlAllowAbsent), comparisons: run.result.comparisons ?? [] };
}

// S6b only: the control (no --settings) did not write allowed.txt either, so the project allow never
// applied and the spike's result cannot speak to our deny outranking it.
function s6bControlInvalid(result) {
  return {
    spike: result.spike,
    verdict: "setup-invalid",
    evidence: [
      "setup-invalid: project allow did not apply in the control: the control run (no --settings) did not write allowed.txt either",
      "decision 6.10 (our .claude/** deny outranks a project allow) stays unverified until the control's allow applies",
      ...result.control.comparisons,
      "the control child's stderr is saved as S6b-control.stderr.txt",
      ...result.evidence.map((l) => `spike run (not scored): ${l}`),
    ],
    control: result.control,
  };
}

export async function runSpikes(opts) {
  const { spikes, out, log = console.log } = opts;
  mkdirSync(out, { recursive: true });
  const ctx = makeCtx(opts);
  const scrub = ctx.scrub;
  const results = [];
  for (const id of spikes) {
    log(`running ${id}: ${SPIKES[id].title}`);
    let run;
    try {
      run = await SPIKES[id].run(ctx, out);
    } catch (e) {
      run = { result: { spike: id, verdict: "no-go", evidence: [`could not run the spike: ${e.message}`] }, captures: {} };
    }
    let { result, captures } = run;
    const setup = setupProblems(captures, { spike: id });
    if (setup.length) {
      result = { spike: id, verdict: "setup-invalid", evidence: [...setup.map((l) => `setup-invalid: ${l}`), "not scored: this run measured the owner's setup, not the production shape; fix it and run again"] };
    }
    const startError = Object.values(captures ?? {}).find((c) => c.exit?.error)?.exit.error;
    if (startError) result.evidence.push(`could not start the child: ${startError}`);
    if (result.verdict !== "go") {
      const tail = Object.values(captures ?? {}).map((c) => c.stderr).join("").trim().slice(-400);
      if (tail) result.evidence.push(`stderr tail: ${tail}`);
    }
    writeCaptures(out, id, captures, scrub);
    if (SPIKES[id].control && opts.control !== false && result.verdict !== "setup-invalid") {
      log(`running ${id} control (no --settings)`);
      result.control = await runControl(id, ctx, out, scrub);
      if (result.control.allowAbsent) result = s6bControlInvalid(result);
    }
    results.push(result);
  }
  writeFileSync(path.join(out, "results.json"), scrubText(JSON.stringify(results, null, 2) + "\n", scrub));
  return results;
}

export function parseCli(argv) {
  const ids = Object.keys(SPIKES);
  const byLower = new Map(ids.map((id) => [id.toLowerCase(), id]));
  const opts = {
    spikes: ids.filter((id) => /^S[1-7]$/.test(id)),
    out: null,
    dryRun: false,
    model: "haiku",
    timeoutMs: 120_000,
    extraEnv: [],
    repo: null,
    s8DisableFlags: [],
    s8DisableEnv: {},
    s3bWaitMs: 90_000,
    control: true,
    help: false,
    error: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[++i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--no-control") opts.control = false;
    else if (arg === "--out") opts.out = value();
    else if (arg === "--model") opts.model = value();
    else if (arg === "--extra-env") opts.extraEnv.push(value());
    else if (arg === "--timeout") opts.timeoutMs = Number(value()) * 1000;
    else if (arg === "--repo") opts.repo = value();
    else if (arg === "--s8-disable-flag") opts.s8DisableFlags.push(value());
    else if (arg === "--s8-disable-env") {
      const pair = String(value() ?? "");
      const eq = pair.indexOf("=");
      if (eq <= 0) {
        opts.error = `--s8-disable-env needs NAME=VALUE, got ${pair || "(empty)"}`;
        break;
      }
      opts.s8DisableEnv[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (arg === "--s3b-wait") opts.s3bWaitMs = Number(value()) * 1000;
    else if (arg === "--spike") {
      const wanted = String(value() ?? "").split(",").map((x) => x.trim());
      const bad = wanted.find((x) => !byLower.has(x.toLowerCase()));
      if (bad !== undefined) {
        opts.error = `unknown spike ${(/^s\d/i.test(bad) ? bad.toUpperCase() : bad) || "(empty)"}; choose from ${ids.join(", ")}`;
        break;
      }
      const picked = new Set(wanted.map((x) => byLower.get(x.toLowerCase())));
      opts.spikes = ids.filter((id) => picked.has(id));
    } else {
      opts.error = `unknown argument ${arg}`;
      break;
    }
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) opts.error ??= "--timeout needs a positive number of seconds";
  if (!Number.isFinite(opts.s3bWaitMs) || opts.s3bWaitMs <= 0) opts.error ??= "--s3b-wait needs a positive number of seconds";
  return opts;
}

const HELP = `usage: node apps/bridge/agents/conformance.mjs [--spike S1,S3] [--out <dir>] [--model <m>] [--timeout <s>] [--extra-env NAME]... [--dry-run]
       [--repo <checkout>] [--s8-disable-flag <flag>]... [--s8-disable-env NAME=VALUE]... [--s3b-wait <s>] [--no-control]
A run whose init is missing, or shows a permissionMode other than default, any MCP server, a plugin outside the builtin set, or a hook_started event (not checked for S6b), is reported SETUP-INVALID (never go or no-go). S8, S4b and S6b also run a control without --settings unless --no-control.
S4b is SETUP-INVALID unless its tool (tail -f on a hold file inside the child's cwd) is shown running, by a pid other than the child's, before each signal.
S8 waits for a peer message until the turn's result (outcome c if it lands late) and probes two control_response shapes. It checks the socket and its directory for group and other bits and the directory's owner uid.
S6b is SETUP-INVALID when the control's allowed.txt is also absent ("project allow did not apply in the control"): the control's stderr goes to S6b-control.stderr.txt, and two comparison probes run (a //path allow in the worktree, and --repo itself as the cwd with a temporary allow in its .claude/settings.local.json, restored afterwards).
The default run is S1 to S7; S8, S4b, S6b, S3b, Live, Wall, Limits and Container run only when named (--spike S8,S4b,S6b,S3b,Live,Wall,Limits,Container). S6b adds its worktree to --repo (default: the repository containing this script); run \`claude\` there once so the owner has trusted it.
Live (npm run smoke:live) starts one agent through startBridge and the production runtime in a throwaway repository, allows its one held Write over HTTP, and saves Live.jsonl (stdout), Live-stdin.jsonl and Live-bridge.jsonl.
Runs ADR 0016's spikes against the real \`claude\` login (DEN_CLAUDE_BIN overrides the binary).
--dry-run prints the plan and spends nothing.`;

export function planText(opts) {
  const turns = opts.spikes.reduce((n, id) => n + SPIKES[id].turns, 0);
  const lines = opts.spikes.map((id) => `  ${id} (${SPIKES[id].turns} turns): ${SPIKES[id].title}`);
  return [`plan: ${opts.spikes.length} spikes, about ${turns} user turns on model ${opts.model} (each turn is roughly 2 to 4 API calls)`, ...lines].join("\n");
}

// S6b's default --repo (ADR 0016): the repository containing this script, or null outside git.
function defaultRepo() {
  try {
    return execFileSync("git", ["-C", path.dirname(fileURLToPath(import.meta.url)), "rev-parse", "--show-toplevel"], { stdio: "pipe", encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) return console.log(HELP);
  if (opts.error) {
    console.error(`conformance: ${opts.error}\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (opts.dryRun) return console.log(planText(opts));
  const out = opts.out ?? path.join(tmpdir(), `den-conformance-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  console.log(planText(opts));
  const results = await runSpikes({
    spikes: opts.spikes,
    out,
    claudeBin: process.env.DEN_CLAUDE_BIN || "claude",
    env: process.env,
    extraEnv: opts.extraEnv,
    model: opts.model,
    timeoutMs: opts.timeoutMs,
    repo: opts.repo ?? defaultRepo(),
    s8DisableFlags: opts.s8DisableFlags,
    s8DisableEnv: opts.s8DisableEnv,
    s3bWaitMs: opts.s3bWaitMs,
    control: opts.control,
  });
  console.log("");
  for (const r of results) {
    console.log(`${r.spike} ${r.verdict.toUpperCase()}`);
    for (const line of r.evidence) console.log(`  - ${line}`);
    if (r.control) console.log(`  control (no --settings): ${r.control.verdict.toUpperCase()}`);
  }
  console.log(`\nfixtures and results.json: ${out}`);
  if (results.some((r) => r.verdict === "setup-invalid")) console.log("\nSETUP-INVALID: nothing above is evidence. Fix the named field and run again.");
  if (results.some((r) => r.verdict === "no-go" || r.verdict === "setup-invalid")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
