// team-and-den-ux/02 (ADR 0029): the four new roles can be dispatched from the den and the terminal, under the wall.
//   criterion 4 (dispatchable from the den and the router, under the wall and resource limits) -> every test below
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeBoardFixture, runBoard, eventsPath } from "./board-fixture.mjs";
import { isBoardRole } from "./board-service.mjs";
import { DESK_ROLE, ROLES, SESSION_CAP, SLOT_CLASSES, definitionOf, slotClassOf } from "../bridge/agents/policy.mjs";
import { buildClaudeArgs, ceilingOf } from "../bridge/agents/claude-adapter.mjs";
import { SPECIALISTS } from "../bridge/meetings/types.mjs";

const NEW = ["code-reviewer", "release-manager", "sre", "technical-writer"];
const json = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
// Every role definition the bridge may start: runner is a leaf that only agents start (ADR 0029 decision 1).
const DEFINED = readdirSync(fileURLToPath(new URL("../../.claude/agents/", import.meta.url))).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).filter((r) => r !== "runner");

test("every role definition the bridge may start is in its role table, has a ceiling, and the board can hold it", () => {
  // team-and-den-ux/19: the role table is the role files plus Bao's desk key, which has no file of its own.
  assert.deepEqual([...ROLES].sort(), [...DEFINED, DESK_ROLE].sort());
  for (const role of ROLES) {
    assert.ok(ceilingOf(role), `${role} has no ceiling in ceilings.json`);
    assert.ok(isBoardRole(role), `the board cannot hold a ticket for ${role}`);
  }
});

// team-and-den-ux/19 criterion 1: orchestrator, herald and scout are retired as dispatchable roles.
test("orchestrator, herald and scout have no role file, are not dispatchable, and the scout slot is gone", () => {
  for (const role of ["orchestrator", "herald", "scout"]) assert.ok(!DEFINED.includes(role), `.claude/agents/${role}.md still exists`);
  for (const role of ["herald", "scout"]) {
    assert.ok(!ROLES.includes(role), `${role} is still in the bridge's role table`);
    assert.ok(!SPECIALISTS.includes(role), `${role} still takes a meeting seat`);
    assert.throws(() => buildClaudeArgs({ sessionId: "00000000-0000-4000-8000-000000000000", agent: role }));
  }
  assert.deepEqual(SLOT_CLASSES, ["worker", "bao"]);
  assert.equal(SESSION_CAP, 3);
  assert.deepEqual(Object.keys(json("../bridge/agents/limits.json").classes).sort(), ["bao", "worker"]);
  const connections = json("../bridge/library/connections.json").connections;
  for (const c of connections) assert.ok(!c.roles.includes("scout") && !c.roles.includes("herald"), c.name);
});

test("Bao's desk key runs the chief of staff's definition on Bao's slot", () => {
  assert.equal(definitionOf(DESK_ROLE), "chief-of-staff");
  assert.equal(slotClassOf(DESK_ROLE), "bao");
  const args = buildClaudeArgs({ sessionId: "00000000-0000-4000-8000-000000000000", agent: DESK_ROLE });
  assert.equal(args[args.indexOf("--agent") + 1], "chief-of-staff");
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

// Reviews run in parallel but a ticket has one claim lock: a reviewer's counted verdict
// must not depend on who happens to hold it.
test("on an in-review ticket, a reviewer's verdict counts while another reviewer holds the lock", async () => {
  const fx = await makeBoardFixture({ status: "in-review" });
  try {
    const claim = await runBoard(["claim", fx.ticketRelPath, "security"], { cwd: fx.worktree });
    assert.equal(claim.code, 0, claim.stderr);
    for (const role of ["code-reviewer", "qa"]) {
      const verdict = await runBoard(["comment", fx.ticketRelPath, "--as", role, "--verdict", "pass", "ok at abc123"], { cwd: fx.worktree });
      assert.equal(verdict.code, 0, verdict.stderr);
    }
    const rows = readFileSync(eventsPath(fx.root), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    for (const role of ["code-reviewer", "qa"]) {
      assert.ok(rows.some((e) => e.op === "comment" && e.verdict === "pass" && e.role === role), role);
    }
    const dev = await runBoard(["comment", fx.ticketRelPath, "--as", "developer", "--verdict", "pass", "self"], { cwd: fx.worktree });
    assert.notEqual(dev.code, 0, "a non-reviewer still cannot sign past the lock");
  } finally {
    await fx.cleanup();
  }
});

test("a qa lock held in specify mode still cannot post a counted qa verdict on an in-review ticket", async () => {
  const fx = await makeBoardFixture({ status: "in-review" });
  try {
    const claim = await runBoard(["claim", fx.ticketRelPath, "qa", "--mode", "specify"], { cwd: fx.worktree });
    assert.equal(claim.code, 0, claim.stderr);
    const verdict = await runBoard(["comment", fx.ticketRelPath, "--as", "qa", "--verdict", "pass", "spec ok"], { cwd: fx.worktree });
    assert.notEqual(verdict.code, 0);
  } finally {
    await fx.cleanup();
  }
});

test("before in-review, a reviewer cannot sign past another role's lock", async () => {
  const fx = await makeBoardFixture();
  try {
    const claim = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree });
    assert.equal(claim.code, 0, claim.stderr);
    const verdict = await runBoard(["comment", fx.ticketRelPath, "--as", "code-reviewer", "--verdict", "pass", "early"], { cwd: fx.worktree });
    assert.notEqual(verdict.code, 0);
  } finally {
    await fx.cleanup();
  }
});

test("board resolve works with no orchestrator role: the chief of staff claims and resolves (team-and-den-ux/57)", async () => {
  const fx = await makeBoardFixture();
  try {
    const claim = await runBoard(["claim", fx.ticketRelPath, "chief-of-staff"], { cwd: fx.worktree });
    assert.equal(claim.code, 0, claim.stderr);
    const released = await runBoard(["release", fx.ticketRelPath, "--status", "in-review", "--force", "--reason", "fixture has no handoff"], { cwd: fx.worktree });
    assert.equal(released.code, 0, released.stderr);
    const resolved = await runBoard(["resolve", fx.ticketRelPath, "--pr", "1"], { cwd: fx.worktree });
    assert.equal(resolved.code, 0, resolved.stderr);
    const rows = readFileSync(eventsPath(fx.root), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.some((e) => e.op === "resolve" || e.to_status === "resolved"), JSON.stringify(rows.at(-1)));
  } finally {
    await fx.cleanup();
  }
});
