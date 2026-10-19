// organism-infra/62: `board handoff --name` must carry the ref's own NN- prefix,
// and must not overwrite a handoff published under an earlier claim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, utimes } from "node:fs/promises";
import path from "node:path";
import { makeBoardFixture, runBoard, validStateJson } from "./board-fixture.mjs";

const NO_ROOT = { DEN_ROOT: "" };
const handoff = (fx, args) => runBoard(["handoff", ...args], { cwd: fx.worktree, env: NO_ROOT });
const hdir = (fx) => path.join(fx.root, ".scratch", fx.feature, "handoffs");

// organism-infra/78: drafts live beside the worktree; `board handoff` refuses one inside it.
async function local(fx, filename, over = {}) {
  const dir = path.join(path.dirname(fx.worktree), ".local-handoffs");
  await mkdir(dir, { recursive: true });
  const state = validStateJson({ ticket: `${fx.feature}/${fx.ticket}`, role: "developer", ...over });
  const p = path.join(dir, filename);
  await writeFile(p, "```json\n" + JSON.stringify(state) + "\n```\n\nbody\n", "utf8");
  return p;
}

test("a --name with another ticket's NN- prefix is refused and that file is untouched", async () => {
  const fx = await makeBoardFixture({ ticket: "08-thing" });
  try {
    await mkdir(hdir(fx), { recursive: true });
    const victim = path.join(hdir(fx), "01-developer.md");
    const victimBody =
      "```json\n" + JSON.stringify(validStateJson({ ticket: `${fx.feature}/01-other`, role: "developer" })) + "\n```\n\nticket 01's own handoff\n";
    await writeFile(victim, victimBody, "utf8");
    const src = await local(fx, "src.md");
    const r = await handoff(fx, [fx.ticketRelPath, "--from", src, "--name", "01-developer.md"]);
    assert.notEqual(r.code, 0);
    assert.equal(await readFile(victim, "utf8"), victimBody);
  } finally {
    await fx.cleanup();
  }
});

test("the prefix error names the expected prefix", async () => {
  const fx = await makeBoardFixture({ ticket: "08-thing" });
  try {
    const src = await local(fx, "src.md");
    const r = await handoff(fx, [fx.ticketRelPath, "--from", src, "--name", "01-developer.md"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /08-/);
  } finally {
    await fx.cleanup();
  }
});

test("a --name with the matching prefix is still accepted", async () => {
  const fx = await makeBoardFixture({ ticket: "08-thing" });
  try {
    const src = await local(fx, "src.md");
    const r = await handoff(fx, [fx.ticketRelPath, "--from", src, "--name", "08-developer.md"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(await readFile(path.join(hdir(fx), "08-developer.md"), "utf8"), /developer/);
  } finally {
    await fx.cleanup();
  }
});

test("refuses to overwrite a handoff from an earlier claim, allows own draft under the current claim", async () => {
  const fx = await makeBoardFixture();
  try {
    // A handoff left by a previous claim: same agent, older than the new lock.
    await mkdir(hdir(fx), { recursive: true });
    const old = path.join(hdir(fx), "01-developer.md");
    const oldBody = "```json\n" + JSON.stringify(validStateJson({ ticket: `${fx.feature}/${fx.ticket}`, role: "developer" })) + "\n```\n\nold claim\n";
    await writeFile(old, oldBody, "utf8");
    const past = new Date(Date.now() - 3_600_000);
    await utimes(old, past, past);

    const c = await runBoard(["claim", fx.ticketRelPath, "developer"], { cwd: fx.worktree, env: NO_ROOT });
    assert.equal(c.code, 0, c.stderr);

    const src = await local(fx, "new.md");
    const refused = await handoff(fx, [fx.ticketRelPath, "--from", src, "--name", "01-developer.md"]);
    assert.notEqual(refused.code, 0);
    assert.equal(await readFile(old, "utf8"), oldBody);

    // Own draft under the current claim (51's rule) still overwrites.
    const first = await handoff(fx, [fx.ticketRelPath, "--from", src, "--name", "01-draft.md"]);
    assert.equal(first.code, 0, first.stderr);
    const second = await handoff(fx, [fx.ticketRelPath, "--from", src, "--name", "01-draft.md"]);
    assert.equal(second.code, 0, second.stderr);
  } finally {
    await fx.cleanup();
  }
});
