// organism-infra/50: verdict needs the claim lock; log-agent --failures; log-agent symlinked .scratch;
// log-resolved race. All tests use a temp board root; the live .scratch is never touched.
//
// Pinned contracts (the ticket leaves these open; the developer must follow them):
//   - `board comment --verdict` with no claim lock on the ticket is refused for EVERY author, including
//     orchestrator (with or without --as): non-zero exit, stderr mentions "verdict" and "lock", no comment
//     event, no ticket change. The author is the lock's agent; --as must match it (unchanged rule).
//   - a qa lock only permits a verdict in mode verify: a qa lock claimed with --mode specify is refused
//     the same way (stderr mentions "verdict"). security and orchestrator locks need no mode.
//   - a comment WITHOUT --verdict keeps today's rules (no lock + --as is still accepted).
//   - log-agent --failures "<tool>:<what>;<tool>:<what>": items split on ";", each item split on its FIRST
//     ":" (what may contain ":"). One row per item, written after the agent row, in order:
//       {"kind":"incident","ts","ticket","role","tool","what","cost":null,"fix":null,"rule_change":null,"source":"agent-report"}
//     ticket and agent come from the agent row's --ticket and --cell. tool must be one of: bash-guard,
//     board-claim, board-release, board-comment, board-handoff, handoff-state, git, npm, write, ci, other.
//     Unknown tool, empty what, or what over 300 chars (exactly 300 is fine): exit non-zero, nothing
//     written (not even the agent row).
//   - log-agent refuses when <root>/.scratch is a symlink (non-zero, nothing written through the link),
//     as log-resolved already does.
//   - log-resolved: N concurrent runs for one resolved ticket write exactly one resolved row.
//   - ADR 0008 mentions the verdict claim lock and log-agent --failures.
//
// Criterion map:
//   1 verdict needs lock        -> "--verdict without ..." / "qa lock in mode specify ..." tests
//   2 --failures                -> "log-agent --failures ..." tests
//   3 symlinked .scratch        -> "log-agent refuses a symlinked .scratch"
//   4 log-resolved race         -> "concurrent log-resolved ..."
//   5 ADR                       -> "ADR 0008 ..."
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeBoardFixture, runBoard, REPO_ROOT } from "../apps/board/board-fixture.mjs";

const LOG_AGENT = path.join(REPO_ROOT, "scripts", "log-agent.mjs");
const LOG_RESOLVED = path.join(REPO_ROOT, "scripts", "log-resolved.mjs");
const usagePath = (root) => path.join(root, ".scratch", "usage.jsonl");
const rows = (root) => {
  try {
    return readFileSync(usagePath(root), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const commentEvents = (fx) =>
  existsSync(fx.eventsPath)
    ? readFileSync(fx.eventsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.op === "comment")
    : [];
const codeTicket = (t, status = "ready-for-agent") =>
  `# ${t}\n\n**Type:** feature\n\n**Status:** ${status}\n\n- [ ] criterion\n\n## Comments\n`;
const env = (fx) => ({ DEN_ROOT: fx.root });
const script = (file, args, root) =>
  spawnSync(process.execPath, [file, ...args], { env: { ...process.env, DEN_ROOT: root }, encoding: "utf8", timeout: 15000 });

// --- Criterion 1: verdict needs the claim lock ---

for (const role of ["qa", "security", "orchestrator"]) {
  test(`--verdict without a claim lock is refused for ${role} (with --as), nothing written`, async () => {
    const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
    try {
      const before = await fx.readTicket();
      const c = await runBoard(["comment", fx.ticketRelPath, "--verdict", "pass", "ok", "--as", role], { cwd: fx.worktree, env: env(fx) });
      assert.notEqual(c.code, 0);
      assert.match(c.stderr, /verdict/i);
      assert.match(c.stderr, /lock/i);
      assert.equal(commentEvents(fx).length, 0);
      assert.equal(await fx.readTicket(), before);
    } finally {
      await fx.cleanup();
    }
  });
}

test("--verdict without a claim lock and without --as is refused", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const c = await runBoard(["comment", fx.ticketRelPath, "--verdict", "bounce", "x"], { cwd: fx.worktree, env: env(fx) });
    assert.notEqual(c.code, 0);
    assert.equal(commentEvents(fx).length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("--verdict with --as not matching the lock's agent is refused", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const k = await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "verify"], { cwd: fx.worktree, env: env(fx) });
    assert.equal(k.code, 0, k.stderr);
    const c = await runBoard(["comment", fx.ticketRelPath, "--verdict", "pass", "x", "--as", "orchestrator"], { cwd: fx.worktree, env: env(fx) });
    assert.notEqual(c.code, 0);
    assert.equal(commentEvents(fx).length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("a qa lock in mode specify does not permit --verdict; mode verify does", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const k = await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "specify"], { cwd: fx.worktree, env: env(fx) });
    assert.equal(k.code, 0, k.stderr);
    const c = await runBoard(["comment", fx.ticketRelPath, "--verdict", "pass", "x"], { cwd: fx.worktree, env: env(fx) });
    assert.notEqual(c.code, 0);
    assert.match(c.stderr, /verdict/i);
    assert.equal(commentEvents(fx).length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("a comment without --verdict and no lock is still accepted with --as", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const c = await runBoard(["comment", fx.ticketRelPath, "plain note", "--as", "orchestrator"], { cwd: fx.worktree, env: env(fx) });
    assert.equal(c.code, 0, c.stderr);
    assert.equal(commentEvents(fx).length, 1);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 2: log-agent --failures ---

const TOOLS = ["bash-guard", "board-claim", "board-release", "board-comment", "board-handoff", "handoff-state", "git", "npm", "write", "ci", "other"];
const base = ["--ticket", "sample/01-do-thing", "--role", "qa", "--tokens", "10", "--ms", "20", "--outcome", "done", "--allow-no-handoff", "test setup"];

test("log-agent --failures writes the agent row then one incident row per item", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const r = script(LOG_AGENT, [...base, "--failures", "bash-guard:pipe into git refused;npm:ci failed: EACCES"], fx.root);
    assert.equal(r.status, 0, r.stderr);
    const got = rows(fx.root);
    assert.equal(got.length, 3);
    assert.equal(got[0].kind, "agent");
    for (const [i, [tool, what]] of [["bash-guard", "pipe into git refused"], ["npm", "ci failed: EACCES"]].entries()) {
      const row = got[i + 1];
      assert.deepEqual(Object.keys(row).sort(), ["role", "cost", "fix", "kind", "rule_change", "source", "tool", "ts", "ticket", "what"].sort());
      assert.equal(row.kind, "incident");
      assert.equal(row.ticket, "sample/01-do-thing");
      assert.equal(row.role, "qa");
      assert.equal(row.tool, tool);
      assert.equal(row.what, what);
      assert.strictEqual(row.cost, null);
      assert.strictEqual(row.fix, null);
      assert.strictEqual(row.rule_change, null);
      assert.equal(row.source, "agent-report");
      assert.ok(!Number.isNaN(Date.parse(row.ts)), "ts is an ISO date");
    }
  } finally {
    await fx.cleanup();
  }
});

test("log-agent --failures accepts every listed tool", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const r = script(LOG_AGENT, [...base, "--failures", TOOLS.map((t) => `${t}:x`).join(";")], fx.root);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(rows(fx.root).filter((x) => x.kind === "incident").map((x) => x.tool), TOOLS);
  } finally {
    await fx.cleanup();
  }
});

test("log-agent --failures accepts what of exactly 300 chars", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const r = script(LOG_AGENT, [...base, "--failures", `git:${"w".repeat(300)}`], fx.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(rows(fx.root).length, 2);
  } finally {
    await fx.cleanup();
  }
});

for (const [label, failures] of [
  ["an unknown tool", "bogus:something"],
  ["an unknown tool after a valid item", "git:ok;bogus:something"],
  ["an empty what", "git:"],
  ["a whitespace-only what", "git:   "],
  ["a what over 300 chars", `git:${"w".repeat(301)}`],
  ["an item with no tool separator", "just some text"],
]) {
  test(`log-agent --failures with ${label} is refused and writes nothing, not even the agent row`, async () => {
    const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
    try {
      const r = script(LOG_AGENT, [...base, "--failures", failures], fx.root);
      assert.notEqual(r.status, 0);
      assert.ok(r.stderr.length > 0, "explains on stderr");
      assert.equal(rows(fx.root).length, 0);
    } finally {
      await fx.cleanup();
    }
  });
}

test("log-agent without --failures still writes only the agent row", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const r = script(LOG_AGENT, base, fx.root);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(rows(fx.root).map((x) => x.kind), ["agent"]);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 3: symlinked .scratch ---

test("log-agent refuses a symlinked .scratch directory and writes nothing through it", async () => {
  const real = mkdtempSync(path.join(tmpdir(), "scratch-real-"));
  const root = mkdtempSync(path.join(tmpdir(), "scratch-root-"));
  try {
    mkdirSync(path.join(real, "sample", "issues"), { recursive: true });
    writeFileSync(path.join(real, "sample", "issues", "01-do-thing.md"), codeTicket("01-do-thing"));
    symlinkSync(real, path.join(root, ".scratch"));
    const r = script(LOG_AGENT, base, root);
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(path.join(real, "usage.jsonl")), false, "nothing written through the symlink");
  } finally {
    rmSync(real, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Criterion 4: log-resolved race ---

test("concurrent log-resolved runs write exactly one resolved row", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing", "resolved") });
  try {
    const runs = Array.from({ length: 32 }, () =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [LOG_RESOLVED, "--ticket", "sample/01-do-thing", "--pr", "42"], {
          env: { ...process.env, DEN_ROOT: fx.root },
        });
        child.on("exit", (code) => resolve(code));
      })
    );
    const codes = await Promise.all(runs);
    assert.equal(rows(fx.root).filter((x) => x.kind === "resolved").length, 1);
    assert.equal(codes.filter((c) => c === 0).length, 1, "exactly one run succeeds; the rest refuse as duplicates");
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 5: ADR ---

test("ADR 0008 documents the verdict claim lock and log-agent --failures", () => {
  const adr = readFileSync(path.join(REPO_ROOT, "docs", "adr", "0008-board-service.md"), "utf8");
  assert.match(adr, /verdict[^\n]*(claim )?lock|lock[^\n]*verdict/i);
  assert.match(adr, /--failures/);
});
