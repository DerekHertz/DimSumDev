// Acceptance tests for organism-infra/45, criterion 1: a release with no claim
// lock must not skip the handoff gate.
//
// Pinned contract (QA's reading of the ticket's "either" option; the developer
// must follow it): `board release --status in-review` with no claim lock is
// refused (non-zero exit, stderr mentions "claim"), even when a matching
// handoff file exists, and leaves the ticket unchanged with no release event.
// Ungated releases (--status blocked) and --force are out of scope here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { makeBoardFixture, runBoard, eventsPath, validStateJson } from "./board-fixture.mjs";

async function readEvents(root) {
  const raw = await readFile(eventsPath(root), "utf8").catch(() => "");
  return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function writeHandoff(fx, filename, overrides) {
  const dir = path.join(fx.root, ".scratch", fx.feature, "handoffs");
  await mkdir(dir, { recursive: true });
  const state = validStateJson({ ticket: `${fx.feature}/${fx.ticket}`, ...overrides });
  await writeFile(path.join(dir, filename), "```json\n" + JSON.stringify(state) + "\n```\n", "utf8");
}

const release = (fx, ...extra) =>
  runBoard(["release", fx.ticketRelPath, ...extra], { cwd: fx.worktree });

test("release --status in-review with no claim lock and no handoff is refused", async () => {
  const fx = await makeBoardFixture();
  try {
    const before = await fx.readTicket();
    const r = await release(fx, "--status", "in-review");
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /claim/i);
    assert.equal(await fx.readTicket(), before);
    assert.equal((await readEvents(fx.root)).filter((e) => e.op === "release").length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("release --status in-review with no claim lock is refused even when a handoff exists", async () => {
  const fx = await makeBoardFixture();
  try {
    await writeHandoff(fx, "01-developer.md", { role: "developer" });
    const before = await fx.readTicket();
    const r = await release(fx, "--status", "in-review");
    assert.notEqual(r.code, 0, "no lock means no role/mode/age binding, so refuse");
    assert.match(r.stderr, /claim/i);
    assert.equal(await fx.readTicket(), before);
    assert.equal((await readEvents(fx.root)).filter((e) => e.op === "release").length, 0);
  } finally {
    await fx.cleanup();
  }
});
