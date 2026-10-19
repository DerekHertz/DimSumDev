// Round 4 conformance fixes (ticket organism-infra/202; ADR 0016 amendment 6, security 143 findings
// 1, 3, 4, 5, 7). Every runner test drives a scripted fake `claude`; none starts the real one.
// Human-verified (not tested here): the run instructions in the ticket handoff fit on one screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { evaluateS4b, evaluateS8, runSpikes } from "./conformance.mjs";

function writeFake(dir, body) {
  const file = path.join(dir, "fake-claude.mjs");
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}
function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "conf4-repo-"));
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  writeFileSync(path.join(dir, "README.md"), "x\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  return dir;
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
const pids = (file) => lines(file).map(Number);
async function stillAlive(list, ms = 4000) {
  const end = Date.now() + ms;
  let left = list.filter(alive);
  while (left.length && Date.now() < end) {
    await pause(100);
    left = list.filter(alive);
  }
  for (const p of left) {
    try {
      process.kill(p, "SIGKILL");
    } catch {}
  }
  return left;
}
const FAST = { settleMs: 100, eofPollMs: 1500, termCheckMs: [300, 800] };

// ==== 1. S4b: evaluator ======================================================================
// An `unstarted` run (the tool was not shown in flight) is setup-invalid, never go or no-go.

const s4bClean = () => ({
  eof: { exited: true, survivors: 0 },
  term: { exited: true, exitMs: 120, survivorsAt2s: 0, survivorsAt10s: 0 },
  kill: { survivors: 0 },
  group: null,
});

test("S4b evaluator: a tool call that never started is setup-invalid, not unconfirmed or go", () => {
  const r = evaluateS4b({ ...s4bClean(), unstarted: ["eof", "term"] });
  assert.equal(r.verdict, "setup-invalid", r.evidence.join("\n"));
  assert.match(r.evidence.join("\n"), /eof/);
});

test("S4b evaluator: a tool call that never started is setup-invalid even when the child did not exit on EOF (never no-go)", () => {
  const d = s4bClean();
  d.eof = { exited: false, survivors: 0 };
  const r = evaluateS4b({ ...d, unstarted: ["eof"] });
  assert.equal(r.verdict, "setup-invalid", r.evidence.join("\n"));
});

// ==== 2. S4b: runner against a stub child ====================================================
// The stub plays the model: it takes the first double-quoted string of the prompt as the Bash
// command and really runs it (`exec <command>` under sh, cwd = the child's cwd) as the tool process.
// Options: eofExits, termExits;
//   deny           every tool call is refused (system/permission_denied + is_error tool_result), no tool runs
//   blockOutsideCwd refused only when the command names an absolute path outside the cwd (like the real CLI)
//   noTool         tool_use is emitted but no process is started
//   selfTitle      no tool process; the child's own command line (ps) carries the command (its argv hit)
//   endTurnEarly   the turn ends (`result`) right after the tool starts
// Recorded under $HOME: children.txt, tools.txt, commands.txt (what ran), argv.txt (every child argv).

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
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = String(JSON.parse(line).message.content);
  out({ type: "system", subtype: "init", permissionMode: "default", mcp_servers: [], session_id: sid });
  const command = (text.match(/"([^"]+)"/) ?? [])[1];
  if (!command) { out({ type: "result", subtype: "success", is_error: false, result: "PROBE-ROLE-OK", session_id: sid }); return; }
  const cwds = [process.cwd(), fs.realpathSync(process.cwd())];
  const outside = command.split(/\\s+/).some((t) => t.startsWith("/") && !cwds.some((c) => path.resolve(t).startsWith(c + path.sep)));
  const tu = { type: "assistant", message: { content: [{ type: "tool_use", id: "tsl", name: "Bash", input: { command } }] } };
  if (o.deny || (o.blockOutsideCwd && outside)) {
    out(tu);
    out({ type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "tsl", message: command.split(" ")[0] + " in '" + command + "' was blocked. For security, Claude Code may only read the end of files from the allowed working directories" });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "blocked", is_error: true, tool_use_id: "tsl" }] } });
    return;
  }
  if (o.selfTitle) process.title = command;
  else if (!o.noTool) {
    const tool = spawn("sh", ["-c", "exec " + command], { stdio: "ignore" });
    tool.unref();
    log("tools.txt", tool.pid);
    log("commands.txt", command);
  }
  out(tu);
  if (o.endTurnEarly) out({ type: "result", subtype: "success", is_error: false, result: "done", session_id: sid });
});
rl.on("close", () => { if (o.eofExits) process.exit(0); });
process.on("SIGTERM", () => { if (o.termExits) process.exit(0); });
setInterval(() => {}, 1000);
`;

const runS4b = async (o) => {
  const dir = mkdtempSync(path.join(tmpdir(), "c4r4-"));
  const fake = writeFake(dir, s4bFake({ eofExits: true, termExits: true, ...o }));
  const results = await runSpikes({ spikes: ["S4b"], out: path.join(dir, "out"), claudeBin: fake, env: { PATH: process.env.PATH, HOME: dir }, timeoutMs: 10_000, timing: FAST, log: () => {} });
  return {
    r: results[0],
    commands: lines(path.join(dir, "commands.txt")),
    argvs: lines(path.join(dir, "argv.txt")).map((l) => JSON.parse(l)),
    leftTools: await stillAlive(pids(path.join(dir, "tools.txt"))),
    leftChildren: await stillAlive(pids(path.join(dir, "children.txt"))),
  };
};
const evidence = (r) => r.evidence.join("\n");

test("runSpikes S4b: a tool call the CLI refuses (permission_denied) is setup-invalid, never go", async () => {
  const { r, leftTools, leftChildren } = await runS4b({ deny: true });
  assert.equal(r.verdict, "setup-invalid", evidence(r));
  assert.match(evidence(r), /permission_denied/);
  assert.deepEqual(leftTools, []);
  assert.deepEqual(leftChildren, []);
});

test("runSpikes S4b: a tool_use with no tool process anywhere is setup-invalid", async () => {
  const { r } = await runS4b({ noTool: true });
  assert.equal(r.verdict, "setup-invalid", evidence(r));
});

test("runSpikes S4b: the child itself matching the marker (its own command line) is not a tool in flight: setup-invalid", async () => {
  const { r, leftChildren } = await runS4b({ selfTitle: true });
  assert.equal(r.verdict, "setup-invalid", evidence(r));
  assert.deepEqual(leftChildren, []);
});

test("runSpikes S4b: a turn that already ended (result) before the signal is setup-invalid and the evidence says so", async () => {
  const { r } = await runS4b({ endTurnEarly: true });
  assert.equal(r.verdict, "setup-invalid", evidence(r));
  assert.match(evidence(r), /turn[^\n]*result|result[^\n]*turn/i);
});

test("runSpikes S4b: the hold file is inside the child's cwd, so a CLI that blocks paths outside the cwd lets the tool run (group-kill, go)", async () => {
  const { r, commands, leftTools, leftChildren } = await runS4b({ blockOutsideCwd: true });
  assert.ok(commands.length >= 3, `the tool was refused: only ${commands.length} runs started it`);
  assert.equal(r.verdict, "go", evidence(r));
  assert.equal(r.decision, "group-kill");
  assert.deepEqual(leftTools, []);
  assert.deepEqual(leftChildren, []);
});

test("runSpikes S4b: the matcher key (every distinctive token of the tool command) is absent from every child's argv", async () => {
  const { commands, argvs } = await runS4b({});
  assert.ok(commands.length >= 3);
  for (const c of commands) {
    const tokens = c.split(/\s+/).filter((t) => t.length >= 4 && /[0-9/.]/.test(t));
    assert.ok(tokens.length > 0, `the tool command has no unique marker token: ${c}`);
    for (const t of tokens) for (const a of argvs) assert.ok(!a.some((x) => String(x).includes(t)), `marker ${t} is in a child's argv: ${JSON.stringify(a)}`);
  }
});

// ==== 3. S8: evaluator (second control_response shape, socket owner and group) ================

const s8Probes = (effects = {}) =>
  [
    ["user-message", '{"type":"user","message":{"role":"user","content":"<nonce>"}}'],
    ["interrupt-control-request", '{"type":"control_request","request":{"subtype":"interrupt"}}'],
    ["interrupt-bare", '{"type":"interrupt"}'],
    ["control-response", '{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"behavior":"allow"}}}'],
    ["control-response-2", '{"type":"control_response","request_id":"<id>","behavior":"allow"}'],
  ].map(([name, shape]) => ({ name, shape, reply: '{"error":"unsupported"}', effect: Boolean(effects[name]) }));
const s8Base = () => ({
  init: { socketPath: "/tmp/cc-socks/123.sock", capabilities: ["interrupt_send_now_v1"] },
  stat: { type: "socket", mode: 0o600, uid: 501, ownUid: 501, dirUid: 501, dirMode: 0o700 },
  connect: { connected: true, unsolicited: "", greeting: null },
  probes: s8Probes(),
  disable: [],
});

test("S8 evaluator: a second control_response shape that answers the request is outcome d (no-go), reported on its own line", () => {
  const d = s8Base();
  d.probes = s8Probes({ "control-response-2": true });
  const r = evaluateS8(d);
  assert.equal(r.verdict, "no-go", evidence(r));
  assert.equal(r.outcome, "d");
  const probeLines = r.evidence.filter((l) => l.startsWith("probe control-response"));
  assert.equal(probeLines.length, 2, evidence(r));
  assert.notEqual(probeLines[0], probeLines[1]);
  assert.match(probeLines.find((l) => l.startsWith("probe control-response-2")), /effect YES/);
  assert.match(probeLines.find((l) => l.startsWith("probe control-response:")), /effect no/);
});

test("S8 evaluator: neither control_response shape taking effect leaves the verdict a go", () => {
  const r = evaluateS8(s8Base());
  assert.equal(r.verdict, "go", evidence(r));
});

test("S8 evaluator: the socket directory's owner uid is recorded; a directory owned by someone else is not a go", () => {
  const ok = evaluateS8(s8Base());
  assert.match(evidence(ok), /directory uid 501/);
  const d = s8Base();
  d.stat = { ...d.stat, dirUid: 4242 };
  const r = evaluateS8(d);
  assert.notEqual(r.verdict, "go", evidence(r));
  assert.match(evidence(r), /directory uid 4242/);
});

test("S8 evaluator: group bits count as open on the socket and on the directory, and a clean pair is not flagged", () => {
  for (const [mode, dirMode] of [[0o660, 0o700], [0o600, 0o770]]) {
    const d = s8Base();
    d.stat = { ...d.stat, mode, dirMode };
    const ev = evidence(evaluateS8(d));
    assert.match(ev, /OPEN/, `${mode.toString(8)} / ${dirMode.toString(8)}`);
    assert.match(ev, /group/i);
  }
  assert.doesNotMatch(evidence(evaluateS8(s8Base())), /OPEN/);
});

// ==== 4. S8: runner against a fake (polling for a late nonce, two shapes, directory uid) ======
// The fake's socket obeys nothing unless told. The first stdin user message starts a tool call that
// lasts toolMs; any `user` frame arriving on the socket is QUEUED and echoed into the stream only when
// the tool ends (tool_result, the echo, then result), like the real CLI.
//   honourSecondShape  the second distinct control_response shape (by key structure) answers the request

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
const sock = path.join(home, "m.sock");
const out = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
const keys = (v) => (v && typeof v === "object" ? Object.keys(v).sort().map((k) => k + ":" + keys(v[k])).join(",") : "");
let pending = null, turn = 0, queued = [], shapes = new Set();
fs.rmSync(sock, { force: true });
net.createServer((c) => {
  c.on("data", (d) => {
    for (const raw of d.toString().split("\\n").filter(Boolean)) {
      let f = null;
      try { f = JSON.parse(raw); } catch {}
      if (f?.type === "user") queued.push(raw);
      if (f?.type === "control_response") {
        shapes.add(keys({ ...f, request_id: 0, response: f.response && { ...f.response, request_id: 0 } }));
        fs.appendFileSync(path.join(home, "sock-recv.txt"), raw + "\\n");
        if (o.honourSecondShape && pending && shapes.size >= 2) {
          fs.writeFileSync(pending.file, "x");
          const p = pending; pending = null;
          out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: p.id, content: "created", is_error: false }] } });
          out({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: sid });
        }
      }
    }
    c.write(JSON.stringify({ error: "unsupported" }) + "\\n");
  });
}).listen(sock);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "user") {
    turn += 1;
    const text = String(msg.message.content);
    if (turn === 1) {
      out({ type: "system", subtype: "init", permissionMode: "default", mcp_servers: [], session_id: sid, messaging_socket_path: sock, capabilities: ["interrupt_send_now_v1"] });
      out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tsl", name: "Bash", input: { command: "tail -f x" } }] } });
      setTimeout(() => {
        out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tsl", content: "", is_error: false }] } });
        for (const q of queued) out({ type: "user", message: { role: "user", content: q } });
        out({ type: "result", subtype: "success", is_error: false, result: "PROBE-ROLE-OK", session_id: sid });
      }, o.toolMs);
    } else {
      const file = text.match(/\\S+\\.txt/)?.[0] ?? path.join(process.cwd(), "s8.txt");
      pending = { id: "req_s8", file };
      out({ type: "control_request", request_id: "req_s8", request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: file, content: "x" } } });
    }
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
  const dir = mkdtempSync(path.join(tmpdir(), "c8r4-"));
  const fake = writeFake(dir, s8Fake(o));
  const results = await runSpikes({ spikes: ["S8"], out: path.join(dir, "out"), claudeBin: fake, env: { PATH: process.env.PATH, HOME: dir }, timeoutMs: 40_000, control: false, log: () => {} });
  const left = await stillAlive(pids(path.join(dir, "children.txt")));
  return { r: results[0], left, recv: lines(path.join(dir, "sock-recv.txt")) };
};

test("runSpikes S8: a peer message the child queues until its tool call ends (after the 2 s window, before result) is found: outcome c", async () => {
  const { r, left } = await runS8({ toolMs: 9000 });
  assert.equal(r.outcome, "c", evidence(r));
  assert.equal(r.verdict, "residual");
  assert.match(evidence(r), /outcome c: user-message took effect/);
  assert.deepEqual(left, []);
});

test("runSpikes S8: interrupts still report no effect when the tool simply ends late on its own", async () => {
  const { r } = await runS8({ toolMs: 9000 });
  assert.doesNotMatch(evidence(r), /outcome c:[^\n]*interrupt/);
  for (const l of r.evidence.filter((x) => x.startsWith("probe interrupt"))) assert.match(l, /effect no/, l);
});

test("runSpikes S8: a second, different control_response shape is sent over the socket and reported on its own probe line", async () => {
  const { r, recv, left } = await runS8({ toolMs: 1200, honourSecondShape: true });
  const frames = recv.map((x) => JSON.parse(x));
  assert.ok(frames.length >= 2, "two control_response frames expected on the socket");
  const shape = (f) => JSON.stringify(Object.keys(f).sort()) + JSON.stringify(Object.keys(f.response ?? {}).sort());
  assert.ok(new Set(frames.map(shape)).size >= 2, "the two shapes must differ");
  const probeLines = r.evidence.filter((l) => l.startsWith("probe control-response"));
  assert.ok(probeLines.length >= 2, evidence(r));
  assert.equal(probeLines.filter((l) => /effect YES/.test(l)).length, 1, "only the second shape answered");
  assert.match(probeLines[0], /effect no/);
  assert.equal(r.outcome, "d");
  assert.equal(r.verdict, "no-go");
  assert.deepEqual(left, []);
});

test("runSpikes S8: the evidence records the socket directory's owner uid (this process owns the fake's directory)", async () => {
  const { r } = await runS8({ toolMs: 1200 });
  assert.match(evidence(r), new RegExp(`directory uid ${process.getuid()}\\b`));
});

// ==== 5. S6b: the control's own allow ========================================================
// The fake logs every run to $HOME/s6b-runs.jsonl ({ args, cwd, local }). Options: noAllow (allowed.txt
// is never written, in any run), allowOnlyWithoutSettings (written only when --settings is absent),
// stderrText (printed on stderr at start).

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
fs.appendFileSync(path.join(home, "s6b-runs.jsonl"), JSON.stringify({ args, cwd: fs.realpathSync(process.cwd()), local: fs.existsSync(local) ? JSON.parse(fs.readFileSync(local, "utf8")) : null }) + "\\n");
if (o.stderrText) process.stderr.write(o.stderrText + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", () => {
  out({ type: "system", subtype: "init", permissionMode: "default", session_id: sid, mcp_servers: [], plugins: [{ name: "cc", path: "builtin", source: "cc@builtin" }] });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: path.resolve("allowed.txt"), content: "ok" } }] } });
  if (!o.noAllow && (!o.allowOnlyWithoutSettings || !args.includes("--settings"))) fs.writeFileSync("allowed.txt", "ok");
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "w2", name: "Write", input: { file_path: path.resolve("denied.txt"), content: "ok" } }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "PROBE-ROLE-OK", session_id: sid });
});
rl.on("close", () => process.exit(0));
`;

const runS6b = async (o) => {
  const dir = mkdtempSync(path.join(tmpdir(), "c6r4-"));
  const repo = makeRepo();
  const fake = writeFake(dir, s6bFake(o));
  const out = path.join(dir, "out");
  const results = await runSpikes({ spikes: ["S6b"], out, claudeBin: fake, env: { PATH: process.env.PATH, HOME: dir }, repo, timeoutMs: 10_000, log: () => {} });
  return { r: results[0], out, repo, runs: lines(path.join(dir, "s6b-runs.jsonl")).map((l) => JSON.parse(l)) };
};

test("runSpikes S6b: when the control's allowed.txt is also absent the result is setup-invalid naming the control", async () => {
  const { r } = await runS6b({ noAllow: true });
  assert.equal(r.verdict, "setup-invalid", evidence(r));
  assert.match(evidence(r), /project allow did not apply in the control/);
});

test("runSpikes S6b: the child's stderr from that control run is saved next to the fixtures", async () => {
  const marker = "STDERR-MARKER-9f3a";
  const { out } = await runS6b({ noAllow: true, stderrText: marker });
  const saved = readdirSync(out).filter((n) => n !== "results.json" && !n.endsWith(".jsonl"));
  assert.ok(saved.some((n) => readFileSync(path.join(out, n), "utf8").includes(marker)), `no stderr file among: ${readdirSync(out)}`);
});

test("runSpikes S6b: as a comparison it tries an absolute-path (or //path) allow and the main checkout as the cwd, and leaves the checkout clean", async () => {
  const { runs, repo } = await runS6b({ noAllow: true });
  const abs = runs.some((x) => (x.local?.permissions?.allow ?? []).some((rule) => /^Write\(\/\/?[^)]*allowed\.txt\)$/.test(rule)));
  assert.ok(abs, `no run had an absolute-path allow rule: ${JSON.stringify(runs.map((x) => x.local))}`);
  assert.ok(runs.some((x) => x.cwd === realpathSync(repo)), "no run used the main checkout as its cwd");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim(), "");
});

test("runSpikes S6b: an allow that applies only without --settings is still a plain no-go (not setup-invalid)", async () => {
  const { r } = await runS6b({ allowOnlyWithoutSettings: true });
  assert.equal(r.verdict, "no-go", evidence(r));
});

// ==== 6. Setup guard: absent init, unknown plugins, hook_started ==============================
// A child that never started (spawn error) stays a no-go with its error; only a child that ran and
// sent no init is setup-invalid. An init with no `plugins` field is fine. Builtin plugins (path
// "builtin") are the known set.

const setupFake = (o) => `
import readline from "node:readline";
const o = ${JSON.stringify(o)};
const args = process.argv.slice(2);
const sid = args[args.indexOf("--session-id") + 1] ?? args[args.indexOf("--resume") + 1];
const out = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", () => {
  if (!o.noInit) out({ type: "system", subtype: "init", session_id: sid, permissionMode: "default", mcp_servers: [], plugins: o.plugins ?? [], capabilities: [] });
  if (o.hook) out({ type: "system", subtype: "hook_started", hook_id: "h1", hook_name: "SessionStart:startup", hook_event: "SessionStart", session_id: sid });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "true" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "", is_error: false }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "PROBE-ROLE-OK", session_id: sid });
});
rl.on("close", () => process.exit(0));
setInterval(() => {}, 1000);
`;
const runSetup = async (id, o) => {
  const dir = mkdtempSync(path.join(tmpdir(), "c202-"));
  const fake = writeFake(dir, setupFake(o));
  const results = await runSpikes({ spikes: [id], out: path.join(dir, "out"), claudeBin: fake, env: { PATH: process.env.PATH, HOME: dir }, repo: id === "S6b" ? makeRepo() : undefined, timeoutMs: 3000, s3bWaitMs: 1000, timing: FAST, log: () => {} });
  return results[0];
};
const USER_PLUGIN = { name: "mattpocock-skills", path: "/home/someone/.claude/plugins/cache/x/mattpocock-skills/1.2.3", source: "mattpocock-skills@claude-plugins-official" };

for (const id of ["S1", "S2", "S3", "S4", "S6", "S7", "S8", "S4b", "S6b", "S3b"]) {
  test(`setup guard, ${id}: an absent init is setup-invalid and the evidence names init`, async () => {
    const r = await runSetup(id, { noInit: true });
    assert.equal(r.spike, id);
    assert.equal(r.verdict, "setup-invalid", evidence(r));
    assert.match(evidence(r), /\binit\b/);
  });
}

for (const id of ["S1", "S4b", "S6b", "S8"]) {
  test(`setup guard, ${id}: a plugin from outside the builtin set is setup-invalid and the evidence names plugins and the plugin`, async () => {
    const r = await runSetup(id, { plugins: [{ name: "cc", path: "builtin", source: "cc@builtin" }, USER_PLUGIN] });
    assert.equal(r.verdict, "setup-invalid", evidence(r));
    assert.match(evidence(r), /plugins/);
    assert.match(evidence(r), /mattpocock-skills/);
    assert.doesNotMatch(evidence(r), /permissionMode|mcp_servers/);
  });
}

for (const id of ["S1", "S4b", "S8"]) {
  test(`setup guard, ${id}: a hook_started event is setup-invalid and the evidence names hook_started`, async () => {
    const r = await runSetup(id, { hook: true });
    assert.equal(r.verdict, "setup-invalid", evidence(r));
    assert.match(evidence(r), /hook_started/);
  });
}

test("setup guard, S6b: a hook_started event is not a setup failure (the S6b worktree has its own hooks)", async () => {
  const r = await runSetup("S6b", { hook: true });
  // The fake never writes allowed.txt, so S6b may still be setup-invalid for the control's allow; what must not
  // appear is the hook_started guard.
  assert.doesNotMatch(evidence(r), /hook_started/, evidence(r));
});

test("setup guard: builtin plugins only, and an init with no plugins field, are not setup-invalid", async () => {
  const builtin = await runSetup("S1", { plugins: [{ name: "cc", path: "builtin", source: "cc@builtin" }] });
  assert.notEqual(builtin.verdict, "setup-invalid", evidence(builtin));
  const none = await runSetup("S1", {});
  assert.notEqual(none.verdict, "setup-invalid", evidence(none));
});
