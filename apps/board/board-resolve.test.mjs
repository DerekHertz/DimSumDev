// Acceptance tests for organism-infra/98: `board resolve <ref>... --pr N [--note "<text>"]`.
//
// Pinned contract (QA's reading of the ticket; the developer must follow it):
//   - resolve takes the claim as orchestrator, publishes an orchestrator handoff
//     to <main>/.scratch/<feature>/handoffs/<NN>-*.md whose State block has
//     ticket "<feature>/<NN-slug>", agent "orchestrator", current_step "resolved"
//     and the PR number somewhere in `artifacts`, then releases with
//     --status resolved --pr N (so the usage.jsonl resolved row is the one
//     release writes today).
//   - --pr is required for every resolve (code or not); a missing or invalid
//     value is refused and names "pr" on stderr.
//   - a ticket held by another agent is refused and the claim stays with its holder.
//   - a refusal on any ref in a batch changes none of them: no status change, no
//     lock, no handoff, no usage row, and events.jsonl is byte-identical.
//   - --note text lands in the ticket's comments or in the handoff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile, mkdir, open } from "node:fs/promises";
import { existsSync, constants as fsConstants } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { makeBoardFixture, runBoard, writeValidHandoff, ticketPath, claimLockPath, REPO_ROOT } from "./board-fixture.mjs";
import { validateState } from "./schemas.mjs";

const codeTicket = (t, status = "in-review") =>
  `# ${t}\n\n**Type:** feature\n\n**Status:** ${status}\n\n- [ ] criterion\n\n## Comments\n`;

const run = (fx, args) => runBoard(args, { cwd: fx.worktree, env: { DEN_ROOT: fx.root } });
const resolveCmd = (fx, refs, ...extra) => run(fx, ["resolve", ...refs, ...extra]);

const usageRows = async (root) => {
  const raw = await readFile(path.join(root, ".scratch", "usage.jsonl"), "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
};
const resolvedRows = async (root) => (await usageRows(root)).filter((r) => r.kind === "resolved");
const eventsRaw = (root) => readFile(path.join(root, ".scratch", "events.jsonl"), "utf8").catch(() => "");
const handoffFiles = async (fx) =>
  (await readdir(path.join(fx.root, ".scratch", fx.feature, "handoffs")).catch(() => [])).sort();
const statusOf = (text) => /^\*\*Status:\*\*[ \t]*(\S+)/m.exec(text)?.[1];

async function stateOf(fx, name) {
  const text = await readFile(path.join(fx.root, ".scratch", fx.feature, "handoffs", name), "utf8");
  const m = /```json\s*([\s\S]*?)```/.exec(text);
  assert.ok(m, `handoff ${name} has a json State block`);
  return { state: JSON.parse(m[1]), text };
}

// Adds a second ticket to the fixture's feature (board reads the main checkout on disk).
async function addTicket(fx, ticket, status = "in-review") {
  await writeFile(ticketPath(fx.root, fx.feature, ticket), codeTicket(ticket, status), "utf8");
  return `${fx.feature}/${ticket}`;
}

// Snapshot of everything a refused resolve must leave alone.
async function snapshot(fx, tickets) {
  const out = { events: await eventsRaw(fx.root), usage: await usageRows(fx.root), handoffs: await handoffFiles(fx) };
  out.tickets = {};
  out.locks = {};
  for (const t of tickets) {
    out.tickets[t] = await readFile(ticketPath(fx.root, fx.feature, t), "utf8");
    out.locks[t] = await readFile(claimLockPath(fx.root, fx.feature, t), "utf8").catch(() => null);
  }
  return out;
}

// --- Criterion 1: resolve on an in-review ticket with no lock ---

test("resolve --pr N on an in-review ticket with no lock resolves it with an orchestrator handoff", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const r = await resolveCmd(fx, [fx.ticketRelPath], "--pr", "42");
    assert.equal(r.code, 0, r.stderr);

    assert.equal(statusOf(await fx.readTicket()), "resolved");
    assert.equal(existsSync(fx.claimLockPath), false, "claim lock is released");

    const files = await handoffFiles(fx);
    assert.equal(files.length, 1, `exactly one published handoff, got ${files}`);
    assert.match(files[0], /^01-.*\.md$/);
    const { state } = await stateOf(fx, files[0]);
    assert.equal(validateState(state).ok, true, JSON.stringify(validateState(state)));
    assert.equal(state.ticket, "sample/01-do-thing");
    assert.equal(state.role, "orchestrator");
    assert.equal(state.current_step, "resolved");
    assert.match(JSON.stringify(state.artifacts), /\b42\b/, "the PR is named in artifacts");

    const events = (await eventsRaw(fx.root)).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const rel = events.filter((e) => e.op === "release" && e.kind !== "override");
    assert.equal(rel.length, 1);
    assert.equal(rel[0].role, "orchestrator");
    assert.equal(rel[0].from_status, "claimed");
    assert.equal(rel[0].to_status, "resolved");
    assert.equal(events.some((e) => e.kind === "override"), false, "no --force override used");
  } finally {
    await fx.cleanup();
  }
});

test("resolve writes the same resolved row as the claim/handoff/release path (bounces included)", async () => {
  const viaResolve = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  const viaRelease = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    // A verdict comment needs a held claim, so seed the recorded events directly:
    // one bounce and one pass on each fixture's ticket.
    for (const fx of [viaResolve, viaRelease]) {
      const lines = ["bounce", "pass"].map((verdict, i) =>
        JSON.stringify({ seq: i + 1, ts: new Date().toISOString(), feature: fx.feature, ticket: fx.ticket, role: "qa", op: "comment", verdict })
      );
      await mkdir(path.dirname(fx.eventsPath), { recursive: true });
      await writeFile(fx.eventsPath, lines.join("\n") + "\n", "utf8");
    }
    const a = await resolveCmd(viaResolve, [viaResolve.ticketRelPath], "--pr", "42");
    assert.equal(a.code, 0, a.stderr);

    const c = await run(viaRelease, ["claim", viaRelease.ticketRelPath, "orchestrator"]);
    assert.equal(c.code, 0, c.stderr);
    await writeValidHandoff(viaRelease);
    const b = await run(viaRelease, ["release", viaRelease.ticketRelPath, "--status", "resolved", "--pr", "42"]);
    assert.equal(b.code, 0, b.stderr);

    const rowA = await resolvedRows(viaResolve.root);
    const rowB = await resolvedRows(viaRelease.root);
    assert.equal(rowA.length, 1, "exactly one resolved row");
    assert.equal(rowB.length, 1);
    const { ts: tsA, ...restA } = rowA[0];
    const { ts: tsB, ...restB } = rowB[0];
    assert.ok(!Number.isNaN(Date.parse(tsA)), "ts is an ISO date");
    assert.deepEqual(restA, restB);
    assert.deepEqual(restA, { kind: "resolved", ticket: "sample/01-do-thing", pr: 42, bounces: 1 });
  } finally {
    await viaResolve.cleanup();
    await viaRelease.cleanup();
  }
});

test("resolve --note records the note text on the ticket or in the handoff", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const r = await resolveCmd(fx, [fx.ticketRelPath], "--pr", "9", "--note", "merged green, squash");
    assert.equal(r.code, 0, r.stderr);
    const files = await handoffFiles(fx);
    const handoffText = files.length ? (await stateOf(fx, files[0])).text : "";
    const combined = (await fx.readTicket()) + "\n" + handoffText;
    assert.match(combined, /merged green, squash/);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 2: refusals change nothing ---

test("resolve on a ticket locked by another agent is refused, the lock stays, nothing is written", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing", "ready-for-agent") });
  try {
    const c = await run(fx, ["claim", fx.ticketRelPath, "developer"]);
    assert.equal(c.code, 0, c.stderr);
    const before = await snapshot(fx, [fx.ticket]);

    const r = await resolveCmd(fx, [fx.ticketRelPath], "--pr", "5");
    assert.notEqual(r.code, 0);
    assert.doesNotMatch(r.stderr, /unknown command/i);
    assert.match(r.stderr, /claim|developer|held/i);
    assert.deepEqual(await snapshot(fx, [fx.ticket]), before);
    assert.match(before.locks[fx.ticket], /^developer\b/, "the developer still holds the lock");
  } finally {
    await fx.cleanup();
  }
});

for (const bad of [[], ["--pr", "abc"], ["--pr", "0"], ["--pr", "-3"], ["--pr", "4.5"]]) {
  test(`resolve with ${bad.length ? bad.join(" ") : "no --pr"} is refused and changes nothing`, async () => {
    const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
    try {
      const before = await snapshot(fx, [fx.ticket]);
      const r = await resolveCmd(fx, [fx.ticketRelPath], ...bad);
      assert.notEqual(r.code, 0);
      assert.doesNotMatch(r.stderr, /unknown command/i);
      assert.match(r.stderr, /\bpr\b/i);
      assert.deepEqual(await snapshot(fx, [fx.ticket]), before);
      assert.equal(statusOf(before.tickets[fx.ticket]), "in-review");
      assert.equal(before.locks[fx.ticket], null);
    } finally {
      await fx.cleanup();
    }
  });
}

// --- Criterion 3: batch ---

test("several refs with one --pr resolve every ticket in the batch", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const second = await addTicket(fx, "02-other-thing");
    const r = await resolveCmd(fx, [fx.ticketRelPath, second], "--pr", "77");
    assert.equal(r.code, 0, r.stderr);

    for (const t of ["01-do-thing", "02-other-thing"]) {
      assert.equal(statusOf(await readFile(ticketPath(fx.root, fx.feature, t), "utf8")), "resolved", t);
      assert.equal(existsSync(claimLockPath(fx.root, fx.feature, t)), false, `${t} lock released`);
    }
    const files = await handoffFiles(fx);
    for (const nn of ["01", "02"]) {
      const mine = files.filter((f) => f.startsWith(`${nn}-`));
      assert.equal(mine.length, 1, `one handoff for ${nn}, got ${files}`);
      const { state } = await stateOf(fx, mine[0]);
      assert.equal(state.ticket, nn === "01" ? "sample/01-do-thing" : "sample/02-other-thing");
      assert.equal(state.role, "orchestrator");
      assert.equal(state.current_step, "resolved");
      assert.match(JSON.stringify(state.artifacts), /\b77\b/);
    }
    const rows = await resolvedRows(fx.root);
    assert.deepEqual(
      rows.map((x) => [x.ticket, x.pr]).sort(),
      [["sample/01-do-thing", 77], ["sample/02-other-thing", 77]]
    );
  } finally {
    await fx.cleanup();
  }
});

for (const order of ["refused ref last", "refused ref first"]) {
  test(`batch with a ticket locked by another agent (${order}) changes none of the tickets`, async () => {
    const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
    try {
      const other = await addTicket(fx, "02-other-thing");
      const c = await run(fx, ["claim", other, "developer"]);
      assert.equal(c.code, 0, c.stderr);
      const before = await snapshot(fx, ["01-do-thing", "02-other-thing"]);

      const refs = order === "refused ref last" ? [fx.ticketRelPath, other] : [other, fx.ticketRelPath];
      const r = await resolveCmd(fx, refs, "--pr", "77");
      assert.notEqual(r.code, 0);
      assert.doesNotMatch(r.stderr, /unknown command/i);
      assert.match(r.stderr, /claim|developer|held/i);
      assert.deepEqual(await snapshot(fx, ["01-do-thing", "02-other-thing"]), before);
      assert.equal(before.locks["01-do-thing"], null, "the clean ticket was not claimed");
    } finally {
      await fx.cleanup();
    }
  });
}

test("batch with a ref that does not exist changes none of the tickets", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const before = await snapshot(fx, ["01-do-thing"]);
    const r = await resolveCmd(fx, [fx.ticketRelPath, "sample/09-missing"], "--pr", "77");
    assert.notEqual(r.code, 0);
    assert.doesNotMatch(r.stderr, /unknown command/i);
    assert.match(r.stderr, /not found|09-missing/i);
    assert.deepEqual(await snapshot(fx, ["01-do-thing"]), before);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 4: docs (the existing claim/handoff/release path is covered by the
// scripts/usage-rows.test.mjs and board-release-*.test.mjs suites, and by the
// "same resolved row" test above, which drives it end to end) ---

test("docs/agents/issue-tracker.md documents `board resolve`", async () => {
  const doc = await readFile(path.join(REPO_ROOT, "docs", "agents", "issue-tracker.md"), "utf8");
  assert.match(doc, /board resolve/);
  const line = doc.split("\n").find((l) => /board resolve/.test(l)) ?? "";
  assert.match(line, /--pr/, "the command's documented line names --pr");
});

// --- organism-infra/114: failure paths in a batch (undo, foreign lock, resolved list) ---
//
// Pinned contract (QA's reading of ticket 114):
//   - A failed resolve undoes a ref's claim only when that claim is the
//     orchestrator's own. A lock held by any other agent is never released,
//     re-statused or commented on.
//   - The failure message ends with `resolved: <refs|none>; not attempted: <refs|none>`.
//   - A ref whose release wrote `resolved` is listed under `resolved:` even when
//     the usage.jsonl append that follows it failed.

// Adds a ticket in another feature whose handoffs path is a plain file, so
// publishing its handoff fails after resolve has claimed it (a failure that
// strikes after the claim, mid-batch, and only on that ref).
async function addUnpublishableTicket(fx, feature, ticket) {
  const issues = path.join(fx.root, ".scratch", feature, "issues");
  await mkdir(issues, { recursive: true });
  await writeFile(path.join(issues, `${ticket}.md`), codeTicket(ticket), "utf8");
  await writeFile(path.join(fx.root, ".scratch", feature, "handoffs"), "not a directory\n", "utf8");
  return `${feature}/${ticket}`;
}

// Parses the trailing `resolved: a, b; not attempted: c` report from stderr.
function failureReport(stderr) {
  const m = /resolved: (.*?); not attempted: (.*?)\s*$/m.exec(stderr);
  assert.ok(m, `stderr ends with a "resolved: ...; not attempted: ..." report, got: ${stderr}`);
  const list = (s) => (s === "none" ? [] : s.split(", "));
  return { resolved: list(m[1]), notAttempted: list(m[2]) };
}

const releaseEvents = async (root, feature, ticket) =>
  (await eventsRaw(root))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.op === "release" && e.feature === feature && e.ticket === ticket);

test("114 AC2: a mid-batch failure undoes only the failing ref's own orchestrator claim and reports resolved / not attempted refs", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const bad = await addUnpublishableTicket(fx, "other", "02-other-thing");
    const third = await addTicket(fx, "03-third-thing");
    const r = await resolveCmd(fx, [fx.ticketRelPath, bad, third], "--pr", "42");
    assert.notEqual(r.code, 0);
    assert.doesNotMatch(r.stderr, /unknown command/i);

    // The ref that finished stays resolved, with its row.
    assert.equal(statusOf(await fx.readTicket()), "resolved");
    assert.equal(existsSync(fx.claimLockPath), false);
    assert.deepEqual((await resolvedRows(fx.root)).map((x) => x.ticket), ["sample/01-do-thing"]);

    // The failing ref is put back: its own orchestrator claim is gone and its status restored.
    assert.equal(statusOf(await readFile(ticketPath(fx.root, "other", "02-other-thing"), "utf8")), "in-review");
    assert.equal(existsSync(claimLockPath(fx.root, "other", "02-other-thing")), false, "the undone claim's lock is gone");

    // The ref after the failure was never touched.
    assert.equal(statusOf(await readFile(ticketPath(fx.root, fx.feature, "03-third-thing"), "utf8")), "in-review");
    assert.equal(existsSync(claimLockPath(fx.root, fx.feature, "03-third-thing")), false);
    assert.deepEqual(await releaseEvents(fx.root, fx.feature, "03-third-thing"), []);

    assert.match(r.stderr, /other\/02-other-thing/, "names the ref it stopped at");
    assert.deepEqual(failureReport(r.stderr), { resolved: [fx.ticketRelPath], notAttempted: [third] });
  } finally {
    await fx.cleanup();
  }
});

test("114 AC2: a failure on the first ref undoes its claim and reports nothing resolved", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const bad = await addUnpublishableTicket(fx, "other", "02-other-thing");
    const second = await addTicket(fx, "03-third-thing");
    const r = await resolveCmd(fx, [bad, fx.ticketRelPath, second], "--pr", "42");
    assert.notEqual(r.code, 0);
    assert.equal(statusOf(await readFile(ticketPath(fx.root, "other", "02-other-thing"), "utf8")), "in-review");
    assert.equal(existsSync(claimLockPath(fx.root, "other", "02-other-thing")), false);
    assert.equal(statusOf(await fx.readTicket()), "in-review", "later refs stay untouched");
    assert.deepEqual(await resolvedRows(fx.root), []);
    assert.deepEqual(failureReport(r.stderr), { resolved: [], notAttempted: [fx.ticketRelPath, second] });
  } finally {
    await fx.cleanup();
  }
});

test("114 AC1: a foreign lock claimed mid-batch survives a failed resolve, untouched", { skip: process.platform === "win32" }, async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  const fifo = path.join(fx.root, ".scratch", "usage.jsonl");
  let child;
  try {
    const other = await addTicket(fx, "02-other-thing");
    // A named pipe at usage.jsonl freezes resolve at a known point: ref 01 is
    // already written as resolved, and the resolved-row append blocks in open()
    // until a reader appears. Nothing has touched ref 02 yet, so a developer can
    // claim it exactly between resolve's validation and its claim.
    execFileSync("mkfifo", [fifo]);
    child = run(fx, ["resolve", fx.ticketRelPath, other, "--pr", "42"]);

    const deadline = Date.now() + 10_000;
    while (statusOf(await fx.readTicket()) !== "resolved") {
      assert.ok(Date.now() < deadline, "resolve reached ref 01 within 10s");
      await new Promise((r) => setTimeout(r, 20));
    }

    const c = await run(fx, ["claim", other, "developer"]);
    assert.equal(c.code, 0, c.stderr);
    const lockBefore = await readFile(claimLockPath(fx.root, fx.feature, "02-other-thing"), "utf8");
    const ticketBefore = await readFile(ticketPath(fx.root, fx.feature, "02-other-thing"), "utf8");
    assert.match(lockBefore, /^developer\b/);
    const eventsBefore = (await releaseEvents(fx.root, fx.feature, "02-other-thing")).length;

    // Unblock resolve: drain the pipe so ref 01's append completes.
    const reader = await open(fifo, fsConstants.O_RDONLY);
    await reader.readFile();
    await reader.close();

    const r = await child;
    assert.notEqual(r.code, 0, "resolve fails: ref 02 is no longer free to claim");
    assert.equal(r.timedOut, false);

    // The developer's claim is exactly as they left it.
    assert.equal(
      await readFile(claimLockPath(fx.root, fx.feature, "02-other-thing"), "utf8").catch(() => null),
      lockBefore,
      "the developer's lock was not released or rewritten"
    );
    assert.equal(
      await readFile(ticketPath(fx.root, fx.feature, "02-other-thing"), "utf8"),
      ticketBefore,
      "no status reset and no comment was written to the developer's ticket"
    );
    assert.equal((await releaseEvents(fx.root, fx.feature, "02-other-thing")).length, eventsBefore, "no release was logged for ref 02");
    assert.doesNotMatch(r.stderr, /put back|claim undone/i);

    // Ref 01 did finish, and the report says so.
    assert.equal(statusOf(await fx.readTicket()), "resolved");
    assert.deepEqual(failureReport(r.stderr), { resolved: [fx.ticketRelPath], notAttempted: [] });
  } finally {
    // If an assertion fired before the pipe was drained, the child is still
    // blocked in open(); runBoard's timeout kills it. Nothing else to clean.
    await fx.cleanup();
  }
});

test("114 AC3: a ref whose release wrote resolved is listed under resolved: even when the usage append failed", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const second = await addTicket(fx, "02-other-thing");
    // A directory at usage.jsonl makes the resolved-row append fail (EISDIR)
    // after release has already written the ticket as resolved.
    await mkdir(path.join(fx.root, ".scratch", "usage.jsonl"), { recursive: true });

    const r = await resolveCmd(fx, [fx.ticketRelPath, second], "--pr", "42");
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /resolved row was NOT written/, "the usage-append failure is surfaced");
    assert.match(r.stderr, /log-resolved/, "the redo hint is kept");

    assert.equal(statusOf(await fx.readTicket()), "resolved", "release did write resolved");
    assert.equal(existsSync(fx.claimLockPath), false);
    assert.equal(statusOf(await readFile(ticketPath(fx.root, fx.feature, "02-other-thing"), "utf8")), "in-review");
    assert.equal(existsSync(claimLockPath(fx.root, fx.feature, "02-other-thing")), false);

    assert.deepEqual(failureReport(r.stderr), { resolved: [fx.ticketRelPath], notAttempted: [second] });
  } finally {
    await fx.cleanup();
  }
});
