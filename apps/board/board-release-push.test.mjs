// Acceptance tests for organism-infra/158, part 1: `board release` pushes the
// releasing agent's branch to origin before it records the release.
//
// Pinned contract (QA's reading of the ticket; the developer must follow it):
//   - `board release` run from a worktree on a branch pushes that branch to
//     `origin` with upstream tracking (`git push -u origin HEAD`-equivalent)
//     BEFORE the ticket status, claim lock and release event are written.
//   - If the push fails, the release is refused: non-zero exit, the git error
//     text is on stderr, and the claim lock, the `claimed` status and the
//     event log are untouched. A retry after the cause is fixed succeeds.
//   - A detached HEAD has no branch: nothing is pushed, the release succeeds.
//   - A repo with no `origin` remote at all skips the push (decision: keeps the
//     ~40 existing board tests, which use origin-less fixtures, valid; the
//     refusal is for a push that was attempted and failed).
//   - Applies to every gated release the relay uses, including qa specify's
//     `--keep-status` (the tests branch is what went missing in incident 140).
//
// Criterion map (ticket 158):
//   1 push then record           -> "release pushes the branch ..." (2 tests)
//   2 failed push refuses        -> "a rejected push ..." and "an unreachable origin ..."
//   3 detached HEAD              -> "a detached HEAD ..."
//   (no-origin compat is QA's pinned decision above -> "a repo with no origin ...")
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeBoardFixture, runBoard, writeValidHandoff, eventsPath } from "./board-fixture.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

// A fixture whose main checkout has a local bare repo as `origin`, with main pushed.
async function withRemote() {
  const fx = await makeBoardFixture();
  const bare = mkdtempSync(path.join(tmpdir(), "board-origin-"));
  git(bare, ["init", "-q", "--bare", "-b", "main"]);
  git(fx.root, ["remote", "add", "origin", bare]);
  git(fx.root, ["push", "-q", "origin", "main"]);
  const cleanup = fx.cleanup;
  fx.cleanup = async () => {
    await cleanup();
    rmSync(bare, { recursive: true, force: true });
  };
  return { fx, bare };
}

const branchOf = (fx) => git(fx.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
const headOf = (fx) => git(fx.worktree, ["rev-parse", "HEAD"]);
const remoteRefs = (bare) => git(bare, ["for-each-ref", "--format=%(refname) %(objectname)"]);

async function claimAndHandoff(fx, role, mode) {
  const r = await runBoard(["claim", fx.ticketRelPath, role, ...(mode ? ["--mode", mode] : [])], {
    cwd: fx.worktree,
  });
  assert.equal(r.code, 0, r.stderr);
  await writeValidHandoff(fx);
}

const release = (fx, ...extra) => runBoard(["release", fx.ticketRelPath, ...extra], { cwd: fx.worktree });

async function releaseEvents(fx) {
  const raw = await readFile(eventsPath(fx.root), "utf8").catch(() => "");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.op === "release" && e.kind !== "override");
}

function rejectPushes(bare, marker) {
  const hook = path.join(bare, "hooks", "pre-receive");
  writeFileSync(hook, `#!/bin/sh\necho "${marker}" >&2\nexit 1\n`);
  chmodSync(hook, 0o755);
  return hook;
}

// --- Criterion 1: push, then record ---

test("release pushes the branch to origin with upstream tracking, then records the release", async () => {
  const { fx, bare } = await withRemote();
  try {
    const branch = branchOf(fx);
    await claimAndHandoff(fx, "developer");
    const r = await release(fx, "--status", "in-review");
    assert.equal(r.code, 0, r.stderr);

    assert.equal(git(bare, ["rev-parse", `refs/heads/${branch}`]), headOf(fx), "origin has the branch at HEAD");
    assert.equal(git(fx.worktree, ["config", `branch.${branch}.remote`]), "origin");
    assert.equal(git(fx.worktree, ["config", `branch.${branch}.merge`]), `refs/heads/${branch}`);

    assert.match(await fx.readTicket(), /Status:\s*in-review/);
    assert.equal(existsSync(fx.claimLockPath), false, "claim lock freed");
    assert.equal((await releaseEvents(fx)).length, 1);
  } finally {
    await fx.cleanup();
  }
});

test("release --keep-status (qa specify) pushes the tests branch too", async () => {
  const { fx, bare } = await withRemote();
  try {
    const branch = branchOf(fx);
    await claimAndHandoff(fx, "qa", "specify");
    const r = await release(fx, "--keep-status");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(git(bare, ["rev-parse", `refs/heads/${branch}`]), headOf(fx));
    assert.equal(existsSync(fx.claimLockPath), false);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 2: a failed push refuses and keeps the lock ---

test("a rejected push refuses the release with the git error, keeps the lock, then a retry succeeds", async () => {
  const { fx, bare } = await withRemote();
  try {
    const hook = rejectPushes(bare, "REJECTED-BY-QA-HOOK-158");
    const branch = branchOf(fx);
    await claimAndHandoff(fx, "developer");

    const r = await release(fx, "--status", "in-review");
    assert.notEqual(r.code, 0, "release must refuse");
    assert.ok(`${r.stdout}${r.stderr}`.includes("REJECTED-BY-QA-HOOK-158"), `git error shown: ${r.stderr}`);
    assert.equal(existsSync(fx.claimLockPath), true, "lock stays in place");
    assert.match(await fx.readTicket(), /Status:\s*claimed/, "status not changed");
    assert.equal((await releaseEvents(fx)).length, 0, "no release event recorded");

    rmSync(hook);
    const retry = await release(fx, "--status", "in-review");
    assert.equal(retry.code, 0, retry.stderr);
    assert.equal(git(bare, ["rev-parse", `refs/heads/${branch}`]), headOf(fx));
    assert.match(await fx.readTicket(), /Status:\s*in-review/);
    assert.equal(existsSync(fx.claimLockPath), false);
  } finally {
    await fx.cleanup();
  }
});

test("an unreachable origin refuses the release and keeps the lock", async () => {
  const fx = await makeBoardFixture();
  try {
    git(fx.root, ["remote", "add", "origin", path.join(tmpdir(), "board-no-such-remote-158.git")]);
    await claimAndHandoff(fx, "developer");
    const r = await release(fx, "--status", "in-review");
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}${r.stderr}`, /no-such-remote-158|does not appear to be a git repository|fatal/i);
    assert.equal(existsSync(fx.claimLockPath), true);
    assert.match(await fx.readTicket(), /Status:\s*claimed/);
    assert.equal((await releaseEvents(fx)).length, 0);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 3: detached HEAD ---

test("a detached HEAD does not push and still releases", async () => {
  const { fx, bare } = await withRemote();
  try {
    git(fx.worktree, ["checkout", "-q", "--detach"]);
    const before = remoteRefs(bare);
    await claimAndHandoff(fx, "developer");
    const r = await release(fx, "--status", "in-review");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(remoteRefs(bare), before, "origin refs untouched");
    assert.match(await fx.readTicket(), /Status:\s*in-review/);
    assert.equal(existsSync(fx.claimLockPath), false);
  } finally {
    await fx.cleanup();
  }
});

// --- Pinned decision: no origin means nothing to push to ---

test("a repo with no origin remote skips the push and releases as before", async () => {
  const fx = await makeBoardFixture();
  try {
    assert.equal(git(fx.root, ["remote"]), "", "fixture has no remote");
    await claimAndHandoff(fx, "developer");
    const r = await release(fx, "--status", "in-review");
    assert.equal(r.code, 0, r.stderr);
    assert.match(await fx.readTicket(), /Status:\s*in-review/);
  } finally {
    await fx.cleanup();
  }
});
