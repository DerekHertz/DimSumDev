// organism-infra/49: verdict roles, specify claim keeps in-review, usage-row hardening.
// All tests use a temp board root (makeBoardFixture); the live .scratch is never touched.
//
// Pinned contracts (the ticket leaves these open; the developer must follow them):
//   - verdict roles: `board comment --verdict` is accepted only when the author (lock agent, or --as)
//     is qa, security or orchestrator. Any other author (developer, scout, ...) is refused: non-zero
//     exit, stderr mentions "verdict", no event and no ticket change.
//   - specify claim: a qa claim in mode specify on an in-review ticket leaves the status in-review
//     (like verify); on any other status it still sets claimed.
//   - lost resolved row: REDO OPTION CHOSEN = scripts/log-resolved.mjs (not a release rewrite).
//       node scripts/log-resolved.mjs --ticket <feature>/<NN-slug> [--pr <n>]
//     root = $DEN_ROOT else cwd. It appends exactly the same row shape as the release does
//     (bounces from the verdict events; pr rules as release: --pr required for feature/bug Types,
//     null otherwise). It refuses (exit 1, nothing written) when the ticket's status is not
//     resolved (stderr says "not resolved"), or when a resolved row for that ticket already exists
//     (stderr says "already"; no duplicates).
//     When the append fails inside `board release --status resolved`, the release has already
//     committed (ticket resolved, lock gone); release exits non-zero and stderr mentions
//     "usage.jsonl" and "log-resolved".
//   - append hardening: a usage.jsonl that is a symlink is refused by BOTH board (resolved row) and
//     log-agent (non-zero, symlink target untouched). log-agent caps --outcome at 500 chars and
//     --mode at 32 chars: exactly the cap is accepted, one over is refused with nothing written.
//   - --pr on any release whose status is not resolved (in-review, blocked, --keep-status) is
//     refused: non-zero, stderr mentions --pr, claim and ticket status unchanged.
//   - ADR 0008 (docs/adr/0008-board-service.md) documents 49: it must mention "log-resolved",
//     "specify" with "in-review" on one line, and the verdict roles (qa, security, orchestrator).
//
// Criterion map:
//   1 verdict roles        -> "--verdict from ..." tests
//   2 specify keeps        -> "specify claim on ..." tests
//   3 resolved row redo    -> "failed resolved-row append ..." and "log-resolved ..." tests
//   4 hardening/--pr       -> "symlinked usage", "log-agent caps", "--pr on a non-resolved release" tests
//   5 ADR                  -> "ADR 0008 ..." test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeBoardFixture, runBoard, writeValidHandoff, REPO_ROOT } from "../apps/board/board-fixture.mjs";

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
const events = (fx) =>
  existsSync(fx.eventsPath) ? readFileSync(fx.eventsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const ticketText = (fx) => readFileSync(fx.ticketPath, "utf8");
const codeTicket = (t, status = "ready-for-agent") =>
  `# ${t}\n\n**Type:** feature\n\n**Status:** ${status}\n\n- [ ] criterion\n\n## Comments\n`;
const env = (fx) => ({ DEN_ROOT: fx.root });
const status = async (fx) => (await runBoard(["status", fx.ticketRelPath], { cwd: fx.worktree, env: env(fx) })).stdout.trim();
const script = (file, args, root) =>
  spawnSync(process.execPath, [file, ...args], { env: { ...process.env, DEN_ROOT: root }, encoding: "utf8", timeout: 15000 });

async function claimAndReady(fx, role, mode) {
  const c = await runBoard(["claim", fx.ticketRelPath, role, ...(mode ? ["--mode", mode] : [])], { cwd: fx.worktree, env: env(fx) });
  assert.equal(c.code, 0, c.stderr);
  await writeValidHandoff(fx);
}
const release = (fx, ...extra) => runBoard(["release", fx.ticketRelPath, ...extra], { cwd: fx.worktree, env: env(fx) });

// --- Criterion 1: verdict roles (organism-infra/50: every verdict needs the matching claim lock) ---

const lockArgs = (role) => (role === "qa" ? ["qa", "--mode", "verify"] : [role]);
const claimAs = async (fx, role) => {
  const c = await runBoard(["claim", fx.ticketRelPath, ...lockArgs(role)], { cwd: fx.worktree, env: env(fx) });
  assert.equal(c.code, 0, c.stderr);
};
const commentEvents = (fx) => events(fx).filter((e) => e.op === "comment");

for (const role of ["qa", "security", "orchestrator"]) {
  test(`--verdict from ${role} holding the claim lock is accepted and recorded`, async () => {
    const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
    try {
      await claimAs(fx, role);
      const c = await runBoard(["comment", fx.ticketRelPath, "--verdict", "pass", "ok", "--as", role], { cwd: fx.worktree, env: env(fx) });
      assert.equal(c.code, 0, c.stderr);
      assert.deepEqual(commentEvents(fx).map((e) => e.verdict), ["pass"]);
    } finally {
      await fx.cleanup();
    }
  });
}

for (const role of ["developer", "scout", "designer"]) {
  test(`--verdict from ${role} holding the claim lock is refused and writes nothing`, async () => {
    const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
    try {
      await claimAs(fx, role);
      const before = ticketText(fx);
      const c = await runBoard(["comment", fx.ticketRelPath, "--verdict", "bounce", "forged", "--as", role], { cwd: fx.worktree, env: env(fx) });
      assert.notEqual(c.code, 0);
      assert.match(c.stderr, /verdict/i);
      assert.equal(commentEvents(fx).length, 0);
      assert.equal(ticketText(fx), before);
    } finally {
      await fx.cleanup();
    }
  });
}

test("--verdict from a developer holding the claim lock (no --as) is refused", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const c0 = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree, env: env(fx) });
    assert.equal(c0.code, 0, c0.stderr);
    const c = await runBoard(["comment", fx.ticketRelPath, "--verdict", "pass", "self-approve"], { cwd: fx.worktree, env: env(fx) });
    assert.notEqual(c.code, 0);
    assert.equal(events(fx).filter((e) => e.op === "comment").length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("a developer comment without --verdict is still accepted", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const c = await runBoard(["comment", fx.ticketRelPath, "plain note", "--as", "developer"], { cwd: fx.worktree });
    assert.equal(c.code, 0, c.stderr);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 2: specify claim keeps in-review ---

test("specify claim on an in-review ticket keeps in-review, and --keep-status leaves it in-review", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing", "in-review") });
  try {
    const c = await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "specify"], { cwd: fx.worktree, env: env(fx) });
    assert.equal(c.code, 0, c.stderr);
    assert.equal(await status(fx), "in-review");
    await writeValidHandoff(fx);
    const r = await release(fx, "--keep-status");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await status(fx), "in-review");
  } finally {
    await fx.cleanup();
  }
});

test("specify claim on a ready-for-agent ticket still sets claimed", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const c = await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "specify"], { cwd: fx.worktree, env: env(fx) });
    assert.equal(c.code, 0, c.stderr);
    assert.equal(await status(fx), "claimed");
  } finally {
    await fx.cleanup();
  }
});

test("a developer claim on an in-review ticket still sets claimed", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing", "in-review") });
  try {
    const c = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree, env: env(fx) });
    assert.equal(c.code, 0, c.stderr);
    assert.equal(await status(fx), "claimed");
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 3: lost resolved row ---

async function failedResolve(fx, { verdict } = {}) {
  await claimAndReady(fx, "orchestrator");
  if (verdict) {
    const cm = await runBoard(["comment", fx.ticketRelPath, "--verdict", verdict, "QA " + verdict], { cwd: fx.worktree, env: env(fx) });
    assert.equal(cm.code, 0, cm.stderr);
  }
  // usage.jsonl as a directory makes the append fail after the release commits.
  mkdirSync(usagePath(fx.root), { recursive: true });
  return release(fx, "--status", "resolved", "--pr", "42");
}

test("failed resolved-row append is reported on stderr with non-zero exit, after the release committed", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const r = await failedResolve(fx);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /usage\.jsonl/);
    assert.match(r.stderr, /log-resolved/);
    assert.equal(await status(fx), "resolved");
  } finally {
    await fx.cleanup();
  }
});

test("log-resolved redoes the lost row with the release's row shape", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    await failedResolve(fx, { verdict: "bounce" });
    rmSync(usagePath(fx.root), { recursive: true });
    const r = script(LOG_RESOLVED, ["--ticket", "sample/01-do-thing", "--pr", "42"], fx.root);
    assert.equal(r.status, 0, r.stderr);
    const got = rows(fx.root).filter((x) => x.kind === "resolved");
    assert.equal(got.length, 1);
    assert.equal(got[0].ticket, "sample/01-do-thing");
    assert.strictEqual(got[0].pr, 42);
    assert.strictEqual(got[0].bounces, 1);
    assert.deepEqual(Object.keys(got[0]).sort(), ["bounces", "kind", "pr", "ticket", "ts"]);
  } finally {
    await fx.cleanup();
  }
});

test("log-resolved refuses a ticket that is not resolved, and a duplicate row", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const notYet = script(LOG_RESOLVED, ["--ticket", "sample/01-do-thing", "--pr", "42"], fx.root);
    assert.notEqual(notYet.status, 0);
    assert.match(notYet.stderr, /not resolved/i);
    assert.equal(rows(fx.root).length, 0);
    await claimAndReady(fx, "orchestrator");
    const ok = await release(fx, "--status", "resolved", "--pr", "42");
    assert.equal(ok.code, 0, ok.stderr);
    const dup = script(LOG_RESOLVED, ["--ticket", "sample/01-do-thing", "--pr", "42"], fx.root);
    assert.notEqual(dup.status, 0);
    assert.match(dup.stderr, /already/i);
    assert.equal(rows(fx.root).filter((x) => x.kind === "resolved").length, 1);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 4: append hardening and --pr ---

function outsideTarget() {
  const dir = mkdtempSync(path.join(tmpdir(), "usage-outside-"));
  const target = path.join(dir, "victim.jsonl");
  writeFileSync(target, "ORIGINAL\n");
  return { dir, target };
}

test("symlinked usage.jsonl is refused by board's resolved-row append", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  const { dir, target } = outsideTarget();
  try {
    await claimAndReady(fx, "orchestrator");
    symlinkSync(target, usagePath(fx.root));
    const r = await release(fx, "--status", "resolved", "--pr", "5");
    assert.notEqual(r.code, 0);
    assert.equal(readFileSync(target, "utf8"), "ORIGINAL\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await fx.cleanup();
  }
});

test("symlinked usage.jsonl is refused by log-agent", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  const { dir, target } = outsideTarget();
  try {
    symlinkSync(target, usagePath(fx.root));
    const r = script(LOG_AGENT, ["--ticket", "sample/01-do-thing", "--role", "qa", "--tokens", "1", "--ms", "1", "--outcome", "x", "--allow-no-handoff", "test setup"], fx.root);
    assert.notEqual(r.status, 0);
    assert.equal(readFileSync(target, "utf8"), "ORIGINAL\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await fx.cleanup();
  }
});

test("log-agent caps --outcome at 500 chars and --mode at 32 chars", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const base = ["--ticket", "sample/01-do-thing", "--role", "qa", "--tokens", "1", "--ms", "1", "--allow-no-handoff", "test setup"];
    const okBoth = script(LOG_AGENT, [...base, "--mode", "m".repeat(32), "--outcome", "o".repeat(500)], fx.root);
    assert.equal(okBoth.status, 0, okBoth.stderr);
    assert.equal(rows(fx.root).length, 1);
    const longOutcome = script(LOG_AGENT, [...base, "--outcome", "o".repeat(501)], fx.root);
    assert.notEqual(longOutcome.status, 0);
    const longMode = script(LOG_AGENT, [...base, "--mode", "m".repeat(33), "--outcome", "ok"], fx.root);
    assert.notEqual(longMode.status, 0);
    assert.equal(rows(fx.root).length, 1, "refusals write nothing");
  } finally {
    await fx.cleanup();
  }
});

for (const [label, args] of [
  ["in-review", ["--status", "in-review", "--pr", "9"]],
  ["blocked", ["--status", "blocked", "--pr", "9"]],
  ["--keep-status", ["--keep-status", "--pr", "9"]],
]) {
  test(`--pr on a non-resolved release (${label}) is refused, claim intact`, async () => {
    const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
    try {
      await claimAndReady(fx, "developer");
      const r = await release(fx, ...args);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /--pr/);
      assert.equal(await status(fx), "claimed");
      assert.ok(existsSync(fx.claimLockPath), "claim lock remains");
    } finally {
      await fx.cleanup();
    }
  });
}

// --- Criterion 5: ADR ---

test("ADR 0008 documents verdict roles, specify keeping in-review, and log-resolved", () => {
  const adr = readFileSync(path.join(REPO_ROOT, "docs", "adr", "0008-board-service.md"), "utf8");
  assert.match(adr, /log-resolved/);
  assert.match(adr, /specify[^\n]*in-review|in-review[^\n]*specify/i);
  assert.match(adr, /verdict[^\n]*qa[^\n]*security[^\n]*orchestrator/i);
});
