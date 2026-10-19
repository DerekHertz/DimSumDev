// den-mvp/28: a walled run's sandbox leaves empty read-only placeholder files; the runtime removes the ones the run created.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { snapshotPlaceholders, sweepPlaceholders } from "./placeholders.mjs";

const gone = (p) => stat(p).then(() => false, () => true);
const empty = async (p) => { await writeFile(p, ""); await chmod(p, 0o444); };

test("removes new empty read-only placeholders, keeps pre-existing, non-empty and writable files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ph-"));
  const git = path.join(dir, ".git"), wt = path.join(dir, "wt");
  await mkdir(git); await mkdir(wt);
  await empty(path.join(git, "config.lock")); // stale in the main .git: swept
  await empty(path.join(wt, ".gitmodules")); // existed before in the worktree: left alone
  const snap = await snapshotPlaceholders({ mainGit: git, worktree: wt });
  await empty(path.join(wt, ".bash_profile"));
  await mkdir(path.join(wt, ".github")); await empty(path.join(wt, ".github", "CODEOWNERS"));
  await writeFile(path.join(wt, ".mcp.json"), "{}"); // real content
  await writeFile(path.join(wt, ".bashrc"), ""); // writable: not a placeholder
  await writeFile(path.join(git, "HEAD.lock"), ""); await chmod(path.join(git, "HEAD.lock"), 0o444); // not on the list
  await sweepPlaceholders(snap);
  assert.ok(await gone(path.join(git, "config.lock")));
  assert.ok(await gone(path.join(wt, ".github", "CODEOWNERS")));
  assert.ok(await gone(path.join(wt, ".bash_profile")));
  assert.ok(!(await gone(path.join(git, "HEAD.lock"))));
  assert.ok(!(await gone(path.join(wt, ".bashrc"))));
  assert.ok(!(await gone(path.join(wt, ".gitmodules"))));
  assert.ok(!(await gone(path.join(wt, ".mcp.json"))));
    await rm(dir, { recursive: true, force: true });
});
