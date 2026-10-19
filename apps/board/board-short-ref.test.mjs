// organism-infra/126: the board CLI takes <feature>/<NN> and resolves it to the one
// issue file named <NN>-*. The whole numeric segment must match (12 is not 126);
// zero or two or more matches are refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeBoardFixture, runBoard } from "./board-fixture.mjs";

const run = (fx, args) => runBoard(args, { cwd: fx.worktree, env: { DEN_ROOT: fx.root } });
const statusOf = (text) => /^\*\*Status:\*\*[ \t]*(\S+)/m.exec(text)?.[1];
const content = (t) => `# ${t}\n\n**Type:** feature\n\n**Status:** ready-for-agent\n\n- [ ] criterion\n\n## Comments\n`;

async function withFx(fn) {
  const fx = await makeBoardFixture({ feature: "sample", ticket: "126-thing", content: content("126-thing") });
  try {
    await fn(fx);
  } finally {
    await fx.cleanup();
  }
}

test("status takes a short ref and prints the ticket's status", () =>
  withFx(async (fx) => {
    const r = await run(fx, ["status", "sample/126"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), "ready-for-agent");
  }));

test("claim, comment and release take a short ref and act on the full-slug ticket", () =>
  withFx(async (fx) => {
    let r = await run(fx, ["claim", "sample/126", "developer"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /claimed sample\/126-thing/);
    assert.equal(statusOf(await fx.readTicket()), "claimed");

    r = await run(fx, ["comment", "sample/126", "short ref note"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(await fx.readTicket(), /short ref note/);

    r = await run(fx, ["release", "sample/126", "--status", "blocked", "--reason", "x"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(statusOf(await fx.readTicket()), "blocked");
  }));

test("park takes short refs", () =>
  withFx(async (fx) => {
    const r = await run(fx, ["park", "sample/126", "--reason", "later"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(statusOf(await fx.readTicket()), "parked");
  }));

test("a full slug ref still works", () =>
  withFx(async (fx) => {
    const r = await run(fx, ["status", "sample/126-thing"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), "ready-for-agent");
  }));

test("a short ref with no matching ticket is refused", () =>
  withFx(async (fx) => {
    const r = await run(fx, ["status", "sample/127"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /not found/);
  }));

test("a shorter number does not match a longer one (12 is not 126)", () =>
  withFx(async (fx) => {
    const r = await run(fx, ["status", "sample/12"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /not found/);
  }));

test("an ambiguous short ref is refused and names the matches", () =>
  withFx(async (fx) => {
    await writeFile(path.join(fx.root, ".scratch", "sample", "issues", "126-other.md"), content("126-other"));
    const r = await run(fx, ["status", "sample/126"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /ambiguous/);
    assert.match(r.stderr, /126-thing/);
    assert.match(r.stderr, /126-other/);
  }));

test("a short ref for an unknown feature is refused", () =>
  withFx(async (fx) => {
    await mkdir(path.join(fx.root, ".scratch", "empty"), { recursive: true });
    const r = await run(fx, ["status", "nope/126"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /not found/);
  }));
