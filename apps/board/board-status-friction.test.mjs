// organism-infra/55: status friction after qa specify and for designer verdicts.
// See .scratch/organism-infra/issues/55-board-status-friction.md.
//
// Pinned behavior:
//  - a qa `specify` claim followed by `release --keep-status` restores the
//    status the ticket had before the claim (ready-for-agent, or blocked for a
//    fix-round on a blocked ticket), not `claimed`;
//  - a designer claim accepts --mode review|spec|critique|direction, and
//    `comment --verdict pass|bounce` is accepted from a designer review claim
//    and recorded in the events log where the snapshot reads verdicts;
//  - the same role/mode may republish its own handoff under the same name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeBoardFixture, runBoard, writeValidHandoff } from "./board-fixture.mjs";

async function statusOf(fx) {
  const r = await runBoard(["status", fx.ticketRelPath], { cwd: fx.worktree });
  assert.equal(r.code, 0, r.stderr);
  return r.stdout.trim();
}

async function events(fx) {
  const raw = await readFile(fx.eventsPath, "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

for (const prior of ["ready-for-agent", "blocked"]) {
  test(`qa specify claim then --keep-status release returns a ${prior} ticket to ${prior}`, async () => {
    const fx = await makeBoardFixture({ status: prior });
    try {
      const c = await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "specify"], { cwd: fx.worktree });
      assert.equal(c.code, 0, c.stderr);
      assert.match(await statusOf(fx), /claimed/, "status is claimed while the lock is held");

      await writeValidHandoff(fx);
      const r = await runBoard(["release", fx.ticketRelPath, "--keep-status"], { cwd: fx.worktree });
      assert.equal(r.code, 0, r.stderr);
      assert.match(await fx.readTicket(), new RegExp(`^Status: ${prior}$`, "m"));
      assert.match(await statusOf(fx), new RegExp(prior));

      const rel = (await events(fx)).filter((e) => e.op === "release").at(-1);
      assert.equal(rel.to_status, prior, "the release event records the restored status");
    } finally {
      await fx.cleanup();
    }
  });
}

test("qa specify claim then an explicit --status blocked release still sets blocked", async () => {
  const fx = await makeBoardFixture();
  try {
    const c = await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "specify"], { cwd: fx.worktree });
    assert.equal(c.code, 0, c.stderr);
    const r = await runBoard(["release", fx.ticketRelPath, "--status", "blocked", "--reason", "need answer"], {
      cwd: fx.worktree,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(await fx.readTicket(), /^Status: blocked$/m);
  } finally {
    await fx.cleanup();
  }
});

for (const mode of ["review", "spec", "critique", "direction"]) {
  test(`a designer claim accepts --mode ${mode}`, async () => {
    const fx = await makeBoardFixture();
    try {
      const c = await runBoard(["claim", fx.ticketRelPath, "designer", "--mode", mode], { cwd: fx.worktree });
      assert.equal(c.code, 0, c.stderr);
      assert.match(await fx.readTicket(), /^Status: claimed$/m);
    } finally {
      await fx.cleanup();
    }
  });
}

for (const verdict of ["pass", "bounce"]) {
  test(`a designer review claim can post --verdict ${verdict}, recorded for the snapshot`, async () => {
    const fx = await makeBoardFixture({ status: "in-review" });
    try {
      const c = await runBoard(["claim", fx.ticketRelPath, "designer", "--mode", "review"], { cwd: fx.worktree });
      assert.equal(c.code, 0, c.stderr);
      const r = await runBoard(["comment", fx.ticketRelPath, "--verdict", verdict, "design review"], {
        cwd: fx.worktree,
      });
      assert.equal(r.code, 0, r.stderr);
      const row = (await events(fx)).filter((e) => e.op === "comment").at(-1);
      assert.equal(row.role, "designer");
      assert.equal(row.verdict, verdict);
    } finally {
      await fx.cleanup();
    }
  });
}

test("a designer --verdict without a claim lock is still rejected", async () => {
  const fx = await makeBoardFixture({ status: "in-review" });
  try {
    const r = await runBoard(["comment", fx.ticketRelPath, "--as", "designer", "--verdict", "pass", "x"], {
      cwd: fx.worktree,
    });
    assert.notEqual(r.code, 0);
  } finally {
    await fx.cleanup();
  }
});

test("the same agent and mode can republish its own handoff under the same name after release", async () => {
  const fx = await makeBoardFixture();
  try {
    const c = await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "specify"], { cwd: fx.worktree });
    assert.equal(c.code, 0, c.stderr);
    const state = (extra) =>
      "```json\n" +
      JSON.stringify({
        ticket: fx.ticketRelPath,
        role: "qa",
        mode: "specify",
        current_step: extra,
        artifacts: [],
        decisions: [],
        failures: [],
        pending: [],
      }) +
      "\n```\n\n## Summary\n\n" +
      extra +
      "\n";
    const { writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const src = path.join(fx.worktree, "..", "draft.md");
    await writeFile(src, state("first"));
    const a = await runBoard(["handoff", fx.ticketRelPath, "--from", src, "--name", "01-qa-specify.md"], {
      cwd: fx.worktree,
    });
    assert.equal(a.code, 0, a.stderr);
    await runBoard(["release", fx.ticketRelPath, "--keep-status"], { cwd: fx.worktree });
    await writeFile(src, state("second"));
    const b = await runBoard(["handoff", fx.ticketRelPath, "--from", src, "--name", "01-qa-specify.md"], {
      cwd: fx.worktree,
    });
    assert.equal(b.code, 0, b.stderr);
  } finally {
    await fx.cleanup();
  }
});
