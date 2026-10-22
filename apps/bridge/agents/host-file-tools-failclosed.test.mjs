// hardening/01, the two cases beyond qa's map: NotebookEdit outside the worktree is denied, and a file tool whose request
// carries no usable path is denied (the rule fails closed). At the host seam, as host-file-tools-outside.test.mjs does.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeBridge, until } from "./host-test-helpers.mjs";
import { fileToolRefusal } from "./claude-adapter.mjs";

let t;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function answerTo(tool, input, requestId) {
  t = await makeBridge();
  const res = await t.post("/tasks", { role: "developer", text: "Tidy the notes." });
  assert.equal(res.status, 201, res.text);
  const rec = t.fake.spawns[0];
  rec.emit({ type: "permission-request", requestId, tool, input });
  const decision = await until(() => rec.decisions.find((d) => d.requestId === requestId), { what: "the host's answer" });
  return { decision, rec, cwd: rec.args.cwd };
}

test("NotebookEdit outside the worktree is denied by the host", async () => {
  const { decision } = await answerTo("NotebookEdit", { notebook_path: "/etc/nb.ipynb", new_source: "x" }, "nb-1");
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /outside the worktree/);
});

test("a Read, Write, Edit or NotebookEdit with no usable path is denied, not asked", async () => {
  for (const [tool, input] of [["Read", {}], ["Write", { file_path: 7 }], ["Edit", { file_path: "" }], ["NotebookEdit", { file_path: "/x" }]]) {
    const { decision } = await answerTo(tool, input, `nopath-${tool}`);
    assert.equal(decision.allow, false, tool);
    assert.match(decision.reason, /plain file path/, tool);
    assert.deepEqual(((await t.state()).approvals ?? []).filter((a) => a.state === "pending"), [], `${tool} not held`);
    await t.close();
    t = undefined;
  }
});

test("fileToolRefusal: other tools are not its to answer, and a NotebookEdit inside the worktree passes", () => {
  const worktree = "/w/tree";
  assert.equal(fileToolRefusal({ tool: "Bash", input: { command: "cat /etc/passwd" }, worktree }), null);
  assert.equal(fileToolRefusal({ tool: "mcp__docs__find", input: { file_path: "/etc/passwd" }, worktree }), null);
  assert.equal(fileToolRefusal({ tool: "NotebookEdit", input: { notebook_path: "a/b.ipynb" }, worktree }), null);
  assert.equal(fileToolRefusal({ tool: "Read", input: { file_path: "/w/tree-evil/x" }, worktree }) === null, false);
  assert.equal(fileToolRefusal({ tool: "constructor", input: {}, worktree }), null);
});
