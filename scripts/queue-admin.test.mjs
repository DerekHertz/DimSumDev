// queue/04: acceptance tests for scripts/queue-admin.mjs, the user-only entry point that sets the active feature and
// admits a refused ticket (ADR 0015 Amendment 3, B; spec decisions 3 and 7).
//
// The script does not exist yet, so every test that spawns it should currently fail on the missing module
// (node exits 1 with MODULE_NOT_FOUND and the row is never written), not on a fixture or assertion bug.
//
// Public interface these tests pin (the developer implements it):
//
//   node scripts/queue-admin.mjs [--root <repoRoot>] active <feature>
//   node scripts/queue-admin.mjs [--root <repoRoot>] admit <ref> --reason "<why>"
//
//   - --root names the main checkout whose .scratch/usage.jsonl is appended to (default: cwd). It is accepted before
//     or after the subcommand, as apply-gated takes its --root.
//   - Each command prints a prompt, reads ONE line from stdin and writes only when that line, trimmed, is exactly `y`.
//     Anything else (n, empty, yes, Y, EOF, a closed or /dev/null stdin) writes nothing and exits nonzero.
//     There is no --yes / -y flag. The prompt for `active` shows the old and the new value (ADR 0015 Amendment 3 B(4)).
//   - `active <feature>` appends ONE line to <root>/.scratch/usage.jsonl:
//       {"kind":"config","ts":"<ISO>","queue_active":"<feature>","by":"user", ...extra fields allowed}
//     <feature> must match ^[a-z0-9-]+$ (ADR 0008 decision 6); otherwise nothing is written and the exit is nonzero.
//   - `admit <ref> --reason "<why>"` appends ONE line:
//       {"kind":"queue-admit","ts":"<ISO>","ref":"<ref>","reason":"<why>","by":"user"}
//     A missing, empty or whitespace-only reason, or a missing ref, writes nothing and exits nonzero, with or without y.
//   - The file is only appended to: existing lines stay byte for byte, and a refusal creates no file.
//   - The Queue reads both rows (apps/board/frontier-queue.mjs loadSnapshot / gateRefusals / board gate):
//     the active feature's tickets go in the active tier; a ticket with a queue-admit row is not refused by the gate.
//
// Not pinned (open scope questions, see the qa specify handoff): whether `admit` checks that <ref> names a real ticket,
// and whether the reader ignores a row whose `by` is not "user".
//
// human-verified, not tested here: the settings deny patch is in the developer handoff and NOT applied (criterion 4,
// and applying it is ticket 07); the result of trying `!npm run queue-admin ...` under the deny rules in the main
// session (criterion 5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSnapshot, gateRefusals } from "../apps/board/frontier-queue.mjs";
import { makeBoardFixture, runBoard } from "../apps/board/board-fixture.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, "scripts", "queue-admin.mjs");

// Run the script. `input: undefined` plus stdin "ignore" is a /dev/null stdin (what an agent's Bash call gives).
// `env` is added to the inherited environment, but DEN_ROOT is always removed first, so the developer's own shell
// cannot leak in.
function admin(args, { input = "", devnull = false, cwd, env = {} } = {}) {
  const { DEN_ROOT: _drop, ...inherited } = process.env;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: cwd ?? tmpdir(),
    encoding: "utf8",
    timeout: 15000,
    env: { ...inherited, ...env },
    ...(devnull ? { stdio: ["ignore", "pipe", "pipe"] } : { input }),
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function withRoot(fn, { usage } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "queue-admin-"));
  const root = path.join(base, "main");
  await mkdir(path.join(root, ".scratch"), { recursive: true });
  if (usage !== undefined) await writeFile(path.join(root, ".scratch", "usage.jsonl"), usage, "utf8");
  try {
    await fn(root);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const usagePath = (root) => path.join(root, ".scratch", "usage.jsonl");
const readUsage = (root) => readFile(usagePath(root), "utf8").catch(() => null);
const exists = (p) => access(p).then(() => true, () => false);
const rowsOf = (text) => (text ?? "").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const PRIOR = [
  JSON.stringify({ kind: "resolved", ts: "2026-10-10T00:00:00Z", ticket: "x/01-y" }),
  JSON.stringify({ kind: "config", ts: "2026-10-11T00:00:00Z", queue_active: "alpha", by: "user" }),
].join("\n") + "\n";

// Assert the script wrote nothing: the usage file is byte-identical to before (or still absent).
// `r` is the script's result. The script must have actually run (a missing module would exit nonzero and write nothing,
// which would pass vacuously), and a refusal says something. `prompt` names text the prompt/message must mention.
// `scratch` is the sorted .scratch listing taken after the fixture was set up and before the script ran; the listing must equal it exactly.
const snapshotScratch = async (root) => (await readdir(path.join(root, ".scratch"))).sort();

async function assertUntouched(root, before, ctx, r, prompt, { scratch } = {}) {
  if (r) {
    assert.notEqual(r.code, 0, `exit is nonzero (${ctx})`);
    assert.doesNotMatch(r.stderr, /Cannot find module|MODULE_NOT_FOUND/, `the script exists (${ctx})`);
    assert.ok((r.stdout + r.stderr).trim().length > 0, `the script says something (${ctx})`);
    if (prompt) assert.ok((r.stdout + r.stderr).includes(prompt), `output mentions ${prompt} (${ctx}):\n${r.stdout}${r.stderr}`);
  }
  assert.equal(await readUsage(root), before, `usage.jsonl unchanged (${ctx})`);
  assert.deepEqual(
    (await readdir(path.join(root, ".scratch"))).sort(),
    scratch ?? (before === null ? [] : ["usage.jsonl"]),
    `no other file appears under .scratch (${ctx})`
  );
}

// --- package.json ------------------------------------------------------------------------------------------------

test("package.json has a queue-admin script that runs scripts/queue-admin.mjs", async () => {
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.match(pkg.scripts?.["queue-admin"] ?? "", /scripts\/queue-admin\.mjs/);
});

// --- active: writes on y ---------------------------------------------------------------------------------------

test("active <feature> with y on stdin appends exactly one queue_active config row by the user", async () => {
  await withRoot(async (root) => {
    const t0 = Date.now();
    const r = admin(["--root", root, "active", "den-v1"], { input: "y\n" });
    const t1 = Date.now();
    assert.equal(r.code, 0, r.stderr);
    const text = await readUsage(root);
    assert.ok(text.startsWith(PRIOR), "existing lines are kept byte for byte");
    const added = rowsOf(text.slice(PRIOR.length));
    assert.equal(added.length, 1, "exactly one new line");
    const row = added[0];
    assert.equal(row.kind, "config");
    assert.equal(row.queue_active, "den-v1");
    assert.equal(row.by, "user");
    assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    assert.ok(Date.parse(row.ts) >= t0 - 1000 && Date.parse(row.ts) <= t1 + 1000, `ts is now: ${row.ts}`);
    assert.ok(text.endsWith("\n"), "the row ends with a newline");
  }, { usage: PRIOR });
});

test("active creates usage.jsonl when it is absent", async () => {
  await withRoot(async (root) => {
    const r = admin(["--root", root, "active", "den-v1"], { input: "y\n" });
    assert.equal(r.code, 0, r.stderr);
    const rows = rowsOf(await readUsage(root));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].queue_active, "den-v1");
  });
});

test("--root is accepted after the subcommand as well", async () => {
  await withRoot(async (root) => {
    const r = admin(["active", "den-v1", "--root", root], { input: "y\n" });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(rowsOf(await readUsage(root))[0].queue_active, "den-v1");
  });
});

test("the active prompt shows the old and the new value", async () => {
  await withRoot(async (root) => {
    const r = admin(["--root", root, "active", "beta"], { input: "n\n" });
    assert.notEqual(r.code, 0);
    assert.match(r.stdout, /alpha/, `old value shown:\n${r.stdout}`);
    assert.match(r.stdout, /beta/, `new value shown:\n${r.stdout}`);
  }, { usage: PRIOR });
});

test("a second active command supersedes the first: the Queue reads the last row", async () => {
  await withRoot(async (root) => {
    assert.equal(admin(["--root", root, "active", "alpha"], { input: "y\n" }).code, 0);
    assert.equal(admin(["--root", root, "active", "beta"], { input: "y\n" }).code, 0);
    assert.equal(rowsOf(await readUsage(root)).length, 2, "history is kept, not rewritten");
    assert.equal((await loadSnapshot(root)).active, "beta");
  });
});

// --- active: writes nothing without a y ------------------------------------------------------------------------

for (const answer of ["n\n", "\n", "", "yes\n", "Y\n", "yy\n", "no\n", "x\ny\n"]) {
  test(`active with stdin ${JSON.stringify(answer)} writes nothing and exits nonzero`, async () => {
    for (const before of [PRIOR, null]) {
      await withRoot(async (root) => {
        const r = admin(["--root", root, "active", "den-v1"], { input: answer });
        assert.notEqual(r.code, 0, "exit is nonzero");
        await assertUntouched(root, before, JSON.stringify(answer), r, "den-v1");
      }, before === null ? {} : { usage: before });
    }
  });
}

test("active with a /dev/null stdin (what an agent's Bash call gives) writes nothing and exits nonzero", async () => {
  await withRoot(async (root) => {
    const r = admin(["--root", root, "active", "den-v1"], { devnull: true });
    assert.notEqual(r.code, 0);
    await assertUntouched(root, PRIOR, "devnull", r, "den-v1");
  }, { usage: PRIOR });
});

test("there is no flag that stands in for the y: --yes and -y with empty stdin write nothing", async () => {
  for (const flag of ["--yes", "-y", "--force", "--confirm"]) {
    await withRoot(async (root) => {
      const a = admin(["--root", root, "active", "den-v1", flag], { input: "" });
      assert.notEqual(a.code, 0, `${flag} does not confirm active`);
      const m = admin(["--root", root, "admit", "x/01-y", "--reason", "why", flag], { input: "" });
      assert.notEqual(m.code, 0, `${flag} does not confirm admit`);
      await assertUntouched(root, PRIOR, flag, a);
      await assertUntouched(root, PRIOR, flag, m);
    }, { usage: PRIOR });
  }
});

test("active refuses a feature name outside ^[a-z0-9-]+$, even with y", async () => {
  const bad = ["../etc", "Den V1", "a/b", "den_v1", 'den-v1"}', "DEN", "den-v1\nx", "."];
  for (const feature of bad) {
    await withRoot(async (root) => {
      const r = admin(["--root", root, "active", feature], { input: "y\n" });
      assert.notEqual(r.code, 0, `refused: ${JSON.stringify(feature)}`);
      await assertUntouched(root, PRIOR, JSON.stringify(feature), r);
    }, { usage: PRIOR });
  }
});

test("active with no feature, or an unknown subcommand, writes nothing and exits nonzero", async () => {
  for (const args of [["active"], ["bogus", "den-v1"], [], ["active", "a", "b"]]) {
    await withRoot(async (root) => {
      const r = admin(["--root", root, ...args], { input: "y\n" });
      assert.notEqual(r.code, 0, JSON.stringify(args));
      await assertUntouched(root, PRIOR, JSON.stringify(args), r);
    }, { usage: PRIOR });
  }
});

// --- admit -------------------------------------------------------------------------------------------------------

test("admit <ref> --reason with y on stdin appends exactly one queue-admit row by the user", async () => {
  await withRoot(async (root) => {
    await putTicket(root, "den-v1", "05-thing"); // developer change: admit now needs a real ticket (ruling 1)
    const t0 = Date.now();
    const r = admin(["--root", root, "admit", "den-v1/05-thing", "--reason", "needed for the demo"], { input: "y\n" });
    const t1 = Date.now();
    assert.equal(r.code, 0, r.stderr);
    const text = await readUsage(root);
    assert.ok(text.startsWith(PRIOR));
    const added = rowsOf(text.slice(PRIOR.length));
    assert.equal(added.length, 1);
    const row = added[0];
    assert.equal(row.kind, "queue-admit");
    assert.equal(row.ref, "den-v1/05-thing");
    assert.equal(row.reason, "needed for the demo");
    assert.equal(row.by, "user");
    assert.ok(Date.parse(row.ts) >= t0 - 1000 && Date.parse(row.ts) <= t1 + 1000, `ts is now: ${row.ts}`);
  }, { usage: PRIOR });
});

test("admit keeps a reason with quotes, a backslash and unicode intact (one valid JSON line)", async () => {
  const reason = 'user said "ship it" \\ at 5é, {"kind":"config"}';
  await withRoot(async (root) => {
    await putTicket(root, "den-v1", "05-thing");
    const r = admin(["--root", root, "admit", "den-v1/05-thing", "--reason", reason], { input: "y\n" });
    assert.equal(r.code, 0, r.stderr);
    const rows = rowsOf(await readUsage(root));
    assert.equal(rows.length, 1, "one row, and the reason did not inject a second");
    assert.equal(rows[0].reason, reason);
    assert.equal(rows[0].kind, "queue-admit");
  });
});

for (const answer of ["n\n", "\n", "", "yes\n", "Y\n"]) {
  test(`admit with stdin ${JSON.stringify(answer)} writes nothing and exits nonzero`, async () => {
    await withRoot(async (root) => {
      await putTicket(root, "den-v1", "05-thing");
      const scratch = await snapshotScratch(root);
      const r = admin(["--root", root, "admit", "den-v1/05-thing", "--reason", "why"], { input: answer });
      assert.notEqual(r.code, 0);
      await assertUntouched(root, PRIOR, JSON.stringify(answer), r, "den-v1/05-thing", { scratch });
    }, { usage: PRIOR });
  });
}

test("admit with a /dev/null stdin writes nothing and exits nonzero", async () => {
  await withRoot(async (root) => {
    await putTicket(root, "den-v1", "05-thing");
    const scratch = await snapshotScratch(root);
    const r = admin(["--root", root, "admit", "den-v1/05-thing", "--reason", "why"], { devnull: true });
    assert.notEqual(r.code, 0);
    await assertUntouched(root, null, "devnull", r, "den-v1/05-thing", { scratch });
  });
});

test("admit refuses a missing, empty or blank reason and a missing ref, even with y", async () => {
  const cases = [
    ["admit", "den-v1/05-thing"],
    ["admit", "den-v1/05-thing", "--reason"],
    ["admit", "den-v1/05-thing", "--reason", ""],
    ["admit", "den-v1/05-thing", "--reason", "   "],
    ["admit", "--reason", "why"],
    ["admit"],
  ];
  for (const args of cases) {
    await withRoot(async (root) => {
      await putTicket(root, "den-v1", "05-thing");
      const scratch = await snapshotScratch(root);
      const r = admin(["--root", root, ...args], { input: "y\n" });
      assert.notEqual(r.code, 0, JSON.stringify(args));
      await assertUntouched(root, PRIOR, JSON.stringify(args), r, undefined, { scratch });
    }, { usage: PRIOR });
  }
});

// Developer addition (queue/04 ruling 1): admit refuses a ref that is not a real ticket.
test("admit refuses a ref that names no ticket, or is not shaped like a ref, even with y", async () => {
  const refs = [
    "den-v1/99-missing", // well formed, no such file
    "nofeature/01-thing", // no such feature
    "den-v1/05", // the number alone is not the full ref
    "05-thing",
    "den-v1/05-thing/extra",
    "../den-v1/05-thing",
    "den-v1/../den-v1/05-thing",
    "DEN-V1/05-thing",
    "den-v1/05-thing.md",
    "",
  ];
  for (const ref of refs) {
    await withRoot(async (root) => {
      await putTicket(root, "den-v1", "05-thing");
      const scratch = await snapshotScratch(root);
      const r = admin(["--root", root, "admit", ref, "--reason", "why"], { input: "y\n" });
      assert.notEqual(r.code, 0, JSON.stringify(ref));
      await assertUntouched(root, PRIOR, JSON.stringify(ref), r, undefined, { scratch });
    }, { usage: PRIOR });
  }
});

// Developer addition (queue/04 ruling 3): with no --root the row goes to the main checkout, found as `board` finds it.
test("with no --root, run from a worktree, the row is written in the main checkout", async () => {
  const fx = await makeBoardFixture(SEED);
  try {
    const r = admin(["active", "den-v1"], { input: "y\n", cwd: fx.worktree });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(rowsOf(await readUsage(fx.root))[0]?.queue_active, "den-v1", "main checkout has the row");
    assert.equal(await readUsage(fx.worktree), null, "the worktree has no usage.jsonl");
    const a = admin(["admit", "seed/09-seed", "--reason", "why"], { input: "y\n", cwd: fx.worktree });
    assert.equal(a.code, 0, a.stderr);
    assert.equal(rowsOf(await readUsage(fx.root)).at(-1)?.kind, "queue-admit");
    assert.equal(await readUsage(fx.worktree), null, "still no usage.jsonl in the worktree");
  } finally {
    await fx.cleanup();
  }
});

test("with no --root, $DEN_ROOT is the main checkout, and --root still wins over it", async () => {
  await withRoot(async (a) => {
    await withRoot(async (b) => {
      const viaEnv = admin(["active", "den-v1"], { input: "y\n", env: { DEN_ROOT: a } });
      assert.equal(viaEnv.code, 0, viaEnv.stderr);
      assert.equal(rowsOf(await readUsage(a))[0]?.queue_active, "den-v1");
      const both = admin(["--root", b, "active", "beta"], { input: "y\n", env: { DEN_ROOT: a } });
      assert.equal(both.code, 0, both.stderr);
      assert.equal(rowsOf(await readUsage(b))[0]?.queue_active, "beta", "--root wins");
      assert.equal(rowsOf(await readUsage(a)).length, 1, "the env root got nothing more");
    });
  });
});

test("with no --root, outside any checkout and with no $DEN_ROOT, it refuses and writes nothing", async () => {
  await withRoot(async (root) => {
    const r = admin(["active", "den-v1"], { input: "y\n", cwd: root });
    assert.notEqual(r.code, 0);
    assert.doesNotMatch(r.stderr, /Cannot find module|MODULE_NOT_FOUND/, "the script exists");
    assert.equal(await readUsage(root), null);
  });
});

// --- the Queue reads both rows ------------------------------------------------------------------------------------

const ticketText = ({ title = "a ticket", header = [] } = {}) =>
  [
    `# ${title}`,
    "",
    "**Type:** code",
    "**Priority:** P2",
    "**Blocked by:** none",
    "**Status:** ready-for-agent",
    ...header,
    "",
    "## What to build",
    "",
    "- [ ] criterion",
    "",
    "## Comments",
    "",
  ].join("\n");

async function putTicket(root, feature, slug, header = []) {
  const dir = path.join(root, ".scratch", feature, "issues");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${slug}.md`), ticketText({ header }), "utf8");
}

const runB = (fx, args) => runBoard(args, { cwd: fx.worktree, env: { DEN_ROOT: fx.root } });
const SEED = { feature: "seed", ticket: "09-seed", status: "resolved" };

test("board queue puts the active feature's tickets first after `queue-admin active` (and not before)", async () => {
  const fx = await makeBoardFixture(SEED);
  try {
    await putTicket(fx.root, "other", "01-low-number");
    await putTicket(fx.root, "den-v1", "05-in-feature");
    const line = (out, ref) => out.split("\n").findIndex((l) => l.includes(ref));

    const before = await runB(fx, ["queue"]);
    assert.equal(before.code, 0, before.stderr);
    assert.ok(line(before.stdout, "other/01-low-number") < line(before.stdout, "den-v1/05-in-feature"), `control: no active feature, number order:\n${before.stdout}`);

    const set = admin(["--root", fx.root, "active", "den-v1"], { input: "y\n" });
    assert.equal(set.code, 0, set.stderr);

    const after = await runB(fx, ["queue"]);
    assert.equal(after.code, 0, after.stderr);
    const a = line(after.stdout, "den-v1/05-in-feature");
    const o = line(after.stdout, "other/01-low-number");
    assert.ok(a >= 0 && o >= 0 && a < o, `active feature first:\n${after.stdout}`);
    assert.match(after.stdout.split("\n")[a], /active tier/);
    assert.match(after.stdout.split("\n")[o], /rest tier/);
    assert.match(after.stdout, /active feature: den-v1/);
  } finally {
    await fx.cleanup();
  }
});

test("a declined `active` leaves board queue as it was (no active feature)", async () => {
  const fx = await makeBoardFixture(SEED);
  try {
    await putTicket(fx.root, "den-v1", "05-in-feature");
    const set = admin(["--root", fx.root, "active", "den-v1"], { input: "n\n" });
    assert.notEqual(set.code, 0);
    assert.doesNotMatch(set.stderr, /Cannot find module|MODULE_NOT_FOUND/, "the script exists");
    const q = await runB(fx, ["queue"]);
    assert.equal(q.code, 0, q.stderr);
    assert.match(q.stdout, /no active feature/);
  } finally {
    await fx.cleanup();
  }
});

test("board gate lists a refused ticket until `queue-admin admit` with y; gate --apply then leaves it ready", async () => {
  const fx = await makeBoardFixture(SEED);
  try {
    await putTicket(fx.root, "lone", "01-bare"); // no Class, no Serves: the gate refuses it
    await putTicket(fx.root, "lone", "02-also-bare"); // stays refused: it is the control
    const gate = async () => (await runB(fx, ["gate"]));

    const first = await gate();
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /lone\/01-bare/, `refused before admit:\n${first.stdout}`);

    const declined = admin(["--root", fx.root, "admit", "lone/01-bare", "--reason", "user wants it"], { input: "n\n" });
    assert.notEqual(declined.code, 0);
    assert.doesNotMatch(declined.stderr, /Cannot find module|MODULE_NOT_FOUND/, "the script exists");
    assert.match((await gate()).stdout, /lone\/01-bare/, "a declined admit changes nothing");

    const admitted = admin(["--root", fx.root, "admit", "lone/01-bare", "--reason", "user wants it"], { input: "y\n" });
    assert.equal(admitted.code, 0, admitted.stderr);
    const second = await gate();
    assert.equal(second.code, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /lone\/01-bare/, `admitted ticket is not refused:\n${second.stdout}`);
    assert.match(second.stdout, /lone\/02-also-bare/, "another refused ticket is still refused");

    const applied = await runB(fx, ["gate", "--apply"]);
    assert.equal(applied.code, 0, applied.stderr);
    const status = await runB(fx, ["status", "lone/01-bare"]);
    assert.match(status.stdout, /ready-for-agent/, `admitted ticket was not parked:\n${status.stdout}`);
    const other = await runB(fx, ["status", "lone/02-also-bare"]);
    assert.match(other.stdout, /parked/, `control ticket was parked:\n${other.stdout}`);
  } finally {
    await fx.cleanup();
  }
});

// The reader seam: the row shape in the ADR, written by hand, with no script involved.
test("loadSnapshot and gateRefusals: a queue-admit row admits exactly the ticket it names", async () => {
  await withRoot(async (root) => {
    await putTicket(root, "lone", "01-bare");
    await putTicket(root, "lone", "02-bare");
    const refs = async () => gateRefusals(await loadSnapshot(root)).map((x) => x.ref).sort();
    assert.deepEqual(await refs(), ["lone/01-bare", "lone/02-bare"], "control: both refused");
    const row = { kind: "queue-admit", ts: "2026-10-12T01:00:00Z", ref: "lone/01-bare", reason: "user said so", by: "user" };
    await writeFile(usagePath(root), JSON.stringify(row) + "\n", "utf8");
    assert.deepEqual(await refs(), ["lone/02-bare"]);
  });
});

// Developer additions (queue/04 ruling 2): the Queue ignores a row that does not carry by:"user".
const withBy = (row, by) => JSON.stringify(by === undefined ? row : { ...row, by }) + "\n";

test("loadSnapshot ignores a queue-admit row without by:user", async () => {
  for (const by of [undefined, "orchestrator", "User", "", null]) {
    await withRoot(async (root) => {
      await putTicket(root, "lone", "01-bare");
      const row = { kind: "queue-admit", ts: "2026-10-12T01:00:00Z", ref: "lone/01-bare", reason: "agent said so" };
      await writeFile(usagePath(root), withBy(row, by), "utf8");
      assert.deepEqual(gateRefusals(await loadSnapshot(root)).map((x) => x.ref), ["lone/01-bare"], `by=${JSON.stringify(by)}`);
    });
  }
});

test("loadSnapshot ignores a queue_active row without by:user, and a later user row still wins", async () => {
  for (const by of [undefined, "orchestrator", "User", ""]) {
    await withRoot(async (root) => {
      const base = { kind: "config", ts: "2026-10-12T01:00:00Z", queue_active: "intruder" };
      await writeFile(usagePath(root), withBy(base, by), "utf8");
      assert.equal((await loadSnapshot(root)).active, null, `by=${JSON.stringify(by)}`);
      const user = { kind: "config", ts: "2026-10-12T02:00:00Z", queue_active: "alpha", by: "user" };
      await writeFile(usagePath(root), withBy(base, by) + withBy(user), "utf8");
      assert.equal((await loadSnapshot(root)).active, "alpha");
      // an agent row AFTER the user's row does not displace it
      await writeFile(usagePath(root), withBy(user) + withBy({ ...base, ts: "2026-10-12T03:00:00Z" }, by), "utf8");
      assert.equal((await loadSnapshot(root)).active, "alpha", "a later non-user row is ignored");
    });
  }
});
