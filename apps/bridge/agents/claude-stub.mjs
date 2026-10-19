// organism-infra/143: test-only helpers for the Claude process tests (not a test file: no .test.mjs suffix).
//
// makeStub(opts) writes an executable node script that stands in for the `claude` binary, so the runtime is exercised
// over real pipes, real signals and a real process group. The script records what it sees to a jsonl file:
//   { kind: "start", pid, argv, cwd, envKeys }   once, at launch
//   { kind: "stdin", line }                      every line the runtime writes to the child's stdin
// opts.mode picks what it does after it reads the prompt line (its first stdin line):
//   approve   assistant tool_use (Bash, id tu1) + usage, then a can_use_tool control_request "req-1" (input
//             { command: "npm test" }); on a control_response it emits the tool_result and a success `result`, exits 0
//   hang      assistant tool_use + usage, then stays alive until killed (ignores stdin EOF)
//   hog       (den-mvp outcome 1) assistant tool_use, then takes memory 8 MiB at a time until something stops it
//   crash     assistant tool_use, then exit code 3
//   flood     writes 1 MB to stderr, then a success `result`, exits 0
//   utf8      a tool_use whose command holds multibyte characters, written in byte pieces split inside a character
//   oversize  a 1.2 MB non-JSON stdout line, then a tool_use and a success `result`, exits 0
//   dup       control_request req-1 twice, then a control_request req-2 with subtype "set_model"; stays alive
//   write     assistant tool_use (Write, id tu1) for opts.writePath, then a can_use_tool control_request "req-1" for it;
//             on a control_response it writes the file only if the answer is allow, then tool_result and `result`;
//             like the live CLI it then stays up until its stdin closes, and exits 0; a second user line that
//             carries a uuid is replayed with it, as the live CLI does under --replay-user-messages
//   replay    writes the lines of opts.replayFile (a recorded stdout capture) in order; after each control_request it
//             waits for a control_response before going on, and after the last line it stays up until stdin closes
//   message   (den-v1 loop S5) replays the prompt line as the live CLI does under --replay-user-messages (with a uuid
//             of its own), starts a tool call and waits; a second user line is replayed with the uuid it came with,
//             then the tool result, a text block and a `result` that repeat its text; up until stdin closes.
//             opts.forgeReplay: a uuid it also "replays" just before, though no such message was ever written
// opts.grandchild: null | "plain" | "ignoreTerm" | "detached"   spawns a child of the stub, pid in pidFile. "detached"
//   ignores SIGTERM and starts its own session, so a signal to the stub's process group never reaches it
// opts.ignoreTerm: the stub itself ignores SIGTERM
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const UTF8_COMMAND = "echo héllo 🙂 日本";
export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

export async function makeStub({ mode = "approve", grandchild = null, ignoreTerm = false, writePath = null, replayFile = null, forgeReplay = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "den-claude-stub-"));
  const logFile = path.join(dir, "log.jsonl");
  const pidFile = path.join(dir, "grandchild.pid");
  const bin = path.join(dir, "claude-stub.mjs");
  const opts = { mode, grandchild, ignoreTerm, logFile, pidFile, writePath, replayFile, forgeReplay, command: UTF8_COMMAND };
  const source = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
const O = ${JSON.stringify(opts)};
const log = (o) => appendFileSync(O.logFile, JSON.stringify(o) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
log({ kind: "start", pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), envKeys: Object.keys(process.env).sort() });
if (O.ignoreTerm) process.on("SIGTERM", () => {});
if (O.grandchild) {
  // The grandchild writes its own pid file once its SIGTERM disposition is in place, so a test that waits for
  // the pid file never signals a grandchild that has not yet installed its handler.
  const ready = "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)";
  const src = O.grandchild === "plain" ? ready : "process.on('SIGTERM',()=>{});" + ready;
  spawn(process.execPath, ["-e", src, O.pidFile], { stdio: "ignore", detached: O.grandchild === "detached" });
}
const toolUse = (command) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command } }], usage: { input_tokens: 10, output_tokens: 20 } } });
const request = (id, subtype) => ({ type: "control_request", request_id: id, request: subtype === "can_use_tool" ? { subtype, tool_name: "Bash", input: { command: "npm test" } } : { subtype } });
const writeInput = { file_path: O.writePath, content: "written by the stub" };
const result = () => ({ type: "result", subtype: "success", is_error: false, result: "done by the stub", total_cost_usd: 0.0012 });
const finish = (code = 0) => process.stdout.write("", () => process.exit(code));
setInterval(() => {}, 1000);
let prompted = false;
let lingering = false;
let replay = [];
// Writes recorded lines until one is a control_request (held until its answer) or none are left.
const pump = () => {
  while (replay.length) {
    const line = replay.shift();
    process.stdout.write(line + "\\n");
    if (JSON.parse(line).type === "control_request") return;
  }
  lingering = true;
};
const rl = readline.createInterface({ input: process.stdin });
rl.on("close", () => { if (lingering) finish(0); });
rl.on("line", async (line) => {
  log({ kind: "stdin", line });
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "control_response" && O.mode === "approve") {
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } });
    out(result());
    finish(0);
    return;
  }
  if (msg.type === "control_response" && O.mode === "write") {
    const allowed = msg.response?.response?.behavior === "allow";
    if (allowed) writeFileSync(O.writePath, writeInput.content);
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: allowed ? "ok" : "denied", is_error: !allowed }] } });
    out(result());
    lingering = true; // like the live CLI: up after the result line, until stdin closes
    return;
  }
  if (msg.type === "control_response" && O.mode === "replay") return pump();
  if (prompted && msg.type === "user" && O.mode === "write" && typeof msg.uuid === "string") {
    out({ type: "user", message: msg.message, uuid: msg.uuid, isReplay: true });
    return;
  }
  if (prompted && msg.type === "user" && O.mode === "message") {
    const said = typeof msg.message?.content === "string" ? msg.message.content : "";
    if (O.forgeReplay) out({ type: "user", message: { role: "user", content: "never sent" }, uuid: O.forgeReplay, isReplay: true });
    out({ type: "user", message: msg.message, uuid: msg.uuid, isReplay: true });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } });
    out({ type: "assistant", message: { content: [{ type: "text", text: "got: " + said }] } });
    out({ ...result(), result: "got: " + said });
    lingering = true;
    return;
  }
  if (prompted || msg.type !== "user") return;
  prompted = true;
  if (O.mode === "replay") {
    replay = readFileSync(O.replayFile, "utf8").split("\\n").filter(Boolean);
    return pump();
  }
  if (O.mode === "approve") { out(toolUse("npm test")); out(request("req-1", "can_use_tool")); }
  else if (O.mode === "write") {
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Write", input: writeInput }], usage: { input_tokens: 10, output_tokens: 20 } } });
    out({ type: "control_request", request_id: "req-1", request: { subtype: "can_use_tool", tool_name: "Write", input: writeInput } });
  }
  else if (O.mode === "message") {
    out({ type: "user", message: msg.message, uuid: typeof msg.uuid === "string" ? msg.uuid : "00000000-0000-4000-8000-0000000000aa", isReplay: true });
    out(toolUse("sleep 5"));
    lingering = true;
  }
  else if (O.mode === "hang") out(toolUse("sleep 999"));
  else if (O.mode === "hog") {
    out(toolUse("node hog.js"));
    const held = [];
    setInterval(() => held.push(Buffer.alloc(8 << 20, 1)), 20);
  }
  else if (O.mode === "crash") { out(toolUse("boom")); finish(3); }
  else if (O.mode === "flood") {
    const chunk = "e".repeat(65536) + "\\n";
    for (let i = 0; i < 16; i += 1) process.stderr.write(chunk);
    out(result());
    finish(0);
  } else if (O.mode === "utf8") {
    const buf = Buffer.from(JSON.stringify(toolUse(O.command)) + "\\n");
    const cut = buf.indexOf(Buffer.from("é")) + 1; // inside the two-byte character
    process.stdout.write(buf.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 60));
    const emoji = buf.indexOf(Buffer.from("🙂")) + 2; // inside the four-byte character
    process.stdout.write(buf.subarray(cut, emoji));
    await new Promise((r) => setTimeout(r, 60));
    process.stdout.write(buf.subarray(emoji));
    out(result());
    finish(0);
  } else if (O.mode === "oversize") {
    process.stdout.write("x".repeat(1_200_000) + "\\n");
    out(toolUse("after the big line"));
    out(result());
    finish(0);
  } else if (O.mode === "dup") {
    out(request("req-1", "can_use_tool"));
    out(request("req-1", "can_use_tool"));
    out(request("req-2", "set_model"));
  }
});
`;
  await writeFile(bin, source);
  await chmod(bin, 0o755);
  return {
    dir,
    bin,
    logFile,
    pidFile,
    async log() {
      const text = await readFile(logFile, "utf8").catch(() => "");
      return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    async stdinLines() {
      return (await this.log()).filter((e) => e.kind === "stdin").map((e) => JSON.parse(e.line));
    },
    async start() {
      return (await this.log()).find((e) => e.kind === "start");
    },
    async grandchildPid() {
      const text = await readFile(pidFile, "utf8").catch(() => "");
      return text ? Number(text) : null;
    },
  };
}

// Drain a CellProcess's events into an array in the background; `done` resolves when the stream ends.
export function collect(proc) {
  const events = [];
  const done = (async () => {
    for await (const e of proc.events) events.push(e);
  })();
  return { events, done };
}
