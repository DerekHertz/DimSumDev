// organism-infra/217: `board claim` accepts `--role <role>` and refuses unknown flags.
// See .scratch/organism-infra/issues/217-board-claim-cell-flag.md.
//
// Wire shapes pinned here:
//   1. `board claim <ref> --role <role>` behaves like `board claim <ref> <type>`
//      (same exit code, same stdout, same lock holder, same status, same event).
//   2. `board claim <ref> --as <type>` exits non-zero, stderr names the bad flag
//      and prints a usage line (`usage:` ... `board claim <ref>`), and no lock is
//      written. `--as` must never be silently ignored.
//   3. A positional agent plus `--role` with different values is refused (no lock);
//      the same value given twice is not a conflict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { makeBoardFixture, runBoard } from "./board-fixture.mjs";

async function exists(p) {
  return access(p).then(
    () => true,
    () => false
  );
}

async function readEvents(fx) {
  const raw = await readFile(fx.eventsPath, "utf8").catch(() => "");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function lockHolder(fx) {
  return (await readFile(fx.claimLockPath, "utf8")).trim().split(/\s+/);
}

test("`claim <ref> --role developer` claims exactly as `claim <ref> developer` does", async () => {
  const positional = await makeBoardFixture();
  const flagged = await makeBoardFixture();
  try {
    const a = await runBoard(["claim", positional.ticketRelPath, "developer"], { cwd: positional.worktree });
    const b = await runBoard(["claim", flagged.ticketRelPath, "--role", "developer"], { cwd: flagged.worktree });
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, `--role should be accepted: ${b.stderr}`);
    assert.equal(b.stdout, a.stdout, "same stdout as the positional form");

    assert.equal(await exists(flagged.claimLockPath), true, "lock written");
    assert.equal((await lockHolder(flagged))[0], "developer");
    assert.equal((await lockHolder(flagged))[0], (await lockHolder(positional))[0]);

    assert.match(await flagged.readTicket(), /Status:\s*claimed/);
    assert.equal(
      (await flagged.readTicket()).match(/Status:\s*\S+/)[0],
      (await positional.readTicket()).match(/Status:\s*\S+/)[0]
    );

    const ea = (await readEvents(positional)).at(-1);
    const eb = (await readEvents(flagged)).at(-1);
    assert.equal(eb.op, ea.op);
    assert.equal(eb.role, "developer");
  } finally {
    await positional.cleanup();
    await flagged.cleanup();
  }
});

test("`claim <ref> --role qa --mode specify` records agent qa and mode specify like the positional form", async () => {
  const positional = await makeBoardFixture();
  const flagged = await makeBoardFixture();
  try {
    const a = await runBoard(["claim", positional.ticketRelPath, "qa", "--mode", "specify"], {
      cwd: positional.worktree,
    });
    const b = await runBoard(["claim", flagged.ticketRelPath, "--role", "qa", "--mode", "specify"], {
      cwd: flagged.worktree,
    });
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, `--role with --mode should be accepted: ${b.stderr}`);
    const hb = await lockHolder(flagged);
    const ha = await lockHolder(positional);
    assert.equal(hb[0], "qa");
    assert.equal(hb[2], "specify", "mode recorded in the lock");
    assert.deepEqual([hb[0], hb[2]], [ha[0], ha[2]]);
    assert.equal((await readEvents(flagged)).at(-1).role, "qa");
  } finally {
    await positional.cleanup();
    await flagged.cleanup();
  }
});

test("`claim <ref> --as qa` exits non-zero, prints the usage line, and writes no lock", async () => {
  const fx = await makeBoardFixture();
  try {
    const before = await fx.readTicket();
    const r = await runBoard(["claim", fx.ticketRelPath, "--as", "qa"], { cwd: fx.worktree });
    assert.notEqual(r.code, 0, "an unknown flag on claim must fail");
    assert.equal(r.timedOut, false);
    assert.match(r.stderr, /--as/, "names the bad flag");
    assert.match(r.stderr, /usage/i, "prints a usage line");
    assert.match(r.stderr, /board claim <ref>/, "the usage line shows the claim syntax");
    assert.equal(await exists(fx.claimLockPath), false, "no lock written");
    assert.equal(await fx.readTicket(), before, "ticket untouched");
    assert.match(before, /Status:\s*ready-for-agent/);
  } finally {
    await fx.cleanup();
  }
});

test("`claim <ref> developer --as qa` (positional plus unknown flag) is refused with no lock", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await runBoard(["claim", fx.ticketRelPath, "developer", "--as", "qa"], { cwd: fx.worktree });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /usage/i);
    assert.equal(await exists(fx.claimLockPath), false);
  } finally {
    await fx.cleanup();
  }
});

test("a positional agent and a different `--role` value is refused with no lock", async () => {
  const fx = await makeBoardFixture();
  try {
    const before = await fx.readTicket();
    const r = await runBoard(["claim", fx.ticketRelPath, "developer", "--role", "qa"], { cwd: fx.worktree });
    assert.notEqual(r.code, 0, "conflicting agent values must be refused");
    assert.equal(r.timedOut, false);
    assert.match(r.stderr, /developer/);
    assert.match(r.stderr, /qa/);
    assert.equal(await exists(fx.claimLockPath), false, "no lock written");
    assert.equal(await fx.readTicket(), before);
  } finally {
    await fx.cleanup();
  }
});

test("a positional agent and the same `--role` value is not a conflict", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await runBoard(["claim", fx.ticketRelPath, "developer", "--role", "developer"], { cwd: fx.worktree });
    assert.equal(r.code, 0, r.stderr);
    assert.equal((await lockHolder(fx))[0], "developer");
  } finally {
    await fx.cleanup();
  }
});

test("`claim <ref> --role` with no value is refused with no lock", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await runBoard(["claim", fx.ticketRelPath, "--role"], { cwd: fx.worktree });
    assert.notEqual(r.code, 0);
    assert.equal(await exists(fx.claimLockPath), false);
  } finally {
    await fx.cleanup();
  }
});
