// organism-infra/110: scripts/session-start.mjs is a Claude Code `SessionStart` hook command.
// Public interface under test: `node scripts/session-start.mjs` with the hook input JSON on stdin
// ({"hook_event_name":"SessionStart","source":"startup|resume|compact","agent_type":"orchestrator"})
// and these env seams (no real Claude Code, GitHub, credentials or network):
//   DEN_ROOT                    board root: .scratch/_handoffs, .scratch/_requests
//   GH_BIN                           the gh executable to run (default `gh`). The script asks for
//                                    `gh pr list --json number,title,statusCheckRollup ...` and
//                                    reads a JSON array of {number,title,statusCheckRollup:[{status,conclusion}]}
//   SESSION_START_USAGE_SCRIPT       node script printing usage JSON like scripts/usage-claude.mjs
//                                    (default scripts/usage.mjs)
//   SESSION_START_TIMEOUT_MS         bound for the gh call and the usage read (default 5000)
// Output is plain stdout (SessionStart adds stdout to the model context), one open PR per line.
// Criterion -> test map: see the "AC" tags in each test name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(ROOT, "scripts", "session-start.mjs");

const USAGE = {
  "5-hour": { percent: 11, resets_at: "2026-10-02T19:59:00.000Z" },
  weekly: { percent: 51, resets_at: "2026-10-06T00:00:00.000Z" },
};

function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "session-start-")));
  const root = path.join(dir, "root");
  const handoffs = path.join(root, ".scratch", "_handoffs");
  mkdirSync(handoffs, { recursive: true });
  mkdirSync(path.join(root, ".scratch", "_requests"), { recursive: true });
  return { dir, root, handoffs };
}

function handoff(f, name, mtimeSec) {
  const file = path.join(f.handoffs, name);
  writeFileSync(file, `# ${name}\n`);
  if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec);
}

function requests(f, rows) {
  writeFileSync(path.join(f.root, ".scratch", "_requests", "requests.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

// A fake gh: records argv, then does what `body` says (node source).
function fakeGh(f, body) {
  const file = path.join(f.dir, "fake-gh");
  const log = path.join(f.dir, "gh-argv.json");
  writeFileSync(file, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n${body}\n`);
  chmodSync(file, 0o755);
  return { file, log };
}
const ghJson = (f, prs) => fakeGh(f, `console.log(${JSON.stringify(JSON.stringify(prs))});`);

function usageScript(f, { usage = USAGE, exit = 0, hang = false } = {}) {
  const file = path.join(f.dir, "fake-usage.mjs");
  writeFileSync(file, [hang ? `await new Promise((r) => setTimeout(r, 15000));` : "", exit ? `process.exit(${exit});` : "", `console.log(${JSON.stringify(JSON.stringify(usage))});`].join("\n"));
  return file;
}

function run(f, stdin, env = {}) {
  const e = { ...process.env, DEN_ROOT: f.root, HOME: f.dir, ...env };
  delete e.CLAUDE_CODE_SESSION_ID;
  const t0 = process.hrtime.bigint();
  const r = spawnSync("node", [SCRIPT], { cwd: f.root, env: e, input: typeof stdin === "string" ? stdin : JSON.stringify(stdin), encoding: "utf8", timeout: 30000 });
  return { ...r, ms: Number(process.hrtime.bigint() - t0) / 1e6, out: r.stdout ?? "" };
}

const hook = (over = {}) => ({ hook_event_name: "SessionStart", source: "startup", session_id: "s1", agent_type: "orchestrator", ...over });
const lineWith = (out, re) => out.split("\n").find((l) => re.test(l));

const PRS = [
  { number: 136, title: "Add the thing", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SUCCESS" }] },
  { number: 137, title: "Break the thing", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "FAILURE" }] },
  { number: 138, title: "Wait for the thing", statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: "" }] },
];

function full(f) {
  handoff(f, "2026-10-01-orchestrator-18.md");
  handoff(f, "2026-10-02-orchestrator-23.md");
  requests(f, [
    { id: "r1", ts: "2026-10-02T10:00:00Z", kind: "merge-approve", ref: "organism-infra/98-board-resolve-command" },
    { id: "r2", ts: "2026-10-02T10:01:00Z", kind: "dispatch-reject", ref: "ci-cd/07-other", note: "later" },
    { id: "r3", ts: "2026-10-02T10:02:00Z", kind: "merge-approve", ref: "organism-infra/handled-one" },
    { handled: "r3", ts: "2026-10-02T10:03:00Z", outcome: "ok" },
  ]);
  const gh = ghJson(f, PRS);
  return { gh, env: { GH_BIN: gh.file, SESSION_START_USAGE_SCRIPT: usageScript(f) } };
}

test("AC1: for the orchestrator it names the latest orchestrator handoff, open PRs with check state, pending requests and usage", () => {
  const f = fixture();
  const { env } = full(f);
  const r = run(f, hook(), env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.out.includes(".scratch/_handoffs/2026-10-02-orchestrator-23.md"), r.out);
  assert.ok(!r.out.includes("orchestrator-18"), "only the latest handoff is named");
  assert.match(lineWith(r.out, /#136/) ?? "", /pass/i);
  assert.match(lineWith(r.out, /#137/) ?? "", /fail/i);
  assert.match(lineWith(r.out, /#138/) ?? "", /pend/i);
  assert.ok(r.out.includes("organism-infra/98-board-resolve-command"), r.out);
  assert.ok(r.out.includes("ci-cd/07-other"), r.out);
  assert.ok(!r.out.includes("handled-one"), "a handled request is not pending");
  const usage = lineWith(r.out, /usage/i) ?? "";
  assert.ok(usage.includes("11%") && usage.includes("51%"), r.out);
});

test("AC1: it asks gh for open PRs with their check rollup, once, within a pr list call", () => {
  const f = fixture();
  const { gh, env } = full(f);
  run(f, hook(), env);
  const argv = JSON.parse(readFileSync(gh.log, "utf8"));
  assert.deepEqual(argv.slice(0, 2), ["pr", "list"]);
  assert.ok(argv.join(" ").includes("statusCheckRollup"), argv.join(" "));
});

test("AC1: the latest handoff is chosen by date then numeric suffix, not by mtime or string order", () => {
  const f = fixture();
  const old = Date.now() / 1000 - 86400 * 30;
  const recent = Date.now() / 1000;
  handoff(f, "2026-10-02-orchestrator-10.md", old); // the true latest, oldest mtime
  handoff(f, "2026-10-02-orchestrator-9.md", recent); // string-sorts after -10, newest mtime
  handoff(f, "2026-10-01-orchestrator-20.md", recent);
  handoff(f, "2026-10-02-design.md", recent); // other agent, not an orchestrator handoff
  handoff(f, "2026-10-02-orchestrator-notes.txt", recent); // not .md
  const gh = ghJson(f, []);
  const r = run(f, hook(), { GH_BIN: gh.file, SESSION_START_USAGE_SCRIPT: usageScript(f) });
  assert.ok(r.out.includes("2026-10-02-orchestrator-10.md"), r.out);
  assert.ok(!r.out.includes("orchestrator-9.md"), r.out);
  assert.ok(!r.out.includes("design.md"), r.out);
});

test("AC1: no orchestrator handoff yet still exits 0 and says so", () => {
  const f = fixture();
  const gh = ghJson(f, []);
  const r = run(f, hook(), { GH_BIN: gh.file, SESSION_START_USAGE_SCRIPT: usageScript(f) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(lineWith(r.out, /handoff/i) ?? "", /none|no /i);
});

test("AC1: it runs for startup, resume and compact", () => {
  const f = fixture();
  const { env } = full(f);
  for (const source of ["startup", "resume", "compact"]) {
    const r = run(f, hook({ source }), env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.out.includes("2026-10-02-orchestrator-23.md"), `${source}: ${r.out}`);
  }
});

test("AC2: a gh failure degrades to 'unknown' for PRs, exits 0, keeps the rest", () => {
  const f = fixture();
  full(f);
  const gh = fakeGh(f, `console.error("gh: not logged in"); process.exit(4);`);
  const r = run(f, hook(), { GH_BIN: gh.file, SESSION_START_USAGE_SCRIPT: usageScript(f) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(lineWith(r.out, /PR/) ?? "", /unknown/i);
  assert.ok(r.out.includes("2026-10-02-orchestrator-23.md"), r.out);
  assert.ok(r.out.includes("organism-infra/98-board-resolve-command"), r.out);
});

test("AC2: a missing gh binary degrades to 'unknown' and exits 0", () => {
  const f = fixture();
  full(f);
  const r = run(f, hook(), { GH_BIN: path.join(f.dir, "no-such-gh"), SESSION_START_USAGE_SCRIPT: usageScript(f) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(lineWith(r.out, /PR/) ?? "", /unknown/i);
});

test("AC2: a hanging gh is cut off by SESSION_START_TIMEOUT_MS and degrades to 'unknown'", () => {
  const f = fixture();
  full(f);
  const gh = fakeGh(f, `await new Promise((r) => setTimeout(r, 15000));`);
  const r = run(f, hook(), { GH_BIN: gh.file, SESSION_START_USAGE_SCRIPT: usageScript(f), SESSION_START_TIMEOUT_MS: "300" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(lineWith(r.out, /PR/) ?? "", /unknown/i);
  assert.ok(r.ms < 6000, `took ${r.ms} ms`);
});

test("AC2: a failing usage read degrades to 'unknown' for usage and exits 0", () => {
  const f = fixture();
  full(f);
  const gh = ghJson(f, PRS);
  const r = run(f, hook(), { GH_BIN: gh.file, SESSION_START_USAGE_SCRIPT: usageScript(f, { exit: 1 }) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(lineWith(r.out, /usage/i) ?? "", /unknown/i);
  assert.match(lineWith(r.out, /#137/) ?? "", /fail/i);
});

test("AC2: a hanging usage read is cut off by SESSION_START_TIMEOUT_MS", () => {
  const f = fixture();
  full(f);
  const gh = ghJson(f, PRS);
  const r = run(f, hook(), { GH_BIN: gh.file, SESSION_START_USAGE_SCRIPT: usageScript(f, { hang: true }), SESSION_START_TIMEOUT_MS: "300" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(lineWith(r.out, /usage/i) ?? "", /unknown/i);
  assert.ok(r.ms < 6000, `took ${r.ms} ms`);
});

test("AC2: malformed stdin exits 0 without blocking", () => {
  const f = fixture();
  for (const stdin of ["", "not json", "{"]) {
    const r = run(f, stdin, {});
    assert.equal(r.status, 0, r.stderr);
  }
});

test("AC2: output stays under 400 tokens (about 1600 chars) even with many PRs and requests, and keeps the handoff path", () => {
  const f = fixture();
  handoff(f, "2026-10-02-orchestrator-23.md");
  const longTitle = "A very long pull request title that goes on and on ".repeat(3);
  const prs = Array.from({ length: 40 }, (_, i) => ({ number: 200 + i, title: longTitle + i, statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }));
  requests(
    f,
    Array.from({ length: 40 }, (_, i) => ({ id: `id-${i}`, ts: "2026-10-02T10:00:00Z", kind: "merge-approve", ref: `organism-infra/${300 + i}-a-long-ticket-slug-name`, note: "n".repeat(120) })),
  );
  const gh = ghJson(f, prs);
  const r = run(f, hook(), { GH_BIN: gh.file, SESSION_START_USAGE_SCRIPT: usageScript(f) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.out.length <= 1600, `${r.out.length} chars`);
  assert.ok(r.out.includes("2026-10-02-orchestrator-23.md"), "handoff path survives truncation");
  assert.match(lineWith(r.out, /usage/i) ?? "", /11%/);
});

test("AC3: other agents get no output and gh is never called", () => {
  const f = fixture();
  const { gh, env } = full(f);
  for (const agent_type of ["developer", "qa", "scout", "security", "architect"]) {
    const r = run(f, hook({ agent_type }), env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out, "", `${agent_type} must get nothing`);
  }
  assert.ok(!existsSync(gh.log), "gh must not run for non-orchestrator sessions");
});

test("AC3: a session with no agent_type (plain claude) gets no output", () => {
  const f = fixture();
  const { gh, env } = full(f);
  const input = hook();
  delete input.agent_type;
  const r = run(f, input, env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out, "");
  assert.ok(!existsSync(gh.log));
});
