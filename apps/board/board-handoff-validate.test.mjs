// Acceptance tests for organism-infra/51 (board side): `board handoff` validates
// the State block at publish time.
//
// Criterion map:
//   1 invalid State refused, nothing written, stderr = problems + example
//                                   -> "refuses ..." tests
//   2 valid block publishes         -> "publishes a valid State block" test
//   scope (a) fill role/mode from the claim lock; no JSON block rejected
//                                   -> "fills role/mode ...", "rejects a file with no JSON State block"
//   scope (b) lock holder overwrites its own earlier draft
//                                   -> "lock holder may overwrite ..." tests
//   3 agent-start existing branch    -> scripts/agent-start.existing-branch.test.mjs
//   4 log-agent handoff check        -> scripts/log-agent-handoff.test.mjs
//   scope (c) usage.mjs 401 hint    -> scripts/usage-401.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, readdir, utimes } from "node:fs/promises";
import path from "node:path";
import { makeBoardFixture, runBoard, validStateJson } from "./board-fixture.mjs";

const NO_ROOT = { DEN_ROOT: "" };
const handoffsDir = (fx) => path.join(fx.root, ".scratch", fx.feature, "handoffs");
const listHandoffs = (fx) => readdir(handoffsDir(fx)).catch(() => []);

// organism-infra/78: drafts live beside the worktree; `board handoff` refuses one inside it.
async function draft(fx, filename, state, { raw } = {}) {
  const dir = path.join(path.dirname(fx.worktree), ".local-handoffs");
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, filename);
  await writeFile(p, raw ?? "```json\n" + JSON.stringify(state) + "\n```\n\n## Summary\n\nx\n", "utf8");
  return p;
}
const publish = (fx, src, name = "01-developer.md") =>
  runBoard(["handoff", fx.ticketRelPath, "--from", src, "--name", name], { cwd: fx.worktree, env: NO_ROOT });
const claim = async (fx, role, mode) => {
  const r = await runBoard(["claim", fx.ticketRelPath, role, ...(mode ? ["--mode", mode] : [])], {
    cwd: fx.worktree,
    env: NO_ROOT,
  });
  assert.equal(r.code, 0, r.stderr);
};
const good = (fx, extra = {}) => validStateJson({ ticket: fx.ticketRelPath, role: "developer", ...extra });

// The example printed on failure is the handoff skill's State block.
function assertShowsExample(stderr) {
  assert.match(stderr, /```json/, "stderr should include the example State block");
  for (const key of ["current_step", "artifacts", "decisions", "failures", "pending"]) {
    assert.ok(stderr.includes(`"${key}"`), `example should show "${key}"`);
  }
}

// --- Criterion 1 ---

for (const field of ["current_step", "artifacts", "decisions", "failures", "pending"]) {
  test(`refuses a State block missing ${field}: nothing written, stderr names it and shows the example`, async () => {
    const fx = await makeBoardFixture();
    try {
      const state = good(fx);
      delete state[field];
      const r = await publish(fx, await draft(fx, "01-developer.md", state));
      assert.notEqual(r.code, 0);
      assert.ok(r.stderr.includes(field), `stderr should name ${field}: ${r.stderr}`);
      assertShowsExample(r.stderr);
      assert.deepEqual(await listHandoffs(fx), []);
    } finally {
      await fx.cleanup();
    }
  });
}

test("refuses pending given as strings: nothing written, stderr names the item and shows the example", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await publish(fx, await draft(fx, "01-developer.md", good(fx, { pending: ["write more tests"] })));
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /pending\[0\]/);
    assertShowsExample(r.stderr);
    assert.deepEqual(await listHandoffs(fx), []);
  } finally {
    await fx.cleanup();
  }
});

test("prints every problem, not just the first", async () => {
  const fx = await makeBoardFixture();
  try {
    const state = good(fx, { pending: ["a", "b"] });
    delete state.artifacts;
    const r = await publish(fx, await draft(fx, "01-developer.md", state));
    assert.notEqual(r.code, 0);
    assert.ok(r.stderr.includes("artifacts"));
    assert.match(r.stderr, /pending\[0\]/);
    assert.match(r.stderr, /pending\[1\]/);
  } finally {
    await fx.cleanup();
  }
});

test("a refused publish leaves an existing published handoff untouched", async () => {
  const fx = await makeBoardFixture();
  try {
    const ok = await publish(fx, await draft(fx, "01-developer.md", good(fx, { current_step: "first" })));
    assert.equal(ok.code, 0, ok.stderr);
    const before = await readFile(path.join(handoffsDir(fx), "01-developer.md"), "utf8");
    const r = await publish(fx, await draft(fx, "bad.md", good(fx, { pending: ["x"] })));
    assert.notEqual(r.code, 0);
    assert.equal(await readFile(path.join(handoffsDir(fx), "01-developer.md"), "utf8"), before);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 2 ---

test("publishes a valid State block with owned pending items as today", async () => {
  const fx = await makeBoardFixture();
  try {
    const src = await draft(fx, "01-developer.md", good(fx, { pending: [{ item: "verify", owner: "qa" }] }));
    const r = await publish(fx, src);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await readFile(path.join(handoffsDir(fx), "01-developer.md"), "utf8"), await readFile(src, "utf8"));
  } finally {
    await fx.cleanup();
  }
});

// --- Scope (a) ---

test("fills agent and mode from the claim lock when the State block omits them", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "qa", "specify");
    const state = validStateJson({ ticket: fx.ticketRelPath });
    const r = await publish(fx, await draft(fx, "01-qa-specify.md", state), "01-qa-specify.md");
    assert.equal(r.code, 0, r.stderr);
    const published = await readFile(path.join(handoffsDir(fx), "01-qa-specify.md"), "utf8");
    const block = JSON.parse(/```json\s*([\s\S]*?)```/.exec(published)[1]);
    assert.equal(block.role, "qa");
    assert.equal(block.mode, "specify");
    assert.equal(block.ticket, fx.ticketRelPath);
  } finally {
    await fx.cleanup();
  }
});

test("a filled-in handoff satisfies the release gate", async () => {
  const fx = await makeBoardFixture();
  try {
    // A developer claim: developers release at in-review (qa may not, by design).
    await claim(fx, "developer");
    const src = await draft(fx, "01-developer.md", validStateJson({ ticket: fx.ticketRelPath }));
    assert.equal((await publish(fx, src, "01-developer.md")).code, 0);
    const r = await runBoard(["release", fx.ticketRelPath, "--status", "in-review"], { cwd: fx.worktree, env: NO_ROOT });
    assert.equal(r.code, 0, r.stderr);
  } finally {
    await fx.cleanup();
  }
});

test("rejects a file with no JSON State block and writes nothing", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "developer");
    const src = await draft(fx, "01-developer.md", null, { raw: "## Summary\n\nno state block here\n" });
    const r = await publish(fx, src);
    assert.notEqual(r.code, 0);
    assertShowsExample(r.stderr);
    assert.deepEqual(await listHandoffs(fx), []);
  } finally {
    await fx.cleanup();
  }
});

// --- Scope (b) ---

test("the lock holder may overwrite its own earlier draft even when the draft named another role/mode", async () => {
  const fx = await makeBoardFixture();
  try {
    await claim(fx, "qa", "specify");
    // Earlier draft published under this claim with the wrong identity.
    const first = await publish(fx, await draft(fx, "a.md", good(fx, { role: "qa", mode: "verify", current_step: "old" })), "01-qa.md");
    assert.equal(first.code, 0, first.stderr);
    const second = await publish(
      fx,
      await draft(fx, "b.md", good(fx, { role: "qa", mode: "specify", current_step: "new" })),
      "01-qa.md"
    );
    assert.equal(second.code, 0, second.stderr);
    assert.match(await readFile(path.join(handoffsDir(fx), "01-qa.md"), "utf8"), /"current_step":"new"/);
  } finally {
    await fx.cleanup();
  }
});

test("the lock holder still cannot overwrite another agent's handoff from before its claim", async () => {
  const fx = await makeBoardFixture();
  try {
    await mkdir(handoffsDir(fx), { recursive: true });
    const old = path.join(handoffsDir(fx), "01-qa.md");
    await writeFile(old, "```json\n" + JSON.stringify(good(fx, { role: "qa", mode: "specify", current_step: "earlier hop" })) + "\n```\n");
    const past = new Date(Date.now() - 3600_000);
    await utimes(old, past, past);
    await claim(fx, "developer");
    const before = await readFile(old, "utf8");
    const r = await publish(fx, await draft(fx, "b.md", good(fx, { role: "developer" })), "01-qa.md");
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /different agent|overwrite/i);
    assert.equal(await readFile(old, "utf8"), before);
  } finally {
    await fx.cleanup();
  }
});

test("without a claim, a different role/mode still cannot overwrite", async () => {
  const fx = await makeBoardFixture();
  try {
    assert.equal((await publish(fx, await draft(fx, "a.md", good(fx, { role: "qa", mode: "verify" })), "01-qa.md")).code, 0);
    const r = await publish(fx, await draft(fx, "b.md", good(fx, { role: "qa", mode: "specify" })), "01-qa.md");
    assert.notEqual(r.code, 0);
  } finally {
    await fx.cleanup();
  }
});
