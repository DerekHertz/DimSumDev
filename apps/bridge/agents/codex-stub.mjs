// Test-only stand-in for `codex app-server` (not a .test.mjs file). It speaks the JSON-RPC lines the adapter
// expects over stdio. On turn/start it runs the turn's input text as a real shell command and reports the
// result the way app-server does: a commandExecution item whose aggregatedOutput holds the command's output.
// argv[2] picks the mode: "ok" (default) | "crash" (exit 3 once the turn is acknowledged) | "deaf" (ignores SIGTERM)
// | "flood" (400 command starts, then done, ignoring the input).
// Like Codex 0.163, the shell tool is the code-mode `exec` tool: a config with `features.code_mode_host = false` makes every command fail
// closed ("code-mode host is disabled") instead of running (den-revival/03 1b, found by a real run).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import readline from "node:readline";

const MODE = process.argv[2] ?? "ok";
const MODEL = "gpt-stub-1";
if (MODE === "deaf") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
const out = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const notify = (method, params) => out({ method, params });
let thread = null;

function flood() {
  notify("turn/started", { threadId: thread.id, turn: { id: "turn-1", status: "inProgress" } });
  for (let i = 0; i < 400; i += 1) notify("item/started", { threadId: thread.id, turnId: "turn-1", item: { id: `cmd-${i}`, type: "commandExecution", command: "x" } });
  notify("turn/completed", { threadId: thread.id, turn: { id: "turn-1", status: "completed" } });
}

function shellHostDisabled() {
  const file = `${process.env.CODEX_HOME}/config.toml`;
  return existsSync(file) && /^code_mode_host = false$/m.test(readFileSync(file, "utf8"));
}

function runTurn(input) {
  if (MODE === "flood") return flood();
  const base = { threadId: thread.id, turnId: "turn-1" };
  notify("turn/started", { threadId: thread.id, turn: { id: "turn-1", status: "inProgress" } });
  notify("item/started", { ...base, item: { id: "cmd-1", type: "commandExecution", command: input } });
  const ran = shellHostDisabled() ? { status: 1, stdout: "code-mode host is disabled" } : spawnSync("sh", ["-c", input], { encoding: "utf8", cwd: thread.cwd });
  const output = (ran.stdout ?? "") + (ran.stderr ?? "");
  notify("item/completed", { ...base, item: { id: "cmd-1", type: "commandExecution", command: input,
    status: ran.status === 0 ? "completed" : "failed", exitCode: ran.status, aggregatedOutput: output } });
  notify("item/completed", { ...base, item: { id: "msg-1", type: "agentMessage", text: `ran: ${input}` } });
  notify("turn/completed", { threadId: thread.id, turn: { id: "turn-1", status: "completed" } });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined || !message.method) return;
  const reply = (result) => out({ id: message.id, result });
  const p = message.params;
  if (message.method === "initialize") return reply({ userAgent: "codex-stub/0" });
  if (message.method === "model/list") return reply({ data: [{ id: MODEL, model: MODEL, supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: 'medium' }] }], nextCursor: null });
  if (message.method === "thread/start") {
    thread = { id: "thread-1", cwd: p.cwd };
    return reply({ thread: { id: thread.id }, model: p.model, cwd: p.cwd, activePermissionProfile: { id: p.permissions } });
  }
  if (message.method === "turn/start") {
    reply({ turn: { id: "turn-1", status: "inProgress" } });
    if (MODE === "crash") process.exit(3);
    return runTurn(p.input[0].text);
  }
  if (message.method === "turn/interrupt") return reply({});
});
