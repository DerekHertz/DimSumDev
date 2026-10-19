// Acceptance tests for organism-infra/30: State-block rejections print a
// filled-in skeleton, and `release` to anything but `blocked` needs a valid
// handoff newer than the claim.
//
// Pinned contract (QA's reading of the ticket; the developer must follow it):
//   - On rejection (`board handoff` "must name ticket", `board release` "no
//     valid handoff State block" / "no handoff file found"), the error output
//     (stdout or stderr) contains a fenced ```json block whose object has
//     ticket = "<feature>/<ticket-slug>", agent = the claim's agent, mode = the
//     claim's mode (key absent for unmoded agents), and current_step,
//     artifacts, decisions, failures, pending. `pending` is an array; any
//     entries are {item, owner} objects. The skeleton must itself pass
//     validateState, so copying it into a handoff file works in one retry.
//   - The skeleton's role/mode come from the live claim lock.
//   - `release --status <s>` for every s except `blocked` needs a valid
//     handoff written after the claim (the mtime rule from organism-infra/35).
//
// Criterion map:
//   1 skeleton on each rejection -> the "skeleton" tests below
//   2 release gate for non-blocked -> the "release --status ..." tests
//   3 tests cover both           -> this file
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, utimes } from "node:fs/promises";
import path from "node:path";
import { makeBoardFixture, runBoard, validStateJson } from "./board-fixture.mjs";
import { validateState } from "./schemas.mjs";

const REQUIRED = ["ticket", "current_step", "artifacts", "decisions", "failures", "pending"];

async function claim(fx, role, mode) {
  const args = ["claim", fx.ticketRelPath, role, ...(mode ? ["--mode", mode] : [])];
  const r = await runBoard(args, { cwd: fx.worktree });
  assert.equal(r.code, 0, r.stderr);
}

// organism-infra/78: drafts live beside the worktree; `board handoff` refuses one inside it.
async function scratchFile(fx, name, body) {
  const p = path.join(path.dirname(fx.worktree), name);
  await writeFile(p, body, "utf8");
  return p;
}

function skeletonFrom(r) {
  const out = `${r.stdout}\n${r.stderr}`;
  const m = /```json\s*([\s\S]*?)```/.exec(out);
  assert.ok(m, `expected a fenced json skeleton in output, got:\n${out}`);
  return JSON.parse(m[1]);
}

function assertSkeleton(sk, fx, role, mode) {
  for (const k of REQUIRED) assert.ok(k in sk, `skeleton missing "${k}"`);
  assert.equal(sk.ticket, fx.ticketRelPath);
  assert.equal(sk.role, role);
  if (mode) assert.equal(sk.mode, mode);
  else assert.ok(!("mode" in sk), "unmoded agent skeleton must not carry mode");
  assert.ok(Array.isArray(sk.pending));
  for (const p of sk.pending) {
    assert.equal(typeof p.item, "string");
    assert.equal(typeof p.owner, "string");
  }
  assert.equal(validateState(sk).ok, true);
}

async function writeHandoffFile(fx, filename, state, { ageMs = -60_000 } = {}) {
  const dir = path.join(fx.root, ".scratch", fx.feature, "handoffs");
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, filename);
  await writeFile(p, "```json\n" + JSON.stringify(state) + "\n```\n\n## Summary\n", "utf8");
  const t = new Date(Date.now() - ageMs);
  await utimes(p, t, t);
}

// --- Criterion 1: skeleton on each rejection ---

test("handoff naming the wrong ticket prints a skeleton with ticket, agent and mode (qa specify)", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "qa", "specify");
    const from = await scratchFile(
      fx,
      "01-qa.md",
      "```json\n" + JSON.stringify(validStateJson({ ticket: "other/99-nope" })) + "\n```\n"
    );
    const r = await runBoard(["handoff", fx.ticketRelPath, "--from", from], { cwd: fx.worktree });
    assert.notEqual(r.code, 0);
    assertSkeleton(skeletonFrom(r), fx, "qa", "specify");
  } finally {
    await fx.cleanup();
  }
});

test("handoff written as markdown instead of json prints a skeleton", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "designer");
    const from = await scratchFile(fx, "01-designer.md", "## State\n\n- ticket: sample/01-do-thing\n");
    const r = await runBoard(["handoff", fx.ticketRelPath, "--from", from], { cwd: fx.worktree });
    assert.notEqual(r.code, 0);
    assertSkeleton(skeletonFrom(r), fx, "designer");
  } finally {
    await fx.cleanup();
  }
});

test("release with a handoff missing required fields prints a skeleton (developer)", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "developer");
    await writeHandoffFile(fx, "01-developer.md", {
      ticket: fx.ticketRelPath,
      role: "developer",
      current_step: "done",
    });
    const r = await runBoard(["release", fx.ticketRelPath, "--status", "in-review"], { cwd: fx.worktree });
    assert.notEqual(r.code, 0);
    assertSkeleton(skeletonFrom(r), fx, "developer");
  } finally {
    await fx.cleanup();
  }
});

test("release with no handoff file prints a skeleton (qa verify carries mode)", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "qa", "verify");
    const r = await runBoard(["release", fx.ticketRelPath, "--status", "in-review"], { cwd: fx.worktree });
    assert.notEqual(r.code, 0);
    assertSkeleton(skeletonFrom(r), fx, "qa", "verify");
  } finally {
    await fx.cleanup();
  }
});

test("release --keep-status rejection also prints a skeleton", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "security");
    const r = await runBoard(["release", fx.ticketRelPath, "--keep-status"], { cwd: fx.worktree });
    assert.notEqual(r.code, 0);
    assertSkeleton(skeletonFrom(r), fx, "security");
  } finally {
    await fx.cleanup();
  }
});

test("a printed skeleton is accepted by `board handoff` unchanged (one-retry fix)", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "qa", "specify");
    const bad = await scratchFile(fx, "01-qa.md", "not json at all\n");
    const r = await runBoard(["handoff", fx.ticketRelPath, "--from", bad], { cwd: fx.worktree });
    assert.notEqual(r.code, 0);
    const sk = skeletonFrom(r);
    const good = await scratchFile(fx, "01-qa-retry.md", "```json\n" + JSON.stringify(sk) + "\n```\n");
    const r2 = await runBoard(["handoff", fx.ticketRelPath, "--from", good, "--name", "01-qa.md"], {
      cwd: fx.worktree,
    });
    assert.equal(r2.code, 0, r2.stderr);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 2: release gate for every status except blocked ---

for (const status of ["ready-for-human", "ready-for-agent", "claimed"]) {
  test(`release --status ${status} refuses with no handoff, keeping the claim`, async () => {
    const fx = await makeBoardFixture();
    try {
      await claim(fx, "developer");
      const before = await fx.readTicket();
      const r = await runBoard(["release", fx.ticketRelPath, "--status", status], { cwd: fx.worktree });
      assert.notEqual(r.code, 0);
      assert.match(`${r.stdout}${r.stderr}`, /handoff/i);
      assert.equal(await fx.readTicket(), before, "ticket must be untouched");
      const lock = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
      assert.notEqual(lock.code, 0, "claim lock must still be held");
    } finally {
      await fx.cleanup();
    }
  });
}

test("release --status ready-for-human refuses when the only handoff is older than the claim", async () => {
  const fx = await makeBoardFixture();
  try {
    await writeHandoffFile(
      fx,
      "01-developer.md",
      validStateJson({ ticket: fx.ticketRelPath, role: "developer" }),
      { ageMs: 3_600_000 }
    );
    await claim(fx, "developer");
    const r = await runBoard(["release", fx.ticketRelPath, "--status", "ready-for-human"], {
      cwd: fx.worktree,
    });
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}${r.stderr}`, /handoff/i);
  } finally {
    await fx.cleanup();
  }
});

test("release --status ready-for-human succeeds with a valid handoff newer than the claim", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "developer");
    await writeHandoffFile(
      fx,
      "01-developer.md",
      validStateJson({ ticket: fx.ticketRelPath, role: "developer" }),
      { ageMs: -60_000 }
    );
    const r = await runBoard(["release", fx.ticketRelPath, "--status", "ready-for-human"], {
      cwd: fx.worktree,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(await fx.readTicket(), /Status:\s*ready-for-human/);
  } finally {
    await fx.cleanup();
  }
});

test("release --status blocked still works without a handoff", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "developer");
    const r = await runBoard(
      ["release", fx.ticketRelPath, "--status", "blocked", "--reason", "waiting on user"],
      { cwd: fx.worktree }
    );
    assert.equal(r.code, 0, r.stderr);
    assert.match(await fx.readTicket(), /Status:\s*blocked/);
  } finally {
    await fx.cleanup();
  }
});
