// portable-den/11: found work cannot sink. A ticket filed from other work carries `**Discovered from:** <ref>`, and the
// parent cannot resolve (board resolve, board release --status resolved) while a ticket discovered from it is
// untriaged. Untriaged = status ready-for-agent or ready-for-human, no claim lock, and no comment by the chief of staff
// in its ## Comments. Anything else (claimed, in-review, blocked, parked, closed, resolved, or a chief-of-staff
// comment) counts as triaged. `board file` files a discovered ticket with the link set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { makeBoardFixture, runBoard, writeValidHandoff, ticketPath, claimLockPath } from "./board-fixture.mjs";

const PARENT = "01-do-thing";
const run = (fx, args) => runBoard(args, { cwd: fx.worktree, env: { DEN_ROOT: fx.root } });
const statusOf = (text) => /^\*\*Status:\*\*[ \t]*(\S+)/m.exec(text)?.[1];

const parentTicket = `# ${PARENT}\n\n**Type:** feature\n\n**Status:** in-review\n\n- [ ] criterion\n\n## Comments\n`;
const childTicket = (n, status, { discovered = `sample/${PARENT}`, comments = "" } = {}) =>
  `# ${n}\n\n**Type:** task\n\n**Status:** ${status}\n\n**Discovered from:** ${discovered}\n\n- [ ] criterion\n\n## Comments\n${comments}`;

async function fixture() {
  return makeBoardFixture({ ticket: PARENT, content: parentTicket });
}
async function addChild(fx, ticket, status, opts) {
  await writeFile(ticketPath(fx.root, fx.feature, ticket), childTicket(ticket, status, opts), "utf8");
  return `${fx.feature}/${ticket}`;
}

test("board resolve refuses, writing nothing, while a ticket discovered from the parent is untriaged", async () => {
  for (const status of ["ready-for-agent", "ready-for-human"]) {
    const fx = await fixture();
    try {
      const child = await addChild(fx, "02-found-bug", status);
      const before = await fx.readTicket();
      const r = await run(fx, ["resolve", fx.ticketRelPath, "--pr", "42"]);
      assert.notEqual(r.code, 0, `${status}: ${r.stdout}`);
      assert.match(r.stderr, new RegExp(child), "names the untriaged child");
      assert.match(r.stderr, /untriaged|discovered/i);
      assert.equal(await fx.readTicket(), before, "parent untouched");
      assert.equal(existsSync(fx.claimLockPath), false, "no claim left behind");
      assert.deepEqual(await readdir(path.join(fx.root, ".scratch", fx.feature, "handoffs")).catch(() => []), []);
    } finally {
      await fx.cleanup();
    }
  }
});

test("board resolve passes once each discovered ticket is claimed, parked, closed, resolved, blocked or commented on by the chief of staff", async () => {
  const fx = await fixture();
  try {
    await addChild(fx, "02-claimed", "ready-for-agent");
    await writeFile(claimLockPath(fx.root, fx.feature, "02-claimed"), "developer 1 0\n", "utf8");
    await addChild(fx, "03-parked", "parked");
    await addChild(fx, "04-closed", "closed");
    await addChild(fx, "05-resolved", "resolved");
    await addChild(fx, "06-blocked", "blocked");
    await addChild(fx, "07-triaged", "ready-for-agent", { comments: "- **chief-of-staff, 2026-10-31:** triaged: stays, next sprint\n" });
    const r = await run(fx, ["resolve", fx.ticketRelPath, "--pr", "42"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(statusOf(await fx.readTicket()), "resolved");
  } finally {
    await fx.cleanup();
  }
});

test("a chief-of-staff comment through board comment triages an untriaged discovered ticket", async () => {
  const fx = await fixture();
  try {
    const child = await addChild(fx, "02-found-bug", "ready-for-agent");
    assert.notEqual((await run(fx, ["resolve", fx.ticketRelPath, "--pr", "42"])).code, 0);
    const c = await run(fx, ["comment", child, "--as", "chief-of-staff", "triaged: keep, P2"]);
    assert.equal(c.code, 0, c.stderr);
    const r = await run(fx, ["resolve", fx.ticketRelPath, "--pr", "42"]);
    assert.equal(r.code, 0, r.stderr);
  } finally {
    await fx.cleanup();
  }
});

test("a ticket discovered from some other ticket does not hold the parent", async () => {
  const fx = await fixture();
  try {
    await addChild(fx, "02-elsewhere", "ready-for-agent", { discovered: "sample/09-someone-else" });
    const r = await run(fx, ["resolve", fx.ticketRelPath, "--pr", "42"]);
    assert.equal(r.code, 0, r.stderr);
  } finally {
    await fx.cleanup();
  }
});

test("a ticket linked by the short feature/NN parent ref holds the parent too", async () => {
  const fx = await fixture();
  try {
    const child = await addChild(fx, "02-found-bug", "ready-for-agent", { discovered: `${fx.feature}/01` });
    const r = await run(fx, ["resolve", fx.ticketRelPath, "--pr", "42"]);
    assert.notEqual(r.code, 0, r.stdout);
    assert.match(r.stderr, new RegExp(child));
  } finally {
    await fx.cleanup();
  }
});

test("board release --status resolved refuses on the same condition and leaves the claim and status alone", async () => {
  const fx = await fixture();
  try {
    const child = await addChild(fx, "02-found-bug", "ready-for-agent");
    assert.equal((await run(fx, ["claim", fx.ticketRelPath, "chief-of-staff"])).code, 0);
    await writeValidHandoff(fx);
    const r = await run(fx, ["release", fx.ticketRelPath, "--status", "resolved", "--pr", "42"]);
    assert.notEqual(r.code, 0, r.stdout);
    assert.match(r.stderr, new RegExp(child));
    assert.equal(existsSync(fx.claimLockPath), true, "claim stays");
    assert.notEqual(statusOf(await fx.readTicket()), "resolved");

    await run(fx, ["comment", child, "--as", "chief-of-staff", "triaged"]);
    const ok = await run(fx, ["release", fx.ticketRelPath, "--status", "resolved", "--pr", "42"]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(statusOf(await fx.readTicket()), "resolved");
  } finally {
    await fx.cleanup();
  }
});

test("--force does not bypass the discovered-ticket check on release", async () => {
  const fx = await fixture();
  try {
    await addChild(fx, "02-found-bug", "ready-for-agent");
    assert.equal((await run(fx, ["claim", fx.ticketRelPath, "chief-of-staff"])).code, 0);
    const r = await run(fx, ["release", fx.ticketRelPath, "--status", "resolved", "--pr", "42", "--force", "--reason", "skip"]);
    assert.notEqual(r.code, 0);
    assert.notEqual(statusOf(await fx.readTicket()), "resolved");
  } finally {
    await fx.cleanup();
  }
});

test("board file writes a ticket with the Discovered from line set, and the new ticket then holds the parent", async () => {
  const fx = await fixture();
  try {
    const r = await run(fx, [
      "file", fx.feature, "found-bug",
      "--discovered-from", fx.ticketRelPath,
      "--title", "Found a bug while working",
      "--text", "The widget rounds down.",
    ]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /sample\/02-found-bug/);
    const md = await readFile(ticketPath(fx.root, fx.feature, "02-found-bug"), "utf8");
    assert.match(md, /^\*\*Discovered from:\*\* sample\/01-do-thing$/m);
    assert.match(md, /^\*\*Status:\*\* ready-for-agent$/m);
    assert.match(md, /^> The widget rounds down\.$/m);

    const held = await run(fx, ["resolve", fx.ticketRelPath, "--pr", "42"]);
    assert.notEqual(held.code, 0);
    assert.match(held.stderr, /02-found-bug/);
  } finally {
    await fx.cleanup();
  }
});

test("board file resolves a short parent ref, refuses a missing parent, and requires --discovered-from", async () => {
  const fx = await fixture();
  try {
    const short = await run(fx, ["file", fx.feature, "short-ref", "--discovered-from", "sample/01", "--title", "T", "--text", "x"]);
    assert.equal(short.code, 0, short.stderr);
    assert.match(await readFile(ticketPath(fx.root, fx.feature, "02-short-ref"), "utf8"), /^\*\*Discovered from:\*\* sample\/01-do-thing$/m);

    const missing = await run(fx, ["file", fx.feature, "orphan", "--discovered-from", "sample/77-nope", "--title", "T", "--text", "x"]);
    assert.notEqual(missing.code, 0);
    assert.equal(existsSync(ticketPath(fx.root, fx.feature, "03-orphan")), false);

    const none = await run(fx, ["file", fx.feature, "unlinked", "--title", "T", "--text", "x"]);
    assert.notEqual(none.code, 0);
    assert.match(none.stderr, /discovered-from/);
    assert.equal(existsSync(ticketPath(fx.root, fx.feature, "03-unlinked")), false);
  } finally {
    await fx.cleanup();
  }
});

test("board file --ticket-file writes the author's own drafted ticket with the link set", async () => {
  const fx = await fixture();
  try {
    const draft = path.join(fx.root, "draft.md");
    await writeFile(draft, "## What to build\n\nRound up.\n\n## Acceptance criteria\n\n- [ ] rounds up\n", "utf8");
    const r = await run(fx, ["file", fx.feature, "drafted", "--discovered-from", fx.ticketRelPath, "--title", "Drafted", "--ticket-file", draft]);
    assert.equal(r.code, 0, r.stderr);
    const md = await readFile(ticketPath(fx.root, fx.feature, "02-drafted"), "utf8");
    assert.match(md, /^\*\*Discovered from:\*\* sample\/01-do-thing$/m);
    assert.match(md, /- \[ \] rounds up/);
  } finally {
    await fx.cleanup();
  }
});
