// organism-infra/87: dispatch-context script (scripts/dispatch-context.mjs) — specify tests (qa).
// Design: docs/adr/0014-jevgrep-context-supply-at-dispatch.md decisions 3, 5, 7.
//
// Seam 1 (library): exported buildContext({ ticketText, root, run, exists, now, ticket? }) -> Promise<{ file?, row }>
//   ticketText: the whole ticket markdown (its `**Type:**` line and `**What to build:**` paragraph are read).
//   file:       the context-file contents (a string, or { content }); absent on skip and on every fallback.
//   row:        { kind:"jg", ts: ISO of now() at start, bytes, files, ms, skipped, fallback } (skipped/fallback are a
//               reason string or null; `ticket` is added when passed).
//   run(cmd, args, opts) -> Promise<{ stdout, stderr?, exitCode, timedOut? }>   the ONLY seam to the outside world.
//     cmd is "jg" or "git". A missing binary rejects with an Error whose code is "ENOENT".
//     A timeout resolves { stdout, exitCode: null, timedOut: true }.
//     jg search:  run("jg", [...flags, question, root], { timeoutMs: 90000, env: { NODE_USE_ENV_PROXY: "1", ... } })
//                 flags include `--exclude .scratch/` and `--max-source-bytes 24576`.
//     5 MB check: trackedBytes({ root, files }) seam (default: stat sizes of `git ls-files`, .scratch/ and .claude/ excluded).
//     git:        run("git", ["ls-files", ...]) for the secret-in-root check (the fake passes git through to real git).
//   exists(p): tracked-path test for paths named in the ticket (default: real fs under root).
//
// Seam 2 (CLI): node scripts/dispatch-context.mjs --ticket <feature>/<NN-slug> [--root <dir>] [--refresh]
//   Run as a subprocess with a FAKE `jg` first on PATH and HOME redirected: the real jg and the user's key are never touched.
//
// Reasons (regex-matched except secret-in-root, which ADR 0014 names):
//   skipped:  non-code type | two or more named paths | root over 5 MB
//   fallback: jg-missing | not-authenticated | jg-exit-N | timeout | incomplete | secret-in-output | secret-in-root | output-too-large
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Loaded lazily so a missing script fails each test by name instead of aborting the file.
const buildContext = async (...a) => (await import("./dispatch-context.mjs")).buildContext(...a);

const execFileP = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("./dispatch-context.mjs", import.meta.url));
const tmp = (p) => mkdtempSync(path.join(realpathSync(tmpdir()), p));
// Built at run time so this file itself holds no secret-looking literal for risk-check.
const FAKE_AWS_KEY = "AKI" + "A" + "ABCDEFGHIJKLMNOP";

function makeRepo(files = {}, { add = true } = {}) {
  const root = tmp("dc87-repo-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  if (add) execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

const ticket = ({ type = "feature", what = "Add a retry to the relay.", comments = "" } = {}) =>
  `# 99: sample\n\n**Type:** ${type}\n\n**Priority:** P1\n\n**What to build:** ${what}\n\n**Blocked by:** none\n\n**Status:** ready-for-agent\n\n- [ ] ACCEPTANCE-CRITERION-TEXT\n\n## Comments\n\n${comments}\n`;

const JG_OK = "## scripts/a.mjs\nexcerpt a\n## scripts/b.mjs\nexcerpt b\nEnd context.\n";

// A fake `run`: jg search answers with `search`, jg files with `files`, git goes to real git in the tmp repo.
function fake({ search = { stdout: JG_OK, exitCode: 0 }, files = "10 files, 1000 bytes eligible", reject } = {}) {
  const calls = [];
  const run = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    if (cmd === "jg") {
      if (reject) throw reject;
      if (args[0] === "files") return { stdout: files + "\n", exitCode: 0 };
      return typeof search === "function" ? search(args, opts) : search;
    }
    try {
      const { stdout } = await execFileP(cmd, args, { cwd: opts.cwd, encoding: "utf8" });
      return { stdout, exitCode: 0 };
    } catch (e) {
      return { stdout: e.stdout ?? "", exitCode: typeof e.code === "number" ? e.code : 1 };
    }
  };
  const searches = () => calls.filter((c) => c.cmd === "jg" && c.args[0] !== "files");
  return { run, calls, searches };
}

const contentOf = (f) => (typeof f === "string" ? f : f?.content);
const NOW = () => 1_700_000_000_000;
const build = (over) => buildContext({ ticketText: ticket(), now: NOW, ...over });

// ── happy path and the usage row ─────────────────────────────────────────────

test("a code ticket gets a context file holding jg's output and a kind:jg row", async () => {
  const root = makeRepo({ "scripts/jg.mjs": "x" });
  const f = fake();
  const { file, row } = await build({ root, run: f.run });
  const content = contentOf(file);
  assert.match(content, /## scripts\/a\.mjs/);
  assert.match(content, /End context\./);
  assert.equal(row.kind, "jg");
  assert.equal(row.ts, "2023-11-14T22:13:20.000Z");
  assert.equal(row.files, 2);
  assert.equal(row.bytes, Buffer.byteLength(content));
  assert.equal(row.skipped ?? null, null);
  assert.equal(row.fallback ?? null, null);
  assert.ok(Number.isInteger(row.ms) && row.ms >= 0);
  assert.equal(f.searches().length, 1);
});

test("the row carries the ticket ref when the caller passes one", async () => {
  const f = fake();
  const { row } = await build({ root: makeRepo(), run: f.run, ticket: "organism-infra/99-sample" });
  assert.equal(row.ticket, "organism-infra/99-sample");
});

// ── the jg call: question, excludes, cap, timeout, proxy ─────────────────────

test("jg is asked the fixed question plus What to build, searches the root, and excludes .scratch/", async () => {
  const root = makeRepo();
  const f = fake();
  await build({ root, run: f.run, ticketText: ticket({ what: "Retry failed claims.", comments: "COMMENT-BODY" }) });
  const [{ args }] = f.searches();
  const question = args.find((a) => a.startsWith("Where would this change be made, and which tests cover it?"));
  assert.ok(question, "an argument starts with the fixed question");
  assert.match(question, /Retry failed claims\./);
  assert.doesNotMatch(question, /ACCEPTANCE-CRITERION-TEXT|COMMENT-BODY|Blocked by/);
  assert.ok(args.includes(root), "the root is passed to jg");
  const i = args.indexOf("--exclude");
  assert.ok(i >= 0 && args[i + 1] === ".scratch/", "--exclude .scratch/");
});

test("question text from the ticket is cut to 1,500 characters", async () => {
  const f = fake();
  await build({ root: makeRepo(), run: f.run, ticketText: ticket({ what: "w".repeat(1500) + "OVERFLOW" }) });
  const question = f.searches()[0].args.find((a) => a.startsWith("Where would this change be made"));
  assert.ok(question.includes("w".repeat(1500)));
  assert.doesNotMatch(question, /OVERFLOW/);
  assert.match(question, /^.{0,1700}$/s);
});

test("jg runs with --max-source-bytes 24576, a 90 s timeout, and NODE_USE_ENV_PROXY=1 for its child", async () => {
  const f = fake();
  await build({ root: makeRepo(), run: f.run });
  const { args, opts } = f.searches()[0];
  const i = args.indexOf("--max-source-bytes");
  assert.ok(i >= 0 && args[i + 1] === "24576");
  assert.equal(opts.timeoutMs, 90000);
  assert.equal(opts.env?.NODE_USE_ENV_PROXY, "1");
});

test("jg output over the 24 KB cap never becomes a bigger file", async () => {
  const big = "## a.mjs\n" + "x".repeat(30000) + "\nEnd context.\n";
  const f = fake({ search: { stdout: big, exitCode: 0 } });
  const { file, row } = await build({ root: makeRepo(), run: f.run });
  if (file) assert.ok(Buffer.byteLength(contentOf(file)) <= 24576);
  else assert.ok(row.fallback, "no file means a fallback reason");
});

// ── skip rules (no jg search call) ───────────────────────────────────────────

for (const type of ["research", "grilling"]) {
  test(`skip: a ${type} ticket is not a code type`, async () => {
    const f = fake();
    const { file, row } = await build({ root: makeRepo(), run: f.run, ticketText: ticket({ type }) });
    assert.equal(file, undefined);
    assert.match(row.skipped, /type/);
    assert.equal(f.searches().length, 0);
  });
}

test("skip: What to build names two existing tracked paths", async () => {
  const root = makeRepo({ "scripts/jg.mjs": "x", "scripts/board.mjs": "y" });
  const f = fake();
  const { file, row } = await build({ root, run: f.run, ticketText: ticket({ what: "Change scripts/jg.mjs and scripts/board.mjs together." }) });
  assert.equal(file, undefined);
  assert.match(row.skipped, /path/);
  assert.equal(f.searches().length, 0);
});

test("no skip: one tracked path, or a second path that does not exist", async () => {
  const root = makeRepo({ "scripts/jg.mjs": "x" });
  const f = fake();
  const { file } = await build({ root, run: f.run, ticketText: ticket({ what: "Change scripts/jg.mjs and scripts/dispatch-context.mjs." }) });
  assert.ok(contentOf(file));
  assert.equal(f.searches().length, 1);
});

test("the exists seam decides which named paths count", async () => {
  const root = makeRepo();
  const f = fake();
  const known = new Set(["apps/ui/a.jsx", "apps/ui/b.jsx"]);
  const exists = (p) => known.has(path.relative(root, path.resolve(root, p)));
  const { row } = await build({ root, run: f.run, exists, ticketText: ticket({ what: "Edit apps/ui/a.jsx and apps/ui/b.jsx." }) });
  assert.match(row.skipped, /path/);
});

test("skip: tracked files total more than 5 MB; exactly 5 MB proceeds", async () => {
  // trackedBytes({ root, files }) is the injected seam: it sums the byte sizes of `git ls-files` output (board dirs excluded).
  const over = fake();
  const r1 = await build({ root: makeRepo(), run: over.run, trackedBytes: async () => 5242881 });
  assert.equal(r1.file, undefined);
  assert.ok(r1.row.skipped, "skipped has a reason");
  assert.equal(over.searches().length, 0);

  const at = fake();
  const r2 = await build({ root: makeRepo(), run: at.run, trackedBytes: async () => 5242880 });
  assert.ok(contentOf(r2.file));
});

test("the size check is handed tracked files only, not .scratch/ or .claude/", async () => {
  const root = makeRepo({ "src/a.mjs": "x".repeat(100), ".scratch/big.md": "y".repeat(10), ".claude/s.md": "z".repeat(10) });
  let seen;
  const f = fake();
  await build({ root, run: f.run, trackedBytes: async ({ files }) => { seen = files; return 0; } });
  assert.deepEqual(seen, ["src/a.mjs"]);
});

// ── fallbacks (no file, row says why) ────────────────────────────────────────

const fallbackCases = [
  ["jg missing", { reject: Object.assign(new Error("spawn jg ENOENT"), { code: "ENOENT" }) }, /missing/],
  ["not authenticated", { search: { stdout: "", stderr: "Not authenticated. Run: jg auth", exitCode: 1 } }, /auth/],
  ["non-zero exit", { search: { stdout: "", stderr: "boom", exitCode: 1 } }, /exit/],
  ["incomplete exit 2", { search: { stdout: "## a.mjs\npartial\n", exitCode: 2 } }, /exit|incomplete/],
  ["90 s timeout", { search: { stdout: "", exitCode: null, timedOut: true } }, /timeout/],
  ["missing End context. marker", { search: { stdout: "## a.mjs\nexcerpt\n", exitCode: 0 } }, /incomplete/],
  ["secret in jg output", { search: { stdout: `## a.mjs\nkey ${FAKE_AWS_KEY}\nEnd context.\n`, exitCode: 0 } }, /secret.*output|output.*secret/],
];
for (const [name, cfg, reason] of fallbackCases) {
  test(`fallback: ${name} writes no file and records the reason`, async () => {
    const f = fake(cfg);
    const { file, row } = await build({ root: makeRepo(), run: f.run });
    assert.equal(file, undefined);
    assert.match(row.fallback, reason);
    assert.equal(row.kind, "jg");
    assert.equal(row.bytes, 0);
    assert.equal(row.skipped ?? null, null);
  });
}

// ── secret-in-root (ADR 0014 decision 5) ─────────────────────────────────────

test("refuses when a tracked file in the root matches a risk-check secret pattern", async () => {
  const root = makeRepo({ "src/config.mjs": `export const k = "${FAKE_AWS_KEY}";\n` });
  const f = fake();
  const { file, row } = await build({ root, run: f.run });
  assert.equal(file, undefined);
  assert.equal(row.fallback, "secret-in-root");
  assert.equal(f.searches().length, 0, "nothing is sent to jg");
});

test("a secret in a gitignored, untracked file does not block the search", async () => {
  const root = makeRepo({ ".gitignore": "local.env\n", "local.env": `AWS=${FAKE_AWS_KEY}\n` });
  const f = fake();
  const { file, row } = await build({ root, run: f.run });
  assert.ok(contentOf(file));
  assert.equal(row.fallback ?? null, null);
});

// ── CLI: fake jg on PATH, HOME redirected ────────────────────────────────────

function cliEnv({ withJg = true } = {}) {
  const bin = tmp("dc87-bin-");
  symlinkSync(process.execPath, path.join(bin, "node"));
  const log = path.join(bin, "calls.log");
  if (withJg) {
    const jg = path.join(bin, "jg");
    writeFileSync(jg, `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "files") { console.log("3 files, 1000 bytes eligible"); process.exit(0); }
if (process.env.FAKE_JG_MODE === "fail") { console.error("boom"); process.exit(1); }
console.log("## scripts/a.mjs\\nexcerpt\\nEnd context.");
`);
    chmodSync(jg, 0o755);
  }
  const searchCalls = () =>
    (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((a) => a[0] !== "files" && a[0] !== "--version");
  return { bin, searchCalls, home: tmp("dc87-home-") };
}

// A main checkout (git repo) holding the ticket on the board.
function cliWorld(type = "feature") {
  const root = makeRepo({ "scripts/jg.mjs": "x" });
  mkdirSync(path.join(root, ".scratch", "feat-x", "issues"), { recursive: true });
  writeFileSync(path.join(root, ".scratch", "feat-x", "issues", "01-thing.md"), ticket({ type }));
  return root;
}

function cli(args, { root, env: e, mode }) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: { PATH: `${e.bin}:/usr/bin:/bin`, HOME: e.home, DEN_ROOT: root, FAKE_JG_MODE: mode ?? "ok" },
  });
  let out = null;
  try { out = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { /* not JSON */ }
  return { status: r.status, out, stderr: r.stderr };
}

const usageRows = (root) => {
  const p = path.join(root, ".scratch", "usage.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};

test("CLI: writes .scratch/_context/<feature>/<NN-slug>.md, prints one JSON line, appends a jg usage row", () => {
  const root = cliWorld();
  const e = cliEnv();
  const { status, out } = cli(["--ticket", "feat-x/01-thing", "--root", root], { root, env: e });
  const expected = path.join(root, ".scratch", "_context", "feat-x", "01-thing.md");
  assert.equal(status, 0);
  assert.deepEqual(Object.keys(out).sort(), ["bytes", "fallback", "path", "skipped"]);
  assert.equal(out.path, expected);
  assert.equal(out.skipped ?? null, null);
  assert.equal(out.fallback ?? null, null);
  const body = readFileSync(expected, "utf8");
  assert.match(body, /## scripts\/a\.mjs/);
  assert.equal(out.bytes, Buffer.byteLength(body));
  const row = usageRows(root).find((r) => r.kind === "jg");
  assert.ok(row, "a kind:jg row was appended");
  assert.equal(row.ticket, "feat-x/01-thing");
  for (const k of ["ts", "bytes", "files", "ms", "skipped", "fallback"]) assert.ok(k in row, `row has ${k}`);
});

test("CLI: the file is reused by later hops, and --refresh searches again", () => {
  const root = cliWorld();
  const e = cliEnv();
  const args = ["--ticket", "feat-x/01-thing", "--root", root];
  const first = cli(args, { root, env: e });
  const second = cli(args, { root, env: e });
  assert.equal(e.searchCalls().length, 1, "second hop reuses the file");
  assert.equal(second.out.path, first.out.path);
  assert.equal(second.status, 0);
  cli([...args, "--refresh"], { root, env: e });
  assert.equal(e.searchCalls().length, 2, "--refresh runs jg again");
});

test("CLI: a jg failure exits 0 with no context file and a fallback reason", () => {
  const root = cliWorld();
  const e = cliEnv();
  const { status, out } = cli(["--ticket", "feat-x/01-thing", "--root", root], { root, env: e, mode: "fail" });
  assert.equal(status, 0);
  assert.equal(out.path ?? null, null);
  assert.ok(out.fallback);
  assert.equal(existsSync(path.join(root, ".scratch", "_context", "feat-x", "01-thing.md")), false);
});

test("CLI: jg not installed exits 0, no file, fallback names it", () => {
  const root = cliWorld();
  const e = cliEnv({ withJg: false });
  const { status, out } = cli(["--ticket", "feat-x/01-thing", "--root", root], { root, env: e });
  assert.equal(status, 0);
  assert.equal(out.path ?? null, null);
  assert.match(out.fallback, /missing/);
});

test("CLI: a non-code ticket is skipped without calling jg", () => {
  const root = cliWorld("research");
  const e = cliEnv();
  const { status, out } = cli(["--ticket", "feat-x/01-thing", "--root", root], { root, env: e });
  assert.equal(status, 0);
  assert.equal(out.path ?? null, null);
  assert.ok(out.skipped);
  assert.equal(e.searchCalls().length, 0);
});

test("CLI: bad arguments exit 2 (no --ticket, unknown flag, --root without a value)", () => {
  const root = cliWorld();
  const e = cliEnv();
  assert.equal(cli([], { root, env: e }).status, 2);
  assert.equal(cli(["--ticket", "feat-x/01-thing", "--bogus"], { root, env: e }).status, 2);
  assert.equal(cli(["--ticket", "feat-x/01-thing", "--root"], { root, env: e }).status, 2);
  assert.equal(e.searchCalls().length, 0);
});

// ── organism-infra/95: the size gate measures what jg would send (text), not binaries ──────────────────────────
// No trackedBytes seam is injected here: these tests drive the DEFAULT size check against real files in a real git repo.
// Binary fixtures hold NUL bytes AND a binary extension, so either detection the ticket allows (NUL in the first 8 KB, or
// a known extension list) classifies them. Criterion 3 ("binaries never sent to jg") is covered by jg's own filter and
// by the existing tests staying green; criterion 4 (run against this repo, eligible bytes) is human-verified in the handoff.

const MB = 1024 * 1024;
const binary = (bytes) => Buffer.alloc(bytes); // all NUL
const text = (bytes) => Buffer.alloc(bytes, "a");

test("[95] AC1: under 5 MB of text plus over 5 MB of binaries is not skipped and jg is called", async () => {
  const root = makeRepo({
    "src/a.mjs": text(1 * MB),
    "design/3d/den.blend": binary(3 * MB),
    "apps/ui/atlas.png": binary(3 * MB),
  });
  const f = fake();
  const { file, row } = await build({ root, run: f.run });
  assert.equal(row.skipped ?? null, null);
  assert.equal(row.fallback ?? null, null);
  assert.ok(contentOf(file));
  assert.equal(f.searches().length, 1, "jg is called once");
});

test("[95] AC1: the same holds end to end through the CLI", () => {
  const root = makeRepo({ "scripts/jg.mjs": "x", "design/3d/den.blend": binary(6 * MB) });
  mkdirSync(path.join(root, ".scratch", "feat-x", "issues"), { recursive: true });
  writeFileSync(path.join(root, ".scratch", "feat-x", "issues", "01-thing.md"), ticket());
  const e = cliEnv();
  const { status, out } = cli(["--ticket", "feat-x/01-thing", "--root", root], { root, env: e });
  assert.equal(status, 0);
  assert.equal(out.skipped ?? null, null);
  assert.equal(out.fallback ?? null, null);
  assert.equal(e.searchCalls().length, 1);
});

test("[95] AC2: over 5 MB of tracked text is still skipped with the 'root over 5 MB eligible' reason", async () => {
  const root = makeRepo({ "src/big.mjs": text(5 * MB + 1024), "design/3d/den.blend": binary(1 * MB) });
  const f = fake();
  const { file, row } = await build({ root, run: f.run });
  assert.equal(file, undefined);
  assert.equal(row.skipped, "root over 5 MB eligible");
  assert.equal(f.searches().length, 0);
});

test("[95] AC3: a big binary beside a text file holding a secret still falls back with secret-in-root", async () => {
  const root = makeRepo({ "src/config.mjs": `export const k = "${FAKE_AWS_KEY}";\n`, "design/3d/den.blend": binary(6 * MB) });
  const f = fake();
  const { file, row } = await build({ root, run: f.run });
  assert.equal(file, undefined);
  assert.equal(row.skipped ?? null, null, "not skipped on size");
  assert.equal(row.fallback, "secret-in-root");
  assert.equal(f.searches().length, 0, "nothing is sent to jg");
});

// ── organism-infra/92 M1: the root listing includes untracked, non-ignored files ──────────────────────────────

test("[92] AC1: a secret in an untracked, non-ignored file falls back with secret-in-root and never calls jg", async () => {
  const root = makeRepo({ "src/a.mjs": "x" });
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "untracked.env"), `AWS=${FAKE_AWS_KEY}\n`); // never `git add`ed
  const f = fake();
  const { file, row } = await build({ root, run: f.run });
  assert.equal(file, undefined);
  assert.equal(row.fallback, "secret-in-root");
  assert.equal(f.searches().length, 0, "nothing is sent to jg");
});

test("[92] AC1: the listing handed to the size check adds untracked files but not ignored ones or the board", async () => {
  const root = makeRepo({ ".gitignore": "local.env\n", "src/a.mjs": "x" });
  writeFileSync(path.join(root, "src", "new.mjs"), "y");
  writeFileSync(path.join(root, "local.env"), "z");
  mkdirSync(path.join(root, ".scratch"), { recursive: true });
  writeFileSync(path.join(root, ".scratch", "note.md"), "n");
  let seen;
  const f = fake();
  await build({ root, run: f.run, trackedBytes: async ({ files }) => { seen = files; return 0; } });
  assert.deepEqual([...seen].sort(), [".gitignore", "src/a.mjs", "src/new.mjs"]);
});

test("[92] AC1: a secret in an untracked file under .scratch/ or .claude/ stays out of the scan", async () => {
  const root = makeRepo({ "src/a.mjs": "x" });
  for (const dir of [".scratch", ".claude"]) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, "note.md"), `AWS=${FAKE_AWS_KEY}\n`);
  }
  const f = fake();
  const { file, row } = await build({ root, run: f.run });
  assert.ok(contentOf(file));
  assert.equal(row.fallback ?? null, null);
  assert.equal(f.searches().length, 1);
});

// ── organism-infra/92 L2: the context file is written by rename ───────────────────────────────────────────────

test("[92] AC3: --refresh replaces the context file by rename, so a reader of the old file never sees a partial write", () => {
  const root = cliWorld();
  const e = cliEnv();
  const args = ["--ticket", "feat-x/01-thing", "--root", root];
  const first = cli(args, { root, env: e });
  const outFile = first.out.path;
  assert.ok(outFile, "the first run wrote a context file");

  // A second hard link to the same inode stands in for a reader holding the old file open.
  writeFileSync(outFile, "OLD CONTENT\n");
  const held = path.join(tmp("dc92-held-"), "old.md");
  linkSync(outFile, held);

  const second = cli([...args, "--refresh"], { root, env: e });
  assert.equal(second.status, 0);
  assert.match(readFileSync(outFile, "utf8"), /## scripts\/a\.mjs/, "the new context is in place");
  assert.equal(readFileSync(held, "utf8"), "OLD CONTENT\n", "the old inode was left whole, not rewritten in place");
  assert.deepEqual(readdirSync(path.dirname(outFile)), ["01-thing.md"], "no temp file is left behind");
});

// ── organism-infra/102: a '## What to build' heading is read like the bold line ───────────────────────────────

// The shape real board tickets use (see .scratch/organism-infra/issues/*.md): metadata as bold lines, then ## sections.
const headingTicket = ({ type = 'bug', what = 'Make the retry read the claim.', tail = '' } = {}) =>
  `# 99: sample\n\n**Type:** ${type}\n\n**Priority:** P2\n\n**Blocked by:** none\n\n**Status:** ready-for-agent\n\n## What to build\n\n${what}\n\n## Acceptance criteria\n\n- [ ] ACCEPTANCE-CRITERION-TEXT scripts/jg.mjs scripts/board.mjs\n\n## Comments\n- **orchestrator:** COMMENT-BODY scripts/jg.mjs scripts/board.mjs\n${tail}`;

test('[102] AC1: a ## What to build section is in the jg query; Acceptance criteria and Comments are not', async () => {
  const f = fake();
  await build({ root: makeRepo(), run: f.run, ticketText: headingTicket({ what: 'Retry failed claims in the relay.\n\nSecond paragraph about HEADING-SECOND-PARA.' }) });
  const [{ args }] = f.searches();
  const question = args.find((a) => a.startsWith('Where would this change be made, and which tests cover it?'));
  assert.ok(question, 'an argument starts with the fixed question');
  assert.match(question, /Retry failed claims in the relay\./);
  assert.match(question, /HEADING-SECOND-PARA/, 'the whole section is read, not one line');
  assert.doesNotMatch(question, /ACCEPTANCE-CRITERION-TEXT|COMMENT-BODY|Acceptance criteria|Blocked by|Status:/);
});

test('[102] AC1: a section at the end of the file (no later heading) is read to the end', async () => {
  const f = fake();
  const text = '# 99: sample\n\n**Type:** bug\n\n## Comments\n- note COMMENT-BODY\n\n## What to build\n\nLAST-SECTION-TEXT here.\n';
  await build({ root: makeRepo(), run: f.run, ticketText: text });
  const question = f.searches()[0].args.find((a) => a.startsWith('Where would this change be made'));
  assert.match(question, /LAST-SECTION-TEXT here\./);
  assert.doesNotMatch(question, /COMMENT-BODY/);
});

test('[102] AC1: a ### subheading inside the section does not end it; only the next ## heading does', async () => {
  const f = fake();
  await build({ root: makeRepo(), run: f.run, ticketText: headingTicket({ what: 'Before.\n\n### Detail\n\nSUBSECTION-TEXT.' }) });
  const question = f.searches()[0].args.find((a) => a.startsWith('Where would this change be made'));
  assert.match(question, /SUBSECTION-TEXT/);
});

test('[102] AC1: heading-form text is cut to 1,500 characters too', async () => {
  const f = fake();
  await build({ root: makeRepo(), run: f.run, ticketText: headingTicket({ what: 'h'.repeat(1500) + 'OVERFLOW' }) });
  const question = f.searches()[0].args.find((a) => a.startsWith('Where would this change be made'));
  assert.ok(question.includes('h'.repeat(1500)));
  assert.doesNotMatch(question, /OVERFLOW/);
});

test('[102] AC2: the bold **What to build:** line still feeds the query (a ticket with no heading)', async () => {
  const f = fake();
  await build({ root: makeRepo(), run: f.run, ticketText: ticket({ what: 'BOLD-FORM-TEXT stays read.' }) });
  const question = f.searches()[0].args.find((a) => a.startsWith('Where would this change be made'));
  assert.match(question, /BOLD-FORM-TEXT stays read\./);
});

test('[102] AC3: a heading-form ticket naming two existing paths is skipped without a jg search', async () => {
  const root = makeRepo({ 'scripts/jg.mjs': 'x', 'scripts/board.mjs': 'y' });
  const f = fake();
  const { file, row } = await build({ root, run: f.run, ticketText: headingTicket({ what: 'Change scripts/jg.mjs and scripts/board.mjs together.\n\nFiles: scripts/jg.mjs, scripts/board.mjs' }) });
  assert.equal(file, undefined);
  assert.match(row.skipped, /path/);
  assert.equal(f.searches().length, 0);
});

test('[102] AC3: paths named only in Acceptance criteria or Comments do not trigger the skip', async () => {
  const root = makeRepo({ 'scripts/jg.mjs': 'x', 'scripts/board.mjs': 'y' });
  const f = fake();
  const { file } = await build({ root, run: f.run, ticketText: headingTicket({ what: 'Change scripts/jg.mjs only.' }) });
  assert.ok(contentOf(file), 'one path in the section means the search runs');
  assert.equal(f.searches().length, 1);
});
