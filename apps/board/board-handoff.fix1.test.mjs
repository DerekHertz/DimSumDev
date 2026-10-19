// Security fix round 1 for organism-infra/30: containment, overwrite and
// --from hardening for `board handoff`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { makeBoardFixture, runBoard, validStateJson } from "./board-fixture.mjs";

const NO_ROOT = { DEN_ROOT: "" };
const handoff = (fx, args) => runBoard(["handoff", ...args], { cwd: fx.worktree, env: NO_ROOT });

// organism-infra/78: drafts live beside the worktree; `board handoff` refuses one inside it.
async function local(fx, filename, over = {}) {
  const dir = path.join(path.dirname(fx.worktree), ".local-handoffs");
  await mkdir(dir, { recursive: true });
  const state = validStateJson({ ticket: `${fx.feature}/${fx.ticket}`, role: "developer", ...over });
  const p = path.join(dir, filename);
  await writeFile(p, "```json\n" + JSON.stringify(state) + "\n```\n\nbody\n", "utf8");
  return p;
}
const hdir = (fx) => path.join(fx.root, ".scratch", fx.feature, "handoffs");

test("handoff rejects a symlinked handoffs dir pointing outside the root", async () => {
  const fx = await makeBoardFixture();
  const outside = path.join(tmpdir(), `outside-30-${process.pid}`);
  try {
    await mkdir(outside, { recursive: true });
    await rm(hdir(fx), { recursive: true, force: true });
    await symlink(outside, hdir(fx));
    const src = await local(fx, "01-developer.md");
    const r = await handoff(fx, [fx.ticketRelPath, "--from", src]);
    assert.notEqual(r.code, 0);
    await assert.rejects(readFile(path.join(outside, "01-developer.md")));
  } finally {
    await rm(outside, { recursive: true, force: true });
    await fx.cleanup();
  }
});

test("handoff rejects a symlinked destination file", async () => {
  const fx = await makeBoardFixture();
  const target = path.join(tmpdir(), `target-30-${process.pid}.md`);
  try {
    await writeFile(target, "orig", "utf8");
    await mkdir(hdir(fx), { recursive: true });
    await symlink(target, path.join(hdir(fx), "01-developer.md"));
    const src = await local(fx, "01-developer.md");
    const r = await handoff(fx, [fx.ticketRelPath, "--from", src]);
    assert.notEqual(r.code, 0);
    assert.equal(await readFile(target, "utf8"), "orig");
  } finally {
    await rm(target, { force: true });
    await fx.cleanup();
  }
});

test("handoff refuses to overwrite another agent's handoff, allows same agent", async () => {
  const fx = await makeBoardFixture();
  try {
    const a = await local(fx, "01-x.md", { role: "developer" });
    assert.equal((await handoff(fx, [fx.ticketRelPath, "--from", a])).code, 0);
    const other = await local(fx, "01-y.md", { role: "security" });
    const r = await handoff(fx, [fx.ticketRelPath, "--from", other, "--name", "01-x.md"]);
    assert.notEqual(r.code, 0);
    assert.match(await readFile(path.join(hdir(fx), "01-x.md"), "utf8"), /developer/);
    const again = await local(fx, "01-z.md", { role: "developer" });
    const r2 = await handoff(fx, [fx.ticketRelPath, "--from", again, "--name", "01-x.md"]);
    assert.equal(r2.code, 0, r2.stderr);
  } finally {
    await fx.cleanup();
  }
});

test("handoff refuses overwrite when mode differs", async () => {
  const fx = await makeBoardFixture();
  try {
    const a = await local(fx, "01-x.md", { role: "qa", mode: "specify" });
    assert.equal((await handoff(fx, [fx.ticketRelPath, "--from", a])).code, 0);
    const b = await local(fx, "01-y.md", { role: "qa", mode: "verify" });
    const r = await handoff(fx, [fx.ticketRelPath, "--from", b, "--name", "01-x.md"]);
    assert.notEqual(r.code, 0);
  } finally {
    await fx.cleanup();
  }
});

test("handoff rejects an oversized --from file", async () => {
  const fx = await makeBoardFixture();
  try {
    const src = await local(fx, "01-developer.md");
    await writeFile(src, (await readFile(src, "utf8")) + "x".repeat(300 * 1024), "utf8");
    const r = await handoff(fx, [fx.ticketRelPath, "--from", src]);
    assert.notEqual(r.code, 0);
  } finally {
    await fx.cleanup();
  }
});

test("handoff rejects a symlinked --from", async () => {
  const fx = await makeBoardFixture();
  try {
    const real = await local(fx, "real.md");
    const link = path.join(path.dirname(real), "01-link.md");
    await symlink(real, link);
    const r = await handoff(fx, [fx.ticketRelPath, "--from", link]);
    assert.notEqual(r.code, 0);
  } finally {
    await fx.cleanup();
  }
});
