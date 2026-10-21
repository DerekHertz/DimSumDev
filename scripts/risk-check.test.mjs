// organism-infra/08: the scripted risk check. Given a git range (default
// `main...HEAD`), it exits 0 when the diff is clean enough for a scout-run
// scripted check to suffice, and non-zero when it hits something that should
// escalate to a full `security` review. See
// .scratch/organism-infra/issues/08-risk-sized-review.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, "scripts", "risk-check.mjs");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "risk-check-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(path.join(dir, "README.md"), "hello\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: {} }, null, 2) + "\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["branch", "-m", "main"]);
  git(dir, ["checkout", "-q", "-b", "feature"]);
  return dir;
}

function runCheck(dir, range = "main...feature") {
  try {
    const stdout = execFileSync("node", [SCRIPT, range], { cwd: dir, encoding: "utf8" });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

function commitChange(dir, relPath, content) {
  const full = path.join(dir, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  git(dir, ["add", relPath]);
  git(dir, ["commit", "-q", "-m", `change ${relPath}`]);
}

test("a clean diff exits 0", () => {
  const dir = initRepo();
  try {
    commitChange(dir, "apps/ci-cd/foo.mjs", "export const x = 1;\n");
    const { code } = runCheck(dir);
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hardcoded secret-shaped value fails and names the file", () => {
  const dir = initRepo();
  try {
    commitChange(dir, "apps/ci-cd/config.mjs", 'export const apiKey = "sk_live_' + '1234567890abcdef";\n');
    const { code, stdout } = runCheck(dir);
    assert.notEqual(code, 0);
    assert.match(stdout, /apps\/ci-cd\/config\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a private key block fails", () => {
  const dir = initRepo();
  try {
    // Built at runtime (not a literal PEM header/footer) so this fixture
    // itself doesn't trip generic secret scanners on this source file.
    const header = "-----BEGIN " + "RSA PRIVATE KEY" + "-----";
    const footer = "-----END " + "RSA PRIVATE KEY" + "-----";
    commitChange(dir, "keys/id_rsa", `${header}\nabc\n${footer}\n`);
    const { code } = runCheck(dir);
    assert.notEqual(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a package.json dependency field change fails", () => {
  const dir = initRepo();
  try {
    commitChange(
      dir,
      "package.json",
      JSON.stringify({ name: "x", dependencies: { "left-pad": "1.0.0" } }, null, 2) + "\n"
    );
    const { code, stdout } = runCheck(dir);
    assert.notEqual(code, 0);
    assert.match(stdout, /package\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("any package-lock.json change fails", () => {
  const dir = initRepo();
  try {
    commitChange(dir, "package-lock.json", '{"lockfileVersion": 3}\n');
    const { code, stdout } = runCheck(dir);
    assert.notEqual(code, 0);
    assert.match(stdout, /package-lock\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a change under .github/ fails", () => {
  const dir = initRepo();
  try {
    commitChange(dir, ".github/workflows/ci.yml", "name: ci\non: push\n");
    const { code, stdout } = runCheck(dir);
    assert.notEqual(code, 0);
    assert.match(stdout, /\.github\/workflows\/ci\.yml/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shelling out via child_process in source fails", () => {
  const dir = initRepo();
  try {
    commitChange(
      dir,
      "apps/ci-cd/runner.mjs",
      'import { spawn } from "node:child_process";\nspawn("ls");\n'
    );
    const { code, stdout } = runCheck(dir);
    assert.notEqual(code, 0);
    assert.match(stdout, /apps\/ci-cd\/runner\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opening a network listener in source fails", () => {
  const dir = initRepo();
  try {
    commitChange(
      dir,
      "apps/ci-cd/server.mjs",
      'import http from "node:http";\nhttp.createServer().listen(3000);\n'
    );
    const { code, stdout } = runCheck(dir);
    assert.notEqual(code, 0);
    assert.match(stdout, /apps\/ci-cd\/server\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the word 'secret' in ticket prose does not trigger a false positive", () => {
  const dir = initRepo();
  try {
    commitChange(
      dir,
      ".scratch/some-feature/issues/01-ticket.md",
      "**What to build:** handle secrets and credentials safely.\n"
    );
    const { code } = runCheck(dir);
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option-shaped range argument is rejected without writing a file or reporting clean", () => {
  const dir = initRepo();
  try {
    commitChange(dir, "apps/ci-cd/foo.mjs", "export const x = 1;\n");
    const outputPath = path.join(dir, "pwned.txt");
    const maliciousRange = `--output=${outputPath}`;
    const { code, stdout } = runCheck(dir, maliciousRange);
    assert.notEqual(code, 0);
    assert.equal(existsSync(outputPath), false);
    assert.doesNotMatch(stdout, /clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execFileSync used without touching an already-present import line still fails", () => {
  const dir = initRepo();
  try {
    const filePath = "apps/ci-cd/runner.mjs";
    const full = path.join(dir, filePath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, 'import { execFileSync } from "node:child_process";\n');
    git(dir, ["add", filePath]);
    git(dir, ["commit", "-q", "-m", "add import only"]);

    // The only *added* line in this next commit is the call itself; the
    // import line is unchanged context, so a naive "added lines" diff scan
    // must still catch it via the call-site pattern, not the import.
    writeFileSync(full, 'import { execFileSync } from "node:child_process";\nexecFileSync("ls");\n');
    git(dir, ["add", filePath]);
    git(dir, ["commit", "-q", "-m", "call execFileSync"]);

    const { code, stdout } = runCheck(dir);
    assert.notEqual(code, 0);
    assert.match(stdout, /apps\/ci-cd\/runner\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnSync, execFile, and fork calls are also caught", () => {
  const dir = initRepo();
  try {
    commitChange(
      dir,
      "apps/ci-cd/runner2.mjs",
      'import { spawnSync, execFile, fork } from "node:child_process";\n' +
        'spawnSync("ls");\nexecFile("ls", () => {});\nfork("./x.js");\n'
    );
    const { code, stdout } = runCheck(dir);
    assert.notEqual(code, 0);
    assert.match(stdout, /apps\/ci-cd\/runner2\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("board, lock, or daemon vocabulary triggers escalation", () => {
  const dir = initRepo();
  try {
    commitChange(
      dir,
      "apps/ci-cd/worker.mjs",
      "// starts the daemon that watches the board\nexport function start() {}\n"
    );
    const { code, stdout } = runCheck(dir);
    assert.notEqual(code, 0);
    assert.match(stdout, /apps\/ci-cd\/worker\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secrets-handling vocabulary triggers escalation", () => {
  const dir = initRepo();
  try {
    commitChange(
      dir,
      "apps/ci-cd/auth.mjs",
      "export function load() {\n  const credential = fetchFromVault();\n  return credential;\n}\n"
    );
    const { code, stdout } = runCheck(dir);
    assert.notEqual(code, 0);
    assert.match(stdout, /apps\/ci-cd\/auth\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaults the range to main...HEAD when no argument is given", () => {
  const dir = initRepo();
  try {
    commitChange(dir, "apps/ci-cd/foo.mjs", "export const x = 1;\n");
    let stdout;
    let code;
    try {
      stdout = execFileSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
      code = 0;
    } catch (err) {
      code = err.status ?? 1;
      stdout = (err.stdout ?? "") + (err.stderr ?? "");
    }
    assert.equal(code, 0, stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ci-cd/13: a diff over the default 1 MiB execFileSync buffer must not crash.
function bigProse() {
  const line = "The quick brown fox jumps over the lazy dog while the tea steeps.\n";
  return line.repeat(Math.ceil((2 * 1024 * 1024) / line.length));
}

test("a diff over 1 MiB with nothing risky exits 0 and prints clean", () => {
  const dir = initRepo();
  try {
    commitChange(dir, "docs/research/big.md", bigProse());
    const { code, stdout } = runCheck(dir);
    assert.equal(code, 0, stdout.slice(0, 500));
    assert.match(stdout, /risk-check: clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a diff over 1 MiB that also changes a risky file fails and names it", () => {
  const dir = initRepo();
  try {
    commitChange(dir, "docs/research/big.md", bigProse());
    commitChange(dir, ".github/workflows/ci.yml", "name: ci\non: push\n");
    const { code, stdout } = runCheck(dir);
    assert.notEqual(code, 0);
    // A buffer crash also exits non-zero and can echo partial diff output.
    assert.doesNotMatch(stdout, /ENOBUFS|maxBuffer/);
    assert.match(stdout, /\.github\/workflows\/ci\.yml/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
