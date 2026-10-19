// den-mvp/28: the runtime sweeps the sandbox's placeholder files when the child exits, and the wall itself is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeStub } from "./claude-stub.mjs";
import { buildClaudeArgs, compileCeiling } from "./claude-adapter.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";
import { unconfinedLauncher } from "./launcher-test-helpers.mjs";

const gone = (p) => stat(p).then(() => false, () => true);

test("spawn's exit removes the placeholders the child's sandbox left, in the main .git and the worktree", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "den-ph-"));
  const git = path.join(dir, "main", ".git"), wt = path.join(dir, "wt");
  await mkdir(git, { recursive: true }); await mkdir(wt);
  const stale = path.join(git, "config.lock");
  await writeFile(stale, ""); await chmod(stale, 0o444);
  const inner = unconfinedLauncher();
  const made = [path.join(wt, ".bash_profile"), path.join(wt, ".zshrc")];
  const launcher = { ...inner, async launch(o) {
    for (const p of made) { await writeFile(p, ""); await chmod(p, 0o444); }
    return inner.launch(o);
  } };
  const stub = await makeStub({ mode: "crash" });
  const runtime = createClaudeRuntime({ controlRoot: "/", launcher, env: { PATH: process.env.PATH, HOME: process.env.HOME, DEN_CLAUDE_BIN: stub.bin } });
  const proc = await runtime.spawn({ role: "developer", cwd: wt, mainGit: git, prompt: "go", sessionId: "0b8f1c1e-5c1a-4c0e-9a55-3f2d9e7a4b10" });
  await proc.exited;
  for (const p of [...made, stale]) assert.ok(await gone(p), `${p} should be gone`);
});

test("the wall still denies the main .git config and refs for a writing role", () => {
  const c = compileCeiling("developer", { worktree: "/w/t", mainGit: "/m/.git" });
  const deny = JSON.stringify(c);
  for (const p of ["/m/.git/refs/**", "/m/.git/HEAD", "/m/.git/packed-refs", "/m/.git/index"]) assert.ok(deny.includes(p), `${p} denied`);
  assert.ok(buildClaudeArgs({ sessionId: "0b8f1c1e-5c1a-4c0e-9a55-3f2d9e7a4b10", agent: "developer", ...c }).includes("--settings"));
});
