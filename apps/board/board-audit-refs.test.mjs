// organism-infra/81: `board audit` stays quiet on the board's normal shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { makeBoardFixture, runBoard, validStateJson } from "./board-fixture.mjs";

const NO_ROOT = { DEN_ROOT: "" };
const audit = (fx) => runBoard(["audit"], { cwd: fx.worktree, env: NO_ROOT });

async function seedHandoff(fx, name, state) {
  const dir = path.join(fx.root, ".scratch", fx.feature, "handoffs");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), "```json\n" + JSON.stringify(state) + "\n```\n", "utf8");
}

test("a pending item naming the handoff's own ticket is not an orphan", async () => {
  const fx = await makeBoardFixture({ status: "resolved" });
  try {
    await seedHandoff(
      fx,
      "01-security.md",
      validStateJson({
        ticket: fx.ticketRelPath,
        role: "security",
        pending: [{ item: `propose merge of ${fx.feature}/01`, owner: "orchestrator" }],
      })
    );
    const r = await audit(fx);
    assert.equal(r.code, 0, r.stdout);
  } finally {
    await fx.cleanup();
  }
});

for (const value of ["None (07 resolved)", "at least 15 risk-check-clean tickets", "jg trial verdict (ADR 0014 decision 8)"]) {
  test(`free-text Blocked by "${value}" yields no finding`, async () => {
    const fx = await makeBoardFixture();
    try {
      await writeFile(
        fx.ticketPath,
        `# ${fx.ticket}\n\n**Blocked by:** ${value}\n\n**Status:** ready-for-agent\n\n## Comments\n`,
        "utf8"
      );
      const r = await audit(fx);
      assert.equal(r.code, 0, r.stdout);
    } finally {
      await fx.cleanup();
    }
  });
}

test("a lock is backed by a branch its ticket's handoff names", async () => {
  const fx = await makeBoardFixture();
  try {
    const claim = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree, env: NO_ROOT });
    assert.equal(claim.code, 0, claim.stderr);
    execFileSync("git", ["branch", "feat/batch-x"], { cwd: fx.root });
    const before = await audit(fx);
    assert.match(before.stdout, /no-branch/);
    await seedHandoff(fx, "01-developer.md", validStateJson({ ticket: fx.ticketRelPath, role: "developer", current_step: "on feat/batch-x" }));
    const after = await audit(fx);
    assert.equal(after.code, 0, after.stdout);
  } finally {
    await fx.cleanup();
  }
});
