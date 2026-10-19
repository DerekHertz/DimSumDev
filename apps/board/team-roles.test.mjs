// team-and-den-ux/02 (ADR 0029): the four new roles can be dispatched from the den and the terminal, under the wall.
//   criterion 4 (dispatchable from the den and the router, under the wall and resource limits) -> every test below
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeBoardFixture, runBoard, eventsPath } from "./board-fixture.mjs";
import { isBoardRole } from "./board-service.mjs";
import { ROLES, slotClassOf } from "../bridge/agents/policy.mjs";
import { ceilingOf } from "../bridge/agents/claude-adapter.mjs";

const NEW = ["code-reviewer", "release-manager", "sre", "technical-writer"];
const json = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
// Every role definition the bridge may start: runner is a leaf that only agents start (ADR 0029 decision 1).
const DEFINED = readdirSync(fileURLToPath(new URL("../../.claude/agents/", import.meta.url))).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).filter((r) => r !== "runner");

test("every role definition the bridge may start is in its role table, has a ceiling, and the board can hold it", () => {
  assert.deepEqual([...ROLES].sort(), [...DEFINED].sort());
  for (const role of DEFINED) {
    assert.ok(ceilingOf(role), `${role} has no ceiling in ceilings.json`);
    // herald runs unclaimed: the board keeps no handoffs for it (apps/bridge/server.mjs), and it retires in team-and-den-ux/19.
    if (role !== "herald") assert.ok(isBoardRole(role), `the board cannot hold a ticket for ${role}`);
  }
});

test("the new roles run on the worker slot and its resource limits, write only in their worktree, and reach no host", () => {
  const ceilings = json("../bridge/agents/ceilings.json");
  const limits = json("../bridge/agents/limits.json");
  for (const role of NEW) {
    assert.equal(slotClassOf(role), "worker", role);
    assert.ok(limits.classes.worker, "limits.json has a worker class");
    assert.deepEqual(ceilings[role], { write: "worktree", hosts: [] }, role);
  }
});

test("the code reviewer claims a ticket on the board and its verdict counts", async () => {
  const fx = await makeBoardFixture();
  try {
    const claim = await runBoard(["claim", fx.ticketRelPath, "code-reviewer"], { cwd: fx.worktree });
    assert.equal(claim.code, 0, claim.stderr);
    const verdict = await runBoard(["comment", fx.ticketRelPath, "--verdict", "bounce", "the helper is duplicated"], { cwd: fx.worktree });
    assert.equal(verdict.code, 0, verdict.stderr);
    const rows = readFileSync(eventsPath(fx.root), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.some((e) => e.op === "comment" && e.verdict === "bounce" && e.role === "code-reviewer"), JSON.stringify(rows.at(-1)));
  } finally {
    await fx.cleanup();
  }
});
