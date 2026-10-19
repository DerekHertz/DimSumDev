// organism-infra/111: scripts/notify.mjs is a Claude Code `Notification` and `Stop` hook command.
// Public interface under test: `node scripts/notify.mjs` with the hook input JSON on stdin
// ({"hook_event_name":"Notification","message":"..."} or {"hook_event_name":"Stop"}) and env seams:
//   DEN_ROOT        board root: .scratch/<feature>/issues/NN-slug.md ("**Status:** ready-for-human")
//   NOTIFY_POWERSHELL    the powershell executable to run (default `powershell.exe`). A toast is
//                        attempted whenever this command can be run and exits 0 (no separate WSL
//                        gate); the message may travel in argv, stdin or env, whichever the developer picks
//   NOTIFY_BELL_PATH     where the terminal-bell fallback ("\x07") is written (default /dev/tty,
//                        else stderr)
//   NOTIFY_STATE         JSON file remembering which gates were already notified
// Gates on the board: a ticket whose Status is `ready-for-human`. (Merge proposals and "question to
// the user" have no board representation today: see the qa handoff, open question.)
// Criterion -> test map: see the "AC" tags in each test name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(ROOT, "scripts", "notify.mjs");

function fixture({ powershell = "ok" } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "notify-")));
  const root = path.join(dir, "root");
  mkdirSync(path.join(root, ".scratch", "organism-infra", "issues"), { recursive: true });
  const log = path.join(dir, "powershell-calls.jsonl");
  const ps = path.join(dir, "fake-powershell");
  writeFileSync(
    ps,
    [
      `#!/usr/bin/env node`,
      `import { appendFileSync, readFileSync } from "node:fs";`,
      `const base = JSON.parse(process.env.FAKE_BASE_KEYS || "[]").concat("FAKE_BASE_KEYS");`,
      `let stdin = ""; try { stdin = readFileSync(0, "utf8"); } catch {}`,
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !base.includes(k))) }) + "\\n");`,
      powershell === "fail" ? `process.exit(1);` : "",
    ].join("\n"),
  );
  chmodSync(ps, 0o755);
  return {
    dir,
    root,
    log,
    ps,
    bell: path.join(dir, "bell.txt"),
    state: path.join(dir, "notify-state.json"),
    missingPs: path.join(dir, "no-such-powershell.exe"),
  };
}

const toasts = (f) => (existsSync(f.log) ? readFileSync(f.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const bells = (f) => (existsSync(f.bell) ? (readFileSync(f.bell, "utf8").match(/\x07/g) ?? []).length : 0);
// Transport-agnostic: the text may be in argv, stdin or env, JSON-escaped or not.
const toastHas = (call, text) => JSON.stringify(call).includes(JSON.stringify(text).slice(1, -1));

function run(f, stdin, { powershell, env = {} } = {}) {
  const e = { ...process.env, HOME: f.dir, DEN_ROOT: f.root, NOTIFY_STATE: f.state, NOTIFY_BELL_PATH: f.bell, NOTIFY_POWERSHELL: powershell ?? f.ps, ...env };
  delete e.CLAUDE_CODE_SESSION_ID;
  // The fake records only env vars the script itself added, so inherited env cannot match by accident.
  e.FAKE_BASE_KEYS = JSON.stringify(Object.keys(e));
  return spawnSync("node", [SCRIPT], { cwd: f.root, env: e, input: typeof stdin === "string" ? stdin : JSON.stringify(stdin), encoding: "utf8", timeout: 20000 });
}

const notification = (message) => ({ hook_event_name: "Notification", session_id: "s1", message });
const stop = () => ({ hook_event_name: "Stop", session_id: "s1", stop_hook_active: false });

function ticket(f, name, status) {
  writeFileSync(path.join(f.root, ".scratch", "organism-infra", "issues", `${name}.md`), `# ${name}\n\n**Type:** feature\n\n**Status:** ${status}\n`);
}

test("AC1: a Notification event raises a toast carrying the event message", () => {
  const f = fixture();
  const r = run(f, notification("Claude needs your permission to use Bash"));
  assert.equal(r.status, 0, r.stderr);
  const t = toasts(f);
  assert.equal(t.length, 1);
  assert.ok(toastHas(t[0], "Claude needs your permission to use Bash"), JSON.stringify(t[0].argv));
  assert.equal(bells(f), 0, "a delivered toast replaces the bell");
});

test("AC1: every Notification toasts (they are not de-duplicated), and awkward characters in the message do not break it", () => {
  const f = fixture();
  const msg = `it's "quoted" $(calc) \`tick\` & more`;
  assert.equal(run(f, notification(msg)).status, 0);
  assert.equal(run(f, notification(msg)).status, 0);
  const t = toasts(f);
  assert.equal(t.length, 2);
  assert.ok(toastHas(t[0], msg));
});

test("AC2: Stop with no gate waiting stays quiet: no toast, no bell, no stdout, exit 0", () => {
  const f = fixture();
  ticket(f, "150-demo", "claimed");
  ticket(f, "151-other", "in-review");
  ticket(f, "152-done", "resolved");
  const r = run(f, stop());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(toasts(f).length, 0);
  assert.equal(bells(f), 0);
  assert.equal(r.stdout, "");
});

test("AC2: Stop with a ready-for-human ticket raises one toast naming DimSumDev and the ticket", () => {
  const f = fixture();
  ticket(f, "150-demo", "ready-for-human");
  ticket(f, "151-other", "claimed");
  const r = run(f, stop());
  assert.equal(r.status, 0, r.stderr);
  const t = toasts(f);
  assert.equal(t.length, 1);
  assert.ok(toastHas(t[0], "DimSumDev"), JSON.stringify(t[0].argv));
  assert.ok(toastHas(t[0], "150"), JSON.stringify(t[0].argv));
  assert.ok(!toastHas(t[0], "151-other"), "only the waiting gate is named");
});

test("AC2: the same gate never notifies twice, across repeated Stops", () => {
  const f = fixture();
  ticket(f, "150-demo", "ready-for-human");
  run(f, stop());
  run(f, stop());
  run(f, stop());
  assert.equal(toasts(f).length, 1);
});

test("AC2: a new gate after an earlier notify toasts again, naming only the new one", () => {
  const f = fixture();
  ticket(f, "150-demo", "ready-for-human");
  run(f, stop());
  ticket(f, "153-new", "ready-for-human");
  run(f, stop());
  const t = toasts(f);
  assert.equal(t.length, 2);
  assert.ok(toastHas(t[1], "153"), JSON.stringify(t[1].argv));
  assert.ok(!toastHas(t[1], "150-demo"), "the already-notified gate is not repeated");
});

test("AC2: a gate that cleared and later returns counts as new", () => {
  const f = fixture();
  ticket(f, "150-demo", "ready-for-human");
  run(f, stop());
  ticket(f, "150-demo", "claimed");
  run(f, stop()); // quiet, and forgets the cleared gate
  ticket(f, "150-demo", "ready-for-human");
  run(f, stop());
  assert.equal(toasts(f).length, 2);
});

test("AC2: a Notification event does not consume a pending gate", () => {
  const f = fixture();
  ticket(f, "150-demo", "ready-for-human");
  run(f, notification("Claude is waiting for your input"));
  run(f, stop());
  assert.equal(toasts(f).length, 2);
});

test("AC3: no powershell: a Notification falls back to one bell and exits 0", () => {
  const f = fixture();
  const r = run(f, notification("Claude needs your permission"), { powershell: f.missingPs });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(bells(f), 1);
  assert.equal(toasts(f).length, 0);
});

test("AC3: no powershell: Stop with a gate bells once, exits 0, and the gate does not bell again", () => {
  const f = fixture();
  ticket(f, "150-demo", "ready-for-human");
  const first = run(f, stop(), { powershell: f.missingPs });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(bells(f), 1);
  const second = run(f, stop(), { powershell: f.missingPs });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(bells(f), 1);
});

test("AC3: powershell present but failing (non-zero exit) also falls back to the bell, exit 0", () => {
  const f = fixture({ powershell: "fail" });
  const r = run(f, notification("hello"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(bells(f), 1);
});

test("robustness: empty, malformed or unknown-event stdin exits 0 and raises nothing", () => {
  const f = fixture();
  ticket(f, "150-demo", "ready-for-human");
  for (const stdin of ["", "not json", "{", JSON.stringify({ hook_event_name: "PreToolUse" })]) {
    const r = run(f, stdin);
    assert.equal(r.status, 0, r.stderr);
  }
  assert.equal(toasts(f).length, 0);
  assert.equal(bells(f), 0);
});

test("AC4: notify.mjs contains no model or network call", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.ok(!/fetch\(|https?:\/\/|api\.anthropic|@anthropic-ai|node:https?|node:net/.test(src), "no network/model client in the script");
  assert.ok(!/(spawn|exec)(Sync|File|FileSync)?\(\s*["']claude["']/.test(src), "no claude CLI call");
});
