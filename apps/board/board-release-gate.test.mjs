// Acceptance tests for organism-infra/35: release events record --force, and
// the handoff gate only accepts a handoff from the releasing agent.
//
// Pinned contract (QA's reading of the ticket; the developer must follow it):
//   - every op:"release" event carries `force: true|false` (boolean). The
//     separate kind:"override" event (ticket 18) is unchanged.
//   - a handoff State block names its author with `role` (`cell` before ADR 0028; and `mode` for
//     moded agents, e.g. qa). The gate accepts only a handoff whose `role`
//     equals the claim's agent and, when the claim has a mode, whose `mode`
//     equals it.
//   - the handoff must be newer than the current claim (file mtime >= the
//     claim lock's mtime), so a stale earlier handoff never satisfies it.
//
// Criterion map:
//   1 force recorded            -> "release events record force ..." (3 tests)
//   2 no handoff fails          -> "... no handoff file ... fails without --force"
//   3 role/mode/age binding     -> the four "gate accepts only ..." tests
//   4 34 case explained         -> human-verified (a comment on the ticket)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, utimes } from "node:fs/promises";
import path from "node:path";
import { makeBoardFixture, runBoard, eventsPath, validStateJson } from "./board-fixture.mjs";

async function writeHandoff(fx, filename, overrides = {}) {
  const dir = path.join(fx.root, ".scratch", fx.feature, "handoffs");
  await mkdir(dir, { recursive: true });
  const state = validStateJson({ ticket: `${fx.feature}/${fx.ticket}`, ...overrides });
  const p = path.join(dir, filename);
  await writeFile(p, "```json\n" + JSON.stringify(state) + "\n```\n\n## Summary\n", "utf8");
  return p;
}

async function readEvents(root) {
  const raw = await readFile(eventsPath(root), "utf8").catch(() => "");
  return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function claim(fx, role, mode) {
  const args = ["claim", fx.ticketRelPath, role, ...(mode ? ["--mode", mode] : [])];
  const r = await runBoard(args, { cwd: fx.worktree });
  assert.equal(r.code, 0, r.stderr);
}

const release = (fx, ...extra) =>
  runBoard(["release", fx.ticketRelPath, ...extra], { cwd: fx.worktree });

const releaseEvents = (events) => events.filter((e) => e.op === "release" && e.kind !== "override");

// --- Criterion 1 ---

test("release events record force:false on a normal gated release", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "developer");
    await writeHandoff(fx, "01-developer.md", { role: "developer" });
    const r = await release(fx, "--status", "in-review");
    assert.equal(r.code, 0, r.stderr);
    const evs = releaseEvents(await readEvents(fx.root));
    assert.equal(evs.length, 1);
    assert.strictEqual(evs[0].force, false);
  } finally {
    await fx.cleanup();
  }
});

test("release events record force:true when --force bypassed the gate", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "developer");
    const r = await release(fx, "--status", "in-review", "--force", "--reason", "test bypass");
    assert.equal(r.code, 0, r.stderr);
    const evs = releaseEvents(await readEvents(fx.root));
    assert.equal(evs.length, 1);
    assert.strictEqual(evs[0].force, true);
  } finally {
    await fx.cleanup();
  }
});

test("release events record force:false on an ungated release (--status blocked)", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "developer");
    const r = await release(fx, "--status", "blocked");
    assert.equal(r.code, 0, r.stderr);
    const evs = releaseEvents(await readEvents(fx.root));
    assert.equal(evs.length, 1);
    assert.strictEqual(evs[0].force, false);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 2 ---

test("release to in-review with no handoff file fails without --force and leaves the claim", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "developer");
    const before = await fx.readTicket();
    const r = await release(fx, "--status", "in-review");
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /handoff/);
    assert.equal(await fx.readTicket(), before);
    assert.equal(releaseEvents(await readEvents(fx.root)).length, 0, "no release event on refusal");
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 3 ---

test("gate accepts only the releasing agent's handoff: another agent's handoff for the same ticket does not satisfy it", async () => {
  const fx = await makeBoardFixture();
  try {
    // The ticket-34 case: qa's specify handoff exists before the developer releases.
    await writeHandoff(fx, "01-qa-specify.md", { role: "qa", mode: "specify" });
    await claim(fx, "developer");
    const before = await fx.readTicket();
    const r = await release(fx, "--status", "in-review");
    assert.notEqual(r.code, 0, "developer release must not pass on qa's handoff");
    assert.equal(await fx.readTicket(), before);
  } finally {
    await fx.cleanup();
  }
});

test("gate requires the mode to match for moded agents: a qa specify handoff does not satisfy a qa verify release", async () => {
  const fx = await makeBoardFixture({ status: "in-review" });
  try {
    await claim(fx, "qa", "verify");
    await writeHandoff(fx, "01-qa-specify.md", { role: "qa", mode: "specify" });
    const r = await release(fx, "--status", "in-review");
    assert.notEqual(r.code, 0, "verify release must not pass on a specify-mode handoff");
  } finally {
    await fx.cleanup();
  }
});

test("gate accepts a handoff from the releasing agent (and mode) written after the claim", async () => {
  const fx = await makeBoardFixture({ status: "in-review" });
  try {
    await claim(fx, "qa", "verify");
    await writeHandoff(fx, "01-qa-verify.md", { role: "qa", mode: "verify" });
    const r = await release(fx, "--status", "in-review");
    assert.equal(r.code, 0, r.stderr);
  } finally {
    await fx.cleanup();
  }
});

test("gate rejects a handoff from the releasing agent that predates the current claim", async () => {
  const fx = await makeBoardFixture();
  try {
    const p = await writeHandoff(fx, "01-developer.md", { role: "developer" });
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(p, past, past);
    await claim(fx, "developer");
    const before = await fx.readTicket();
    const r = await release(fx, "--status", "in-review");
    assert.notEqual(r.code, 0, "a handoff older than the claim is from a previous run");
    assert.equal(await fx.readTicket(), before);
  } finally {
    await fx.cleanup();
  }
});
