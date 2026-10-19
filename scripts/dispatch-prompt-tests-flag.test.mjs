// organism-infra/198: dispatch-prompt --tests <file> for qa verify -- specify tests (qa).
//
// Seam (CLI): node scripts/dispatch-prompt.mjs --ticket <ref> --role qa --mode verify --base <sha> --tests <file>
//   Run as a subprocess with DEN_ROOT pointing at a throwaway board root (as dispatch-prompt.test.mjs does).
//
// Criterion map:
//   1. prints a line naming the file         -> "names the file" tests (absolute path, relative path, suite wording, no leak)
//   2. refused path exits 2                  -> hidden dir, symlink, over 1 MB (and the 1 MB boundary stays allowed), missing file,
//                                               stdout empty, reason on stderr
//   3. orchestrator role definition stage 3           -> human-verified (gated .claude edit, applied by the user)
//   4. npm test green                        -> the whole suite, run by verify
// Assumption flagged in the handoff: the ticket scopes --tests to qa verify; behavior on other agents is not pinned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./dispatch-prompt.mjs", import.meta.url));
const tmp = (p) => mkdtempSync(path.join(realpathSync(tmpdir()), p));

const FEATURE = "feat-x";
const SLUG = "07-sample-thing";
const REF = `${FEATURE}/${SLUG}`;
const SHA = "abc1234";
const SUITE_OUTPUT = "# tests 12\n# pass 12\n# fail 0\nSECRET-SUITE-BODY-MARKER\n";

function world() {
  const root = tmp("dp198-root-");
  mkdirSync(path.join(root, ".scratch", FEATURE, "issues"), { recursive: true });
  writeFileSync(
    path.join(root, ".scratch", FEATURE, "issues", `${SLUG}.md`),
    "# 07: sample\n\n**Type:** research\n\n**Priority:** P1\n\n## What to build\n\nx\n\n**Blocked by:** none\n\n**Status:** in-review\n\n## Comments\n",
  );
  return root;
}

function run(extra, { root, cwd } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, "--ticket", REF, "--role", "qa", "--mode", "verify", "--base", SHA, ...extra], {
    encoding: "utf8",
    timeout: 60000,
    cwd: cwd ?? root,
    env: { PATH: "/usr/bin:/bin", HOME: tmp("dp198-home-"), DEN_ROOT: root },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function goodFile(name = "07-tests.txt", text = SUITE_OUTPUT) {
  const dir = tmp("dp198-files-");
  const file = path.join(dir, name);
  writeFileSync(file, text);
  return file;
}

// --- Criterion 1: a line naming the file ---------------------------------------------------------------------------

test("--tests <file>: exits 0 and prints a line that names the file", () => {
  const file = goodFile();
  const r = run(["--tests", file], { root: world() });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n").filter((l) => l.includes(file));
  assert.equal(lines.length, 1, `expected exactly one line naming ${file}, got:\n${r.stdout}`);
});

test("--tests <file>: the line tells qa to use the file as the suite result", () => {
  const file = goodFile();
  const r = run(["--tests", file], { root: world() });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split("\n").find((l) => l.includes(file));
  assert.ok(line, r.stdout);
  assert.match(line, /suite/i, "the line says what the file is (the suite result)");
  assert.match(line, /\buse\b/i, "the line tells qa to use it");
});

test("--tests <relative path>: resolved against the working directory, the line still names the file", () => {
  const dir = tmp("dp198-rel-");
  writeFileSync(path.join(dir, "out.txt"), SUITE_OUTPUT);
  const r = run(["--tests", "out.txt"], { root: world(), cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /out\.txt/);
});

test("--tests <file>: the file's contents are not echoed into the prompt", () => {
  const r = run(["--tests", goodFile()], { root: world() });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("SECRET-SUITE-BODY-MARKER"), "name the file; do not paste it");
});

test("--tests <file>: the usual qa verify lines are all still there", () => {
  const r = run(["--tests", goodFile()], { root: world() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /node scripts\/agent-start\.mjs .*--detach/);
  assert.match(r.stdout, /07-qa-verify\.md/);
  assert.match(r.stdout, /--keep-status/);
});

test("without --tests: no line about a saved suite result (nothing changes for existing dispatches)", () => {
  const r = run([], { root: world() });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/--tests/.test(r.stdout));
  assert.ok(!/saved|suite result/i.test(r.stdout), r.stdout);
});

test("a file of exactly 1 MB is accepted (the limit is 'over 1 MB')", () => {
  const file = goodFile("big.txt", "x".repeat(1024 * 1024));
  const r = run(["--tests", file], { root: world() });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(file));
});

// --- Criterion 2: the exposure check refuses -> exit 2, nothing on stdout, reason on stderr -------------------------

function assertRefused(r) {
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.equal(r.stdout, "", "nothing on stdout when refused");
  assert.ok(r.stderr.length > 0, "the reason goes to stderr");
  assert.ok(!/unknown argument/.test(r.stderr), "the flag must be recognised; refusing it as unknown is the missing feature");
}

test("--tests in a hidden directory exits 2", () => {
  const dir = path.join(tmp("dp198-hid-"), ".hidden");
  mkdirSync(dir);
  const file = path.join(dir, "07-tests.txt");
  writeFileSync(file, SUITE_OUTPUT);
  assertRefused(run(["--tests", file], { root: world() }));
});

test("--tests naming a hidden file exits 2", () => {
  const dir = tmp("dp198-hidf-");
  const file = path.join(dir, ".07-tests.txt");
  writeFileSync(file, SUITE_OUTPUT);
  assertRefused(run(["--tests", file], { root: world() }));
});

test("--tests naming a symlink exits 2, even when it points at an allowed file", () => {
  const target = goodFile();
  const link = path.join(tmp("dp198-link-"), "07-tests.txt");
  symlinkSync(target, link);
  assertRefused(run(["--tests", link], { root: world() }));
});

test("--tests over 1 MB exits 2", () => {
  const file = goodFile("big.txt", "x".repeat(1024 * 1024 + 1));
  assertRefused(run(["--tests", file], { root: world() }));
});

test("--tests naming a .env file exits 2", () => {
  const dir = tmp("dp198-env-");
  const file = path.join(dir, ".env");
  writeFileSync(file, "A=b\n");
  assertRefused(run(["--tests", file], { root: world() }));
});

test("--tests naming a missing file exits 2", () => {
  assertRefused(run(["--tests", path.join(tmp("dp198-none-"), "nope.txt")], { root: world() }));
});

test("--tests naming a directory exits 2", () => {
  assertRefused(run(["--tests", tmp("dp198-dir-")], { root: world() }));
});

test("--tests without a value exits 2", () => {
  assertRefused(run(["--tests"], { root: world() }));
});
