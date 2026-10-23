// organism-infra/80: jg wrapper (scripts/jg.mjs) — specify tests.
//
// Seam: exported runJg({ query, root, run, now, usageRoot }) -> Promise<{ stdout?, row }>
//   run(argv: string[]) -> Promise<{ stdout: string, exitCode: number }>
//   row: { kind:"jg", ts:string, queryLen:number, filesReturned:number, fallback:bool, ms:number }
//
// jg is never installed; every test injects a fake `run`.
// AC1: wrapper excludes .scratch/ and .claude/, refuses forbidden flags, refuses bad roots.
// AC3: query containing a secret is refused before run() is called.
// AC4: each successful call logs a row; a run() failure exits cleanly (fallback).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// ── helpers ──────────────────────────────────────────────────────────────────

// Fake run that succeeds and returns N file-header lines.
function fakeRun(fileCount = 3) {
  const calls = [];
  // Simulate jg output: N "## <file>" lines followed by "End context."
  const lines = Array.from({ length: fileCount }, (_, i) => `## src/file${i}.mjs`);
  lines.push("End context.");
  const stdout = lines.join("\n") + "\n";
  const run = async (argv) => { calls.push(argv); return { stdout, exitCode: 0 }; };
  return { run, calls };
}

// Fake run that fails (non-zero exit, no "End context.").
function failRun() {
  const calls = [];
  const run = async (argv) => { calls.push(argv); return { stdout: "", exitCode: 1 }; };
  return { run, calls };
}

// A temp dir we use as a fake repo root (never inside .scratch or .claude).
// It carries a .git directory: since the batch-B checkout-boundary fix, a root needs a .git ancestor or an explicit checkout.
function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "jg80-root-"));
  mkdirSync(path.join(root, ".git"));
  writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  return root;
}

// A usage root for logging rows.
function makeUsageRoot() {
  return mkdtempSync(path.join(tmpdir(), "jg80-usage-"));
}

function usageRows(usageRoot) {
  const p = path.join(usageRoot, ".scratch", "usage.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function load() {
  return await import("./jg.mjs");
}

// ── AC1: exclude flags always present ────────────────────────────────────────

test("runJg always passes --exclude '.scratch/' to run", async () => {
  const { runJg } = await load();
  const { run, calls } = fakeRun();
  await runJg({ query: "where is the board?", root: makeRoot(), run });
  assert.equal(calls.length, 1, "run must be called exactly once");
  const argv = calls[0];
  const scratchIdx = argv.indexOf("--exclude");
  assert.ok(scratchIdx >= 0, "argv must contain at least one --exclude");
  // At least one --exclude argument must be '.scratch/' (or cover it)
  const excludeValues = argv
    .map((a, i) => (a === "--exclude" ? argv[i + 1] : null))
    .filter(Boolean);
  assert.ok(
    excludeValues.some((v) => v === ".scratch/" || v === ".scratch"),
    `--exclude '.scratch/' must be present; got: ${JSON.stringify(excludeValues)}`,
  );
});

test("runJg always passes --exclude '.claude/' to run", async () => {
  const { runJg } = await load();
  const { run, calls } = fakeRun();
  await runJg({ query: "where is the board?", root: makeRoot(), run });
  assert.equal(calls.length, 1);
  const argv = calls[0];
  const excludeValues = argv
    .map((a, i) => (a === "--exclude" ? argv[i + 1] : null))
    .filter(Boolean);
  assert.ok(
    excludeValues.some((v) => v === ".claude/" || v === ".claude"),
    `--exclude '.claude/' must be present; got: ${JSON.stringify(excludeValues)}`,
  );
});

// ── AC1: forbidden flags are refused ─────────────────────────────────────────

const FORBIDDEN_FLAGS = ["--hidden", "--no-ignore", "--include-sensitive", "--include-dependencies"];

for (const flag of FORBIDDEN_FLAGS) {
  test(`runJg refuses the forbidden flag ${flag}`, async () => {
    const { runJg } = await load();
    const { run, calls } = fakeRun();
    const root = makeRoot();
    // Pass the forbidden flag as an extra arg (the wrapper should reject it).
    await assert.rejects(
      () => runJg({ query: "foo", root, extraArgs: [flag], run }),
      /forbidden|refused|not allowed|invalid/i,
      `runJg must throw or reject when ${flag} is supplied`,
    );
    assert.equal(calls.length, 0, "run must NOT be called when a forbidden flag is given");
  });
}

// ── AC1: forbidden roots ──────────────────────────────────────────────────────

test("runJg refuses a root inside .scratch/", async () => {
  const { runJg } = await load();
  const { run, calls } = fakeRun();
  const base = makeRoot();
  const badRoot = path.join(base, ".scratch", "organism-infra");
  mkdirSync(badRoot, { recursive: true });
  await assert.rejects(
    () => runJg({ query: "foo", root: badRoot, run }),
    /scratch|forbidden|refused|root/i,
    "runJg must reject a root inside .scratch/",
  );
  assert.equal(calls.length, 0, "run must NOT be called for a forbidden root");
});

test("runJg refuses a root inside .claude/", async () => {
  const { runJg } = await load();
  const { run, calls } = fakeRun();
  const base = makeRoot();
  const badRoot = path.join(base, ".claude", "agents");
  mkdirSync(badRoot, { recursive: true });
  await assert.rejects(
    () => runJg({ query: "foo", root: badRoot, run }),
    /claude|forbidden|refused|root/i,
    "runJg must reject a root inside .claude/",
  );
  assert.equal(calls.length, 0, "run must NOT be called for a forbidden root");
});

// ── AC3: secret in query is refused before calling run ───────────────────────

// Build secret-shaped strings at runtime so static scanners don't flag them.
const body = (n) => "aB3dE5fG7h".repeat(Math.ceil(n / 10)).slice(0, n);

test("runJg refuses a query containing a secret (sk-style key) without calling run", async () => {
  const { runJg } = await load();
  const { run, calls } = fakeRun();
  const secretQuery = "context for sk-" + body(24) + " related code";
  await assert.rejects(
    () => runJg({ query: secretQuery, root: makeRoot(), run }),
    /secret|blocked|refused|sensitive/i,
    "runJg must reject a secret-containing query",
  );
  assert.equal(calls.length, 0, "run must NOT be called when query contains a secret");
});

test("runJg refuses a query containing an AWS access key without calling run", async () => {
  const { runJg } = await load();
  const { run, calls } = fakeRun();
  const secretQuery = "AKIA" + "AAAAAAAAAAAAAAAA" + " is the key used here";
  await assert.rejects(
    () => runJg({ query: secretQuery, root: makeRoot(), run }),
    /secret|blocked|refused|sensitive/i,
  );
  assert.equal(calls.length, 0);
});

test("runJg does not refuse a plain query with no secret", async () => {
  const { runJg } = await load();
  const { run, calls } = fakeRun(2);
  await runJg({ query: "where is the board state module?", root: makeRoot(), run });
  assert.equal(calls.length, 1, "run must be called once for a clean query");
});

// ── AC4: row is logged per call ───────────────────────────────────────────────

test("runJg returns a row with kind:'jg', queryLen, filesReturned, fallback:false, ms", async () => {
  const { runJg } = await load();
  const { run } = fakeRun(4);
  const result = await runJg({ query: "find the board module", root: makeRoot(), run });
  const { row } = result;
  assert.ok(row, "result must have a row");
  assert.equal(row.kind, "jg", "row.kind must be 'jg'");
  assert.equal(typeof row.queryLen, "number", "row.queryLen must be a number");
  assert.equal(row.queryLen, "find the board module".length);
  assert.equal(typeof row.filesReturned, "number", "row.filesReturned must be a number");
  assert.equal(row.filesReturned, 4, "row.filesReturned must match the count of '##' lines in output");
  assert.equal(row.fallback, false, "row.fallback must be false on success");
  assert.equal(typeof row.ms, "number", "row.ms must be a number");
  assert.ok(row.ms >= 0, "row.ms must be non-negative");
});

// ── AC4: jg failure exits cleanly (fallback) ─────────────────────────────────

test("runJg exits cleanly when run() returns non-zero exit (scout fallback)", async () => {
  const { runJg } = await load();
  const { run, calls } = failRun();
  // Must not throw; fallback is silent.
  const result = await runJg({ query: "what is the router?", root: makeRoot(), run });
  assert.equal(calls.length, 1, "run was called");
  assert.ok(result, "result must be returned (not thrown)");
  const { row } = result;
  assert.ok(row, "row must be present even on failure");
  assert.equal(row.kind, "jg");
  assert.equal(row.fallback, true, "row.fallback must be true when run exits non-zero");
});

test("runJg exits cleanly when run() throws (scout fallback)", async () => {
  const { runJg } = await load();
  const throwRun = async () => { throw new Error("spawn failed: jg not found"); };
  const result = await runJg({ query: "what is the router?", root: makeRoot(), run: throwRun });
  assert.ok(result, "result must be returned (not thrown)");
  assert.equal(result.row.fallback, true, "row.fallback must be true when run() throws");
});

// ── organism-infra/87: trusted in-process flags (dispatch-context.mjs) ──────────

test("runJg forwards in-process flags between the excludes and the query", async () => {
  const { runJg } = await load();
  const { run, calls } = fakeRun();
  const root = makeRoot();
  await runJg({ query: "q", root, flags: ["--max-source-bytes", "24576"], run });
  const argv = calls[0];
  assert.ok(argv.indexOf("--max-source-bytes") > argv.lastIndexOf("--exclude"));
  assert.equal(argv[argv.indexOf("--max-source-bytes") + 1], "24576");
  assert.equal(argv.at(-2), "q");
});

test("runJg refuses an in-process flag that widens the filter or adds an exclude", async () => {
  const { runJg } = await load();
  const { run, calls } = fakeRun();
  for (const flag of ["--no-ignore", "--exclude"]) {
    await assert.rejects(() => runJg({ query: "q", root: makeRoot(), flags: [flag], run }));
  }
  assert.equal(calls.length, 0);
});

// ── organism-infra/92 L1: in-process flags are an allowlist (--max-source-bytes only) ─────────────────────────

test("[92] AC2: runJg refuses any in-process flag other than --max-source-bytes", async () => {
  const { runJg } = await load();
  const { run, calls } = fakeRun();
  const refused = [
    ["--verbose"],
    ["--include-ignored"],
    ["--follow-symlinks"],
    ["--max-source-bytes", "24576", "--verbose"],
    ["--verbose", "--max-source-bytes", "24576"],
  ];
  for (const flags of refused) {
    await assert.rejects(
      () => runJg({ query: "q", root: makeRoot(), flags, run }),
      (e) => e.kind === "flag",
      `refused: ${flags.join(" ")}`,
    );
  }
  assert.equal(calls.length, 0, "jg never runs for a refused flag");
});
