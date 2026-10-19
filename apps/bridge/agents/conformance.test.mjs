// Tests for the testable parts of the conformance script (ticket organism-infra/105):
// argument building, the child environment allowlist, message shapes, and the go or no-go
// evaluation of captured stream-json output. A live `claude` is never started here, except a
// scripted fake binary that exercises the harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  FORBIDDEN_FLAGS,
  buildArgs,
  buildChildEnv,
  userMessageLine,
  controlResponseLine,
  parseCaptureLines,
  evaluateS1,
  evaluateS2,
  evaluateS3,
  evaluateS4,
  evaluateS5,
  evaluateS6,
  evaluateS7,
  parseCli,
  runSpikes,
  SPIKES,
} from "./conformance.mjs";

// The round-2 exports are reached through the namespace so a missing one fails its own tests
// with "not a function" instead of breaking the import of the whole file.
import * as conf from "./conformance.mjs";
const evaluateS8 = (...a) => conf.evaluateS8(...a);
const evaluateS4b = (...a) => conf.evaluateS4b(...a);
const evaluateS6b = (...a) => conf.evaluateS6b(...a);
const evaluateS3b = (...a) => conf.evaluateS3b(...a);
const scrubText = (...a) => conf.scrubText(...a);

const SID = "11111111-2222-4333-8444-555555555555";

// Capture helpers: a capture is { lines: [{ t, obj }], exit: { code, signal, t }|null, stderr }.
const L = (t, obj) => ({ t, obj });
const init = (t = 100, extra = {}) => L(t, { type: "system", subtype: "init", session_id: SID, ...extra });
const toolUse = (t, name, input, id = "tu1", extra = {}) =>
  L(t, { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] }, ...extra });
const toolResult = (t, id, content, isError = false, extra = {}) =>
  L(t, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] }, ...extra });
const text = (t, s) => L(t, { type: "assistant", message: { content: [{ type: "text", text: s }] } });
const result = (t, s, extra = {}) => L(t, { type: "result", subtype: "success", is_error: false, result: s, session_id: SID, ...extra });
const cap = (lines, exit = { code: 0, signal: null, t: 5000 }, stderr = "") => ({ lines, exit, stderr });

test("buildArgs: headless stream-json shape with session id and agent", () => {
  const args = buildArgs({ sessionId: SID, agent: "probe" });
  assert.deepEqual(args.slice(0, 1), ["-p"]);
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(flag("--input-format"), "stream-json");
  assert.equal(flag("--output-format"), "stream-json");
  assert.ok(args.includes("--verbose"));
  assert.equal(flag("--session-id"), SID);
  assert.equal(flag("--agent"), "probe");
  assert.ok(!args.includes("--resume"));
});

test("buildArgs: resume replaces session id; permission prompt tool, settings and allowed tools pass through", () => {
  const args = buildArgs({ resume: SID, permissionPromptTool: "stdio", settings: "/x/s.json", allowedTools: ["Bash(sleep 3)", "Read"], model: "haiku" });
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(flag("--resume"), SID);
  assert.ok(!args.includes("--session-id"));
  assert.equal(flag("--permission-prompt-tool"), "stdio");
  assert.equal(flag("--settings"), "/x/s.json");
  assert.equal(flag("--allowedTools"), "Bash(sleep 3),Read");
  assert.equal(flag("--model"), "haiku");
});

test("buildArgs: never constructs a permission-broadening flag", () => {
  assert.deepEqual(
    [...FORBIDDEN_FLAGS].sort(),
    ["--allow-dangerously-skip-permissions", "--dangerously-skip-permissions", "--permission-mode"].sort(),
  );
  for (const flag of FORBIDDEN_FLAGS) {
    assert.throws(() => buildArgs({ sessionId: SID, extraArgs: [flag, "bypassPermissions"] }), /forbidden/i);
  }
  const args = buildArgs({ sessionId: SID, agent: "probe", permissionPromptTool: "stdio", allowedTools: ["Read"] });
  for (const flag of FORBIDDEN_FLAGS) assert.ok(!args.includes(flag));
  assert.ok(!args.some((a) => /bypassPermissions/.test(a)));
});

test("buildChildEnv: allowlist keeps PATH, HOME, locale and DEN_CLAUDE_BIN; drops the canary and everything else", () => {
  const env = buildChildEnv({
    PATH: "/bin",
    HOME: "/h",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    DEN_CLAUDE_BIN: "/opt/claude",
    DEN_CONFORMANCE_CANARY: "secret-canary",
    ANTHROPIC_API_KEY: "sk-nope",
    SSH_AUTH_SOCK: "/s",
  });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", LANG: "en_US.UTF-8", LC_ALL: "C", DEN_CLAUDE_BIN: "/opt/claude" });
});

test("buildChildEnv: extra names are opt-in", () => {
  const env = buildChildEnv({ PATH: "/bin", USER: "d", FOO: "1" }, ["USER"]);
  assert.deepEqual(env, { PATH: "/bin", USER: "d" });
});

test("userMessageLine and controlResponseLine produce one JSON line each", () => {
  const u = userMessageLine("hello");
  assert.ok(u.endsWith("\n") && u.split("\n").length === 2);
  assert.deepEqual(JSON.parse(u), { type: "user", message: { role: "user", content: "hello" } });

  const allow = JSON.parse(controlResponseLine("req_1", "allow", { file_path: "a" }));
  assert.deepEqual(allow, {
    type: "control_response",
    response: { subtype: "success", request_id: "req_1", response: { behavior: "allow", updatedInput: { file_path: "a" } } },
  });
  const deny = JSON.parse(controlResponseLine("req_2", "deny"));
  assert.equal(deny.response.request_id, "req_2");
  assert.equal(deny.response.response.behavior, "deny");
  assert.equal(typeof deny.response.response.message, "string");
  assert.throws(() => controlResponseLine("r", "maybe"), /allow|deny/);
});

test("parseCaptureLines keeps parsed objects and flags non-JSON lines", () => {
  const out = parseCaptureLines([
    { t: 1, raw: '{"type":"system","subtype":"init"}' },
    { t: 2, raw: "not json" },
  ]);
  assert.equal(out[0].obj.subtype, "init");
  assert.equal(out[1].obj, null);
  assert.equal(out[1].raw, "not json");
});

// ---- S1 ----------------------------------------------------------------------------------

const s1Ok = () =>
  cap([
    init(100, { agent: "probe" }),
    toolUse(900, "Bash", { command: "printenv DEN_CONFORMANCE_CANARY" }),
    toolResult(1100, "tu1", "", false),
    text(1500, "PROBE-ROLE-OK canary not visible"),
    result(1600, "PROBE-ROLE-OK canary not visible"),
  ]);
const s1Meta = { sessionId: SID, canary: "canary-value-123", marker: "PROBE-ROLE-OK", exitedOnEof: true };

test("S1 go: logged in, init with the session id, agent marker, exit on EOF, canary absent", () => {
  const r = evaluateS1(s1Ok(), s1Meta);
  assert.equal(r.spike, "S1");
  assert.equal(r.verdict, "go");
  assert.ok(r.evidence.length > 0);
});

test("S1 no-go when the canary reaches the child", () => {
  const c = s1Ok();
  c.lines.splice(2, 1, toolResult(1100, "tu1", "canary-value-123\n", false));
  const r = evaluateS1(c, s1Meta);
  assert.equal(r.verdict, "no-go");
  assert.match(r.evidence.join("\n"), /canary/i);
});

test("S1 no-go when the child is not logged in", () => {
  const c = cap([init(100), result(900, "Not logged in - Please run /login", { is_error: true })]);
  const r = evaluateS1(c, s1Meta);
  assert.equal(r.verdict, "no-go");
  assert.match(r.evidence.join("\n"), /login/i);
});

test("S1 no-go when stdin EOF does not end the child, or the init session id differs", () => {
  assert.equal(evaluateS1(s1Ok(), { ...s1Meta, exitedOnEof: false }).verdict, "no-go");
  const c = s1Ok();
  c.lines[0] = L(100, { type: "system", subtype: "init", session_id: "other" });
  assert.equal(evaluateS1(c, s1Meta).verdict, "no-go");
});

test("S1 no-go when the agent marker is missing from the reply (--agent not honoured)", () => {
  const c = cap([init(100), toolUse(900, "Bash", {}), toolResult(1100, "tu1", ""), result(1600, "all good")]);
  const r = evaluateS1(c, s1Meta);
  assert.equal(r.verdict, "no-go");
  assert.match(r.evidence.join("\n"), /agent/i);
});

// ---- S2 ----------------------------------------------------------------------------------

test("S2 go when the tool_use line arrives well before the tool_result of a 3 s command", () => {
  const c = cap([init(100), toolUse(1200, "Bash", { command: "sleep 3" }), toolResult(4300, "tu1", ""), result(5000, "done")]);
  const r = evaluateS2(c, { sleepMs: 3000, subagentCapture: null });
  assert.equal(r.verdict, "go");
  assert.match(r.evidence.join("\n"), /latency/i);
});

test("S2 no-go when the tool_use line is only delivered once the tool finishes", () => {
  const c = cap([init(100), toolUse(4290, "Bash", { command: "sleep 3" }), toolResult(4300, "tu1", ""), result(5000, "done")]);
  assert.equal(evaluateS2(c, { sleepMs: 3000, subagentCapture: null }).verdict, "no-go");
});

test("S2 no-go when no tool event arrives at all", () => {
  assert.equal(evaluateS2(cap([init(100), result(900, "hi")]), { sleepMs: 3000, subagentCapture: null }).verdict, "no-go");
});

test("S2 reports whether subagent activity appears on the stream (tailer decision)", () => {
  const base = [init(100), toolUse(1200, "Bash", { command: "sleep 3" }), toolResult(4300, "tu1", ""), result(5000, "done")];
  const withSub = cap([
    init(100),
    toolUse(500, "Task", { prompt: "x" }, "sub1"),
    toolUse(900, "Read", { file_path: "p" }, "inner1", { parent_tool_use_id: "sub1" }),
    toolResult(1000, "sub1", "ok"),
    result(1100, "done"),
  ]);
  const yes = evaluateS2(cap(base), { sleepMs: 3000, subagentCapture: withSub });
  assert.match(yes.evidence.join("\n"), /subagent activity: visible/i);
  assert.equal(yes.tailerNeeded, false);
  const noSub = cap([init(100), toolUse(500, "Task", { prompt: "x" }, "sub1"), toolResult(1000, "sub1", "ok"), result(1100, "done")]);
  const no = evaluateS2(cap(base), { sleepMs: 3000, subagentCapture: noSub });
  assert.match(no.evidence.join("\n"), /subagent activity: not visible/i);
  assert.equal(no.tailerNeeded, true);
  const untested = evaluateS2(cap(base), { sleepMs: 3000, subagentCapture: null });
  assert.equal(untested.tailerNeeded, null);
});

// ---- S3 ----------------------------------------------------------------------------------

const controlRequest = (t, id, tool, input) =>
  L(t, { type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: tool, input } });

const s3Allow = () =>
  cap([init(100), controlRequest(800, "req_a", "Write", { file_path: "/w/s3-allow.txt", content: "ALLOW-BODY" }), toolResult(1500, "tu1", "File created", false), result(2000, "ok")]);
const s3Deny = () =>
  cap([init(100), controlRequest(800, "req_d", "Write", { file_path: "/w/s3-deny.txt", content: "DENY-BODY" }), toolResult(1500, "tu1", "Permission denied", true), result(2000, "ok")]);

test("S3 go: control_request carries the full input, allow and deny are honoured", () => {
  const r = evaluateS3(
    { allow: s3Allow(), deny: s3Deny() },
    { allowBody: "ALLOW-BODY", denyBody: "DENY-BODY", allowFileExists: true, denyFileExists: false },
  );
  assert.equal(r.verdict, "go");
  assert.equal(r.shapes.controlRequest.request.tool_name, "Write");
});

test("S3 no-go when no control_request is emitted for the tool outside the allowlist", () => {
  const silent = cap([init(100), toolResult(900, "tu1", "denied", true), result(1000, "no")]);
  const r = evaluateS3(
    { allow: silent, deny: s3Deny() },
    { allowBody: "ALLOW-BODY", denyBody: "DENY-BODY", allowFileExists: false, denyFileExists: false },
  );
  assert.equal(r.verdict, "no-go");
  assert.match(r.evidence.join("\n"), /control_request/);
});

test("S3 no-go when the control_request input is truncated or the deny is not honoured", () => {
  const truncated = cap([init(100), controlRequest(800, "req_a", "Write", { file_path: "/w/s3-allow.txt" }), toolResult(1500, "tu1", "ok"), result(2000, "ok")]);
  const base = { allowBody: "ALLOW-BODY", denyBody: "DENY-BODY", allowFileExists: true, denyFileExists: false };
  assert.equal(evaluateS3({ allow: truncated, deny: s3Deny() }, base).verdict, "no-go");
  assert.equal(evaluateS3({ allow: s3Allow(), deny: s3Deny() }, { ...base, denyFileExists: true }).verdict, "no-go");
  assert.equal(evaluateS3({ allow: s3Allow(), deny: s3Deny() }, { ...base, allowFileExists: false }).verdict, "no-go");
});

// ---- S4 ----------------------------------------------------------------------------------

const s4Meta = { killedAt: 1000, transcriptFound: true, sessionId: SID };
test("S4 go: SIGTERM ends the child quickly, the transcript stays, resume reopens the session", () => {
  const killed = cap([init(100), toolUse(500, "Bash", { command: "sleep 20" })], { code: null, signal: "SIGTERM", t: 1300 });
  const resumed = cap([init(50, { session_id: SID }), result(900, "You were running sleep 20")]);
  const r = evaluateS4({ killed, resumed }, s4Meta);
  assert.equal(r.verdict, "go");
});

test("S4 no-go when the child outlives SIGTERM, the transcript is missing, or resume fails", () => {
  const resumed = cap([init(50), result(900, "ok")]);
  const slow = cap([init(100), toolUse(500, "Bash", {})], { code: null, signal: "SIGKILL", t: 9000 });
  assert.equal(evaluateS4({ killed: slow, resumed }, s4Meta).verdict, "no-go");
  const killed = cap([init(100), toolUse(500, "Bash", {})], { code: null, signal: "SIGTERM", t: 1300 });
  assert.equal(evaluateS4({ killed, resumed }, { ...s4Meta, transcriptFound: false }).verdict, "no-go");
  const bad = cap([result(300, "No conversation found", { is_error: true })]);
  assert.equal(evaluateS4({ killed, resumed: bad }, s4Meta).verdict, "no-go");
});

// ---- S5 ----------------------------------------------------------------------------------

test("S5 go when the plan usage reading moved after a headless run", () => {
  const r = evaluateS5({
    before: { "5-hour": { percent: 10, resets_at: "2026-10-05T20:00:00Z" } },
    after: { "5-hour": { percent: 11, resets_at: "2026-10-05T20:00:00Z" } },
    costUsd: 0.0123,
  });
  assert.equal(r.verdict, "go");
  assert.match(r.evidence.join("\n"), /10.*11/);
});

test("S5 stays unconfirmed when the reading did not move, readings are missing, or the window rolled over", () => {
  const same = { "5-hour": { percent: 10, resets_at: "A" } };
  assert.equal(evaluateS5({ before: same, after: same, costUsd: 0.01 }).verdict, "unconfirmed");
  assert.equal(evaluateS5({ before: null, after: same, costUsd: 0.01 }).verdict, "unconfirmed");
  const rolled = { "5-hour": { percent: 0, resets_at: "B" } };
  assert.equal(evaluateS5({ before: same, after: rolled, costUsd: 0.01 }).verdict, "unconfirmed");
  assert.match(evaluateS5({ before: same, after: same, costUsd: 0.01 }).evidence.join("\n"), /usage page/i);
});

// ---- S6 ----------------------------------------------------------------------------------

test("S6 go: --settings merges (the allowed write lands) and deny outranks the project allow", () => {
  const c = cap([
    init(100),
    toolUse(500, "Write", { file_path: "/w/allowed.txt", content: "a" }, "w1"),
    toolUse(600, "Write", { file_path: "/w/.claude/probe.txt", content: "b" }, "w2"),
    toolResult(900, "w1", "ok"),
    toolResult(950, "w2", "denied", true),
    result(1000, "done"),
  ]);
  assert.equal(evaluateS6(c, { allowedExists: true, deniedExists: false }).verdict, "go");
});

test("S6 no-go when the deny does not hold or the merge dropped the project allow", () => {
  const c = cap([
    init(100),
    toolUse(500, "Write", { file_path: "/w/allowed.txt" }, "w1"),
    toolUse(600, "Write", { file_path: "/w/.claude/probe.txt" }, "w2"),
    result(1000, "done"),
  ]);
  assert.equal(evaluateS6(c, { allowedExists: true, deniedExists: true }).verdict, "no-go");
  assert.equal(evaluateS6(c, { allowedExists: false, deniedExists: false }).verdict, "no-go");
});

test("S6 unconfirmed when the model never attempted the denied write", () => {
  const c = cap([init(100), toolUse(500, "Write", { file_path: "/w/allowed.txt" }, "w1"), result(1000, "done")]);
  assert.equal(evaluateS6(c, { allowedExists: true, deniedExists: false }).verdict, "unconfirmed");
});

// ---- S7 ----------------------------------------------------------------------------------

test("S7 queued: a second result arrives after the first and the first tool call finished", () => {
  const c = cap([
    init(100),
    toolUse(500, "Bash", { command: "sleep 8" }),
    toolResult(8700, "tu1", "", false),
    result(9000, "first done"),
    result(11000, "second"),
  ]);
  const r = evaluateS7(c, { sentAt: 2000 });
  assert.equal(r.verdict, "go");
  assert.equal(r.behavior, "queued-new-turn");
});

test("S7 merged: one result that carries both answers", () => {
  const c = cap([init(100), toolUse(500, "Bash", { command: "sleep 8" }), toolResult(8700, "tu1", "", false), result(10000, "first done\nsecond")]);
  const r = evaluateS7(c, { sentAt: 2000 });
  assert.equal(r.verdict, "go");
  assert.equal(r.behavior, "merged-into-running-turn");
});

test("S7 interrupted: the running tool call ends in an error before it could finish", () => {
  const c = cap([init(100), toolUse(500, "Bash", { command: "sleep 8" }), toolResult(2100, "tu1", "[Request interrupted by user]", true), result(3000, "second")]);
  const r = evaluateS7(c, { sentAt: 2000 });
  assert.equal(r.verdict, "no-go");
  assert.equal(r.behavior, "interrupted");
});

test("S7 dropped: the first turn finishes and the second message never shows", () => {
  const c = cap([init(100), toolUse(500, "Bash", { command: "sleep 8" }), toolResult(8700, "tu1", "", false), result(9000, "first done")]);
  const r = evaluateS7(c, { sentAt: 2000 });
  assert.equal(r.verdict, "no-go");
  assert.equal(r.behavior, "dropped");
});

// ---- CLI and plan ------------------------------------------------------------------------

test("parseCli: defaults run every spike; --spike selects; bad input is an error", () => {
  assert.deepEqual(parseCli([]).spikes, ["S1", "S2", "S3", "S4", "S5", "S6", "S7"]);
  assert.deepEqual(parseCli(["--spike", "S3,S1"]).spikes, ["S1", "S3"]);
  assert.equal(parseCli(["--dry-run"]).dryRun, true);
  assert.equal(parseCli(["--out", "/x"]).out, "/x");
  assert.equal(parseCli(["--spike", "S9"]).error.includes("S9"), true);
  assert.ok(parseCli(["--bogus"]).error);
  assert.ok(parseCli(["--help"]).help);
});

test("SPIKES describe every spike with a turn estimate", () => {
  assert.deepEqual(Object.keys(SPIKES), ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S4b", "S6b", "S3b", "Live", "Wall", "Limits"]);
  for (const s of Object.values(SPIKES)) {
    assert.equal(typeof s.title, "string");
    assert.ok(Number.isInteger(s.turns) && s.turns > 0);
  }
});

test("--dry-run prints the plan and spawns nothing", () => {
  const out = execFileSync(process.execPath, [new URL("./conformance.mjs", import.meta.url).pathname, "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, DEN_CLAUDE_BIN: "/nonexistent/claude" },
  });
  assert.match(out, /S1/);
  assert.match(out, /S7/);
  assert.match(out, /turns/i);
});

// ---- Harness against a scripted fake `claude` ----------------------------------------------

function writeFake(dir, body) {
  const file = path.join(dir, "fake-claude.mjs");
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

// The fake speaks just enough stream-json: init on first user line, a Bash tool_use, a tool_result
// echoing the canary env var, a result, then exits on stdin EOF.
const FAKE_S1 = `
import readline from "node:readline";
const args = process.argv.slice(2);
const sid = args[args.indexOf("--session-id") + 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", () => {
  out({ type: "system", subtype: "init", permissionMode: "default", mcp_servers: [], session_id: sid });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "printenv DEN_CONFORMANCE_CANARY" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: process.env.DEN_CONFORMANCE_CANARY ?? "", is_error: false }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "PROBE-ROLE-OK", session_id: sid });
});
rl.on("close", () => process.exit(0));
`;

test("runSpikes S1 against a fake claude: go, and writes fixtures and results", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "conf-test-"));
  const fake = writeFake(dir, FAKE_S1);
  const outDir = path.join(dir, "out");
  const results = await runSpikes({
    spikes: ["S1"],
    out: outDir,
    claudeBin: fake,
    env: { PATH: process.env.PATH, HOME: dir, DEN_CONFORMANCE_CANARY: "must-not-leak" },
    timeoutMs: 10_000,
    log: () => {},
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].verdict, "go", results[0].evidence.join("\n"));
  const saved = JSON.parse(readFileSync(path.join(outDir, "results.json"), "utf8"));
  assert.equal(saved[0].spike, "S1");
  assert.match(readFileSync(path.join(outDir, "S1.jsonl"), "utf8"), /"subtype":"init"/);
});

const FAKE_S3 = `
import readline from "node:readline";
import fs from "node:fs";
const args = process.argv.slice(2);
const sid = args[args.indexOf("--session-id") + 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
let pending = null;
let n = 0;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "user") {
    n += 1;
    const body = String(msg.message.content).match(/BODY-[A-Z0-9]+/)?.[0] ?? "x";
    const file = String(msg.message.content).match(/\\S*s3-(allow|deny)\\.txt/)?.[0] ?? "s3.txt";
    out({ type: "system", subtype: "init", permissionMode: "default", mcp_servers: [], session_id: sid });
    pending = { file, body };
    out({ type: "control_request", request_id: "req_" + n, request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: file, content: body } } });
  } else if (msg.type === "control_response") {
    const ok = msg.response.response.behavior === "allow";
    if (ok) fs.writeFileSync(pending.file, pending.body);
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: ok ? "created" : "denied", is_error: !ok }] } });
    out({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: sid });
  }
});
rl.on("close", () => process.exit(0));
`;

test("runSpikes S3 against a fake claude: allow and deny are driven and checked on disk", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "conf-test-"));
  const fake = writeFake(dir, FAKE_S3);
  const results = await runSpikes({
    spikes: ["S3"],
    out: path.join(dir, "out"),
    claudeBin: fake,
    env: { PATH: process.env.PATH, HOME: dir },
    timeoutMs: 10_000,
    log: () => {},
  });
  assert.equal(results[0].verdict, "go", results[0].evidence.join("\n"));
});

test("runSpikes: a binary that cannot start is a no-go with the error, not a crash", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "conf-test-"));
  const results = await runSpikes({
    spikes: ["S1"],
    out: path.join(dir, "out"),
    claudeBin: path.join(dir, "missing-claude"),
    env: { PATH: process.env.PATH, HOME: dir },
    timeoutMs: 5000,
    log: () => {},
  });
  assert.equal(results[0].verdict, "no-go");
  assert.match(results[0].evidence.join("\n"), /ENOENT|spawn|start/i);
});

const FAKE_GENERIC = `
import readline from "node:readline";
const args = process.argv.slice(2);
const sid = args[args.indexOf("--session-id") + 1] ?? args[args.indexOf("--resume") + 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", () => {
  out({ type: "system", subtype: "init", permissionMode: "default", mcp_servers: [], session_id: sid });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "x" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "", is_error: false }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "PROBE-ROLE-OK second", session_id: sid });
});
rl.on("close", () => process.exit(0));
`;

test("runSpikes S2, S4, S6, S7 run to a verdict against a generic fake without crashing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "conf-test-"));
  const fake = writeFake(dir, FAKE_GENERIC);
  const results = await runSpikes({
    spikes: ["S2", "S4", "S6", "S7"],
    out: path.join(dir, "out"),
    claudeBin: fake,
    env: { PATH: process.env.PATH, HOME: dir },
    timeoutMs: 10_000,
    log: () => {},
  });
  assert.deepEqual(results.map((r) => r.spike), ["S2", "S4", "S6", "S7"]);
  for (const r of results) {
    assert.ok(["go", "no-go", "unconfirmed"].includes(r.verdict));
    assert.ok(!r.evidence.some((e) => /could not run the spike/.test(e)), r.evidence.join("\n"));
  }
});

// =============================================================================================
// Spike round 2 (ticket organism-infra/138; ADR 0016 decision 7): S8, S4b, S6b, S3b, the S3 fixes,
// the fixture scrub and the new CLI flags. Every runner test drives a scripted fake `claude`; none
// starts the real one.
// =============================================================================================

import { existsSync, mkdirSync, realpathSync, readdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
const readPids = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : []);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// Pids still alive after up to `ms`; always SIGKILLs them so a failing test leaks nothing.
async function stillAlive(pids, ms = 4000) {
  const end = Date.now() + ms;
  let left = pids.filter(alive);
  while (left.length && Date.now() < end) {
    await pause(100);
    left = pids.filter(alive);
  }
  for (const p of left) {
    try {
      process.kill(p, "SIGKILL");
    } catch {}
  }
  return left;
}

// ---- CLI ---------------------------------------------------------------------------------

test("parseCli: spike ids are case-insensitive and the round-2 ids are accepted", () => {
  assert.deepEqual(parseCli(["--spike", "s8,s4b,S6B,s3b"]).spikes, ["S8", "S4b", "S6b", "S3b"]);
  assert.equal(parseCli(["--spike", "s8"]).error, null);
  assert.deepEqual(parseCli(["--spike", "s1,S3"]).spikes, ["S1", "S3"]);
  assert.match(parseCli(["--spike", "s9"]).error, /S9/);
  assert.ok(parseCli(["--spike", "S4c"]).error);
});

test("parseCli: the default run stays S1 to S7 (round-2 spikes only run when named)", () => {
  assert.deepEqual(parseCli([]).spikes, ["S1", "S2", "S3", "S4", "S5", "S6", "S7"]);
});

test("parseCli: --repo, --s8-disable-flag, --s8-disable-env and --s3b-wait", () => {
  const o = parseCli([
    "--repo", "/some/repo",
    "--s8-disable-flag", "--no-socket",
    "--s8-disable-flag", "--no-messaging",
    "--s8-disable-env", "CLAUDE_NO_SOCK=1",
    "--s8-disable-env", "OTHER=a=b",
    "--s3b-wait", "5",
  ]);
  assert.equal(o.error, null);
  assert.equal(o.repo, "/some/repo");
  assert.deepEqual(o.s8DisableFlags, ["--no-socket", "--no-messaging"]);
  assert.deepEqual(o.s8DisableEnv, { CLAUDE_NO_SOCK: "1", OTHER: "a=b" });
  assert.equal(o.s3bWaitMs, 5000);
});

test("parseCli: defaults for the new options; a malformed value is an error", () => {
  const d = parseCli([]);
  assert.equal(d.s3bWaitMs, 90_000);
  assert.deepEqual(d.s8DisableFlags, []);
  assert.deepEqual(d.s8DisableEnv, {});
  assert.ok(parseCli(["--s8-disable-env", "NOEQUALS"]).error);
  assert.ok(parseCli(["--s3b-wait", "0"]).error);
  assert.ok(parseCli(["--s3b-wait", "abc"]).error);
});

test("SPIKES: the four round-2 spikes spend about 8 to 12 turns in total", () => {
  const turns = ["S8", "S4b", "S6b", "S3b"].reduce((n, id) => n + SPIKES[id].turns, 0);
  assert.ok(turns >= 8 && turns <= 12, `turns ${turns}`);
});

test("--dry-run with the round-2 spikes prints the plan, spawns nothing and creates no worktree", () => {
  const repo = makeRepo();
  const out = execFileSync(
    process.execPath,
    [new URL("./conformance.mjs", import.meta.url).pathname, "--dry-run", "--spike", "s8,s4b,s6b,s3b", "--repo", repo],
    { encoding: "utf8", env: { ...process.env, DEN_CLAUDE_BIN: "/nonexistent/claude" } },
  );
  for (const id of ["S8", "S4b", "S6b", "S3b"]) assert.match(out, new RegExp(id));
  assert.equal(worktreeCount(repo), 1);
  assert.ok(!existsSync(path.join(repo, ".claude", "worktrees")) || readdirSync(path.join(repo, ".claude", "worktrees")).length === 0);
});

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "conf-repo-"));
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  writeFileSync(path.join(dir, "README.md"), "x\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  return dir;
}
const worktreeCount = (repo) =>
  execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" }).split("\n").filter((l) => l.startsWith("worktree ")).length;

// ---- S3 fixes ----------------------------------------------------------------------------

test("S3 evaluator reports the nested request.subtype shape", () => {
  const r = evaluateS3(
    { allow: s3Allow(), deny: s3Deny() },
    { allowBody: "ALLOW-BODY", denyBody: "DENY-BODY", allowFileExists: true, denyFileExists: false },
  );
  assert.equal(r.verdict, "go");
  assert.equal(r.shapes.requestSubtype, "can_use_tool");
  assert.match(r.evidence.join("\n"), /request\.subtype\W+can_use_tool/);
});

test("S3 evaluator does not mistake a top-level subtype for the nested one", () => {
  const flat = L(800, { type: "control_request", request_id: "req_a", subtype: "can_use_tool", request: { tool_name: "Write", input: { file_path: "/w/s3-allow.txt", content: "ALLOW-BODY" } } });
  const r = evaluateS3(
    { allow: cap([init(100), flat, result(2000, "ok")]), deny: s3Deny() },
    { allowBody: "ALLOW-BODY", denyBody: "DENY-BODY", allowFileExists: true, denyFileExists: false },
  );
  assert.notEqual(r.shapes.requestSubtype, "can_use_tool");
  assert.match(r.evidence.join("\n"), /request\.subtype/);
});

test("S3 evaluator, allow run with an earlier non-Write request: judges the Write request's input", () => {
  const bash = controlRequest(500, "req_b", "Bash", { command: "ls" });
  const write = controlRequest(800, "req_a", "Write", { file_path: "/w/s3-allow.txt", content: "ALLOW-BODY" });
  const allow = cap([init(100), bash, toolResult(600, "t0", "Permission denied", true), write, toolResult(1500, "tu1", "File created"), result(2000, "ok")]);
  const r = evaluateS3(
    { allow, deny: s3Deny() },
    { allowBody: "ALLOW-BODY", denyBody: "DENY-BODY", allowFileExists: true, denyFileExists: false },
  );
  assert.equal(r.verdict, "go", r.evidence.join("\n"));
  assert.equal(r.shapes.controlRequest.request.tool_name, "Write");
});

// A fake that asks permission for Bash and then Write in each turn, and records every answer it
// receives in $HOME/s3-answers.jsonl as { phase, tool, behavior }. A Write is created only if allowed.
const FAKE_S3_MIXED = `
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const sid = args[args.indexOf("--session-id") + 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
let phase = 0;
let queue = [];
let current = null;
const ask = () => {
  current = queue.shift();
  out({ type: "control_request", request_id: "req_" + phase + "_" + current.tool, request: { subtype: "can_use_tool", tool_name: current.tool, input: current.input } });
};
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "user") {
    phase += 1;
    const text = String(msg.message.content);
    const body = text.match(/BODY-[A-Z0-9]+/)?.[0] ?? "x";
    const file = text.match(/\\S*s3-(allow|deny)\\.txt/)?.[0] ?? "s3.txt";
    out({ type: "system", subtype: "init", permissionMode: "default", mcp_servers: [], session_id: sid });
    queue = [
      { tool: "Bash", input: { command: "ls" } },
      { tool: "Write", input: { file_path: file, content: body } },
    ];
    ask();
  } else if (msg.type === "control_response") {
    const behavior = msg.response.response.behavior;
    fs.appendFileSync(path.join(process.env.HOME, "s3-answers.jsonl"), JSON.stringify({ phase, tool: current.tool, behavior }) + "\\n");
    if (behavior === "allow" && current.tool === "Write") fs.writeFileSync(current.input.file_path, current.input.content);
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: behavior, is_error: behavior !== "allow" }] } });
    if (queue.length) ask();
    else out({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: sid });
  }
});
rl.on("close", () => process.exit(0));
`;

test("runSpikes S3: the allow phase answers only Write with allow; Bash and the deny phase are denied", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "conf-test-"));
  const fake = writeFake(dir, FAKE_S3_MIXED);
  const results = await runSpikes({ spikes: ["S3"], out: path.join(dir, "out"), claudeBin: fake, env: { PATH: process.env.PATH, HOME: dir }, timeoutMs: 10_000, log: () => {} });
  const answers = readFileSync(path.join(dir, "s3-answers.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(answers.filter((a) => a.phase === 1).map((a) => [a.tool, a.behavior]), [["Bash", "deny"], ["Write", "allow"]]);
  assert.ok(answers.filter((a) => a.phase === 2).length >= 1);
  assert.ok(answers.filter((a) => a.phase === 2).every((a) => a.behavior === "deny"));
  assert.equal(results[0].verdict, "go", results[0].evidence.join("\n"));
});

// ---- Fixture scrub -----------------------------------------------------------------------

test("scrubText removes home paths and the username from every line and keeps the JSON valid", () => {
  const home = "/home/pandauser";
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", cwd: "/tmp/den-conformance-abc", memory_paths: { auto: `${home}/.claude/projects/-tmp-x/memory/` }, plugins: [{ name: "p", path: `${home}/.claude/plugins/cache/p` }] }),
    JSON.stringify({ type: "user", message: { content: `ran as pandauser in /Users/pandauser/work and /tmp/pandauser-scratch` } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/tmp/den-conformance-abc/a.txt" } }] } }),
  ].join("\n") + "\n";
  const out = scrubText(lines, { homes: [home, "/Users/pandauser/"], username: "pandauser" });
  assert.ok(!out.includes(home), out);
  assert.ok(!out.includes("/Users/pandauser"), out);
  assert.ok(!/pandauser/.test(out), out);
  const parsed = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].subtype, "init");
  assert.equal(parsed[0].cwd, "/tmp/den-conformance-abc");
  assert.equal(parsed[2].message.content[0].name, "Write");
  assert.equal(parsed[2].message.content[0].input.file_path, "/tmp/den-conformance-abc/a.txt");
});

const FAKE_S1_HOMEPATHS = `
import readline from "node:readline";
import os from "node:os";
const args = process.argv.slice(2);
const sid = args[args.indexOf("--session-id") + 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", () => {
  out({
    type: "system", subtype: "init", permissionMode: "default", mcp_servers: [], session_id: sid, cwd: process.cwd(),
    memory_paths: { auto: process.env.HOME + "/.claude/projects/p/memory/" },
    plugins: [{ name: "p", path: os.homedir() + "/.claude/plugins/cache/p", source: "p@m" }],
    note: "owner " + os.userInfo().username,
  });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "printenv DEN_CONFORMANCE_CANARY" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "", is_error: false }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "PROBE-ROLE-OK", session_id: sid });
});
rl.on("close", () => process.exit(0));
`;

test("runSpikes saves scrubbed fixtures: no home path, no username", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "conf-test-"));
  const fake = writeFake(dir, FAKE_S1_HOMEPATHS);
  const outDir = path.join(dir, "out");
  await runSpikes({ spikes: ["S1"], out: outDir, claudeBin: fake, env: { PATH: process.env.PATH, HOME: dir }, timeoutMs: 10_000, log: () => {} });
  const saved = readFileSync(path.join(outDir, "S1.jsonl"), "utf8");
  assert.match(saved, /"subtype":"init"/);
  assert.ok(!saved.includes(dir), "the HOME given to the runner leaked into the fixture");
  if (homedir().length > 1) assert.ok(!saved.includes(homedir()), "the real home path leaked into the fixture");
  assert.ok(!saved.includes(userInfo().username), "the username leaked into the fixture");
  for (const l of saved.split("\n").filter(Boolean)) JSON.parse(l);
});

// ---- S8 evaluator (the child's messaging socket) -----------------------------------------
// Input: init { socketPath, capabilities }, stat { type, mode, uid, ownUid, dirMode } | null,
// connect { connected, error?, unsolicited, greeting }, probes [{ name, shape, reply, effect }],
// disable [{ via, socketGone, loggedIn }].

const s8Probes = (effects = {}, reply = '{"error":"unsupported"}') =>
  [
    ["user-message", '{"type":"user","message":{"role":"user","content":"<nonce>"}}'],
    ["interrupt-control-request", '{"type":"control_request","request":{"subtype":"interrupt"}}'],
    ["interrupt-bare", '{"type":"interrupt"}'],
    ["control-response", '{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"behavior":"allow"}}}'],
  ].map(([name, shape]) => ({ name, shape, reply, effect: Boolean(effects[name]) }));
const s8Base = () => ({
  init: { socketPath: "/tmp/cc-socks/123.sock", capabilities: ["interrupt_send_now_v1", "msg_lifecycle_v1"] },
  stat: { type: "socket", mode: 0o600, uid: 501, ownUid: 501, dirMode: 0o700 },
  connect: { connected: true, unsolicited: "", greeting: null },
  probes: s8Probes(),
  disable: [],
});

test("S8 outcome a: no messaging_socket_path in init is a go", () => {
  const d = s8Base();
  d.init = { socketPath: null, capabilities: [] };
  d.stat = null;
  d.connect = null;
  d.probes = [];
  const r = evaluateS8(d);
  assert.equal(r.spike, "S8");
  assert.equal(r.verdict, "go");
  assert.equal(r.outcome, "a");
});

test("S8 outcome b: the socket exists but refuses the connection", () => {
  const d = s8Base();
  d.connect = { connected: false, error: "EACCES", unsolicited: "", greeting: null };
  d.probes = [];
  const r = evaluateS8(d);
  assert.equal(r.verdict, "go");
  assert.equal(r.outcome, "b");
});

test("S8 outcome b: it accepts a connection, answers every probe with an error and none has an effect", () => {
  const r = evaluateS8(s8Base());
  assert.equal(r.verdict, "go");
  assert.equal(r.outcome, "b");
});

test("S8 unconfirmed: it accepts a connection but stays silent and no probe shows an effect", () => {
  const d = s8Base();
  d.probes = s8Probes({}, null);
  const r = evaluateS8(d);
  assert.equal(r.verdict, "unconfirmed");
});

test("S8 outcome c (residual): messages or interrupts take effect but a control_response does not", () => {
  for (const name of ["user-message", "interrupt-control-request", "interrupt-bare"]) {
    const d = s8Base();
    d.probes = s8Probes({ [name]: true });
    const r = evaluateS8(d);
    assert.equal(r.verdict, "residual", name);
    assert.equal(r.outcome, "c", name);
    assert.match(r.evidence.join("\n"), new RegExp(name));
  }
});

test("S8 outcome d (no-go): a control_response over the socket answers the pending request", () => {
  const d = s8Base();
  d.probes = s8Probes({ "control-response": true, "user-message": true });
  const r = evaluateS8(d);
  assert.equal(r.verdict, "no-go");
  assert.equal(r.outcome, "d");
});

test("S8 an unsolicited event stream on the socket is a finding on its own, never a plain go", () => {
  const d = s8Base();
  d.connect = { connected: true, unsolicited: '{"type":"assistant","message":"leak"}\n', greeting: null };
  const r = evaluateS8(d);
  assert.notEqual(r.verdict, "go");
  assert.match(r.evidence.join("\n"), /leak|unsolicited/i);
});

test("S8 evidence lists every shape tried, the socket's mode and capabilities, and flags open permissions", () => {
  const d = s8Base();
  d.stat = { type: "socket", mode: 0o666, uid: 501, ownUid: 501, dirMode: 0o777 };
  const r = evaluateS8(d);
  const ev = r.evidence.join("\n");
  for (const p of d.probes) assert.ok(ev.includes(p.shape), `missing shape for ${p.name}`);
  assert.match(ev, /interrupt_send_now_v1/);
  assert.match(ev, /others/i);
});

test("S8 a disable candidate counts only if the socket is gone and the child still logs in and answers", () => {
  const withSocket = s8Base();
  withSocket.probes = s8Probes({ "control-response": true });
  withSocket.disable = [{ via: "--no-socket", socketGone: true, loggedIn: false }, { via: "FOO=1", socketGone: false, loggedIn: true }];
  const none = evaluateS8(withSocket);
  assert.equal(none.verdict, "no-go");
  assert.ok(!none.disabledBy);

  withSocket.disable.push({ via: "--no-messaging", socketGone: true, loggedIn: true });
  const ok = evaluateS8(withSocket);
  assert.equal(ok.verdict, "go");
  assert.equal(ok.disabledBy, "--no-messaging");
});

// ---- S8 runner against a fake --------------------------------------------------------------
// The fake optionally listens on a Unix socket named in init. With honourControlResponse a
// control_response arriving there for the pending can_use_tool request is obeyed (outcome d).
// A user message naming "sleep" starts a short fake tool call; one naming "write" and a .txt path
// raises a can_use_tool request. Child pids are recorded in $HOME/children.txt.
const s8Fake = (o) => `
import readline from "node:readline";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
const o = ${JSON.stringify(o)};
const args = process.argv.slice(2);
if (args.includes("--help")) { console.log("usage: fake-claude [options]"); process.exit(0); }
const sid = args[args.indexOf("--session-id") + 1];
const home = process.env.HOME;
fs.appendFileSync(path.join(home, "children.txt"), process.pid + "\\n");
fs.appendFileSync(path.join(home, "argv.txt"), JSON.stringify(args) + "\\n");
const sock = path.join(home, "m.sock");
const out = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
let pending = null;
let inited = false;
const init = () => {
  if (inited) return;
  inited = true;
  const i = { type: "system", subtype: "init", permissionMode: "default", mcp_servers: [], session_id: sid, capabilities: ["interrupt_send_now_v1"] };
  if (o.socket) i.messaging_socket_path = sock;
  out(i);
};
if (o.socket) {
  fs.rmSync(sock, { force: true });
  net.createServer((c) => {
    c.on("data", (d) => {
      const s = d.toString();
      if (o.honourControlResponse && pending && s.includes(pending.id) && /allow/.test(s)) {
        fs.writeFileSync(pending.file, "x");
        const p = pending;
        pending = null;
        out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: p.id, content: "created", is_error: false }] } });
        out({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: sid });
      }
      c.write(JSON.stringify({ error: "unsupported" }) + "\\n");
    });
  }).listen(sock);
}
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "user") {
    init();
    const text = String(msg.message.content);
    let handled = false;
    if (/sleep/i.test(text)) {
      handled = true;
      out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tsl", name: "Bash", input: { command: "sleep 15" } }] } });
      setTimeout(() => {
        out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tsl", content: "", is_error: false }] } });
        out({ type: "result", subtype: "success", is_error: false, result: "PROBE-ROLE-OK", session_id: sid });
      }, 1200);
    }
    if (/write/i.test(text)) {
      handled = true;
      const file = text.match(/\\S+\\.txt/)?.[0] ?? path.join(process.cwd(), "s8.txt");
      pending = { id: "req_s8", file };
      out({ type: "control_request", request_id: "req_s8", request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: file, content: "x" } } });
    }
    if (!handled) out({ type: "result", subtype: "success", is_error: false, result: "PROBE-ROLE-OK", session_id: sid });
  } else if (msg.type === "control_response" && pending) {
    pending = null;
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "req_s8", content: "denied", is_error: true }] } });
    out({ type: "result", subtype: "success", is_error: false, result: "PROBE-ROLE-OK", session_id: sid });
  }
});
rl.on("close", () => process.exit(0));
setInterval(() => {}, 1000);
`;

const runS8 = async (o) => {
  const dir = mkdtempSync(path.join(tmpdir(), "c8-"));
  const fake = writeFake(dir, s8Fake(o));
  const results = await runSpikes({ spikes: ["S8"], out: path.join(dir, "out"), claudeBin: fake, env: { PATH: process.env.PATH, HOME: dir }, timeoutMs: 10_000, log: () => {} });
  const left = await stillAlive(readPids(path.join(dir, "children.txt")));
  const argvFile = path.join(dir, "argv.txt");
  const argvs = existsSync(argvFile) ? readFileSync(argvFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { r: results[0], left, dir, argvs };
};

test("runSpikes S8 against a fake with no messaging socket: go, outcome a, no child left running", async () => {
  const { r, left } = await runS8({ socket: false });
  assert.equal(r.spike, "S8");
  assert.equal(r.verdict, "go", r.evidence.join("\n"));
  assert.equal(r.outcome, "a");
  assert.deepEqual(left, []);
});

test("runSpikes S8 against a fake whose socket obeys a control_response: no-go, outcome d, no child left running", async () => {
  const { r, left } = await runS8({ socket: true, honourControlResponse: true });
  assert.equal(r.verdict, "no-go", r.evidence.join("\n"));
  assert.equal(r.outcome, "d");
  assert.deepEqual(left, []);
});

// ---- S4b evaluator (kill and exit during a tool call) -------------------------------------
// Input: eof { exited, survivors }, term { exited, exitMs, survivorsAt2s, survivorsAt10s },
// kill { survivors }, group null | { term: { survivors }, kill: { survivors } }. Survivors are counts.

const s4bClean = () => ({
  eof: { exited: true, survivors: 0 },
  term: { exited: true, exitMs: 120, survivorsAt2s: 0, survivorsAt10s: 0 },
  kill: { survivors: 0 },
  group: null,
});

test("S4b go with decision plain: exits on EOF mid-call and no sleep survives any run", () => {
  const r = evaluateS4b(s4bClean());
  assert.equal(r.spike, "S4b");
  assert.equal(r.verdict, "go");
  assert.equal(r.decision, "plain");
});

test("S4b go with decision group-kill: sleeps survive the child-only signals and the group signal clears them", () => {
  const d = s4bClean();
  d.term.survivorsAt2s = 1;
  d.term.survivorsAt10s = 1;
  d.kill.survivors = 1;
  d.group = { term: { survivors: 0 }, kill: { survivors: 0 } };
  const r = evaluateS4b(d);
  assert.equal(r.verdict, "go");
  assert.equal(r.decision, "group-kill");
  assert.match(r.evidence.join("\n"), /group/i);
});

test("S4b a sleep that survives only the EOF run, cleared by the group signal, still decides group-kill", () => {
  const d = s4bClean();
  d.eof.survivors = 1;
  d.group = { term: { survivors: 0 }, kill: { survivors: 0 } };
  const r = evaluateS4b(d);
  assert.equal(r.verdict, "go");
  assert.equal(r.decision, "group-kill");
});

test("S4b no-go when a sleep outlives the group signal", () => {
  const d = s4bClean();
  d.kill.survivors = 1;
  d.group = { term: { survivors: 1 }, kill: { survivors: 1 } };
  const r = evaluateS4b(d);
  assert.equal(r.verdict, "no-go");
  assert.notEqual(r.decision, "plain");
});

test("S4b no-go when the child does not exit on stdin EOF in the middle of a tool call", () => {
  const d = s4bClean();
  d.eof = { exited: false, survivors: 0 };
  const r = evaluateS4b(d);
  assert.equal(r.verdict, "no-go");
  assert.match(r.evidence.join("\n"), /EOF/);
});

// ---- S4b runner against a fake: the in-flight tool (ticket organism-infra/195) --------------
// The fake plays the model: it takes the first double-quoted string in the user message as the Bash
// command and really runs it (`exec <command>` under sh) as the tool call's process, then emits the
// tool_use. A runner that quotes no command, or whose command is refused or finishes early, gets no
// tool process to signal. Recorded under $HOME: child pids (children.txt), tool pids (tools.txt),
// the commands run (commands.txt), the prompts (prompts.txt), every argv (argv.txt) and, at stdin
// EOF and at SIGTERM, whether the tool process was still alive (alive-at-eof.txt, alive-at-term.txt).
// Options: eofExits, termExits, toolDetached (the tool gets its own process group).

const s4bFake = (o) => `
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
const o = ${JSON.stringify(o)};
const args = process.argv.slice(2);
const sid = args[args.indexOf("--session-id") + 1] ?? args[args.indexOf("--resume") + 1];
const home = process.env.HOME;
const log = (name, line) => fs.appendFileSync(path.join(home, name), line + "\\n");
log("children.txt", process.pid);
log("argv.txt", JSON.stringify(args));
const out = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
let tool = null;
const toolAlive = () => {
  try { process.kill(tool.pid, 0); return true; } catch { return false; }
};
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = String(JSON.parse(line).message.content);
  log("prompts.txt", JSON.stringify(text));
  out({ type: "system", subtype: "init", permissionMode: "default", mcp_servers: [], session_id: sid });
  const command = (text.match(/"([^"]+)"/) ?? [])[1];
  if (!command) {
    out({ type: "result", subtype: "success", is_error: false, result: "PROBE-ROLE-OK", session_id: sid });
    return;
  }
  tool = spawn("sh", ["-c", "exec " + command], { stdio: "ignore", detached: Boolean(o.toolDetached) });
  tool.unref();
  log("tools.txt", tool.pid);
  log("commands.txt", command);
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tsl", name: "Bash", input: { command } }] } });
});
rl.on("close", () => {
  if (tool) log("alive-at-eof.txt", toolAlive());
  if (o.eofExits) process.exit(0);
});
process.on("SIGTERM", () => {
  if (tool) log("alive-at-term.txt", toolAlive());
  if (o.termExits) process.exit(0);
});
setInterval(() => {}, 1000);
`;

const FAST = { settleMs: 100, eofPollMs: 1500, termCheckMs: [300, 800] };
const readLines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
const runS4b = async (o) => {
  const dir = mkdtempSync(path.join(tmpdir(), "c4-"));
  const fake = writeFake(dir, s4bFake(o));
  const results = await runSpikes({ spikes: ["S4b"], out: path.join(dir, "out"), claudeBin: fake, env: { PATH: process.env.PATH, HOME: dir }, timeoutMs: 10_000, timing: FAST, log: () => {} });
  const tools = readPids(path.join(dir, "tools.txt"));
  const children = readPids(path.join(dir, "children.txt"));
  const leftTools = await stillAlive(tools);
  const leftChildren = await stillAlive(children);
  const at = (name) => readLines(path.join(dir, name));
  return {
    r: results[0],
    dir,
    tools,
    leftTools,
    leftChildren,
    commands: at("commands.txt"),
    prompts: at("prompts.txt").map((l) => JSON.parse(l)),
    aliveAtEof: at("alive-at-eof.txt"),
    aliveAtTerm: at("alive-at-term.txt"),
    argvs: at("argv.txt").map((l) => JSON.parse(l)),
  };
};

test("runSpikes S4b: the in-flight tool is a real process, running when EOF and SIGTERM land, and it is not a sleep command", async () => {
  const { r, tools, commands, prompts, aliveAtEof, aliveAtTerm } = await runS4b({ eofExits: true, termExits: true, toolDetached: false });
  assert.ok(commands.length >= 3, "eof, term and kill runs each start the tool");
  assert.equal(tools.length, commands.length);
  for (const c of commands) assert.doesNotMatch(c, /\bsleep\b/i, `a guard may refuse a sleep command: ${c}`);
  for (const p of prompts) {
    assert.doesNotMatch(p, /\bsleep\b/i, p);
    assert.doesNotMatch(p, /background/i, `the prompt must not ask for run_in_background: ${p}`);
  }
  assert.ok(aliveAtEof.length >= 1 && aliveAtEof.every((x) => x === "true"), `the tool process was not running when stdin EOF landed: ${aliveAtEof}`);
  assert.ok(aliveAtTerm.length >= 1 && aliveAtTerm.every((x) => x === "true"), `the tool process was not running when SIGTERM landed: ${aliveAtTerm}`);
  assert.equal(r.spike, "S4b");
});

test("runSpikes S4b: tools that survive child-only signals are cleared by the group signal (group-kill) and every recorded pid is gone", async () => {
  const { r, tools, leftTools, leftChildren } = await runS4b({ eofExits: true, termExits: true, toolDetached: false });
  assert.ok(tools.length >= 2, "the runner should start several children, each with a tool process");
  assert.equal(r.verdict, "go", r.evidence.join("\n"));
  assert.equal(r.decision, "group-kill");
  assert.deepEqual(leftTools, [], "leftover tool pids were not killed");
  assert.deepEqual(leftChildren, [], "leftover child pids were not killed");
});

test("runSpikes S4b: a tool in its own process group outlives the group signal (no-go) and is still killed at the end", async () => {
  const { r, tools, leftTools, leftChildren } = await runS4b({ eofExits: true, termExits: true, toolDetached: true });
  assert.ok(tools.length >= 2);
  assert.equal(r.verdict, "no-go", r.evidence.join("\n"));
  assert.deepEqual(leftTools, [], "leftover tool pids were not killed");
  assert.deepEqual(leftChildren, [], "leftover child pids were not killed");
});

test("runSpikes S4b: a child that ignores stdin EOF mid-call is a no-go and the runner still ends it", async () => {
  const { r, leftTools, leftChildren } = await runS4b({ eofExits: false, termExits: true, toolDetached: false });
  assert.equal(r.verdict, "no-go", r.evidence.join("\n"));
  assert.match(r.evidence.join("\n"), /EOF/);
  assert.deepEqual(leftTools, []);
  assert.deepEqual(leftChildren, []);
});

test("runSpikes S4b: the tool call is never reported as unstarted when the tool really ran", async () => {
  const { r } = await runS4b({ eofExits: true, termExits: true, toolDetached: false });
  assert.doesNotMatch(r.evidence.join("\n"), /never started/);
});

test("runSpikes S4b: production-shaped arguments (setting sources, strict MCP, inline --settings) on the spike run; the control run has no --settings", async () => {
  const { r, argvs } = await runS4b({ eofExits: true, termExits: true, toolDetached: false });
  const flag = (a, n) => a[a.indexOf(n) + 1];
  const spike = argvs.filter((a) => a.includes("--settings"));
  const control = argvs.filter((a) => !a.includes("--settings"));
  assert.ok(spike.length >= 3, "eof, term and kill runs use --settings");
  assert.ok(control.length >= 1, "a control run without --settings is started");
  for (const a of argvs) {
    assert.equal(flag(a, "--setting-sources"), "project,local");
    assert.ok(a.includes("--strict-mcp-config"));
    assert.ok(!a.includes("--permission-mode"));
  }
  assert.ok(r.control && typeof r.control === "object", "the S4b result carries its scored control run");
  assert.equal(r.control.spike, "S4b");
  assert.equal(typeof r.control.verdict, "string");
  assert.ok(Array.isArray(r.control.evidence) && r.control.evidence.length > 0);
});

// ---- S6b evaluator (--settings precedence and setting sources in a real worktree) ---------

// The deny target is exported by the script (ticket organism-infra/195): a path inside the worktree
// and outside .claude/, so the result shows our deny rule and not the CLI's built-in safetyCheck.
const S6B_DENY_TARGET = () => conf.S6B_DENY_TARGET;
const s6bInit = (extra = {}) => init(100, { permissionMode: "default", mcp_servers: [], plugins: [{ name: "cc-builtin", path: "builtin", source: "cc@builtin" }], ...extra });
const s6bCap = (initLine = s6bInit(), stderr = "") =>
  cap(
    [
      initLine,
      toolUse(500, "Write", { file_path: "/repo/.claude/worktrees/s6b-x/allowed.txt", content: "ok" }, "w1"),
      toolUse(700, "Write", { file_path: `/repo/.claude/worktrees/s6b-x/${S6B_DENY_TARGET()}`, content: "ok" }, "w2"),
      result(900, "PROBE-ROLE-OK"),
    ],
    { code: 0, signal: null, t: 1000 },
    stderr,
  );
const s6bOk = { allowedExists: true, deniedExists: false };

test("S6b go: the project allow applied, the inline deny won, and no user-scope MCP server or plugin loaded", () => {
  const r = evaluateS6b(s6bCap(), s6bOk);
  assert.equal(r.spike, "S6b");
  assert.equal(r.verdict, "go", r.evidence.join("\n"));
});

test("S6b no-go when the denied write landed (deny did not outrank allow, or --settings was ignored)", () => {
  assert.equal(evaluateS6b(s6bCap(), { allowedExists: true, deniedExists: true }).verdict, "no-go");
});

test("S6b no-go when the project allow did not apply and the CLI did not blame trust (--settings replaced it)", () => {
  assert.equal(evaluateS6b(s6bCap(), { allowedExists: false, deniedExists: false }).verdict, "no-go");
});

test("S6b unconfirmed, with the trust finding, when stderr says the worktree workspace is untrusted", () => {
  const stderr = "Warning: this workspace is not trusted; ignoring permissions.allow from project settings";
  const r = evaluateS6b(s6bCap(s6bInit(), stderr), { allowedExists: false, deniedExists: false });
  assert.equal(r.verdict, "unconfirmed");
  assert.match(r.evidence.join("\n"), /trust/i);
  assert.match(r.evidence.join("\n"), /worktree/i);
});

test("S6b no-go when init carries a user or claudeai MCP server; the evidence names it", () => {
  for (const [name, source] of [["blender", "user"], ["claude.ai Claude Docs", "claudeai"]]) {
    const r = evaluateS6b(s6bCap(s6bInit({ mcp_servers: [{ name, status: "connected", source }] })), s6bOk);
    assert.equal(r.verdict, "no-go", name);
    assert.ok(r.evidence.join("\n").includes(name), name);
  }
});

test("S6b no-go when init carries a user-scope plugin (a path under the owner's plugin cache); builtin plugins are fine", () => {
  const plugins = [
    { name: "cc-builtin", path: "builtin", source: "cc@builtin" },
    { name: "mattpocock-skills", path: "/home/someone/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.2.3", source: "mattpocock-skills@claude-plugins-official" },
  ];
  const r = evaluateS6b(s6bCap(s6bInit({ plugins })), s6bOk);
  assert.equal(r.verdict, "no-go");
  assert.ok(r.evidence.join("\n").includes("mattpocock-skills"));
});

// ---- S6b runner against a fake, in a real temporary git repo ------------------------------

const s6bFake = (o) => `
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
const o = ${JSON.stringify(o)};
const args = process.argv.slice(2);
const sid = args[args.indexOf("--session-id") + 1];
const home = process.env.HOME;
const out = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
const local = path.join(".claude", "settings.local.json");
fs.writeFileSync(path.join(home, args.includes("--settings") ? "s6b-seen.json" : "s6b-seen-control.json"), JSON.stringify({
  args, cwd: process.cwd(),
  local: fs.existsSync(local) ? JSON.parse(fs.readFileSync(local, "utf8")) : null,
  role: fs.existsSync(path.join(".claude", "agents", "probe.md")),
}));
if (o.crash) process.exit(1);
const rl = readline.createInterface({ input: process.stdin });
fs.appendFileSync(path.join(home, "s6b-argv.txt"), JSON.stringify(args) + "\\n");
rl.on("line", (line) => {
  fs.appendFileSync(path.join(home, "s6b-prompts.txt"), JSON.stringify(String(JSON.parse(line).message.content)) + "\\n");
  out({ type: "system", subtype: "init", permissionMode: "default", session_id: sid, mcp_servers: [], plugins: [{ name: "cc", path: "builtin", source: "cc@builtin" }] });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: path.resolve("allowed.txt"), content: "ok" } }] } });
  fs.writeFileSync("allowed.txt", "ok");
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "w2", name: "Write", input: { file_path: path.resolve(o.denyTarget), content: "ok" } }] } });
  // Without our inline --settings deny nothing stops this write: the CLI's own behaviour (the control run).
  if (!args.includes("--settings")) {
    fs.mkdirSync(path.dirname(path.resolve(o.denyTarget)), { recursive: true });
    fs.writeFileSync(path.resolve(o.denyTarget), "ok");
  }
  out({ type: "result", subtype: "success", is_error: false, result: "PROBE-ROLE-OK", session_id: sid });
});
rl.on("close", () => process.exit(0));
`;

const runS6b = async (o, repoOpt) => {
  const dir = mkdtempSync(path.join(tmpdir(), "c6-"));
  const repo = repoOpt ?? makeRepo();
  const fake = writeFake(dir, s6bFake({ denyTarget: conf.S6B_DENY_TARGET ?? "denied.txt", ...o }));
  const results = await runSpikes({ spikes: ["S6b"], out: path.join(dir, "out"), claudeBin: fake, env: { PATH: process.env.PATH, HOME: dir }, repo, timeoutMs: 10_000, log: () => {} });
  const seenFile = path.join(dir, "s6b-seen.json");
  const read = (name) => (existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), "utf8").split("\n").filter(Boolean) : []);
  return {
    r: results[0],
    repo,
    seen: existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, "utf8")) : null,
    seenControl: existsSync(path.join(dir, "s6b-seen-control.json")) ? JSON.parse(readFileSync(path.join(dir, "s6b-seen-control.json"), "utf8")) : null,
    prompts: read("s6b-prompts.txt").map((l) => JSON.parse(l)),
  };
};
const leftoverWorktrees = (repo) => {
  const root = path.join(repo, ".claude", "worktrees");
  return existsSync(root) ? readdirSync(root).filter((n) => n.startsWith("s6b-")) : [];
};

test("runSpikes S6b: runs in a detached worktree under <repo>/.claude/worktrees with production-shaped arguments, then removes it", async () => {
  const { r, repo, seen } = await runS6b({});
  assert.equal(r.verdict, "go", r.evidence.join("\n"));
  const root = realpathSync(path.join(repo, ".claude", "worktrees"));
  // The worktree is gone by now, so realpath only its parent (which survives) and match the leaf by name.
  assert.equal(realpathSync(path.dirname(seen.cwd)), root, seen.cwd);
  assert.match(path.basename(seen.cwd), /^s6b-/, seen.cwd);
  const a = seen.args;
  const flag = (n) => a[a.indexOf(n) + 1];
  assert.equal(flag("--setting-sources"), "project,local");
  assert.ok(a.includes("--strict-mcp-config"));
  assert.ok(!a.includes("--mcp-config"));
  assert.ok(!a.includes("--permission-mode"));
  assert.equal(flag("--agent"), "probe");
  const inline = JSON.parse(flag("--settings"));
  // The deny rule and the project-local allow rule name the same target, so the deny must outrank a
  // real allow, and the target is outside .claude/ (the CLI's safetyCheck must not decide the result).
  assert.ok(inline.permissions.deny.includes(`Write(${conf.S6B_DENY_TARGET})`), JSON.stringify(inline));
  assert.ok(seen.local.permissions.allow.includes("Write(allowed.txt)"));
  assert.ok(seen.local.permissions.allow.includes(`Write(${conf.S6B_DENY_TARGET})`), JSON.stringify(seen.local));
  assert.equal(seen.role, true);
  assert.equal(worktreeCount(repo), 1, "the s6b worktree was not removed");
  assert.deepEqual(leftoverWorktrees(repo), []);
});

test("runSpikes S6b: the worktree is removed even when the child crashes", async () => {
  const { r, repo } = await runS6b({ crash: true });
  assert.notEqual(r.verdict, "go");
  assert.equal(worktreeCount(repo), 1);
  assert.deepEqual(leftoverWorktrees(repo), []);
});

test("runSpikes S6b: a --repo that is not a git repository is a not-go result, not a crash", async () => {
  const plain = mkdtempSync(path.join(tmpdir(), "conf-plain-"));
  const { r } = await runS6b({}, plain);
  assert.notEqual(r.verdict, "go");
  assert.ok(r.evidence.length > 0);
});

// ---- S3b evaluator (optional, never gating) ------------------------------------------------
// Input: { subagent, wait, omitted } captures and { waitMs, omittedFileExists }.
// Result: verdict go or unconfirmed (never no-go) and behavior { subagentRequest, wait, updatedInputOmitted }.

const withParent = (line, parent) => L(line.t, { ...line.obj, parent_tool_use_id: parent });
const s3bSub = (identified) =>
  cap([init(100), toolUse(300, "Task", { prompt: "x" }, "task1"), identified ? withParent(controlRequest(900, "req_sub", "Write", { file_path: "/w/x.txt", content: "c" }), "task1") : controlRequest(900, "req_sub", "Write", { file_path: "/w/x.txt", content: "c" }), result(1500, "ok")]);
const s3bWaitDenied = (afterMs) =>
  cap([init(100), controlRequest(500, "req_w", "Write", { file_path: "/w/w.txt", content: "c" }), toolResult(500 + afterMs, "tu1", "timed out waiting for permission", true), result(600 + afterMs, "ok")]);
const s3bOmitted = () => cap([init(100), controlRequest(500, "req_o", "Write", { file_path: "/w/o.txt", content: "c" }), toolResult(900, "tu1", "created"), result(1000, "ok")]);

test("S3b go when all three questions are answered; behavior is recorded per question", () => {
  const r = evaluateS3b({ subagent: s3bSub(true), wait: s3bWaitDenied(30_000), omitted: s3bOmitted() }, { waitMs: 90_000, omittedFileExists: true });
  assert.equal(r.spike, "S3b");
  assert.equal(r.verdict, "go", r.evidence.join("\n"));
  assert.equal(r.behavior.subagentRequest, "reaches-parent-identified");
  assert.equal(r.behavior.wait, "denied");
  assert.equal(r.behavior.updatedInputOmitted, "honoured");
});

test("S3b records a subagent request that does not identify the subagent, and an allow that omitted updatedInput being rejected", () => {
  const r = evaluateS3b({ subagent: s3bSub(false), wait: s3bWaitDenied(30_000), omitted: s3bOmitted() }, { waitMs: 90_000, omittedFileExists: false });
  assert.equal(r.behavior.subagentRequest, "reaches-parent-unidentified");
  assert.equal(r.behavior.updatedInputOmitted, "rejected");
});

test("S3b records a subagent whose tool never prompts the parent", () => {
  const quiet = cap([init(100), toolUse(300, "Task", { prompt: "x" }, "task1"), toolResult(900, "tu9", "ran without a prompt"), result(1500, "ok")]);
  const r = evaluateS3b({ subagent: quiet, wait: s3bWaitDenied(30_000), omitted: s3bOmitted() }, { waitMs: 90_000, omittedFileExists: true });
  assert.equal(r.behavior.subagentRequest, "absent");
});

test("S3b distinguishes an unanswered request that hangs from one that exits or is denied", () => {
  const hung = cap([init(100), controlRequest(500, "req_w", "Write", { file_path: "/w/w.txt", content: "c" })], null);
  const exited = cap([init(100), controlRequest(500, "req_w", "Write", { file_path: "/w/w.txt", content: "c" })], { code: 1, signal: null, t: 20_000 });
  const run = (wait) => evaluateS3b({ subagent: s3bSub(true), wait, omitted: s3bOmitted() }, { waitMs: 90_000, omittedFileExists: true });
  assert.equal(run(hung).behavior.wait, "hung");
  assert.equal(run(exited).behavior.wait, "exited");
  assert.equal(run(s3bWaitDenied(30_000)).behavior.wait, "denied");
});

test("S3b is unconfirmed, never no-go, when a question stays open", () => {
  const nothing = cap([init(100), result(900, "no request was raised")]);
  const open = evaluateS3b({ subagent: s3bSub(true), wait: nothing, omitted: s3bOmitted() }, { waitMs: 90_000, omittedFileExists: true });
  assert.equal(open.verdict, "unconfirmed");
  const allOpen = evaluateS3b({ subagent: nothing, wait: nothing, omitted: nothing }, { waitMs: 90_000, omittedFileExists: false });
  assert.equal(allOpen.verdict, "unconfirmed");
  assert.notEqual(allOpen.verdict, "no-go");
});

// ==== Ticket organism-infra/195: setup guard, S4b and S6b probes, control run =================
// ADR 0016 (spike round 2 verdicts): the first re-run was setup-invalid because the child ran in
// permissionMode auto with user-scope MCP servers loaded. Human-verified (not tested here): the
// run instructions in the ticket handoff fit one screen and can be pasted from the main checkout.

// ---- S6b: the deny target ------------------------------------------------------------------

test("S6B_DENY_TARGET is a relative path inside the worktree and outside .claude/", () => {
  const target = conf.S6B_DENY_TARGET;
  assert.equal(typeof target, "string", "export S6B_DENY_TARGET");
  assert.ok(target.length > 0);
  assert.ok(!path.isAbsolute(target), target);
  const parts = path.normalize(target).split(path.sep);
  assert.ok(!parts.includes(".."), target);
  assert.ok(!parts.includes(".claude"), `a .claude/ target is refused by the CLI's own safetyCheck: ${target}`);
  assert.notEqual(path.normalize(target), "allowed.txt");
});

test("S6b evaluator: a write attempt at the old .claude/probe.txt target no longer counts as the denied attempt", () => {
  const oldTargetCap = cap([
    s6bInit(),
    toolUse(500, "Write", { file_path: "/repo/.claude/worktrees/s6b-x/allowed.txt", content: "ok" }, "w1"),
    toolUse(700, "Write", { file_path: "/repo/.claude/worktrees/s6b-x/.claude/probe.txt", content: "ok" }, "w2"),
    result(900, "PROBE-ROLE-OK"),
  ]);
  assert.equal(evaluateS6b(oldTargetCap, s6bOk).verdict, "unconfirmed");
});

test("runSpikes S6b: the prompt names the new deny target and never the .claude/ one", async () => {
  const { r, prompts } = await runS6b({});
  assert.equal(r.verdict, "go", r.evidence.join("\n"));
  assert.ok(prompts.length >= 1);
  for (const p of prompts) {
    assert.ok(p.includes(conf.S6B_DENY_TARGET), p);
    assert.doesNotMatch(p, /\.claude\/probe/, p);
  }
});

test("runSpikes S6b: no inline deny rule and no project-local allow rule points into .claude/", async () => {
  const { seen } = await runS6b({});
  const flag = (n) => seen.args[seen.args.indexOf(n) + 1];
  const rules = [...JSON.parse(flag("--settings")).permissions.deny, ...seen.local.permissions.allow];
  for (const rule of rules) assert.doesNotMatch(rule, /\.claude/, rule);
});

// ---- Control run (no --settings) ------------------------------------------------------------

test("runSpikes S6b: a control run without --settings is produced, scored next to the spike, and does not change the spike's verdict", async () => {
  const { r, repo, seen, seenControl } = await runS6b({});
  assert.ok(seen.args.includes("--settings"));
  assert.ok(seenControl, "the control child was never started");
  assert.ok(!seenControl.args.includes("--settings"), "the control run must not pass --settings");
  assert.equal(r.verdict, "go", `the control's unguarded write must not leak into the spike's verdict: ${r.evidence.join("\n")}`);
  assert.ok(r.control && typeof r.control === "object", "the S6b result carries its scored control run");
  assert.equal(r.control.spike, "S6b");
  assert.equal(typeof r.control.verdict, "string");
  assert.ok(Array.isArray(r.control.evidence) && r.control.evidence.length > 0);
  assert.equal(worktreeCount(repo), 1, "a control worktree was not removed");
  assert.deepEqual(leftoverWorktrees(repo), []);
});

test("runSpikes S8: a control run without --settings is produced; the spike run passes the production arguments", async () => {
  const { r, argvs, left } = await runS8({ socket: false });
  assert.equal(r.verdict, "go", r.evidence.join("\n"));
  const withSettings = argvs.filter((a) => a.includes("--settings"));
  const without = argvs.filter((a) => !a.includes("--settings"));
  assert.ok(withSettings.length >= 1, "the spike run uses the production-shaped --settings");
  assert.ok(without.length >= 1, "a control run without --settings is started");
  for (const a of argvs) {
    assert.equal(a[a.indexOf("--setting-sources") + 1], "project,local");
    assert.ok(a.includes("--strict-mcp-config"));
    assert.ok(!a.includes("--permission-mode"));
  }
  assert.ok(r.control && typeof r.control === "object", "the S8 result carries its scored control run");
  assert.equal(r.control.spike, "S8");
  assert.equal(typeof r.control.verdict, "string");
  assert.ok(Array.isArray(r.control.evidence) && r.control.evidence.length > 0);
  assert.deepEqual(left, []);
});

// ---- Setup guard ---------------------------------------------------------------------------
// Before scoring, the runner reads the child's init event. permissionMode other than "default", or any
// mcp_servers entry, makes the spike report verdict "setup-invalid" with evidence naming the field,
// never go, no-go or unconfirmed. Tested with a stub child that emits the init it is told to.

const setupFake = (o) => `
import readline from "node:readline";
const o = ${JSON.stringify(o)};
const args = process.argv.slice(2);
const sid = args[args.indexOf("--session-id") + 1] ?? args[args.indexOf("--resume") + 1];
const out = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", () => {
  out({ type: "system", subtype: "init", session_id: sid, permissionMode: o.permissionMode, mcp_servers: o.mcp_servers, plugins: [], capabilities: [] });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "true" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "", is_error: false }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "PROBE-ROLE-OK", session_id: sid });
});
rl.on("close", () => process.exit(0));
setInterval(() => {}, 1000);
`;

const SETUP_SPIKES = ["S1", "S2", "S3", "S4", "S6", "S7", "S8", "S4b", "S6b", "S3b"];
const runSetup = async (id, init) => {
  const dir = mkdtempSync(path.join(tmpdir(), "c195-"));
  const fake = writeFake(dir, setupFake(init));
  const out = path.join(dir, "out");
  const results = await runSpikes({
    spikes: [id],
    out,
    claudeBin: fake,
    env: { PATH: process.env.PATH, HOME: dir },
    repo: id === "S6b" ? makeRepo() : undefined,
    timeoutMs: 3000,
    s3bWaitMs: 1000,
    timing: FAST,
    log: () => {},
  });
  return { r: results[0], out };
};

for (const id of SETUP_SPIKES) {
  test(`setup guard, ${id}: permissionMode auto is setup-invalid and the evidence names permissionMode`, async () => {
    const { r } = await runSetup(id, { permissionMode: "auto", mcp_servers: [] });
    assert.equal(r.spike, id);
    assert.equal(r.verdict, "setup-invalid", r.evidence.join("\n"));
    assert.match(r.evidence.join("\n"), /permissionMode/);
    assert.doesNotMatch(r.evidence.join("\n"), /mcp_servers/);
  });

  test(`setup guard, ${id}: a user-scope MCP server is setup-invalid and the evidence names mcp_servers`, async () => {
    const { r } = await runSetup(id, { permissionMode: "default", mcp_servers: [{ name: "blender", status: "connected", source: "user" }] });
    assert.equal(r.verdict, "setup-invalid", r.evidence.join("\n"));
    assert.match(r.evidence.join("\n"), /mcp_servers/);
    assert.doesNotMatch(r.evidence.join("\n"), /permissionMode/);
  });
}

test("setup guard: both fields wrong are both named", async () => {
  const { r } = await runSetup("S1", { permissionMode: "bypassPermissions", mcp_servers: [{ name: "blender", status: "connected", source: "user" }] });
  assert.equal(r.verdict, "setup-invalid");
  assert.match(r.evidence.join("\n"), /permissionMode/);
  assert.match(r.evidence.join("\n"), /mcp_servers/);
});

test("setup guard: setup-invalid is written to results.json, not softened to unconfirmed or no-go", async () => {
  const { out } = await runSetup("S1", { permissionMode: "auto", mcp_servers: [] });
  const saved = JSON.parse(readFileSync(path.join(out, "results.json"), "utf8"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].verdict, "setup-invalid");
});

test("setup guard: permissionMode default with no MCP servers is not setup-invalid", async () => {
  const { r } = await runSetup("S1", { permissionMode: "default", mcp_servers: [] });
  assert.notEqual(r.verdict, "setup-invalid", r.evidence.join("\n"));
});
