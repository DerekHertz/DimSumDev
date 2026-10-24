// den-v1 loop S3: the live check. One agent goes through the production path (startBridge, the Claude runtime, the
// host's worktree and fixed prompt) and asks for a Write outside its worktree; the bridge holds the request, the
// harness allows it over HTTP, and the answer reaches the child. Three layers of test:
//   the evaluator, over hand-built captures
//   the harness, end to end with claude-stub.mjs as the binary (no login, no tokens)
//   the committed fixture of the one real run, read with the production decoder and parser
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildClaudeArgs, decodeControlRequest, parseClaudeLine } from "./claude-adapter.mjs";
import * as adapterAll from "./claude-adapter.mjs"; // agent-os/04: compileCeiling is read off the namespace so a missing export fails this test by name
import { makeStub } from "./claude-stub.mjs";
import { SPIKES, parseCli, setupProblems } from "./conformance.mjs";
import { unconfinedLauncher } from "./launcher-test-helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
async function load() {
  try {
    return await import("./conformance-live.mjs");
  } catch (err) {
    assert.fail(`apps/bridge/agents/conformance-live.mjs does not exist yet (missing feature): ${err.message}`);
  }
}

// ---- hand-built captures --------------------------------------------------------------------

const WT = "/tmp/den-live-x/.claude/worktrees/den-den-01-live-check-0123abcd";
const TARGET = "/tmp/den-live-x/live-check.txt";
const BODY = "LIVE-BODY-A1B2C3";
const INPUT = { file_path: TARGET, content: BODY };
const cap = (objs) => ({ lines: objs.map((o, i) => ({ t: i, raw: JSON.stringify(o), obj: o })), exit: { code: 0, signal: null }, stderr: "" });

const init = (over = {}) => ({ type: "system", subtype: "init", cwd: WT, permissionMode: "default", mcp_servers: [], plugins: [], model: "claude-haiku-4-5", ...over });
const toolUse = { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Write", input: INPUT }], usage: { input_tokens: 3, output_tokens: 40 } } };
const request = (over = {}) => ({ type: "control_request", request_id: "req-1", request: { subtype: "can_use_tool", tool_name: "Write", input: INPUT, tool_use_id: "tu1", ...over } });
const toolResult = (over = {}) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "File created", ...over }] } });
const result = (over = {}) => ({ type: "result", subtype: "success", is_error: false, result: "LIVE-CHECK-OK wrote the file", total_cost_usd: 0.0123, ...over });
const answer = (over = {}) => ({ type: "control_response", response: { subtype: "success", request_id: "req-1", response: { behavior: "allow", updatedInput: INPUT, ...over } } });

function run({ main, stdin, bridge } = {}) {
  return {
    main: cap(main ?? [init(), toolUse, request(), toolResult(), result()]),
    stdin: cap(stdin ?? [{ type: "user", message: { role: "user", content: "prompt" } }, answer()]),
    bridge: cap(
      bridge ?? [
        { type: "check", check: "setup", worktree: WT, target: TARGET, body: BODY },
        { type: "sse", event: "change", data: { type: "approval", approval: { id: "a-0123456789abcdef", state: "pending", tool: "Write" } } },
        { type: "check", check: "held", approvalId: "a-0123456789abcdef", tool: "Write", agentState: "waiting_on_user", input: INPUT, fileExists: false, cliLines: 3 },
        { type: "check", check: "decided", approvalId: "a-0123456789abcdef", decision: "allow", status: 200 },
        { type: "sse", event: "change", data: { type: "approval", approval: { id: "a-0123456789abcdef", state: "allowed", tool: "Write" } } },
        { type: "check", check: "final", agentState: "done", endedByItself: true, fileExists: true, bodyMatches: true },
      ],
    ),
  };
}
const editBridge = (fn) => run().bridge.lines.map((l) => fn(structuredClone(l.obj)) ?? l.obj);
const text = (r) => r.evidence.join("\n");

describe("evaluateLive", () => {
  test("go: a request for a write outside the worktree, held, allowed, performed, and the agent ended by itself", async () => {
    const { evaluateLive } = await load();
    const r = evaluateLive(run());
    assert.equal(r.verdict, "go", text(r));
    assert.equal(r.spike, "Live");
    assert.equal(r.costUsd, 0.0123);
    for (const word of ["control_request", "held", "allow", "tool_result"]) assert.match(text(r), new RegExp(word), word);
    assert.ok(!r.stopRule);
  });

  test("no-go, and the stop rule, when the CLI raised no permission request for the write", async () => {
    const { evaluateLive } = await load();
    const r = evaluateLive(run({ main: [init(), toolUse, toolResult(), result()], stdin: [{ type: "user" }] }));
    assert.equal(r.verdict, "no-go");
    assert.equal(r.stopRule, true);
    assert.match(text(r), /stop rule/i);
    assert.match(text(r), /before S1/);
  });

  test("no-go when the request does not decode with the production decoder", async () => {
    const { evaluateLive } = await load();
    const r = evaluateLive(run({ main: [init(), toolUse, request({ input: "not an object" }), toolResult(), result()] }));
    assert.equal(r.verdict, "no-go");
    assert.equal(r.stopRule, true);
  });

  test("no-go when the write was inside the agent's worktree (the check must be an outside write)", async () => {
    const { evaluateLive } = await load();
    const inside = { file_path: `${WT}/inside.txt`, content: BODY };
    const r = evaluateLive(run({ main: [init(), toolUse, request({ input: inside }), toolResult(), result()], bridge: editBridge((o) => (o.check === "setup" ? { ...o, target: inside.file_path } : undefined)) }));
    assert.equal(r.verdict, "no-go");
    assert.match(text(r), /inside the worktree/);
  });

  test("no-go when the child did not run in the worktree", async () => {
    const { evaluateLive } = await load();
    const r = evaluateLive(run({ main: [init({ cwd: "/tmp/den-live-x" }), toolUse, request(), toolResult(), result()] }));
    assert.equal(r.verdict, "no-go");
    assert.match(text(r), /cwd/);
  });

  test("no-go when the bridge did not hold the request: no pending approval, or the file was already there", async () => {
    const { evaluateLive } = await load();
    const noHold = evaluateLive(run({ bridge: editBridge(() => undefined).filter((o) => o.check !== "held") }));
    assert.equal(noHold.verdict, "no-go");
    const early = evaluateLive(run({ bridge: editBridge((o) => (o.check === "held" ? { ...o, fileExists: true } : undefined)) }));
    assert.equal(early.verdict, "no-go");
    assert.match(text(early), /while the request was held/);
    const notWaiting = evaluateLive(run({ bridge: editBridge((o) => (o.check === "held" ? { ...o, agentState: "working" } : undefined)) }));
    assert.equal(notWaiting.verdict, "no-go");
    const partial = evaluateLive(run({ bridge: editBridge((o) => (o.check === "held" ? { ...o, input: { file_path: TARGET } } : undefined)) }));
    assert.equal(partial.verdict, "no-go");
    assert.match(text(partial), /full input/);
  });

  test("no-go when the tool result was already out before the hold was observed", async () => {
    const { evaluateLive } = await load();
    const r = evaluateLive(run({ bridge: editBridge((o) => (o.check === "held" ? { ...o, cliLines: 5 } : undefined)) }));
    assert.equal(r.verdict, "no-go");
  });

  test("no-go when the allow never reached the child's stdin, or answered another request", async () => {
    const { evaluateLive } = await load();
    assert.equal(evaluateLive(run({ stdin: [{ type: "user" }] })).verdict, "no-go");
    const other = { type: "control_response", response: { subtype: "success", request_id: "req-9", response: { behavior: "allow", updatedInput: INPUT } } };
    assert.equal(evaluateLive(run({ stdin: [other] })).verdict, "no-go");
    assert.equal(evaluateLive(run({ stdin: [answer({ behavior: "deny", updatedInput: undefined, message: "no" })] })).verdict, "no-go");
    const widened = evaluateLive(run({ stdin: [answer({ updatedPermissions: [{ type: "addRules" }] })] }));
    assert.equal(widened.verdict, "no-go");
    assert.match(text(widened), /bare decision/);
  });

  test("no-go when the tool result is an error, the file is missing or wrong, or the turn failed", async () => {
    const { evaluateLive } = await load();
    assert.equal(evaluateLive(run({ main: [init(), toolUse, request(), toolResult({ is_error: true }), result()] })).verdict, "no-go");
    assert.equal(evaluateLive(run({ main: [init(), toolUse, request(), result()] })).verdict, "no-go");
    assert.equal(evaluateLive(run({ bridge: editBridge((o) => (o.check === "final" ? { ...o, fileExists: false, bodyMatches: false } : undefined)) })).verdict, "no-go");
    assert.equal(evaluateLive(run({ bridge: editBridge((o) => (o.check === "final" ? { ...o, bodyMatches: false } : undefined)) })).verdict, "no-go");
    assert.equal(evaluateLive(run({ main: [init(), toolUse, request(), toolResult(), result({ subtype: "error_during_execution", is_error: true })] })).verdict, "no-go");
    assert.equal(evaluateLive(run({ main: [init(), toolUse, request(), toolResult(), result({ total_cost_usd: undefined })] })).verdict, "no-go");
  });

  test("no-go when the agent did not end by itself after its result line, or did not end done", async () => {
    const { evaluateLive } = await load();
    const hung = evaluateLive(run({ bridge: editBridge((o) => (o.check === "final" ? { ...o, agentState: "working", endedByItself: false } : undefined)) }));
    assert.equal(hung.verdict, "no-go");
    assert.match(text(hung), /did not end/);
    assert.ok(!hung.stopRule, "not the permission stop rule");
    assert.equal(evaluateLive(run({ bridge: editBridge((o) => (o.check === "final" ? { ...o, agentState: "failed" } : undefined)) })).verdict, "no-go");
  });

  // den-v1 loop S5: the message the harness sends while the request is held.
  const MID = "7b0c2f1e-3a4d-4e5f-8a6b-9c0d1e2f3a4b";
  const sentLine = { type: "user", message: { role: "user", content: "end with LIVE-SAID-AB12CD" }, uuid: MID };
  const frame = (status) => ({ type: "sse", event: "change", data: { type: "transcript", agentId: "c-1", entry: { id: 4, kind: "message", role: "user", messageId: MID, status } } });
  const withMessage = ({ main, stdin, said = {}, frames = [frame("queued"), frame("applied")] } = {}) => {
    const base = run();
    const notes = base.bridge.lines.map((l) => l.obj);
    notes.splice(3, 0, { type: "check", check: "message", status: 202, messageId: MID, word: "LIVE-SAID-AB12CD", ...said }, ...frames);
    return run({
      main: main ?? [init(), toolUse, request(), { ...sentLine, isReplay: true }, toolResult(), result({ result: "LIVE-CHECK-OK wrote the file LIVE-SAID-AB12CD" })],
      stdin: stdin ?? [{ type: "user", message: { role: "user", content: "prompt" } }, sentLine, answer()],
      bridge: notes,
    });
  };

  test("go with a message: written while held, replayed by the CLI with its id, marked received", async () => {
    const { evaluateLive } = await load();
    const r = evaluateLive(withMessage());
    assert.equal(r.verdict, "go", text(r));
    assert.match(text(r), /message: written to the child's stdin while the request was held, replayed by the CLI with its id, marked queued -> applied/);
    assert.match(text(r), /note: the replay came before the held tool's result; 1 result line\(s\) \(the message joined the running turn\); the final reply holds the word/);
    assert.ok(!r.messageRule);
  });

  test("a run with no message is scored as before, with no line about one", async () => {
    const { evaluateLive } = await load();
    const r = evaluateLive(run());
    assert.equal(r.verdict, "go", text(r));
    assert.doesNotMatch(text(r), /message/i);
  });

  test("no-go, and the message rule, when the CLI did not replay the message with its id", async () => {
    const { evaluateLive } = await load();
    const noReplay = evaluateLive(withMessage({ main: [init(), toolUse, request(), toolResult(), result()] }));
    assert.equal(noReplay.verdict, "no-go");
    assert.equal(noReplay.messageRule, true);
    assert.match(text(noReplay), /MESSAGE RULE: the CLI did not replay the message with the id it was written with \(0 replay line/);
    const otherId = evaluateLive(withMessage({ main: [init(), toolUse, request(), { ...sentLine, uuid: "00000000-0000-4000-8000-00000000dead", isReplay: true }, toolResult(), result()] }));
    assert.equal(otherId.messageRule, true);
    assert.match(text(otherId), /\(1 replay line/);
    const notReplay = evaluateLive(withMessage({ main: [init(), toolUse, request(), sentLine, toolResult(), result()] }));
    assert.equal(notReplay.messageRule, true, "a user line without isReplay is not a replay");
  });

  test("no-go when the bridge refused the message, never wrote it, or never marked it received", async () => {
    const { evaluateLive } = await load();
    const refused = evaluateLive(withMessage({ said: { status: 409, messageId: null, error: "the agent has finished its work" } }));
    assert.equal(refused.verdict, "no-go");
    assert.match(text(refused), /the bridge refused the message: 409 the agent has finished its work/);
    const unwritten = evaluateLive(withMessage({ stdin: [{ type: "user", message: { role: "user", content: "prompt" } }, answer()] }));
    assert.match(text(unwritten), /FAILED: the message never reached the child's stdin/);
    const unmarked = evaluateLive(withMessage({ frames: [frame("queued")] }));
    assert.equal(unmarked.verdict, "no-go");
    assert.match(text(unmarked), /did not mark the message received \(states queued\)/);
    assert.ok(!unmarked.messageRule);
  });

  test("a message taken as a further turn is a go, and the note gives each result line's totals", async () => {
    const { evaluateLive } = await load();
    const main = [init(), toolUse, request(), toolResult(), result({ num_turns: 2, usage: { output_tokens: 40 } }), { ...sentLine, isReplay: true }, result({ total_cost_usd: 0.02, num_turns: 1, usage: { output_tokens: 9 }, result: "LIVE-CHECK-OK no word" })];
    const r = evaluateLive(withMessage({ main }));
    assert.equal(r.verdict, "go", text(r));
    assert.match(text(r), /the replay came after the held tool's result; 2 result line\(s\) \(the message was a further turn\); the final reply does not hold the word/);
    assert.match(text(r), /note: totals per result line: 0\.0123 USD, 40 output tokens, 2 turns; 0\.02 USD, 9 output tokens, 1 turns/);
    assert.equal(r.costUsd, 0.02);
  });

  test("an empty run is a no-go, never a throw", async () => {
    const { evaluateLive } = await load();
    assert.equal(evaluateLive({}).verdict, "no-go");
    assert.equal(evaluateLive({ main: cap([]), stdin: cap([]), bridge: cap([]) }).verdict, "no-go");
  });
});

// ---- registry -------------------------------------------------------------------------------

describe("scrubLive (the fixture scrub step)", () => {
  const SESSION = "b6b9668e-b422-43e7-ad82-6031ae4f20b4";
  const raw = () => {
    const thinking = { type: "assistant", session_id: SESSION, message: { content: [{ type: "thinking", thinking: "private chain", signature: "s".repeat(64) }] } };
    const r = run({
      main: [init({ session_id: SESSION, memory_paths: { auto: "~/.claude/projects/x/memory/" }, messaging_socket_path: "/tmp/cc-socks/1.sock", slash_commands: ["a"], apiKeySource: "none" }), thinking, toolUse, request(), toolResult(), result({ session_id: SESSION })],
      bridge: [...editBridge(() => undefined), { type: "sse", event: "change", data: { type: "agent", agent: { sessionId: SESSION, resume: `claude --resume ${SESSION}` } } }],
    });
    r.main.lines.push({ t: 99, raw: "not json", obj: null });
    return r;
  };

  test("keeps only the init keys the checks read, empties thinking, fixes the session id, drops non-JSON lines", async () => {
    const { scrubLive, FIXTURE_SESSION_ID } = await load();
    const before = raw();
    const clean = scrubLive(before);
    const first = clean.main.lines[0].obj;
    assert.deepEqual(Object.keys(first), ["type", "subtype", "cwd", "mcp_servers", "model", "permissionMode", "plugins", "session_id"]);
    const all = Object.values(clean).flatMap((c) => c.lines.map((l) => l.raw)).join("\n");
    assert.doesNotMatch(all, /cc-socks|messaging_socket_path|memory_paths|private chain|"signature":"[^"]/);
    assert.ok(!all.includes(SESSION));
    assert.ok(all.includes(`claude --resume ${FIXTURE_SESSION_ID}`));
    assert.equal(clean.main.lines.length, before.main.lines.length - 1);
    for (const c of Object.values(clean)) for (const l of c.lines) assert.deepEqual(JSON.parse(l.raw), l.obj);
    assert.ok(before.main.lines[0].obj.messaging_socket_path, "the input is not changed");
  });

  test("a scrubbed run still scores the same", async () => {
    const { scrubLive, evaluateLive } = await load();
    assert.equal(evaluateLive(scrubLive(raw())).verdict, "go");
    assert.deepEqual(scrubLive({}), {});
  });
});

describe("the Live spike in the conformance script", () => {
  test("is registered, runs only when named, and npm run smoke:live names it", () => {
    assert.ok(SPIKES.Live, "SPIKES.Live");
    assert.equal(typeof SPIKES.Live.run, "function");
    assert.ok(!parseCli([]).spikes.includes("Live"));
    assert.deepEqual(parseCli(["--spike", "live"]).spikes, ["Live"]);
    const pkg = JSON.parse(readFileSync(path.join(HERE, "../../../package.json"), "utf8"));
    assert.equal(pkg.scripts["smoke:live"], "node apps/bridge/agents/conformance.mjs --spike Live");
  });

  test("setupProblems checks the child's init and skips the stdin and bridge captures, which have none", () => {
    assert.deepEqual(setupProblems(run(), { spike: "Live" }), []);
    const loose = setupProblems(run({ main: [init({ permissionMode: "acceptEdits" }), toolUse, request(), toolResult(), result()] }), { spike: "Live" });
    assert.equal(loose.length, 1);
    assert.match(loose[0], /permissionMode/);
  });
});

// ---- the harness, with the stub as the binary -------------------------------------------------

// den-v1 loop, the ticket read: the probe reads its ticket file (in the main checkout, outside its worktree) first.
describe("evaluateLive: the agent's own ticket file", () => {
  const TICKET = "/tmp/den-live-x/.scratch/den/issues/01-live-check.md";
  const readUse = { type: "assistant", message: { content: [{ type: "tool_use", id: "tu0", name: "Read", input: { file_path: TICKET } }] } };
  const readResult = (over = {}) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu0", content: "LIVE-TICKET-0A1B2C", ...over }] } });
  const readRequest = { type: "control_request", request_id: "req-0", request: { subtype: "can_use_tool", tool_name: "Read", input: { file_path: TICKET }, tool_use_id: "tu0" } };
  const withTicket = () => editBridge((o) => (o.check === "setup" ? { ...o, ticket: TICKET } : undefined));

  test("go, with a line of evidence, when the read raised no request and returned the file", async () => {
    const { evaluateLive } = await load();
    const r = evaluateLive(run({ main: [init(), readUse, readResult(), toolUse, request(), toolResult(), result()], bridge: withTicket() }));
    assert.equal(r.verdict, "go", text(r));
    assert.match(text(r), /ticket file .* no permission request/);
  });

  test("no-go under TICKET RULE when the read raised a permission request", async () => {
    const { evaluateLive } = await load();
    const r = evaluateLive(run({ main: [init(), readUse, readRequest, readResult({ is_error: true, content: "denied" }), toolUse, request(), toolResult(), result()], bridge: withTicket() }));
    assert.equal(r.verdict, "no-go");
    assert.equal(r.ticketRule, true);
    assert.match(text(r), /TICKET RULE/);
  });

  test("no-go when the probe never read its ticket, or the read failed", async () => {
    const { evaluateLive } = await load();
    const never = evaluateLive(run({ bridge: withTicket() }));
    assert.equal(never.verdict, "no-go");
    assert.match(text(never), /never read its ticket/);
    const failed = evaluateLive(run({ main: [init(), readUse, readResult({ is_error: true, content: "ENOENT" }), toolUse, request(), toolResult(), result()], bridge: withTicket() }));
    assert.equal(failed.verdict, "no-go");
    assert.match(text(failed), /ticket file failed/);
  });

  // The control: a second board file next to the ticket, which the rule must not open.
  const OTHER = "/tmp/den-live-x/.scratch/den/issues/02-neighbour.md";
  const otherUse = { type: "assistant", message: { content: [{ type: "tool_use", id: "tu9", name: "Read", input: { file_path: OTHER } }] } };
  const otherRequest = { type: "control_request", request_id: "req-9", request: { subtype: "can_use_tool", tool_name: "Read", input: { file_path: OTHER }, tool_use_id: "tu9" } };
  const otherResult = (over = {}) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu9", content: "denied", is_error: true, ...over }] } });
  const withBoth = () => editBridge((o) => (o.check === "setup" ? { ...o, ticket: TICKET, neighbour: OTHER } : undefined));

  test("the neighbouring board file still raises a request: the rule opens the ticket and nothing next to it", async () => {
    const { evaluateLive } = await load();
    const r = evaluateLive(run({ main: [init(), readUse, readResult(), otherUse, otherRequest, otherResult(), toolUse, request(), toolResult(), result()], bridge: withBoth() }));
    assert.equal(r.verdict, "go", text(r));
    assert.match(text(r), /neighbouring board file raised a permission request/);
  });

  test("a neighbour read that raises no request is a no-go: the run does not show the rule is narrow", async () => {
    const { evaluateLive } = await load();
    const r = evaluateLive(run({ main: [init(), readUse, readResult(), otherUse, otherResult({ is_error: false, content: "x" }), toolUse, request(), toolResult(), result()], bridge: withBoth() }));
    assert.equal(r.verdict, "no-go");
    assert.match(text(r), /neighbouring board file raised no permission request/);
    const never = evaluateLive(run({ main: [init(), readUse, readResult(), toolUse, request(), toolResult(), result()], bridge: withBoth() }));
    assert.equal(never.verdict, "no-go");
    assert.match(text(never), /never tried the neighbouring board file/);
  });

  test("a run recorded before the step existed (no ticket in its setup) is not scored on it", async () => {
    const { evaluateLive } = await load();
    const r = evaluateLive(run());
    assert.equal(r.verdict, "go", text(r));
    assert.doesNotMatch(text(r), /ticket file/);
  });

  test("makeLiveRepo writes the ticket only when asked, and the probe role names it first", async () => {
    const { makeLiveRepo, LIVE_ROLE } = await load();
    const plain = makeLiveRepo();
    const withOne = makeLiveRepo({ ticketWord: "LIVE-TICKET-0A1B2C" });
    try {
      assert.equal(plain.ticket, null);
      assert.equal(existsSync(path.join(plain.dir, ".scratch", "den")), false);
      assert.equal(withOne.ticket, path.join(withOne.dir, ".scratch", "den", "issues", "01-live-check.md"));
      assert.match(readFileSync(withOne.ticket, "utf8"), /LIVE-TICKET-0A1B2C/);
      const role = readFileSync(path.join(withOne.dir, ".claude", "agents", `${LIVE_ROLE}.md`), "utf8");
      assert.ok(role.indexOf(`Use the Read tool to read the file ${withOne.ticket}`) > 0, "the role names the ticket read");
      assert.ok(role.indexOf(withOne.ticket) < role.indexOf(withOne.target), "the read comes before the writes");
      assert.equal(plain.neighbour, null);
      assert.equal(withOne.neighbour, path.join(withOne.dir, ".scratch", "den", "issues", "02-neighbour.md"));
      assert.ok(existsSync(withOne.neighbour));
      assert.ok(role.indexOf(withOne.ticket) < role.indexOf(withOne.neighbour) && role.indexOf(withOne.neighbour) < role.indexOf(withOne.target), "ticket, neighbour, then the writes");
      assert.throws(() => makeLiveRepo({ ticketWord: "two\nlines" }), TypeError);
    } finally {
      plain.cleanup();
      withOne.cleanup();
    }
  });
});

// den-mvp outcome 1: the runtime closes the credential stores that exist under the home it was given.
const liveCredentials = () => {
  const credentials = adapterAll.CREDENTIAL_PATHS.filter((p) => existsSync(`${process.env.HOME}${p.slice(1)}`));
  return credentials.length === 0 ? {} : { credentials };
};
const stubCtx = (bin) => ({ bin, launcher: unconfinedLauncher(), parentEnv: { PATH: process.env.PATH, HOME: process.env.HOME, DEN_SECRET_CANARY: "must-not-reach-the-child" }, timeoutMs: 8000, model: "haiku" });

describe("runLive", () => {
  test("drives one agent through the bridge: worktree cwd, production argv, held request, a message, allow over HTTP, done", async () => {
    const { runLive, makeLiveRepo, LIVE_ROLE } = await load();
    const repo = makeLiveRepo({ body: "written by the stub" });
    const stub = await makeStub({ mode: "write", writePath: repo.target });
    const { result, captures } = await runLive(stubCtx(stub.bin), null, { repo, exitWaitMs: 4000, killGraceMs: 150 });
    assert.equal(result.verdict, "go", text(result));
    assert.equal(existsSync(repo.dir), false, "the throwaway repository is removed");

    // The recording wrapper is transparent: the stub saw the production argv, the allowlisted env and the worktree.
    const start = await stub.start();
    const setup = captures.bridge.lines.find((l) => l.obj.check === "setup").obj;
    assert.equal(start.cwd, setup.worktree);
    assert.match(setup.worktree, /\/\.claude\/worktrees\/den-den-01-live-check-[0-9a-f]{8}$/);
    const sessionId = start.argv[start.argv.indexOf("--session-id") + 1];
    assert.equal(typeof adapterAll.compileCeiling, "function", "agent-os/04: claude-adapter.mjs must export compileCeiling");
    // agent-os/04: the live role (sre) has a ceiling, so the production argv carries the wall; the worktree is the child's cwd.
    assert.deepEqual(start.argv, buildClaudeArgs({ sessionId, agent: LIVE_ROLE, ...adapterAll.compileCeiling(LIVE_ROLE, { ...liveCredentials(), worktree: setup.worktree, mainGit: path.join(path.dirname(path.dirname(path.dirname(setup.worktree))), ".git") }), ticketFile: path.join(repo.dir, ".scratch", "den", "issues", "01-live-check.md") }));
    assert.ok(!start.envKeys.includes("DEN_SECRET_CANARY"));

    // What the three captures hold: scrubbed, and every line a JSON object with a type.
    for (const c of Object.values(captures)) for (const l of c.lines) assert.equal(typeof l.obj.type, "string", l.raw.slice(0, 80));
    assert.ok(captures.main.lines.some((l) => l.obj?.type === "control_request"));
    const reply = captures.stdin.lines.map((l) => l.obj).find((o) => o?.type === "control_response");
    assert.equal(reply.response.response.behavior, "allow");
    assert.equal(captures.stdin.lines[0].obj.type, "user", "the first stdin line is the host's prompt");
    assert.ok(!captures.stdin.lines[0].raw.includes(repo.target), "the prompt carries no path: the task is in the role file");
    const states = captures.bridge.lines.map((l) => l.obj).filter((o) => o.type === "sse" && o.data?.type === "approval").map((o) => o.data.approval.state);
    assert.deepEqual(states, ["pending", "allowed"]);
    // den-v1 loop S5: the harness sent one message while the request was held, and the stub replayed it.
    const said = captures.bridge.lines.map((l) => l.obj).find((o) => o.check === "message");
    assert.equal(said.status, 202);
    assert.match(result.evidence.join("\n"), /message: written to the child's stdin while the request was held, replayed by the CLI with its id, marked queued -> applied/);
    assert.equal(captures.stdin.lines.map((l) => l.obj).filter((o) => o.type === "user").length, 2, "the prompt and the one message");
    const final = captures.bridge.lines.map((l) => l.obj).find((o) => o.check === "final");
    assert.deepEqual({ agentState: final.agentState, endedByItself: final.endedByItself, fileExists: final.fileExists, bodyMatches: final.bodyMatches }, { agentState: "done", endedByItself: true, fileExists: true, bodyMatches: true });
  });

  test("message: false leaves the message out", async () => {
    const { runLive, makeLiveRepo } = await load();
    const repo = makeLiveRepo({ body: "written by the stub" });
    const stub = await makeStub({ mode: "write", writePath: repo.target });
    const { result, captures } = await runLive(stubCtx(stub.bin), null, { repo, exitWaitMs: 4000, killGraceMs: 150, message: false });
    assert.equal(result.verdict, "go", text(result));
    assert.equal(captures.bridge.lines.some((l) => l.obj.check === "message"), false);
    assert.equal(captures.stdin.lines.map((l) => l.obj).filter((o) => o.type === "user").length, 1);
  });

  test("a child that raises no request for the write is a no-go that names the stop rule", async () => {
    const { runLive, makeLiveRepo } = await load();
    const repo = makeLiveRepo();
    const stub = await makeStub({ mode: "crash" }); // a tool_use, then exit 3: no control_request at all
    const { result } = await runLive(stubCtx(stub.bin), null, { repo, exitWaitMs: 2000, killGraceMs: 150 });
    assert.equal(result.verdict, "no-go");
    assert.equal(result.stopRule, true);
    assert.equal(existsSync(repo.dir), false);
  });

  test("a request for anything but the expected write is denied, never allowed", async () => {
    const { runLive, makeLiveRepo } = await load();
    const repo = makeLiveRepo();
    const stub = await makeStub({ mode: "approve" }); // asks for Bash "npm test"
    const { result } = await runLive(stubCtx(stub.bin), null, { repo, exitWaitMs: 2000, killGraceMs: 150 });
    assert.equal(result.verdict, "no-go");
    const reply = (await stub.stdinLines()).find((l) => l.type === "control_response");
    assert.equal(reply.response.response.behavior, "deny");
  });

  test("makeLiveRepo: a git repository with the role file committed, and the write target outside any worktree", async () => {
    const { makeLiveRepo, LIVE_ROLE, LIVE_MARKER } = await load();
    const repo = makeLiveRepo({ model: "haiku" });
    try {
      const role = readFileSync(path.join(repo.dir, ".claude", "agents", `${LIVE_ROLE}.md`), "utf8");
      assert.match(role, /^---\nname: sre\n/);
      assert.match(role, /\nmodel: haiku\n/);
      assert.ok(role.includes(repo.target) && role.includes(repo.body) && role.includes(LIVE_MARKER));
      assert.equal(path.dirname(repo.target), repo.dir);
      assert.equal(existsSync(repo.target), false);
      assert.ok(existsSync(path.join(repo.dir, ".git")));
      assert.throws(() => makeLiveRepo({ model: "haiku\nallowedTools: Bash" }), TypeError);
    } finally {
      repo.cleanup();
    }
  });
});

// ---- the committed fixture of the real run ------------------------------------------------------

describe("the committed live fixture (fixtures/live*.jsonl)", () => {
  const file = (name) => path.join(HERE, "fixtures", name);
  const readCap = (name) => {
    let body;
    try {
      body = readFileSync(file(name), "utf8");
    } catch {
      assert.fail(`fixtures/${name} is not recorded yet: run \`npm run smoke:live\` on the owner's login and copy the Live*.jsonl files in`);
    }
    return { lines: body.split("\n").filter(Boolean).map((raw, t) => ({ t, raw, obj: JSON.parse(raw) })), exit: null, stderr: "" };
  };
  const all = () => ({ main: readCap("live.jsonl"), stdin: readCap("live-stdin.jsonl"), bridge: readCap("live-bridge.jsonl") });

  test("scores go: request, held approval, decision, tool result", async () => {
    const { evaluateLive } = await load();
    const r = evaluateLive(all());
    assert.equal(r.verdict, "go", text(r));
  });

  test("the child ran in default permission mode with no MCP server, outside plugin or hook", () => {
    const caps = all();
    assert.deepEqual(setupProblems(caps, { spike: "Live" }), []);
    const first = caps.main.lines.map((l) => l.obj).find((o) => o.type === "system" && o.subtype === "init");
    assert.equal(first.permissionMode, "default");
  });

  test("its lines read with the production decoder and parser: a Write approval, tool events, usage, done", () => {
    const { main } = all();
    const decoded = main.lines.filter((l) => l.obj.type === "control_request").map((l) => decodeControlRequest(l.obj, new Set()));
    assert.ok(decoded.some((d) => d.kind === "approval" && d.tool === "Write" && typeof d.input.file_path === "string"));
    const events = main.lines.flatMap((l) => parseClaudeLine(l.raw));
    const types = new Set(events.map((e) => e.type));
    for (const type of ["tool-start", "tool-end", "usage", "done"]) assert.ok(types.has(type), type);
    const last = main.lines.map((l) => l.obj).findLast((o) => o.type === "result");
    assert.deepEqual({ type: events.at(-1).type, ok: events.at(-1).ok }, { type: "done", ok: true });
    assert.equal(events.at(-1).costUsd, last.total_cost_usd, "done carries the CLI's own cost (den-v1 loop S4)");
    assert.equal(typeof last.total_cost_usd, "number");
    assert.equal(typeof last.result, "string");
  });

  test("holds no home path", () => {
    for (const name of ["live.jsonl", "live-stdin.jsonl", "live-bridge.jsonl"]) {
      assert.doesNotMatch(readFileSync(file(name), "utf8"), /\/home\/|\/Users\//, name);
    }
  });
});

// den-v1 loop S5: a second recorded run (CLI 2.1.293, haiku, 2026-10-10), made with --replay-user-messages in the
// argv and one message sent while the Write request was held. It is the evidence for what the stub assumes: the CLI
// replays a stdin user message with the uuid it was written with.
describe("the committed live message fixture (fixtures/live-message*.jsonl)", () => {
  const readCap = (name) => {
    const body = readFileSync(path.join(HERE, "fixtures", name), "utf8");
    return { lines: body.split("\n").filter(Boolean).map((raw, t) => ({ t, raw, obj: JSON.parse(raw) })), exit: null, stderr: "" };
  };
  const all = () => ({ main: readCap("live-message.jsonl"), stdin: readCap("live-message-stdin.jsonl"), bridge: readCap("live-message-bridge.jsonl") });

  test("scores go, with the message written, replayed with its id and marked received", async () => {
    const { evaluateLive } = await load();
    const r = evaluateLive(all());
    assert.equal(r.verdict, "go", text(r));
    assert.match(text(r), /message: written to the child's stdin while the request was held, replayed by the CLI with its id, marked queued -> applied/);
    assert.match(text(r), /1 result line\(s\) \(the message joined the running turn\); the final reply holds the word/);
    assert.deepEqual(setupProblems(all(), { spike: "Live" }), []);
  });

  test("the production parser reads the message's replay as message-applied with the id the bridge wrote", () => {
    const { main, stdin, bridge } = all();
    const said = bridge.lines.map((l) => l.obj).find((o) => o.check === "message");
    const written = stdin.lines.map((l) => l.obj).filter((o) => o.type === "user");
    assert.deepEqual(written.map((o) => o.uuid), [undefined, said.messageId], "the prompt carries no id, the message carries the bridge's");
    const applied = main.lines.flatMap((l) => parseClaudeLine(l.raw)).filter((e) => e.type === "message-applied");
    assert.equal(applied.length, 2, "the CLI replays the prompt too, under an id of its own");
    assert.equal(applied[1].id, said.messageId);
    assert.notEqual(applied[0].id, said.messageId);
  });

  test("the lines the new flag adds read as nothing else: no tool result, no second reply", () => {
    const { main } = all();
    const extra = main.lines.filter((l) => l.obj.isReplay === true || l.obj.type === "command_lifecycle" || l.obj.type === "control_response");
    assert.equal(extra.length >= 5, true, "two replays, the message's lifecycle lines and the echoed answers");
    assert.deepEqual(extra.flatMap((l) => parseClaudeLine(l.raw)).map((e) => e.type), ["message-applied", "message-applied"]);
    const events = main.lines.flatMap((l) => parseClaudeLine(l.raw));
    assert.equal(events.filter((e) => e.type === "done").length, 1);
    assert.equal(events.filter((e) => e.type === "tool-result").length, 2, "the two writes, and nothing from a replay");
  });

  test("holds no home path", () => {
    for (const name of ["live-message.jsonl", "live-message-stdin.jsonl", "live-message-bridge.jsonl"]) {
      assert.doesNotMatch(readFileSync(path.join(HERE, "fixtures", name), "utf8"), /\/home\/|\/Users\//, name);
    }
  });
});

// The run of 2026-10-10 after the den's first live task stalled on its own ticket: CLI 2.1.293, Haiku.
describe("the committed live ticket fixture (fixtures/live-ticket*.jsonl)", () => {
  const names = ["live-ticket.jsonl", "live-ticket-stdin.jsonl", "live-ticket-bridge.jsonl"];
  const readCap = (name) => {
    const body = readFileSync(path.join(HERE, "fixtures", name), "utf8");
    return { lines: body.split("\n").filter(Boolean).map((raw, t) => ({ t, raw, obj: JSON.parse(raw) })), exit: null, stderr: "" };
  };
  const all = () => ({ main: readCap(names[0]), stdin: readCap(names[1]), bridge: readCap(names[2]) });

  test("scores go: the ticket read raised no request, the file next to it did", async () => {
    const { evaluateLive } = await load();
    const r = evaluateLive(all());
    assert.equal(r.verdict, "go", text(r));
    assert.match(text(r), /read its ticket file in the main checkout, and it raised no permission request/);
    assert.match(text(r), /neighbouring board file raised a permission request/);
    assert.deepEqual(setupProblems(all(), { spike: "Live" }), []);
  });

  test("the child was started with the one allow rule, for the ticket the setup names", () => {
    const { main, bridge } = all();
    const setup = bridge.lines.map((l) => l.obj).find((o) => o.check === "setup");
    const asked = main.lines.map((l) => l.obj).filter((o) => o.type === "control_request").map((o) => `${o.request.tool_name} ${o.request.input.file_path}`);
    assert.ok(asked.includes(`Read ${setup.neighbour}`), "the neighbour was asked about");
    assert.ok(!asked.includes(`Read ${setup.ticket}`), "the ticket was not");
    assert.equal(setup.ticket.endsWith("/.scratch/den/issues/01-live-check.md"), true);
  });

  test("holds no home path", () => {
    for (const name of names) assert.doesNotMatch(readFileSync(path.join(HERE, "fixtures", name), "utf8"), /\/home\/|\/Users\//, name);
  });
});
