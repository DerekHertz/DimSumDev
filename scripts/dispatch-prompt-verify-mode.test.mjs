// organism-infra/207: dispatch-prompt prints the qa verify mode (light or full) -- specify tests (qa).
//
// Seam (CLI): node scripts/dispatch-prompt.mjs --ticket <ref> --role qa --mode verify --base <sha>
//   Run as a subprocess with DEN_ROOT pointing at a throwaway board root (as dispatch-prompt.test.mjs does).
//
// Criterion map:
//   1. qa verify prints `Verify mode: light` when a published qa-specify handoff exists for the ticket, `Verify mode: full`
//      otherwise                                   -> "light" and "full" tests (exactly one line; light names the handoff path;
//                                                    -2 re-dispatch name counts; other tickets, other agents, other modes and a
//                                                    number that only ends the same way (107 vs 07) do not count)
//   2. other agents and modes print no such line    -> "no line" tests (qa specify even with a specify handoff, developer, security,
//                                                    designer spec/review, architect)
//   3. role definition edit as an exact diff in the developer handoff -> human-verified (gated .claude edit, applied by the user)
//   4. npm test green                              -> the whole suite, run by verify
// Assumption flagged in the handoff: the exact wording after "Verify mode: light" (the parenthetical) is not pinned beyond
// naming the handoff path; the ticket's example text is "(qa specify ran for this ticket: <handoff path>)".
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./dispatch-prompt.mjs", import.meta.url));
const tmp = (p) => mkdtempSync(path.join(realpathSync(tmpdir()), p));

const FEATURE = "feat-x";
const SLUG = "07-sample-thing";
const REF = `${FEATURE}/${SLUG}`;
const SHA = "abc1234";

function world({ handoffs = [] } = {}) {
  const root = tmp("dp207-root-");
  mkdirSync(path.join(root, ".scratch", FEATURE, "issues"), { recursive: true });
  writeFileSync(
    path.join(root, ".scratch", FEATURE, "issues", `${SLUG}.md`),
    "# 07: sample\n\n**Type:** chore\n\n**Priority:** P1\n\n## What to build\n\nx\n\n**Blocked by:** none\n\n**Status:** in-review\n\n## Comments\n",
  );
  if (handoffs.length) {
    mkdirSync(path.join(root, ".scratch", FEATURE, "handoffs"), { recursive: true });
    for (const h of handoffs) writeFileSync(path.join(root, ".scratch", FEATURE, "handoffs", h), "old\n");
  }
  return root;
}

function run(args, root) {
  const r = spawnSync(process.execPath, [SCRIPT, "--ticket", REF, "--base", SHA, ...args], {
    encoding: "utf8",
    timeout: 60000,
    cwd: root,
    env: { PATH: "/usr/bin:/bin", HOME: tmp("dp207-home-"), DEN_ROOT: root },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const verify = (root, extra = []) => run(["--role", "qa", "--mode", "verify", ...extra], root);
const modeLines = (stdout) => stdout.split("\n").filter((l) => /verify mode/i.test(l));

// --- Criterion 1: light when a qa-specify handoff is published, full otherwise -----------------------------------------

test("qa verify with a published 07-qa-specify.md prints one `Verify mode: light` line", () => {
  const root = world({ handoffs: ["07-qa-specify.md"] });
  const r = verify(root);
  assert.equal(r.status, 0, r.stderr);
  const lines = modeLines(r.stdout);
  assert.equal(lines.length, 1, r.stdout);
  assert.match(lines[0], /^Verify mode: light\b/);
});

test("the light line names the qa-specify handoff path", () => {
  const root = world({ handoffs: ["07-qa-specify.md"] });
  const r = verify(root);
  assert.equal(r.status, 0, r.stderr);
  const [line] = modeLines(r.stdout);
  assert.ok(line?.includes(path.join(root, ".scratch", FEATURE, "handoffs", "07-qa-specify.md")), r.stdout);
});

test("qa verify with no handoffs at all prints one `Verify mode: full` line", () => {
  const r = verify(world());
  assert.equal(r.status, 0, r.stderr);
  const lines = modeLines(r.stdout);
  assert.equal(lines.length, 1, r.stdout);
  assert.match(lines[0], /^Verify mode: full\b/);
  assert.ok(!/light/i.test(lines[0]), "the full line does not mention light");
});

test("a re-dispatched specify handoff (07-qa-specify-2.md, no plain name) still counts as light", () => {
  const r = verify(world({ handoffs: ["07-qa-specify-2.md"] }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(modeLines(r.stdout)[0] ?? "", /^Verify mode: light\b/);
});

test("other agents' handoffs on this ticket do not make it light (developer, orchestrator, an earlier qa verify)", () => {
  const r = verify(world({ handoffs: ["07-developer.md", "07-orchestrator.md", "07-qa-verify.md", "07-security.md"] }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(modeLines(r.stdout)[0] ?? "", /^Verify mode: full\b/);
});

test("another ticket's qa-specify handoff does not make this one light (08- and 107-)", () => {
  const r = verify(world({ handoffs: ["08-qa-specify.md", "107-qa-specify.md", "17-qa-specify.md"] }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(modeLines(r.stdout)[0] ?? "", /^Verify mode: full\b/);
});

test("a file that merely contains 'qa-specify' in its name (07-qa-specify-notes.txt) does not count", () => {
  const r = verify(world({ handoffs: ["07-qa-specify-notes.txt"] }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(modeLines(r.stdout)[0] ?? "", /^Verify mode: full\b/);
});

test("the mode line works alongside --tests and the usual verify lines", () => {
  const root = world({ handoffs: ["07-qa-specify.md"] });
  const file = path.join(tmp("dp207-files-"), "07-tests.txt");
  writeFileSync(file, "# pass 3\n");
  const r = verify(root, ["--tests", file]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(modeLines(r.stdout).length, 1, r.stdout);
  assert.match(r.stdout, /Verify mode: light/);
  assert.match(r.stdout, /node scripts\/agent-start\.mjs .*--detach/);
  assert.match(r.stdout, /07-qa-verify\.md/);
  assert.ok(r.stdout.includes(file));
});

test("the mode is decided from handoffs alone: --continue does not change it", () => {
  const r = verify(world({ handoffs: ["07-qa-specify.md"] }), ["--continue"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(modeLines(r.stdout)[0] ?? "", /^Verify mode: light\b/);
});

// --- Criterion 2: other agents and modes print no such line -------------------------------------------------------------

const OTHERS = [
  { name: "qa specify", args: ["--role", "qa", "--mode", "specify", "--branch", "feat/x"] },
  { name: "developer", args: ["--role", "developer", "--branch", "feat/x"] },
  { name: "security", args: ["--role", "security"] },
  { name: "architect", args: ["--role", "architect"] },
  { name: "designer spec", args: ["--role", "designer", "--mode", "spec"] },
  { name: "designer review", args: ["--role", "designer", "--mode", "review"] },
  { name: "designer critique", args: ["--role", "designer", "--mode", "critique"] },
  { name: "designer direction", args: ["--role", "designer", "--mode", "direction"] },
];

for (const o of OTHERS) {
  for (const handoffs of [[], ["07-qa-specify.md"]]) {
    test(`${o.name} prints no verify-mode line (${handoffs.length ? "with" : "without"} a qa-specify handoff)`, () => {
      const r = run(o.args, world({ handoffs }));
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(modeLines(r.stdout), [], r.stdout);
    });
  }
}

// --- Criterion 3 (the role definition diff in the developer handoff) is human-verified: no test. -------------------------------
