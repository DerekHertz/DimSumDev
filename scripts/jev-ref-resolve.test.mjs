// organism-infra/126: jev.mjs (tier, route, advisory-outcome) resolves a short ref
// <feature>/<NN> to the full <feature>/<NN-slug> ref, and finds the main checkout from a
// worktree. $DEN_ROOT still wins. An ambiguous or missing NN refuses and logs nothing.
// Seam: the jev CLI run for real from a linked worktree of a throwaway repo. No API key is
// set, so jev takes its fallback path and nothing touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { makeBoardFixture, REPO_ROOT } from "../apps/board/board-fixture.mjs";

const JEV = path.join(REPO_ROOT, "scripts", "jev.mjs");
const usagePath = (root) => path.join(root, ".scratch", "usage.jsonl");
const rows = (root) => readFileSync(usagePath(root), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ticketText = (name) => `# ${name}\n\n**Type:** feature\n\n**Priority:** P2\n\n**Status:** ready-for-agent\n\n## What to build\n\nA thing.\n`;

const POINTS = {
  tier: (ref) => ["tier", "--ticket", ref],
  route: (ref) => ["route", "--ticket", ref],
  "advisory-outcome": (ref) => ["advisory-outcome", "--ticket", ref, "--orchestrator", "qa-specify", "--jev", "none", "--user", "qa-specify", "--bounced", "false"],
};

// cwd is where the process runs; root sets $DEN_ROOT, and null leaves it unset.
function jev(cwd, root, argv) {
  const env = { ...process.env };
  delete env.DEN_ROOT;
  delete env.TYPESAFE_API_KEY;
  if (root) env.DEN_ROOT = root;
  return spawnSync(process.execPath, [JEV, ...argv], { cwd, env, encoding: "utf8", timeout: 20000 });
}

async function withFx(fn, opts = {}) {
  const fx = await makeBoardFixture({ ticket: "126-relay-thing", content: ticketText("126-relay-thing"), ...opts });
  try {
    await fn(fx);
  } finally {
    await fx.cleanup();
  }
}

const lastRow = (root) => rows(root).at(-1);

for (const [point, build] of Object.entries(POINTS)) {
  test(`126 criterion 2: ${point} resolves a short ref to the full slug ref, run from a worktree`, () =>
    withFx(async (fx) => {
      const r = jev(fx.worktree, null, build(`${fx.feature}/126`));
      assert.equal(r.status, 0, r.stderr);
      assert.equal(lastRow(fx.root).ticket, fx.ticketRelPath, "the usage row carries the full ref");
      assert.equal(JSON.parse(r.stdout.trim().split("\n").at(-1)).ticket, fx.ticketRelPath);
      assert.equal(existsSync(usagePath(fx.worktree)), false, "nothing is written into the worktree's own .scratch");
    }));

  test(`126 criterion 2: ${point} still takes a full slug ref`, () =>
    withFx(async (fx) => {
      const r = jev(fx.worktree, null, build(fx.ticketRelPath));
      assert.equal(r.status, 0, r.stderr);
      assert.equal(lastRow(fx.root).ticket, fx.ticketRelPath);
    }));

  test(`126 criterion 2: ${point} refuses a short ref with no matching ticket and logs nothing`, () =>
    withFx(async (fx) => {
      const r = jev(fx.worktree, null, build(`${fx.feature}/99`));
      assert.notEqual(r.status, 0);
      assert.notEqual(r.stderr.trim(), "");
      assert.equal(existsSync(usagePath(fx.root)), false);
    }));

  test(`126 criterion 2: ${point} refuses an ambiguous short ref and logs nothing`, () =>
    withFx(async (fx) => {
      await writeFile(path.join(fx.root, ".scratch", fx.feature, "issues", "126-second-thing.md"), ticketText("126-second-thing"));
      const r = jev(fx.worktree, null, build(`${fx.feature}/126`));
      assert.notEqual(r.status, 0);
      assert.notEqual(r.stderr.trim(), "");
      assert.equal(existsSync(usagePath(fx.root)), false);
    }));

  test(`126 criterion 2: ${point} does not match a shorter NN against a longer one (12 is not 126)`, () =>
    withFx(async (fx) => {
      const r = jev(fx.worktree, null, build(`${fx.feature}/12`));
      assert.notEqual(r.status, 0);
      assert.equal(existsSync(usagePath(fx.root)), false);
    }));

  test(`126 criterion 3: ${point} lets $DEN_ROOT override the git-derived root`, () =>
    withFx(async (a) =>
      withFx(async (b) => {
        // b holds the board named by $DEN_ROOT; the cwd sits in a's worktree, whose main checkout is a.
        const r = jev(a.worktree, b.root, build(b.ticketRelPath));
        assert.equal(r.status, 0, r.stderr);
        assert.equal(lastRow(b.root).ticket, b.ticketRelPath);
        assert.equal(existsSync(usagePath(a.root)), false, "the cwd's own main checkout is left alone");
      })));
}
