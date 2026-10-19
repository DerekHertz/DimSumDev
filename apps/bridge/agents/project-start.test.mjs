// den-mvp/48 (ADR 0021 Amendment 5): the start path follows the project handle; the guide comes from the main checkout's HEAD.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { buildClaudeArgs, readProjectGuide } from "./claude-adapter.mjs";

const SID = "5d3c9a52-8f0e-4b7c-9a41-0e6f1c2b7d90";
const flag = (a, f) => a[a.indexOf(f) + 1];

describe("start path by project handle", () => {
  test("a control project keeps today's flags", () => {
    const plain = buildClaudeArgs({ sessionId: SID, agent: "developer" });
    const ctl = buildClaudeArgs({ sessionId: SID, agent: "developer", project: { control: true, root: "/home/u/den" } });
    assert.deepEqual(ctl, plain);
    assert.equal(flag(ctl, "--setting-sources"), "project,local");
    assert.equal(flag(ctl, "--agent"), "developer");
    assert.ok(!ctl.includes("--plugin-dir"));
  });
  test("a target gets empty setting sources, the control .claude as plugin dir, and den:<role>", () => {
    const a = buildClaudeArgs({ sessionId: SID, agent: "developer", project: { control: false, root: "/home/u/other", pluginDir: "/home/u/den/.claude" } });
    assert.equal(flag(a, "--setting-sources"), "");
    assert.equal(flag(a, "--plugin-dir"), "/home/u/den/.claude");
    assert.equal(flag(a, "--agent"), "den:developer");
  });
  test("a target without a plain pluginDir is refused", () => {
    assert.throws(() => buildClaudeArgs({ sessionId: SID, agent: "scout", project: { control: false, root: "/x" } }), /pluginDir/);
    assert.throws(() => buildClaudeArgs({ sessionId: SID, agent: "scout", project: { control: false, root: "/x", pluginDir: "../.claude" } }), /pluginDir/);
    assert.throws(() => buildClaudeArgs({ sessionId: SID, agent: "scout", project: { root: "/x" } }), /project must be/);
  });
});

describe("readProjectGuide", () => {
  const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" });
  test("reads the committed HEAD, not an uncommitted edit", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "guide-"));
    try {
      git(dir, "init", "-q");
      writeFileSync(path.join(dir, "AGENTS.md"), "committed agents");
      git(dir, "add", "AGENTS.md");
      git(dir, "commit", "-qm", "x");
      writeFileSync(path.join(dir, "AGENTS.md"), "edited");
      writeFileSync(path.join(dir, "CLAUDE.md"), "untracked claude");
      assert.deepEqual(readProjectGuide(dir), { file: "AGENTS.md", text: "committed agents" });
      git(dir, "add", "CLAUDE.md");
      git(dir, "commit", "-qm", "y");
      assert.deepEqual(readProjectGuide(dir), { file: "CLAUDE.md", text: "untracked claude" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("no guide at HEAD is null; a bad root throws", () => {
    assert.equal(readProjectGuide("/x", { exec: () => { throw new Error("no"); } }), null);
    assert.throws(() => readProjectGuide("rel"), /root/);
  });
});
