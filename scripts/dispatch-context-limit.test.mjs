// organism-infra/97: dispatch-context must stay inside jg's resource limit on the full repo root.
// Found by the 96 developer: jg on the whole repo prints "discovery incomplete" with Issue "resource_limit": 1 and exits
// non-zero. The 97 developer measured the cause (handoffs/97-developer.md) and the orchestrator approved the fix
// (ticket comment, 2026-10-02), so the [97] fix tests were re-specified to it:
//   1. jg refuses any file over 16 MiB (design/3d/panda-mascot.blend is 97 MB): the context step excludes each such file,
//      found from the git listing it already reads, through a new in-process `excludes` option on runJg (scripts/jg.mjs).
//   2. a search prints about 91 KB, over the 24 KB cap: the step passes --max-output-bytes 24576, which jg.mjs now allows.
//   3. jg 0.4.4 has no --exclude: the CLI checks `jg --version` and a parseable version below the wrapper's floor falls
//      back jg-version (an unreadable version is not a verdict; the search still runs).
// The library seam (buildContext) does no version check by itself; the CLI wires it, so the 87 tests that count jg calls
// through `run` stay valid.
//
//   AC1 (a live run against this repo returns a non-null path, no fallback): human-verified. Recorded in the developer's
//       handoff, not tested here, because it needs the real jg and the user's key.
//   AC2 (when jg still fails, the run falls back exactly as before, exit 0, a named fallback): tests tagged [97] AC2.
//   AC3 (secret scan and size gate unchanged): the existing dispatch-context.test.mjs stays green, plus the [97] AC3
//       tests here, which run the same gates while jg would hit its limit.
//   The "fix" tests (tagged [97] fix) and the [97] jg.mjs tests stand in for AC1 at the seam: a model of jg 0.8.0 (and,
//       by CLI, 0.4.4) that raises resource_limit while a file over 16 MiB is visible and prints 91 KB unless capped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const buildContext = async (...a) => (await import("./dispatch-context.mjs")).buildContext(...a);
const execFileP = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("./dispatch-context.mjs", import.meta.url));
const tmp = (p) => mkdtempSync(path.join(realpathSync(tmpdir()), p));
const FAKE_AWS_KEY = "AKI" + "A" + "ABCDEFGHIJKLMNOP"; // built at run time so this file holds no secret-looking literal
const MB = 1024 * 1024;
const NOW = () => 1_700_000_000_000;

const LIMIT_STDERR = 'discovery incomplete\nIssue "resource_limit": 1\n';
const JG_OK = "## scripts/dispatch-context.mjs\nexcerpt a\n## apps/board/board.mjs\nexcerpt b\nEnd context.\n";

function makeRepo(files) {
  const root = tmp("dc97-repo-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

// A small repo with three top-level source directories and one path the ticket can name.
const sourceRepo = () =>
  makeRepo({
    "scripts/dispatch-context.mjs": "export {};\n",
    "apps/board/board.mjs": "export {};\n",
    "docs/note.md": "note\n",
  });

const ticket = (what = "Fix the retry in scripts/dispatch-context.mjs.") =>
  `# 99: sample\n\n**Type:** bug\n\n**Priority:** P1\n\n**What to build:** ${what}\n\n**Blocked by:** none\n\n**Status:** ready-for-agent\n\n- [ ] ACCEPTANCE-CRITERION-TEXT\n\n## Comments\n\n`;

// The jg search root is the last argument (wrapper argv: --exclude ... flags... question root).
const rootArg = (args) => args[args.length - 1];

// A fake `run`: git goes to real git; jg search is answered by `search(args)`.
function fake(search) {
  const calls = [];
  const run = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    if (cmd === "jg") return search(args, opts);
    try {
      const { stdout } = await execFileP(cmd, args, { cwd: opts.cwd, encoding: "utf8" });
      return { stdout, exitCode: 0 };
    } catch (e) {
      return { stdout: e.stdout ?? "", exitCode: typeof e.code === "number" ? e.code : 1 };
    }
  };
  return { run, searches: () => calls.filter((c) => c.cmd === "jg") };
}

const limitHit = (exitCode = 1) => ({ stdout: "", stderr: LIMIT_STDERR, exitCode });
const contentOf = (f) => (typeof f === "string" ? f : f?.content);
const build = (over) => buildContext({ ticketText: ticket(), now: NOW, ...over });

// jg's behaviour per the 96 finding: the whole root is too much, a subtree is fine.
const limitOnFullRoot = (root) => (args) => (rootArg(args) === root ? limitHit() : { stdout: JG_OK, exitCode: 0 });

// ── jg 0.8.0 stand-in (the 97 developer's measurements, handoffs/97-developer.md) ───────────────────────────────────
// Real jg refuses to read any candidate file over 16 MiB (resource_limit, exit 2) unless that file is excluded, and a
// search prints far more than the 24 KB context cap unless --max-output-bytes is passed (jg 0.8.0 has both flags; jg
// 0.4.4 has neither). The model below walks the repo the way jg does: hidden entries skipped, --exclude values read as
// gitignore patterns (a pattern with a slash is anchored to the root, a backslash escapes, * ? [..] are wildcards).
// It is a plain function so the CLI tests can paste its source into a fake jg on PATH.
const OVER = 16 * MB + 1024; // a file just over jg's per-file limit (sparse on disk)

function jgModel(fs, path, root, patterns) {
  const lit = (c) => c.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
  const compile = (raw) => {
    let p = raw;
    const dirOnly = p.endsWith("/") && !p.endsWith("\\/");
    if (dirOnly) p = p.slice(0, -1);
    const anchored = p.includes("/");
    if (p.startsWith("/")) p = p.slice(1);
    let re = "";
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === "\\" && i + 1 < p.length) re += lit(p[++i]);
      else if (c === "*") re += "[^/]*";
      else if (c === "?") re += "[^/]";
      else if (c === "[" && p.indexOf("]", i + 2) > 0) {
        const j = p.indexOf("]", i + 2);
        re += p.slice(i, j + 1);
        i = j;
      } else re += lit(c);
    }
    return new RegExp((anchored ? "^" : "(^|/)") + re + (dirOnly ? "/" : "(/|$)"));
  };
  const res = patterns.map(compile);
  const visible = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const rel = dir ? dir + "/" + e.name : e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.isFile() && !res.some((r) => r.test(rel))) visible.push(rel);
    }
  };
  walk("");
  const oversize = visible.filter((rel) => fs.statSync(path.join(root, rel)).size > 16 * 1024 * 1024);
  return { visible, oversize };
}

// A search result of exactly `bytes` bytes: one header, filler lines, then the closing line.
function sizedOutput(bytes) {
  const head = "## scripts/dispatch-context.mjs\n";
  const tail = "End context.\n";
  const room = bytes - head.length - tail.length - 1;
  return head + "excerpt line\n".repeat(Math.ceil(bytes / 13)).slice(0, room) + "\n" + tail;
}

const excludeValues = (args) => args.flatMap((a, i) => (a === "--exclude" ? [args[i + 1]] : []));

// jg 0.8.0 on `root`: resource_limit (exit 2) while an oversize file is visible, else output capped by --max-output-bytes (91,552 bytes when not given).
const jg083 = (root) => (args) => {
  if (jgModel(fs, path, root, excludeValues(args)).oversize.length) return limitHit(2);
  const i = args.indexOf("--max-output-bytes");
  return { stdout: sizedOutput(i >= 0 ? Number(args[i + 1]) : 91552), exitCode: 0 };
};

// A repo whose files are `files` (text) plus sparse files of the given sizes (bytes).
function bigRepo(files, sizes) {
  const root = makeRepo(files);
  for (const [rel, size] of Object.entries(sizes)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), "");
    truncateSync(path.join(root, rel), size);
  }
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

// Today's shape: a source tree plus the 97 MB .blend that tripped jg.
const SOURCE_FILES = { "scripts/dispatch-context.mjs": "export {};\n", "apps/board/board.mjs": "export {};\n" };
const pandaRepo = () => bigRepo(SOURCE_FILES, { "design/3d/panda-mascot.blend": OVER });

// ── fix (stands in for AC1 at the seam) ──────────────────────────────────────

test("[97] fix: a repo holding a file over 16 MiB still gets a context file, no fallback, within the 24 KB cap", async () => {
  const root = pandaRepo();
  const f = fake(jg083(root));
  const { file, row } = await build({ root, run: f.run });
  assert.ok(contentOf(file), "a context file came back");
  assert.match(contentOf(file), /End context\./);
  assert.equal(row.fallback ?? null, null);
  assert.equal(row.skipped ?? null, null);
  assert.equal(row.kind, "jg");
  assert.ok(row.bytes > 0 && row.bytes <= 24576, `${row.bytes} bytes`);
});

test("[97] fix: every file over 16 MiB is excluded by an anchored pattern, and files under the limit are not", async () => {
  const root = bigRepo(SOURCE_FILES, {
    "design/3d/panda-mascot.blend": OVER,
    "assets/model.dat": OVER, // unknown extension, caught by its NUL bytes, not its name
    "-huge.blend": OVER, // a leading dash must never reach jg as a flag
    "design/small.blend": 1024,
    "apps/ui/panda-mascot.blend": 1024, // same name as the big one, different directory
    "design/render.png": 2 * MB, // large, but under the limit
  });
  const f = fake(() => ({ stdout: JG_OK, exitCode: 0 }));
  await build({ root, run: f.run });
  const calls = f.searches();
  assert.ok(calls.length >= 1);
  const { args } = calls[calls.length - 1];
  const patterns = excludeValues(args);
  assert.deepEqual(patterns.slice(0, 2), [".scratch/", ".claude/"], "the fixed excludes stay first");
  assert.ok(patterns.every((p) => typeof p === "string" && !p.startsWith("-")), `no exclude can read as a flag: ${JSON.stringify(patterns)}`);
  const { visible, oversize } = jgModel(fs, path, root, patterns);
  assert.deepEqual(oversize, [], "no file over 16 MiB is left for jg to read");
  for (const rel of ["design/small.blend", "apps/ui/panda-mascot.blend", "design/render.png", "scripts/dispatch-context.mjs", "apps/board/board.mjs"]) {
    assert.ok(visible.includes(rel), `${rel} is still searched`);
  }
});

test("[97] fix: a file name with glob or escape characters is excluded exactly, not its look-alikes", async () => {
  const root = bigRepo(SOURCE_FILES, {
    "design/my big[1]*.blend": OVER,
    "design/back\\slash.blend": OVER,
    "design/my big1.blend": 1024, // what an unescaped [1]* would also hide
    "design/backslash.blend": 1024, // what an unescaped \s would also hide
  });
  const f = fake(() => ({ stdout: JG_OK, exitCode: 0 }));
  await build({ root, run: f.run });
  const { args } = f.searches().at(-1);
  const { visible, oversize } = jgModel(fs, path, root, excludeValues(args));
  assert.deepEqual(oversize, [], "both oversize files are excluded");
  assert.ok(visible.includes("design/my big1.blend"), "the look-alike with a 1 is still searched");
  assert.ok(visible.includes("design/backslash.blend"), "the look-alike without a backslash is still searched");
});

test("[97] fix: a repo with no file over 16 MiB adds no excludes beyond .scratch/ and .claude/", async () => {
  const root = bigRepo(SOURCE_FILES, { "design/render.png": 2 * MB });
  const f = fake(() => ({ stdout: JG_OK, exitCode: 0 }));
  await build({ root, run: f.run });
  for (const { args } of f.searches()) assert.deepEqual(excludeValues(args), [".scratch/", ".claude/"]);
});

test("[97] fix: jg is given --max-output-bytes 24576, so a long answer is capped instead of falling back output-too-large", async () => {
  const root = sourceRepo();
  const f = fake(jg083(root));
  const { file, row } = await build({ root, run: f.run });
  assert.ok(contentOf(file), "a context file came back");
  assert.equal(row.fallback ?? null, null);
  assert.ok(Buffer.byteLength(contentOf(file)) <= 24576);
  for (const { args } of f.searches()) assert.equal(args[args.indexOf("--max-output-bytes") + 1], "24576");
});

test("[97] fix: every search call keeps the wrapper's excludes and the 24 KB output cap", async () => {
  const root = sourceRepo();
  const f = fake(limitOnFullRoot(root));
  await build({ root, run: f.run });
  assert.ok(f.searches().length >= 1);
  for (const { args, opts } of f.searches()) {
    const i = args.indexOf("--exclude");
    assert.ok(i >= 0 && args[i + 1] === ".scratch/", "--exclude .scratch/");
    assert.ok(args.includes(".claude/"), "--exclude .claude/");
    assert.equal(args[args.indexOf("--max-source-bytes") + 1], "24576");
    assert.equal(opts.timeoutMs, 90000);
  }
});

// A fake jg on PATH for the CLI: fails with the resource limit when aimed at FAKE_JG_FULL_ROOT (or always, in mode "always").
function cliEnv() {
  const bin = tmp("dc97-bin-");
  symlinkSync(process.execPath, path.join(bin, "node"));
  const log = path.join(bin, "calls.log");
  const jg = path.join(bin, "jg");
  writeFileSync(jg, `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
if (argv[0] === "files") { console.log("3 files, 1000 bytes eligible"); process.exit(0); }
const aimed = argv[argv.length - 1];
if (process.env.FAKE_JG_MODE === "always" || aimed === process.env.FAKE_JG_FULL_ROOT) {
  console.error('discovery incomplete');
  console.error('Issue "resource_limit": 1');
  process.exit(1);
}
console.log("## scripts/dispatch-context.mjs\\nexcerpt\\nEnd context.");
`);
  chmodSync(jg, 0o755);
  const searchCalls = () =>
    (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((a) => a[0] !== "files" && a[0] !== "--version");
  return { bin, searchCalls, home: tmp("dc97-home-") };
}

function cliWorld() {
  const root = sourceRepo();
  mkdirSync(path.join(root, ".scratch", "feat-x", "issues"), { recursive: true });
  writeFileSync(path.join(root, ".scratch", "feat-x", "issues", "01-thing.md"), ticket());
  return root;
}

function cli(root, e, mode = "full-root-only") {
  const r = spawnSync(process.execPath, [SCRIPT, "--ticket", "feat-x/01-thing", "--root", root], {
    encoding: "utf8",
    timeout: 60000,
    env: { PATH: `${e.bin}:/usr/bin:/bin`, HOME: e.home, DEN_ROOT: root, FAKE_JG_MODE: mode, FAKE_JG_FULL_ROOT: root },
  });
  let out = null;
  try { out = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { /* not JSON */ }
  return { status: r.status, out, stderr: r.stderr };
}

// A fake jg on PATH that behaves like the real one on the 97 repo: it reports FAKE_JG_VERSION for --version, applies the
// 16 MiB limit and the output cap through jgModel/sizedOutput, and (as 0.4.4) rejects --exclude outright.
//   FAKE_JG_VERSION: "0.8.0" (works), "0.4.4" (rejects --exclude), "unreadable" (--version exits 1, search works).
function modelEnv() {
  const bin = tmp("dc97m-bin-");
  symlinkSync(process.execPath, path.join(bin, "node"));
  const log = path.join(bin, "calls.log");
  const jg = path.join(bin, "jg");
  writeFileSync(jg, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
${jgModel.toString()}
${sizedOutput.toString()}
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
const version = process.env.FAKE_JG_VERSION;
if (argv[0] === "--version") { if (version === "unreadable") process.exit(1); console.log(version); process.exit(0); }
if (argv[0] === "files") { console.log("3 files, 1000 bytes eligible"); process.exit(0); }
if (version === "0.4.4" && argv.includes("--exclude")) { console.error("Unknown option or missing option value"); process.exit(1); }
const root = argv[argv.length - 1];
const ex = argv.flatMap((a, i) => (a === "--exclude" ? [argv[i + 1]] : []));
if (jgModel(fs, path, root, ex).oversize.length) { console.error("discovery incomplete"); console.error('Issue "resource_limit": 1'); process.exit(2); }
const k = argv.indexOf("--max-output-bytes");
process.stdout.write(sizedOutput(k >= 0 ? Number(argv[k + 1]) : 91552));
`);
  chmodSync(jg, 0o755);
  const searchCalls = () =>
    (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((a) => a[0] !== "files" && a[0] !== "--version");
  return { bin, searchCalls, home: tmp("dc97m-home-") };
}

function modelWorld() {
  const root = pandaRepo();
  mkdirSync(path.join(root, ".scratch", "feat-x", "issues"), { recursive: true });
  writeFileSync(path.join(root, ".scratch", "feat-x", "issues", "01-thing.md"), ticket());
  return root;
}

function cliModel(root, e, version) {
  const r = spawnSync(process.execPath, [SCRIPT, "--ticket", "feat-x/01-thing", "--root", root], {
    encoding: "utf8",
    timeout: 60000,
    env: { PATH: `${e.bin}:/usr/bin:/bin`, HOME: e.home, DEN_ROOT: root, FAKE_JG_VERSION: version },
  });
  let out = null;
  try { out = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { /* not JSON */ }
  return { status: r.status, out, stderr: r.stderr };
}

const jgRows = (root) =>
  readFileSync(path.join(root, ".scratch", "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.kind === "jg");

test("[97] fix: CLI against jg 0.8.0 on a repo with a 97 MB .blend returns a non-null path, no fallback, and writes the context file", () => {
  const root = modelWorld();
  const e = modelEnv();
  const { status, out } = cliModel(root, e, "0.8.0");
  const expected = path.join(root, ".scratch", "_context", "feat-x", "01-thing.md");
  assert.equal(status, 0);
  assert.equal(out.path, expected);
  assert.equal(out.fallback ?? null, null);
  assert.equal(out.skipped ?? null, null);
  const body = readFileSync(expected, "utf8");
  assert.match(body, /End context\./);
  assert.equal(out.bytes, Buffer.byteLength(body));
  assert.ok(out.bytes <= 24576);
  assert.equal(jgRows(root).length, 1);
});

test("[97] fix: CLI with jg 0.4.4 (no --exclude) falls back jg-version, makes no search call, writes no file, and logs the fallback", () => {
  const root = modelWorld();
  const e = modelEnv();
  const { status, out } = cliModel(root, e, "0.4.4");
  assert.equal(status, 0);
  assert.equal(out.path ?? null, null);
  assert.equal(out.fallback, "jg-version");
  assert.equal(e.searchCalls().length, 0, "no search is sent to a jg that cannot take the wrapper's flags");
  assert.equal(existsSync(path.join(root, ".scratch", "_context", "feat-x", "01-thing.md")), false);
  const rows = jgRows(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticket, "feat-x/01-thing");
  assert.equal(rows[0].fallback, "jg-version");
});

// The version check only turns away a jg it can read as too old. A jg whose --version fails or prints no version is
// searched anyway, so a failure still surfaces as before (jg-exit-N, jg-missing), and the 87 fakes (which answer --version
// like a search) stay valid.
test("[97] fix: CLI treats an unreadable --version as no verdict and still searches", () => {
  const root = modelWorld();
  const e = modelEnv();
  const { status, out } = cliModel(root, e, "unreadable");
  assert.equal(status, 0);
  assert.equal(out.path, path.join(root, ".scratch", "_context", "feat-x", "01-thing.md"));
  assert.equal(out.fallback ?? null, null);
  assert.equal(e.searchCalls().length >= 1, true);
});

// ── AC2: when jg still fails, the run falls back exactly as before ───────────

for (const exitCode of [1, 2]) {
  test(`[97] AC2: jg failing on every root (resource_limit, exit ${exitCode}) writes no file and names jg-exit-${exitCode}, as before`, async () => {
    const root = sourceRepo();
    const f = fake(() => limitHit(exitCode));
    const { file, row } = await build({ root, run: f.run });
    assert.equal(file, undefined);
    assert.equal(row.fallback, `jg-exit-${exitCode}`);
    assert.equal(row.skipped ?? null, null);
    assert.equal(row.kind, "jg");
    assert.equal(row.bytes, 0);
    assert.ok(f.searches().length >= 1, "jg was tried");
  });
}

test("[97] AC2: when every attempt fails the step gives up after a bounded number of jg calls", async () => {
  const root = sourceRepo();
  const f = fake(() => limitHit());
  await build({ root, run: f.run });
  assert.ok(f.searches().length <= 5, `${f.searches().length} jg calls for a 3-directory repo`);
});

test("[97] AC2: jg not installed after the change still falls back jg-missing", async () => {
  const root = sourceRepo();
  const f = fake(() => { throw Object.assign(new Error("spawn jg ENOENT"), { code: "ENOENT" }); });
  const { file, row } = await build({ root, run: f.run });
  assert.equal(file, undefined);
  assert.equal(row.fallback, "jg-missing");
});

test("[97] AC2: a jg timeout after the change still falls back timeout", async () => {
  const root = sourceRepo();
  const f = fake(() => ({ stdout: "", exitCode: null, timedOut: true }));
  const { file, row } = await build({ root, run: f.run });
  assert.equal(file, undefined);
  assert.equal(row.fallback, "timeout");
});

test("[97] AC2: CLI with jg failing on every root exits 0, writes no context file, prints a named fallback and logs a jg row", () => {
  const root = cliWorld();
  const e = cliEnv();
  const { status, out } = cli(root, e, "always");
  assert.equal(status, 0);
  assert.equal(out.path ?? null, null);
  assert.equal(out.fallback, "jg-exit-1");
  assert.equal(existsSync(path.join(root, ".scratch", "_context", "feat-x", "01-thing.md")), false);
  const rows = readFileSync(path.join(root, ".scratch", "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.kind === "jg");
  assert.equal(rows.length, 1, "one kind:jg row for the ticket run");
  assert.equal(rows[0].ticket, "feat-x/01-thing");
  assert.equal(rows[0].fallback, "jg-exit-1");
});

// ── AC3: the secret scan and the size gate still run first and still win ─────

test("[97] AC3: a secret in an untracked, non-ignored file still falls back secret-in-root and jg is never called", async () => {
  const root = sourceRepo();
  writeFileSync(path.join(root, "scripts", "leak.env"), `AWS=${FAKE_AWS_KEY}\n`);
  const f = fake(limitOnFullRoot(root));
  const { file, row } = await build({ root, run: f.run });
  assert.equal(file, undefined);
  assert.equal(row.fallback, "secret-in-root");
  assert.equal(f.searches().length, 0, "nothing is sent to jg");
});

test("[97] AC3: over 5 MB of tracked text is still skipped with the 'root over 5 MB eligible' reason and jg is never called", async () => {
  const root = makeRepo({ "src/big.mjs": Buffer.alloc(5 * MB + 1024, "a"), "scripts/dispatch-context.mjs": "x" });
  const f = fake(limitOnFullRoot(root));
  const { file, row } = await build({ root, run: f.run });
  assert.equal(file, undefined);
  assert.equal(row.skipped, "root over 5 MB eligible");
  assert.equal(f.searches().length, 0);
});

test("[97] fix: a secret in the search output is still refused as secret-in-output once the oversize file is excluded", async () => {
  const root = pandaRepo();
  const f = fake((args) =>
    jgModel(fs, path, root, excludeValues(args)).oversize.length ? limitHit(2) : { stdout: `## a.mjs\nkey ${FAKE_AWS_KEY}\nEnd context.\n`, exitCode: 0 });
  const { file, row } = await build({ root, run: f.run });
  assert.equal(file, undefined);
  assert.equal(row.fallback, "secret-in-output");
});

// ── jg.mjs seam: in-process excludes and --max-output-bytes ──────────────────
// runJg({ ..., excludes: [root-relative file paths] }) is for in-process callers only. The wrapper anchors and escapes each
// path itself, so a caller cannot widen or break a pattern, and appends them after the fixed .scratch/ and .claude/ excludes.

const jgRoot = (files = []) => {
  const root = tmp("jg97-root-");
  mkdirSync(path.join(root, ".git"));
  writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  for (const rel of files) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), "x");
  }
  return root;
};
const jgOk = () => {
  const calls = [];
  return { calls, run: async (argv) => { calls.push(argv); return { stdout: "## a.mjs\nx\nEnd context.\n", exitCode: 0 }; } };
};
const loadJg = async () => (await import("./jg.mjs")).runJg;

test("[97] jg.mjs: --max-output-bytes is an allowed in-process flag and is forwarded between the excludes and the query", async () => {
  const runJg = await loadJg();
  const { run, calls } = jgOk();
  await runJg({ query: "q", root: jgRoot(), flags: ["--max-source-bytes", "24576", "--max-output-bytes", "24576"], run });
  const argv = calls[0];
  assert.ok(argv.indexOf("--max-output-bytes") > argv.lastIndexOf("--exclude"));
  assert.equal(argv[argv.indexOf("--max-output-bytes") + 1], "24576");
  assert.equal(argv[argv.indexOf("--max-source-bytes") + 1], "24576");
  assert.equal(argv.at(-2), "q");
  const { run: run2, calls: calls2 } = jgOk();
  await runJg({ query: "q", root: jgRoot(), flags: ["--max-output-bytes=24576"], run: run2 });
  assert.ok(calls2[0].includes("--max-output-bytes=24576"));
});

test("[97] jg.mjs: --max-output-bytes needs a byte count, and the other flags stay refused", async () => {
  const runJg = await loadJg();
  const { run, calls } = jgOk();
  for (const flags of [["--max-output-bytes", "abc"], ["--max-output-bytes", "-1"], ["--max-output-bytes", "1e9"], ["--max-output-bytes"], ["--max-output-bytes", "24576", "--verbose"], ["--no-ignore"], ["--exclude", "x"]]) {
    await assert.rejects(() => runJg({ query: "q", root: jgRoot(), flags, run }), (e) => e.kind === "flag", flags.join(" "));
  }
  assert.equal(calls.length, 0);
});

test("[97] jg.mjs: excludes are appended after .scratch/ and .claude/, anchored and escaped so each hides exactly its own file", async () => {
  const runJg = await loadJg();
  const files = ["design/3d/panda-mascot.blend", "apps/panda-mascot.blend", "-huge.blend", "a[1]*.blend", "a1.blend", "back\\slash.blend", "backslash.blend"];
  const root = jgRoot(files);
  const { run, calls } = jgOk();
  await runJg({ query: "q", root, excludes: ["design/3d/panda-mascot.blend", "-huge.blend", "a[1]*.blend", "back\\slash.blend"], run });
  const argv = calls[0];
  const patterns = excludeValues(argv);
  assert.deepEqual(patterns.slice(0, 2), [".scratch/", ".claude/"]);
  assert.equal(patterns.length, 6);
  assert.ok(patterns.every((p) => !p.startsWith("-")), `no exclude reads as a flag: ${JSON.stringify(patterns)}`);
  assert.equal(argv.at(-2), "q");
  assert.equal(argv.at(-1), root);
  const { visible } = jgModel(fs, path, root, patterns);
  assert.deepEqual(visible.sort(), ["a1.blend", "apps/panda-mascot.blend", "backslash.blend"]);
});

test("[97] jg.mjs: an exclude that is empty, absolute, climbs out of the root, or is not a string is refused and jg never runs", async () => {
  const runJg = await loadJg();
  const { run, calls } = jgOk();
  for (const bad of ["", "/etc/passwd", "../outside.blend", "a/../../b.blend", 42, null]) {
    await assert.rejects(
      () => runJg({ query: "q", root: jgRoot(), excludes: ["ok/file.blend", bad], run }),
      (e) => typeof e.kind === "string",
      `refused: ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(calls.length, 0);
});

// Guard (passes now): excludes are never a CLI feature, so a caller on the command line cannot add one.
test("[97] jg.mjs: the command line still refuses --exclude", () => {
  const root = jgRoot();
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./jg.mjs", import.meta.url)), "q", root, "--exclude", "design/x.blend"], {
    encoding: "utf8",
    timeout: 30000,
    cwd: root,
    env: { PATH: "/usr/bin:/bin", HOME: tmp("jg97-home-"), DEN_ROOT: root },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not allowed/);
});
