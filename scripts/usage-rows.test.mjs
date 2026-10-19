// organism-infra/48: scripted usage rows. Two seams:
//   1. `board release <ref> --status resolved --pr <n>` appends one resolved row.
//   2. `scripts/log-agent.mjs` appends one validated agent row.
// All tests use a temp board root (makeBoardFixture); the live .scratch is never touched.
//
// Pinned contracts (the ticket leaves these open; the developer must follow them):
//   - usage file: <root>/.scratch/usage.jsonl, root = $DEN_ROOT (else cwd), as jev.mjs.
//   - resolved row: {"kind":"resolved","ts":<ISO string>,"ticket":"<feature>/<NN-slug>","pr":<number|null>,"bounces":<int>}.
//   - bounce count source (structured verdict, coordinator change): `board comment <ref>
//     --verdict pass|bounce "<text>"` records "verdict":"pass"|"bounce" on the op:"comment" event in
//     <root>/.scratch/events.jsonl. Any other --verdict value is refused (non-zero, nothing written:
//     no event, no ticket change). bounces = count of that ticket's comment events with verdict
//     "bounce". Comments without --verdict count as nothing, whatever their text says.
//     The developer documents this in ADR 0008 (the ADR must mention "verdict").
//   - --pr: a positive integer. Required when the ticket's `**Type:**` is feature or bug (code
//     tickets); a missing or non-numeric --pr then fails, writes no row, and leaves the claim.
//     For other Types (e.g. design) --pr may be omitted and the row has pr:null.
//   - only --status resolved appends a resolved row; in-review/blocked releases append none.
//   - a failed release (gate refusal) appends no row.
//   - log-agent row: {"kind":"agent","ts":<ISO>,"ticket","role","mode"(only if given),"tokens":<number>,"ms":<number>,"outcome":<string>}.
//     The ticket must exist at <root>/.scratch/<feature>/issues/<NN-slug>.md. tokens and ms must be
//     non-negative integers; outcome non-empty; --role one of the known roles
//     (product architect orchestrator developer scout qa security designer).
//     Every rejection exits non-zero, explains on stderr, and writes nothing.
//
// Criterion map:
//   1 resolved row on release   -> "release --status resolved --pr ..." tests (row, one only, bounces, pr rules, no row otherwise)
//   2 log-agent valid/rejects    -> "log-agent ..." tests
//   3 ADR updated               -> the ADR 0008 test (names log-agent, the resolved row, bounce, verdict, events.jsonl)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { makeBoardFixture, runBoard, writeValidHandoff, REPO_ROOT } from "../apps/board/board-fixture.mjs";

const LOG_AGENT = path.join(REPO_ROOT, "scripts", "log-agent.mjs");
const usagePath = (root) => path.join(root, ".scratch", "usage.jsonl");
const rows = (root) => {
  const p = usagePath(root);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
};
const codeTicket = (t) => `# ${t}\n\n**Type:** feature\n\n**Status:** ready-for-agent\n\n- [ ] criterion\n\n## Comments\n`;

async function claimAndReady(fx, role = "orchestrator") {
  const c = await runBoard(["claim", fx.ticketRelPath, role], { cwd: fx.worktree });
  assert.equal(c.code, 0, c.stderr);
  await writeValidHandoff(fx);
}
const resolve = (fx, ...extra) =>
  runBoard(["release", fx.ticketRelPath, "--status", "resolved", ...extra], {
    cwd: fx.worktree,
    env: { DEN_ROOT: fx.root },
  });

// --- Criterion 1 ---

test("release --status resolved --pr appends exactly one well-formed resolved row", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    await claimAndReady(fx);
    const r = await resolve(fx, "--pr", "42");
    assert.equal(r.code, 0, r.stderr);
    const got = rows(fx.root).filter((x) => x.kind === "resolved");
    assert.equal(got.length, 1);
    assert.equal(got[0].ticket, "sample/01-do-thing");
    assert.strictEqual(got[0].pr, 42);
    assert.strictEqual(got[0].bounces, 0);
    assert.ok(!Number.isNaN(Date.parse(got[0].ts)), "ts is an ISO date");
    assert.deepEqual(Object.keys(got[0]).sort(), ["bounces", "kind", "pr", "ticket", "ts"]);
  } finally {
    await fx.cleanup();
  }
});

test("bounces counts only comments recorded with --verdict bounce; free-text bounce and pass verdicts count 0", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    await claimAndReady(fx);
    for (const [text, verdict] of [
      ["QA bounce: test x fails", "bounce"],
      ["QA pass", "pass"],
      ["Security bounce: HIGH finding", "bounce"],
      ["security: BOUNCE", "bounce"],
      ["QA bounce, typed without a verdict", undefined],
      ["Note: no bounce this time", undefined],
    ]) {
      const args = ["comment", fx.ticketRelPath, ...(verdict ? ["--verdict", verdict] : []), text];
      const c = await runBoard(args, { cwd: fx.worktree });
      assert.equal(c.code, 0, c.stderr);
    }
    const r = await resolve(fx, "--pr", "7");
    assert.equal(r.code, 0, r.stderr);
    const got = rows(fx.root).filter((x) => x.kind === "resolved");
    assert.equal(got.length, 1);
    assert.strictEqual(got[0].bounces, 3);
  } finally {
    await fx.cleanup();
  }
});

test("comment --verdict is recorded on the comment event", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    await claimAndReady(fx);
    for (const v of ["pass", "bounce"]) {
      const c = await runBoard(["comment", fx.ticketRelPath, "--verdict", v, `verdict ${v}`], { cwd: fx.worktree });
      assert.equal(c.code, 0, c.stderr);
    }
    const evs = readFileSync(fx.eventsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => e.op === "comment");
    assert.deepEqual(evs.map((e) => e.verdict), ["pass", "bounce"]);
  } finally {
    await fx.cleanup();
  }
});

test("comment --verdict bogus is refused and writes nothing", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    await claimAndReady(fx);
    const before = await fx.readTicket();
    const c = await runBoard(["comment", fx.ticketRelPath, "--verdict", "bogus", "hello"], { cwd: fx.worktree });
    assert.notEqual(c.code, 0);
    assert.match(c.stderr, /verdict/i);
    assert.equal(await fx.readTicket(), before);
    const evs = readFileSync(fx.eventsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(evs.filter((e) => e.op === "comment").length, 0, "no comment event written");
  } finally {
    await fx.cleanup();
  }
});

test("bounces ignore other tickets' comments", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    await writeFile(path.join(fx.root, ".scratch", "sample", "issues", "02-other.md"), codeTicket("02-other"));
    const k = await runBoard(["claim", "sample/02-other", "orchestrator"], { cwd: fx.worktree });
    assert.equal(k.code, 0, k.stderr);
    const c = await runBoard(["comment", "sample/02-other", "--verdict", "bounce", "QA bounce: nope"], { cwd: fx.worktree });
    assert.equal(c.code, 0, c.stderr);
    await claimAndReady(fx);
    const r = await resolve(fx, "--pr", "7");
    assert.equal(r.code, 0, r.stderr);
    assert.strictEqual(rows(fx.root).find((x) => x.kind === "resolved").bounces, 0);
  } finally {
    await fx.cleanup();
  }
});

for (const bad of [[], ["--pr", "abc"], ["--pr", "0"], ["--pr", "-3"], ["--pr", "4.5"]]) {
  test(`code ticket: release resolved with ${bad.length ? bad.join(" ") : "no --pr"} fails, writes no row, keeps the claim`, async () => {
    const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
    try {
      await claimAndReady(fx);
      const r = await resolve(fx, ...bad);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /pr/i);
      assert.equal(rows(fx.root).length, 0);
      const s = await runBoard(["status", fx.ticketRelPath], { cwd: fx.worktree, env: { DEN_ROOT: fx.root } });
      assert.match(s.stdout, /claimed/);
    } finally {
      await fx.cleanup();
    }
  });
}

test("non-code ticket (Type: design) may resolve without --pr, row has pr:null", async () => {
  const fx = await makeBoardFixture({
    content: "# 01-do-thing\n\n**Type:** design\n\n**Status:** ready-for-agent\n\n## Comments\n",
  });
  try {
    await claimAndReady(fx, "orchestrator"); // ADR 0008 decision 9: only an orchestrator claim may resolve
    const r = await resolve(fx);
    assert.equal(r.code, 0, r.stderr);
    const got = rows(fx.root).filter((x) => x.kind === "resolved");
    assert.equal(got.length, 1);
    assert.strictEqual(got[0].pr, null);
  } finally {
    await fx.cleanup();
  }
});

test("release to in-review or blocked appends no resolved row", async () => {
  for (const status of ["in-review", "blocked"]) {
    const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
    try {
      await claimAndReady(fx, "developer");
      const r = await runBoard(["release", fx.ticketRelPath, "--status", status], {
        cwd: fx.worktree,
        env: { DEN_ROOT: fx.root },
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(rows(fx.root).filter((x) => x.kind === "resolved").length, 0, status);
    } finally {
      await fx.cleanup();
    }
  }
});

test("a gate-refused resolved release (no handoff) appends no row", async () => {
  const fx = await makeBoardFixture({ content: codeTicket("01-do-thing") });
  try {
    const c = await runBoard(["claim", fx.ticketRelPath, "orchestrator"], { cwd: fx.worktree });
    assert.equal(c.code, 0, c.stderr);
    const r = await resolve(fx, "--pr", "5");
    assert.notEqual(r.code, 0);
    assert.equal(rows(fx.root).length, 0);
  } finally {
    await fx.cleanup();
  }
});

// --- Criterion 2 ---

function logAgent(fx, args) {
  return spawnSync(process.execPath, [LOG_AGENT, ...args], {
    cwd: fx.root,
    env: { ...process.env, DEN_ROOT: fx.root },
    encoding: "utf8",
    timeout: 15000,
  });
}
const good = (fx) => [
  "--ticket", fx.ticketRelPath, "--role", "qa", "--mode", "specify",
  "--tokens", "51234", "--ms", "184000", "--outcome", "tests written, red",
  "--allow-no-handoff", "test setup",
];
const without = (args, flag) => args.filter((x, i) => x !== flag && args[i - 1] !== flag);

test("log-agent appends one valid agent row", async () => {
  const fx = await makeBoardFixture();
  try {
    const r = logAgent(fx, good(fx));
    assert.equal(r.status, 0, r.stderr);
    const got = rows(fx.root);
    assert.equal(got.length, 1);
    assert.equal(got[0].kind, "agent");
    assert.equal(got[0].ticket, "sample/01-do-thing");
    assert.equal(got[0].role, "qa");
    assert.equal(got[0].mode, "specify");
    assert.strictEqual(got[0].tokens, 51234);
    assert.strictEqual(got[0].ms, 184000);
    assert.equal(got[0].outcome, "tests written, red");
    assert.ok(!Number.isNaN(Date.parse(got[0].ts)));
  } finally {
    await fx.cleanup();
  }
});

test("log-agent without --mode omits the mode key; two calls append two rows", async () => {
  const fx = await makeBoardFixture();
  try {
    const args = without(good(fx), "--mode").map((x) => (x === "qa" ? "developer" : x));
    assert.equal(logAgent(fx, args).status, 0);
    assert.equal(logAgent(fx, args).status, 0);
    const got = rows(fx.root);
    assert.equal(got.length, 2);
    assert.ok(!("mode" in got[0]));
  } finally {
    await fx.cleanup();
  }
});

const swap = (from, to) => (fx) => good(fx).map((x) => (x === from ? to : x));
const badCases = {
  "unknown ticket": (fx) => swap(fx.ticketRelPath, "sample/99-nope")(fx),
  "malformed ticket ref": (fx) => swap(fx.ticketRelPath, "../../etc/passwd")(fx),
  "non-numeric tokens": swap("51234", "lots"),
  "negative tokens": swap("51234", "-5"),
  "fractional ms": swap("184000", "1.5"),
  "non-numeric ms": swap("184000", "soon"),
  "unknown role": swap("qa", "wizard"),
  "empty outcome": swap("tests written, red", ""),
  "missing --tokens": (fx) => without(good(fx), "--tokens"),
  "missing --outcome": (fx) => without(good(fx), "--outcome"),
};
for (const [name, mk] of Object.entries(badCases)) {
  test(`log-agent rejects ${name} without writing`, async () => {
    const fx = await makeBoardFixture();
    try {
      const r = logAgent(fx, mk(fx));
      assert.notEqual(r.status, 0);
      assert.ok(r.stderr.length > 0, "explains the rejection on stderr");
      assert.equal(existsSync(usagePath(fx.root)), false, "no usage file written");
    } finally {
      await fx.cleanup();
    }
  });
}

// --- Criterion 3 ---

test("ADR 0008 documents the scripted rows and where the bounce count comes from", () => {
  const dir = path.join(REPO_ROOT, "docs", "adr");
  const f = readdirSync(dir).find((n) => n.startsWith("0008-"));
  const text = readFileSync(path.join(dir, f), "utf8");
  assert.match(text, /log-cell/); // ADR 0008 predates ADR 0028 and keeps the old script name
  assert.match(text, /resolved/i);
  assert.match(text, /bounce/i);
  assert.match(text, /verdict/i);
  assert.match(text, /events\.jsonl/);
});
