// team-and-den-ux/01 (ADR 0028): the old spellings keep working for one release, and board files
// written before the rename still parse.
//   criterion 2 (old flags work with a deprecation line) -> "--cell ..." tests
//   criterion 3 (pre-rename board files parse)            -> "a pre-rename handoff ...", "roleOf ...", "events.jsonl ..."
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, utimes } from "node:fs/promises";
import path from "node:path";
import { makeBoardFixture, runBoard, validStateJson, eventsPath } from "./board-fixture.mjs";
import { normalizeLegacyFlags, roleOf } from "./legacy-terms.mjs";
import { resolveRoot } from "./board-service.mjs";

const NO_ROOT = { DEN_ROOT: "", ORGANISM_ROOT: "" };
const board = (fx, args) => runBoard(args, { cwd: fx.worktree, env: NO_ROOT });
const events = async (fx) =>
  (await readFile(eventsPath(fx.root), "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("normalizeLegacyFlags turns --cell into --role and says so once", () => {
  const lines = [];
  const out = normalizeLegacyFlags(["claim", "x/01", "--cell", "qa", "--mode", "verify", "--cell=qa"], "board", (l) => lines.push(l));
  assert.deepEqual(out, ["claim", "x/01", "--role", "qa", "--mode", "verify", "--role=qa"]);
  assert.deepEqual(lines, ["board: --cell is deprecated; use --role (ADR 0028)"]);
  assert.deepEqual(normalizeLegacyFlags(["claim", "x/01", "developer"], "board", () => assert.fail("no line")), ["claim", "x/01", "developer"]);
});

test("roleOf reads a new row's role and an old row's cell", () => {
  assert.equal(roleOf({ role: "qa" }), "qa");
  assert.equal(roleOf({ cell: "developer" }), "developer");
  assert.equal(roleOf({ role: "qa", cell: "developer" }), "qa");
  assert.equal(roleOf(null), undefined);
});

test("$DEN_ROOT names the main checkout, and the old $ORGANISM_ROOT still does", () => {
  assert.equal(resolveRoot("/", { DEN_ROOT: "/tmp/new" }), "/tmp/new");
  assert.equal(resolveRoot("/", { ORGANISM_ROOT: "/tmp/old" }), "/tmp/old");
  assert.equal(resolveRoot("/", { DEN_ROOT: "/tmp/new", ORGANISM_ROOT: "/tmp/old" }), "/tmp/new");
});

test("--cell on board claim still claims, records the role and prints the deprecation line", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await board(fx, ["claim", fx.ticketRelPath, "--cell", "developer"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /board: --cell is deprecated; use --role/);
    const claimRow = (await events(fx)).find((e) => e.op === "claim");
    assert.equal(claimRow.role, "developer");
    assert.equal("cell" in claimRow, false, "new rows are written with role only");
  } finally {
    await fx.cleanup();
  }
});

test("--role on board claim prints no deprecation line", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await board(fx, ["claim", fx.ticketRelPath, "--role", "developer"]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /deprecated/);
  } finally {
    await fx.cleanup();
  }
});

test("a pre-rename handoff (State block names its author in `cell`) still satisfies release", async () => {
  const fx = await makeBoardFixture();
  try {
    assert.equal((await board(fx, ["claim", fx.ticketRelPath, "developer"])).code, 0);
    const dir = path.join(fx.root, ".scratch", fx.feature, "handoffs");
    await mkdir(dir, { recursive: true });
    const nn = /^(\d{2,})-/.exec(fx.ticket)[1];
    const p = path.join(dir, `${nn}-developer.md`);
    const old = validStateJson({ ticket: fx.ticketRelPath, cell: "developer" });
    await writeFile(p, "```json\n" + JSON.stringify(old) + "\n```\n\n## Summary\n\nwritten before ADR 0028\n", "utf8");
    const later = new Date(Date.now() + 60_000);
    await utimes(p, later, later);
    const r = await board(fx, ["release", fx.ticketRelPath, "--status", "in-review"]);
    assert.equal(r.code, 0, r.stderr);
  } finally {
    await fx.cleanup();
  }
});

test("a pre-rename handoff with the wrong `cell` is still refused", async () => {
  const fx = await makeBoardFixture();
  try {
    assert.equal((await board(fx, ["claim", fx.ticketRelPath, "developer"])).code, 0);
    const dir = path.join(fx.root, ".scratch", fx.feature, "handoffs");
    await mkdir(dir, { recursive: true });
    const nn = /^(\d{2,})-/.exec(fx.ticket)[1];
    const p = path.join(dir, `${nn}-qa.md`);
    await writeFile(p, "```json\n" + JSON.stringify(validStateJson({ ticket: fx.ticketRelPath, cell: "qa" })) + "\n```\n", "utf8");
    const later = new Date(Date.now() + 60_000);
    await utimes(p, later, later);
    const r = await board(fx, ["release", fx.ticketRelPath, "--status", "in-review"]);
    assert.notEqual(r.code, 0);
  } finally {
    await fx.cleanup();
  }
});
