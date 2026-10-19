// Refocus 2026-10-02 (docs/refocus/triage-2026-10-02.md): `board park` and `board close`.
//
// Contract:
//   - `board park <ref>... --reason "<text>"` sets each ticket to `parked`;
//     `board close <ref>... --reason "<text>"` sets each to `closed`. Both
//     append an orchestrator comment carrying the reason and one event per ref.
//   - --reason is required.
//   - Every ref is checked before the first write: a missing ticket, a claim
//     lock, a resolved ticket, or a ref already at the target status refuses
//     the whole command and changes nothing.
//   - `board unpark <ref>... --reason "<text>"` returns a parked ticket to
//     ready-for-agent; a ticket that is not parked is refused.
//   - parked and closed tickets are not reported stale by `board audit`.
//   - `board release` still refuses parked and closed: they are off the relay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { makeBoardFixture, runBoard, ticketPath, claimLockPath } from "./board-fixture.mjs";

const run = (fx, args) => runBoard(args, { cwd: fx.worktree, env: { DEN_ROOT: fx.root } });
const statusOf = (text) => /^(?:\*\*Status:\*\*|Status:)[ \t]*(\S+)/m.exec(text)?.[1];
const read = (fx, t) => readFile(ticketPath(fx.root, fx.feature, t), "utf8");
const eventsRaw = (fx) => readFile(fx.eventsPath, "utf8").catch(() => "");

async function addTicket(fx, ticket, status = "ready-for-agent") {
  await writeFile(
    ticketPath(fx.root, fx.feature, ticket),
    `# ${ticket}\n\n**Status:** ${status}\n\n- [ ] criterion\n\n## Comments\n`,
    "utf8"
  );
  return `${fx.feature}/${ticket}`;
}

test("park sets every ref to parked with the reason in a comment and an event", async () => {
  const fx = await makeBoardFixture();
  try {
    const second = await addTicket(fx, "02-other");
    const r = await run(fx, ["park", fx.ticketRelPath, second, "--reason", "refocus: not a v1 step"]);
    assert.equal(r.code, 0, r.stderr);
    for (const t of [fx.ticket, "02-other"]) {
      const text = await read(fx, t);
      assert.equal(statusOf(text), "parked");
      assert.match(text, /- \*\*orchestrator, \d{4}-\d{2}-\d{2}:\*\* Parked: refocus: not a v1 step/);
    }
    const events = (await eventsRaw(fx)).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(events.filter((e) => e.op === "park").length, 2);
  } finally {
    await fx.cleanup();
  }
});

test("close sets closed and records the reason", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await run(fx, ["close", fx.ticketRelPath, "--reason", "asset art, Blender out"]);
    assert.equal(r.code, 0, r.stderr);
    const text = await read(fx, fx.ticket);
    assert.equal(statusOf(text), "closed");
    assert.match(text, /Closed: asset art, Blender out/);
  } finally {
    await fx.cleanup();
  }
});

test("park without --reason is refused", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = await run(fx, ["park", fx.ticketRelPath]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /reason/);
    assert.equal(statusOf(await read(fx, fx.ticket)), "ready-for-agent");
  } finally {
    await fx.cleanup();
  }
});

test("a bad ref anywhere in the list changes nothing", async () => {
  for (const bad of ["claimed", "resolved", "missing", "already"]) {
    const fx = await makeBoardFixture();
    try {
      let badRef;
      if (bad === "missing") badRef = `${fx.feature}/09-nope`;
      else if (bad === "already") badRef = await addTicket(fx, "02-bad", "parked");
      else badRef = await addTicket(fx, "02-bad", bad === "resolved" ? "resolved" : "claimed");
      if (bad === "claimed") {
        await writeFile(claimLockPath(fx.root, fx.feature, "02-bad"), JSON.stringify({ role: "developer", pid: process.pid }));
      }
      const before = { t: await read(fx, fx.ticket), events: await eventsRaw(fx) };
      const r = await run(fx, ["park", fx.ticketRelPath, badRef, "--reason", "x"]);
      assert.notEqual(r.code, 0, `${bad}: expected refusal`);
      assert.equal(await read(fx, fx.ticket), before.t, `${bad}: first ticket untouched`);
      assert.equal(await eventsRaw(fx), before.events, `${bad}: no events`);
    } finally {
      await fx.cleanup();
    }
  }
});

test("unpark returns a parked ticket to ready-for-agent and refuses one that is not parked", async () => {
  const fx = await makeBoardFixture();
  try {
    assert.equal((await run(fx, ["park", fx.ticketRelPath, "--reason", "later"])).code, 0);
    const r = await run(fx, ["unpark", fx.ticketRelPath, "--reason", "testbed needs it"]);
    assert.equal(r.code, 0, r.stderr);
    const text = await read(fx, fx.ticket);
    assert.equal(statusOf(text), "ready-for-agent");
    assert.match(text, /Unparked: testbed needs it/);
    const again = await run(fx, ["unpark", fx.ticketRelPath, "--reason", "x"]);
    assert.notEqual(again.code, 0);
  } finally {
    await fx.cleanup();
  }
});

test("audit does not report parked or closed tickets as stale", async () => {
  const fx = await makeBoardFixture();
  try {
    await addTicket(fx, "02-closed", "closed");
    await run(fx, ["park", fx.ticketRelPath, "--reason", "later"]);
    const r = await run(fx, ["audit", "--stale-days", "0", "--json"]);
    const findings = JSON.parse(r.stdout || "[]");
    assert.deepEqual(findings.filter((f) => f.kind === "stale"), []);
  } finally {
    await fx.cleanup();
  }
});

test("release still refuses parked and closed", async () => {
  const fx = await makeBoardFixture();
  try {
    assert.equal((await run(fx, ["claim", fx.ticketRelPath, "developer"])).code, 0);
    for (const s of ["parked", "closed"]) {
      const r = await run(fx, ["release", fx.ticketRelPath, "--status", s]);
      assert.notEqual(r.code, 0, `release --status ${s} must be refused`);
      assert.match(r.stderr, /invalid status/);
    }
  } finally {
    await fx.cleanup();
  }
});

test("reopen returns a closed ticket to ready-for-agent and refuses one that is not closed", async () => {
  const fx = await makeBoardFixture();
  try {
    assert.equal((await run(fx, ["close", fx.ticketRelPath, "--reason", "churn"])).code, 0);
    const r = await run(fx, ["reopen", fx.ticketRelPath, "--reason", "user wants it after all"]);
    assert.equal(r.code, 0, r.stderr);
    const text = await read(fx, fx.ticket);
    assert.equal(statusOf(text), "ready-for-agent");
    assert.match(text, /Reopened: user wants it after all/);
    assert.notEqual((await run(fx, ["reopen", fx.ticketRelPath, "--reason", "x"])).code, 0);
  } finally {
    await fx.cleanup();
  }
});
