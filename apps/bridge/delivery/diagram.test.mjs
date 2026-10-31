// portable-den/09: the steps a developer's handoff offers docviz, and the checkout docviz is run in.
// Seam: readDiagramSteps(report) and createDocviz({ root, exec }).run(...) over a real temp git repository and a stub exec for docviz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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
  git("add", "x.mjs", "CONTEXT.md", "out.mjs");
  git("commit", "-q", "-m", "c");
  return { dir, sha: git("rev-parse", "HEAD") };
}

test("docviz runs in the candidate's checkout with the steps file and CONTEXT.md; a symlink out, or another commit, is refused", async () => {
  const { dir, sha } = checkout();
  const seen = [];
  const exec = async (file, args, options) => {
    if (file === "git") return { stdout: execFileSync(file, args, { encoding: "utf8" }) };
    seen.push({ file, args, cwd: options.cwd });
    return { stdout: "<!-- docviz-pr-diagrams -->\nbody\n" };
  };
  const docviz = createDocviz({ root: path.dirname(dir), exec, env: { PATH: "" } });
  const run = (over = {}) => docviz.run({ worktree: path.basename(dir), sha, steps: [{ id: "a", label: "x", sources: [{ path: "x.mjs" }] }], prUrl: "https://github.com/o/r/pull/7", title: "t", ...over });
  assert.match(await run(), /^<!-- docviz-pr-diagrams -->/);
  assert.equal(seen[0].file, "docviz");
  assert.equal(seen[0].args[0], "pr");
  assert.deepEqual(seen[0].args.slice(2, 8), ["--pr", "https://github.com/o/r/pull/7", "--title", "t", "--glossary", seen[0].args[7]]);
  assert.ok(seen[0].args.at(-1).endsWith("CONTEXT.md"));
  assert.equal(docviz.available(), false);
  await assert.rejects(run({ steps: [{ id: "a", label: "x", sources: [{ path: "out.mjs" }] }] }), /not a file of the checkout/);
  await assert.rejects(run({ sha: "0".repeat(40) }), /not at the commit/);
});
