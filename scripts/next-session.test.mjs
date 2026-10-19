// organism-infra/122: `npm run next-session` launcher tests.
//
// Interface under test (the seam): `node scripts/next-session.mjs [--root <dir>] [--run]`.
//   - Root: `--root <dir>`, else $DEN_ROOT, else the cwd. Orchestrator
//     session handoffs live in <root>/.scratch/_handoffs/ and are named
//     `YYYY-MM-DD-orchestrator[-cloud]-N.md`.
//   - Latest = highest date, then highest N (numeric: 10 beats 9). Not mtime.
//   - Without `--run`: prints `claude --agent orchestrator "<prompt>"` and exits 0.
//     It never starts claude.
//   - With `--run`: spawns `claude` (found on PATH) with argv
//     ["--agent", "orchestrator", "<prompt>"], inheriting stdio.
//   - No handoff: exits non-zero, stderr says there is no orchestrator handoff.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(REPO, "scripts", "next-session.mjs");

const tmps = [];
function tmp(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), `${prefix}-`));
  tmps.push(d);
  return d;
}
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

// A fake main checkout with the given session handoff names.
function fakeRoot(names, { mtimes = {} } = {}) {
  const root = tmp("next-session-root");
  const dir = path.join(root, ".scratch", "_handoffs");
  mkdirSync(dir, { recursive: true });
  for (const n of names) {
    const p = path.join(dir, n);
    writeFileSync(p, `# ${n}\n`);
    if (mtimes[n]) utimesSync(p, mtimes[n], mtimes[n]);
  }
  return root;
}

// A stub `claude` that records its argv as JSON to $STUB_OUT.
function stubClaude() {
  const bin = tmp("next-session-bin");
  const out = path.join(bin, "argv.json");
  const stub = path.join(bin, "claude");
  writeFileSync(
    stub,
    `#!${process.execPath}\n` +
      `require("node:fs").writeFileSync(process.env.STUB_OUT, JSON.stringify(process.argv.slice(2)));\n`,
  );
  chmodSync(stub, 0o755);
  return { bin, out };
}

function run(args, { env = {}, cwd = REPO } = {}) {
  const base = { ...process.env };
  delete base.DEN_ROOT;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...base, ...env },
  });
}

describe("next-session: package script", () => {
  it("npm run next-session points at scripts/next-session.mjs", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
    assert.match(pkg.scripts["next-session"] ?? "", /scripts\/next-session\.mjs/);
  });
});

describe("next-session: print mode", () => {
  it("prints a claude --agent orchestrator command naming the latest handoff, exit 0", () => {
    const root = fakeRoot([
      "2026-10-01-orchestrator-18.md",
      "2026-10-02-orchestrator-19.md",
      "2026-10-02-orchestrator-20.md",
    ]);
    const r = run(["--root", root]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /claude --agent orchestrator /);
    assert.ok(r.stdout.includes("2026-10-02-orchestrator-20.md"), r.stdout);
    assert.ok(!r.stdout.includes("orchestrator-19.md"), "older handoff must not be named");
  });

  it("orders handoff numbers numerically: 10 beats 9 on the same date", () => {
    const root = fakeRoot([
      "2026-09-29-orchestrator-9.md",
      "2026-09-29-orchestrator-10.md",
      "2026-09-29-orchestrator-8.md",
    ]);
    const r = run(["--root", root]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("2026-09-29-orchestrator-10.md"), r.stdout);
  });

  it("picks the latest by name, not by file mtime", () => {
    const old = new Date("2020-01-01T00:00:00Z");
    const recent = new Date("2026-10-02T00:00:00Z");
    const root = fakeRoot(["2026-10-02-orchestrator-27.md", "2026-09-26-orchestrator-setup.md"], {
      mtimes: { "2026-10-02-orchestrator-27.md": old, "2026-09-26-orchestrator-setup.md": recent },
    });
    const r = run(["--root", root]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("2026-10-02-orchestrator-27.md"), r.stdout);
  });

  it("ignores files that are not orchestrator session handoffs", () => {
    const root = fakeRoot([
      "2026-10-02-orchestrator-5.md",
      "2026-10-02-design.md",
      "2026-10-03-new-scope-for-product.md",
      "apply-87-and-90.sh",
      "local-90-edits.patch",
    ]);
    mkdirSync(path.join(root, ".scratch", "_handoffs", "gated"));
    const r = run(["--root", root]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("2026-10-02-orchestrator-5.md"), r.stdout);
  });

  it("does not take per-ticket orchestrator handoffs under a feature's handoffs/", () => {
    const root = fakeRoot(["2026-10-01-orchestrator-18.md"]);
    const feat = path.join(root, ".scratch", "organism-infra", "handoffs");
    mkdirSync(feat, { recursive: true });
    writeFileSync(path.join(feat, "119-orchestrator.md"), "# per-ticket\n");
    const r = run(["--root", root]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("2026-10-01-orchestrator-18.md"), r.stdout);
    assert.ok(!r.stdout.includes("119-orchestrator.md"), r.stdout);
  });

  it("falls back to $DEN_ROOT when --root is not given", () => {
    const root = fakeRoot(["2026-10-02-orchestrator-3.md"]);
    const elsewhere = tmp("next-session-cwd");
    const r = run([], { env: { DEN_ROOT: root }, cwd: elsewhere });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("2026-10-02-orchestrator-3.md"), r.stdout);
  });

  it("does not start claude when --run is absent", () => {
    const root = fakeRoot(["2026-10-02-orchestrator-3.md"]);
    const { bin, out } = stubClaude();
    const r = run(["--root", root], {
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_OUT: out },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(out), false, "stub claude must not have been invoked");
  });
});

describe("next-session: prompt content", () => {
  it("is a short prompt that points at the handoff and asks for the frontier proposal", () => {
    const root = fakeRoot(["2026-10-02-orchestrator-3.md"]);
    const { bin, out } = stubClaude();
    const r = run(["--root", root, "--run"], {
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_OUT: out },
    });
    assert.equal(r.status, 0, r.stderr);
    const [, , prompt] = JSON.parse(readFileSync(out, "utf8"));
    assert.match(prompt, /2026-10-02-orchestrator-3\.md/);
    assert.match(prompt, /frontier/i);
    assert.ok(prompt.length < 600, `prompt restates too much (${prompt.length} chars)`);
  });
});

describe("next-session: --run with a stubbed claude", () => {
  it("spawns claude with --agent orchestrator and the prompt as the last argument", () => {
    const root = fakeRoot(["2026-10-02-orchestrator-26.md", "2026-10-02-orchestrator-27.md"]);
    const { bin, out } = stubClaude();
    const r = run(["--root", root, "--run"], {
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_OUT: out },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(out), "stub claude was not invoked");
    const argv = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(argv.slice(0, 2), ["--agent", "orchestrator"]);
    assert.equal(argv.length, 3, `expected exactly one prompt argument, got ${JSON.stringify(argv)}`);
    assert.match(argv[2], /2026-10-02-orchestrator-27\.md/);
    assert.ok(!argv[2].includes("orchestrator-26.md"));
  });

  it("passes the prompt as one argument even when the root path has spaces and quotes", () => {
    const parent = tmp("next-session-odd");
    const root = path.join(parent, `it's a "root" $HOME`);
    mkdirSync(path.join(root, ".scratch", "_handoffs"), { recursive: true });
    writeFileSync(path.join(root, ".scratch", "_handoffs", "2026-10-02-orchestrator-1.md"), "# x\n");
    const { bin, out } = stubClaude();
    const r = run(["--root", root, "--run"], {
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_OUT: out },
    });
    assert.equal(r.status, 0, r.stderr);
    const argv = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(argv.length, 3, JSON.stringify(argv));
    assert.match(argv[2], /2026-10-02-orchestrator-1\.md/);
  });

  it("does not start claude when there is no handoff", () => {
    const root = fakeRoot([]);
    const { bin, out } = stubClaude();
    const r = run(["--root", root, "--run"], {
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_OUT: out },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no orchestrator handoff/i);
    assert.equal(existsSync(out), false, "claude must not start without a handoff");
  });
});

describe("next-session: no handoff", () => {
  it("exits non-zero with a clear message when _handoffs/ has no orchestrator handoff", () => {
    const root = fakeRoot(["2026-10-02-design.md", "notes.txt"]);
    const r = run(["--root", root]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no orchestrator handoff/i);
    assert.equal(r.stdout.includes("claude --agent"), false, "must not print a command");
  });

  it("exits non-zero with the same message when the _handoffs/ directory is missing", () => {
    const root = tmp("next-session-empty");
    const r = run(["--root", root]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no orchestrator handoff/i);
  });
});
