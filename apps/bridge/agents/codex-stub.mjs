// Test-only stand-in for `codex app-server` (not a .test.mjs file). It speaks the JSON-RPC lines the adapter
// expects over stdio. On turn/start it runs the turn's input text as a real shell command and reports the
// result the way app-server does: a commandExecution item whose aggregatedOutput holds the command's output.
// argv[2] picks the mode: "ok" (default) | "crash" (exit 3 once the turn is acknowledged) | "deaf" (ignores SIGTERM)
// | "flood" (400 command starts, then done, ignoring the input).
// Like Codex 0.163, the shell tool is the code-mode `exec` tool: a config with `features.code_mode_host = false` makes every command fail
// closed ("code-mode host is disabled") instead of running (den-revival/03 1b, found by a real run).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const MODE = process.argv[2] ?? "ok";
const MODEL = "gpt-stub-1";
if (MODE === "deaf") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
const out = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const notify = (method, params) => out({ method, params });
let thread = null;
let turnSequence = 0;

function flood() {
  notify("turn/started", { threadId: thread.id, turn: { id: "turn-1", status: "inProgress" } });
  for (let i = 0; i < 400; i += 1) notify("item/started", { threadId: thread.id, turnId: "turn-1", item: { id: `cmd-${i}`, type: "commandExecution", command: "x" } });
  notify("turn/completed", { threadId: thread.id, turn: { id: "turn-1", status: "completed" } });
}

function shellHostDisabled() {
  const file = `${process.env.CODEX_HOME}/config.toml`;
  return existsSync(file) && /^code_mode_host = false$/m.test(readFileSync(file, "utf8"));
}

const git = (...args) => {
  const r = spawnSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: thread.cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
};
const finishDelegation = report => {
  notify('item/completed', { threadId: thread.id, turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: report } });
  notify('turn/completed', { threadId: thread.id, turn: { id: 'turn-1', status: 'completed' } });
};
function runTurn(input, settings) {
  if (MODE === 'delegate-loop') {
    notify('turn/started', { threadId: thread.id, turn: { id: 'turn-1', status: 'inProgress' } });
    if (thread.dynamicTools?.length) {
      thread.manager = /"kind":"manager"/.test(input);
      out({ id: 'managed-1', method: 'item/tool/call', params: { threadId: thread.id, turnId: 'turn-1', callId: 'managed-call-1', tool: 'delegate', arguments: {
        issue: thread.manager ? 'child-check' : 'manager-integration', kind: thread.manager ? 'child' : 'manager', role: 'developer', task: thread.manager ? 'Write probe result' : 'Coordinate probe work',
        reason: 'Separate check and integration', files: ['sample.txt'], constraints: ['No dependencies'], acceptance: ['Return verified probe result'],
      } } });
      return;
    }
    writeFileSync(`${thread.cwd}/sample.txt`, 'verified child work\n');
    git('add', 'sample.txt'); git('commit', '-m', 'probe child work');
    return finishDelegation('child evidence: targeted checks passed');
  }

  if (MODE === "flood") return flood();
  const turnId = `turn-${turnSequence}`;
  const base = { threadId: thread.id, turnId };
  notify("turn/started", { threadId: thread.id, turn: { id: turnId, status: "inProgress" } });
  notify("item/started", { ...base, item: { id: "cmd-1", type: "commandExecution", command: input } });
  const ran = MODE === "settings" ? { status: 0, stdout: JSON.stringify({ model: settings.model, reasoning: settings.effort, serviceTier: settings.serviceTierForTurn, threadModel: thread.model }) } : MODE === "instructions" ? { status: 0, stdout: thread.instructions } : shellHostDisabled() ? { status: 1, stdout: "code-mode host is disabled" } : spawnSync("sh", ["-c", input], { encoding: "utf8", cwd: thread.cwd });
  const output = (ran.stdout ?? "") + (ran.stderr ?? "");
  notify("item/completed", { ...base, item: { id: "cmd-1", type: "commandExecution", command: input,
    status: ran.status === 0 ? "completed" : "failed", exitCode: ran.status, aggregatedOutput: output } });
  notify("item/completed", { ...base, item: { id: "msg-1", type: "agentMessage", text: `ran: ${input}` } });
  notify("turn/completed", { threadId: thread.id, turn: { id: turnId, status: "completed" } });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (MODE === 'delegate-loop' && message.id === 'managed-1' && message.result) {
    const returned = JSON.parse(message.result.contentItems[0].text);
    if (!returned.ok) throw new Error(JSON.stringify(returned));
    if (thread.manager) git('cherry-pick', returned.sha);
    return finishDelegation(`Integrated returned evidence: ${returned.report}; commit ${returned.sha}`);
  }
  if (message.id === undefined || !message.method) return;
  const reply = (result) => out({ id: message.id, result });
  const p = message.params;
  if (message.method === "initialize") return reply({ userAgent: "codex-stub/0" });
  if (message.method === "model/list") return reply({ data: [MODEL, "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"].map(model => ({ id: model, model, supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map(reasoningEffort => ({ reasoningEffort })) })), nextCursor: null });
  if (message.method === "thread/start") {
    thread = { id: "thread-1", cwd: p.cwd, instructions: p.developerInstructions, model: p.model, dynamicTools: p.dynamicTools };
    if (process.env.CODEX_HOME) writeFileSync(`${process.env.CODEX_HOME}/stub-thread.json`, JSON.stringify(thread));
    return reply({ thread: { id: thread.id }, model: p.model, cwd: p.cwd, activePermissionProfile: { id: p.permissions } });
  }
  if (message.method === "thread/resume") {
    const file = `${process.env.CODEX_HOME}/stub-thread.json`;
    if (!existsSync(file) || JSON.parse(readFileSync(file, "utf8")).id !== p.threadId) return out({ id: message.id, error: { code: -32602, message: "unknown thread" } });
    thread = { ...JSON.parse(readFileSync(file, "utf8")), id: p.threadId, cwd: p.cwd, instructions: p.developerInstructions, model: p.model };
    return reply({ thread: { id: thread.id }, model: p.model, cwd: p.cwd, activePermissionProfile: { id: p.permissions } });
  }
  if (message.method === "turn/start") {
    turnSequence += 1;
    reply({ turn: { id: `turn-${turnSequence}`, status: "inProgress" } });
    if (MODE === "crash") process.exit(3);
    return runTurn(p.input[0].text, p);
  }
  if (message.method === "turn/interrupt") return reply({});
});
