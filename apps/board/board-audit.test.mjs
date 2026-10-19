// Acceptance tests for organism-infra/81: `board audit` command.
//
// Pinned contract (QA's reading of the ticket):
//   - `board audit` is a read-only command that scans tickets, locks, and
//     handoffs and prints findings.
//   - Output format: one line per finding: `<ref> <kind> <detail>`.
//   - `--json` flag outputs findings as a JSON array.
//   - Exit 0 when clean, exit 1 when there are findings, exit 2 on bad args.
//   - Never writes to the board.
//   - Detects: in-review/claimed ticket with no lock; lock with no matching
//     worktree or branch; unblocked ticket that still lists only resolved
//     blocked-by; blocked-by names a ticket that does not exist; stale tickets
//     (no comment in N days, --stale-days flag, default 7); published handoff
//     with pending items naming a ticket but no matching ticket or comment.
//   - pipeline-retro calls it: that is a .claude/ edit (human-verified).
//
// Criterion map:
//   1 flags in-review/claimed with no lock       -> "flags missing lock" tests
//   2 flags lock with no worktree/branch          -> "flags stale lock" tests
//   3 flags actually-unblocked ticket, and bad blocked-by ref -> "flags blocked-by" tests
//   4 flags handoff pending with no matching ticket -> "flags orphan pending" tests
//   5 flags stale tickets                         -> "flags stale" test
//   6 output format, --json, exit codes, read-only -> "output" tests
//   7 pipeline-retro calls it                     -> human-verified (.claude/ edit)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, utimes } from "node:fs/promises";
import path from "node:path";
import { makeBoardFixture, runBoard, validStateJson } from "./board-fixture.mjs";

const NO_ROOT = { DEN_ROOT: "" };

function audit(fx, extraArgs = []) {
  return runBoard(["audit", ...extraArgs], { cwd: fx.worktree, env: NO_ROOT });
}

async function seedLock(fx, role = "developer", mode = null) {
  const lockPath = path.join(
    fx.root, ".scratch", fx.feature, "issues", `${fx.ticket}.lock`
  );
  const content = mode ? `${role} --mode ${mode}` : role;
  await writeFile(lockPath, content, "utf8");
}

async function seedHandoff(fx, state, name) {
  const dir = path.join(fx.root, ".scratch", fx.feature, "handoffs");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, name),
    "```json\n" + JSON.stringify(state) + "\n```\n\n## Summary\n\nhandoff\n",
    "utf8"
  );
}

// --- Criterion 1: flags in-review/claimed ticket with no lock ---

test("flags a claimed ticket with no lock file", async () => {
  const fx = await makeBoardFixture({ status: "claimed" });
  try {
    // No lock file — board claim was not run.
    const r = await audit(fx);
    assert.equal(r.code, 1, "exit 1 when there are findings");
    assert.match(
      `${r.stdout}\n${r.stderr}`,
      /no.lock|missing.lock|stale/i,
      "should report the missing lock"
    );
    assert.match(`${r.stdout}\n${r.stderr}`, new RegExp(fx.ticketRelPath));
  } finally {
    await fx.cleanup();
  }
});

test("flags an in-review ticket with no lock file", async () => {
  const fx = await makeBoardFixture({ status: "in-review" });
  try {
    const r = await audit(fx);
    assert.equal(r.code, 1);
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(out, /no.lock|missing.lock|stale/i);
    assert.match(out, new RegExp(fx.ticketRelPath));
  } finally {
    await fx.cleanup();
  }
});

test("exits 0 when everything is clean", async () => {
  const fx = await makeBoardFixture({ status: "ready-for-agent" });
  try {
    const r = await audit(fx);
    assert.equal(r.code, 0, `expected clean exit:\n${r.stdout}\n${r.stderr}`);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 2: flags a lock whose ticket has no matching git worktree or branch ---

test("flags a lock file when no matching git branch or worktree exists", async () => {
  const fx = await makeBoardFixture({ status: "claimed" });
  try {
    // Seed a lock but no branch named after the agent exists.
    await seedLock(fx, "developer");
    // There is no git branch matching this session, so audit should flag it.
    const r = await audit(fx);
    assert.equal(r.code, 1);
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(out, /no.worktree|no.branch|orphan|stale/i);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 3: flags blocked-by inconsistencies ---

test("flags a ticket whose Blocked-by lists only resolved tickets (actually unblocked)", async () => {
  const fx = await makeBoardFixture();
  try {
    // Overwrite the ticket with a blocked-by that is already resolved.
    await writeFile(
      fx.ticketPath,
      `# ${fx.ticket}\n\nStatus: blocked\n\nBlocked by: ${fx.feature}/00-prereq (resolved)\n\n- [ ] criterion\n\n## Comments\n`,
      "utf8"
    );
    const r = await audit(fx);
    assert.equal(r.code, 1);
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(out, /unblocked|actually.unblocked|blocked.by.*resolved/i);
    assert.match(out, new RegExp(fx.ticketRelPath));
  } finally {
    await fx.cleanup();
  }
});

test("flags a ticket blocked by a ticket that does not exist", async () => {
  const fx = await makeBoardFixture();
  try {
    await writeFile(
      fx.ticketPath,
      `# ${fx.ticket}\n\nStatus: blocked\n\nBlocked by: ${fx.feature}/99-ghost\n\n- [ ] criterion\n\n## Comments\n`,
      "utf8"
    );
    const r = await audit(fx);
    assert.equal(r.code, 1);
    const out = `${r.stdout}\n${r.stderr}`;
    // Must name the missing ref, not just "unknown command".
    assert.match(out, /99-ghost|does.not.exist|missing.ticket/i);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 4: flags handoff pending items with no matching ticket or comment ---

test("flags a published handoff whose pending item names a ticket that does not exist", async () => {
  const fx = await makeBoardFixture();
  try {
    const state = validStateJson({
      ticket: fx.ticketRelPath,
      role: "developer",
      pending: [{ item: "verify the feature", owner: "qa" }],
    });
    // Name the pending item with a ticket ref that doesn't exist.
    state.pending[0].ticket = `${fx.feature}/99-ghost`;
    await seedHandoff(fx, state, `${/^(\d{2})/.exec(fx.ticket)?.[1] ?? "01"}-developer.md`);

    const r = await audit(fx);
    assert.equal(r.code, 1);
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(out, /orphan|pending|no.matching/i);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 5: flags stale tickets ---

test("flags a ticket with no board event or comment in more than --stale-days days", async () => {
  const fx = await makeBoardFixture({ status: "ready-for-agent" });
  try {
    // Set the ticket's mtime to 10 days ago to simulate staleness.
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(fx.ticketPath, old, old);

    const r = await audit(fx, ["--stale-days", "7"]);
    assert.equal(r.code, 1);
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(out, /stale/i);
    assert.match(out, new RegExp(fx.ticketRelPath));
  } finally {
    await fx.cleanup();
  }
});

test("does not flag a ticket that was updated within --stale-days", async () => {
  const fx = await makeBoardFixture({ status: "ready-for-agent" });
  try {
    // mtime is "now" from the fixture creation, which is within 7 days.
    const r = await audit(fx, ["--stale-days", "7"]);
    // Should be clean (no findings for this ticket).
    assert.equal(r.code, 0, `expected clean:\n${r.stdout}\n${r.stderr}`);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 6: output format, --json, exit codes, read-only ---

test("exit 2 on bad arguments", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await audit(fx, ["--unknown-flag-xyz"]);
    assert.equal(r.code, 2, "bad args should exit 2");
  } finally {
    await fx.cleanup();
  }
});

test("--json flag outputs a JSON array", async () => {
  const fx = await makeBoardFixture({ status: "claimed" });
  try {
    const r = await audit(fx, ["--json"]);
    // There is a finding (claimed with no lock), so code is 1.
    assert.equal(r.code, 1);
    const parsed = JSON.parse(r.stdout.trim());
    assert.ok(Array.isArray(parsed), "JSON output must be an array");
    assert.ok(parsed.length > 0, "array must have at least one finding");
    assert.ok(
      parsed.every((f) => typeof f.ref === "string" && typeof f.kind === "string"),
      "each finding must have ref and kind"
    );
  } finally {
    await fx.cleanup();
  }
});

test("audit never writes to the board (ticket is unchanged after a run)", async () => {
  const fx = await makeBoardFixture({ status: "claimed" });
  try {
    const before = await fx.readTicket();
    await audit(fx);
    const after = await fx.readTicket();
    assert.equal(after, before, "audit must not modify any board file");
  } finally {
    await fx.cleanup();
  }
});

test("each finding line starts with the ticket ref", async () => {
  const fx = await makeBoardFixture({ status: "claimed" });
  try {
    const r = await audit(fx);
    assert.equal(r.code, 1);
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    assert.ok(
      lines.some((l) => l.startsWith(fx.ticketRelPath)),
      `expected a line starting with ${fx.ticketRelPath}:\n${r.stdout}`
    );
  } finally {
    await fx.cleanup();
  }
});
