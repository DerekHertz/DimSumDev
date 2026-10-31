// portable-den/09: the steps a developer's handoff offers docviz, and the checkout docviz is run in.
// Seam: readDiagramSteps(report) and createDocviz({ root, exec }).run(...) over a real temp git repository and a stub exec for docviz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDocviz, readDiagramSteps } from "./diagram.mjs";

const block = (steps) => "Done.\n\n## Diagram steps\n\n```json\n" + JSON.stringify({ steps }) + "\n```\n\n## Other\n";
const ok = { id: "a", label: "Adds x", changed: true, sources: [{ path: "src/x.mjs", from: "export", to: "// end" }] };

test("a valid Diagram steps block is read; anything else is null", () => {
  assert.deepEqual(readDiagramSteps(block([ok])), { steps: [ok] });
  assert.equal(readDiagramSteps("no section"), null);
  assert.equal(readDiagramSteps("## Diagram steps\n\nnot json"), null);
  const bad = (over) => readDiagramSteps(block([{ ...ok, ...over }]));
  for (const over of [{ id: "1x" }, { label: "" }, { sources: [] }, { sources: [{ path: "../etc/passwd" }] }, { sources: [{ path: "/etc/passwd" }] }, { sources: [{ path: "a/../../b" }] }, { sources: [{ path: ".env" }] }, { sources: [{ path: "k/id_rsa" }] }]) assert.equal(bad(over), null, JSON.stringify(over));
  assert.equal(readDiagramSteps(block([ok, ok])), null, "duplicate ids");
});

function checkout() {
  const dir = mkdtempSync(path.join(tmpdir(), "diagram-"));
  const git = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@e.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(path.join(dir, "x.mjs"), "export const x = 1;\n");
  writeFileSync(path.join(dir, "CONTEXT.md"), "terms\n");
  symlinkSync("/etc/hostname", path.join(dir, "out.mjs"));
  mkdirSync(path.join(dir, "node_modules", "playwright"), { recursive: true });
  writeFileSync(path.join(dir, "node_modules", "playwright", "index.js"), "throw new Error('planted');\n");
  git("add", "-f", "x.mjs", "CONTEXT.md", "out.mjs", "node_modules");
  git("commit", "-q", "-m", "c");
  return { dir, git, sha: git("rev-parse", "HEAD") };
}

const STEP = { id: "a", label: "x", sources: [{ path: "x.mjs" }] };
const PR = "https://github.com/o/r/pull/7";

// The checkout an agent worked in is untrusted: a planted .git file or node_modules there runs code on the host (portable-den/09 security).
// docviz therefore runs in a clean checkout the bridge makes of the candidate's commit, and that checkout is removed afterwards.
test("docviz runs in a clean checkout the bridge makes of the commit, with git's config pinned, and the checkout is removed", async () => {
  const { dir, git, sha } = checkout();
  const seen = [];
  const exec = async (file, args, options) => {
    if (file === "git") return { stdout: execFileSync(file, args, { encoding: "utf8" }) };
    seen.push({ file, args, cwd: options.cwd, env: options.env, files: readdirSync(options.cwd), gitIsFile: lstatSync(path.join(options.cwd, ".git")).isFile() });
    return { stdout: "<!-- docviz-pr-diagrams -->\nbody\n" };
  };
  const docviz = createDocviz({ root: dir, exec, env: { PATH: "", HOME: "/h" } });
  const run = (over = {}) => docviz.run({ sha, steps: [STEP], prUrl: PR, title: "t", ...over });
  assert.match(await run(), /^<!-- docviz-pr-diagrams -->/);
  const [call] = seen;
  assert.equal(call.file, "docviz");
  assert.deepEqual(call.args.slice(0, 1).concat(call.args.slice(2, 8)), ["pr", "--pr", PR, "--title", "t", "--glossary", call.args[7]]);
  assert.ok(call.args.at(-1).endsWith("CONTEXT.md") && call.args.at(-1).startsWith(call.cwd));
  assert.ok(call.cwd.startsWith(path.join(realpathSync(dir), ".claude", "worktrees") + path.sep), "a checkout the bridge made, not an agent's");
  assert.ok(call.files.includes("x.mjs") && !call.files.includes("node_modules"), "the committed node_modules is not carried into the run");
  assert.equal(call.gitIsFile, true);
  assert.equal(call.env.GIT_CONFIG_COUNT, "2");
  assert.deepEqual([call.env.GIT_CONFIG_KEY_0, call.env.GIT_CONFIG_VALUE_0, call.env.GIT_CONFIG_KEY_1, call.env.GIT_CONFIG_VALUE_1], ["core.fsmonitor", "", "core.hooksPath", "/dev/null"]);
  assert.equal(call.env.HOME, "/h");
  assert.equal(existsSync(call.cwd), false, "the checkout is removed after the run");
  assert.doesNotMatch(git("worktree", "list", "--porcelain"), /\.claude\/worktrees/);
  assert.equal(docviz.available(), false);
});

test("a step naming a symlink out of the checkout, or a commit the repository lacks, is refused and leaves no checkout behind", async () => {
  const { dir, git, sha } = checkout();
  const exec = async (file, args) => {
    if (file === "git") return { stdout: execFileSync(file, args, { encoding: "utf8" }) };
    return { stdout: "<!-- docviz-pr-diagrams -->\nbody\n" };
  };
  const docviz = createDocviz({ root: dir, exec, env: { PATH: "" } });
  await assert.rejects(docviz.run({ sha, steps: [{ id: "a", label: "x", sources: [{ path: "out.mjs" }] }], prUrl: PR, title: "t" }), /not a file of the checkout/);
  await assert.rejects(docviz.run({ sha: "0".repeat(40), steps: [STEP], prUrl: PR, title: "t" }), /commit/);
  assert.doesNotMatch(git("worktree", "list", "--porcelain"), /\.claude\/worktrees/);
});
