// organism-infra/147: dispatch-prompt script (scripts/dispatch-prompt.mjs) -- specify tests (qa).
//
// Seam (CLI): node scripts/dispatch-prompt.mjs --ticket <feature>/<NN-slug> --role <role> [--mode <m>]
//                                              [--base <sha> | --branch <b>] [--continue] [--batch <name>]
//   Run as a subprocess with DEN_ROOT pointing at a throwaway board root (no real board, no jg, no network).
//   stdout is the prompt text; bad arguments exit 2 with nothing on stdout; it writes nothing.
//
// Output contract these tests pin (one pinned fact per line of the ticket):
//   - one line holding `node scripts/agent-start.mjs ...` (flags tokenised on whitespace), plus a note naming the worktree;
//   - the ticket path `.scratch/<feature>/issues/<NN-slug>.md`;
//   - the handoff name `<NN>-<role>[-<mode>].md`, or `...-<k>.md` (k = 2, 3, ...) when an earlier name is already published;
//   - `Start-here context: <path>` only for architect, qa specify and developer, and only when dispatch-context gives a path;
//   - exactly one release flag form: `--status in-review`, `--keep-status`, or `--status ready-for-agent`; never `--status resolved`.
//
// Assumptions flagged in the handoff (the ticket leaves them open): designer `review` is not pinned to one release form;
// designer `critique` is a detached reviewer that keeps the status; designer `spec` and `direction` release at ready-for-agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./dispatch-prompt.mjs", import.meta.url));
const tmp = (p) => mkdtempSync(path.join(realpathSync(tmpdir()), p));

const FEATURE = "feat-x";
const SLUG = "07-sample-thing";
const REF = `${FEATURE}/${SLUG}`;
const SHA = "abc1234";
const BRANCH = "feature/feat-x-07";

const ticketText = (type = "research") =>
  `# 07: sample\n\n**Type:** ${type}\n\n**Priority:** P1\n\n## What to build\n\nSomething small.\n\n**Blocked by:** none\n\n**Status:** ready-for-agent\n\n## Comments\n`;

// A board root holding the ticket. withContext pre-creates the context file dispatch-context reuses (no jg needed);
// without it the ticket is a non-code type, so dispatch-context skips and prints path null.
function world({ withContext = false, handoffs = [] } = {}) {
  const root = tmp("dp147-root-");
  mkdirSync(path.join(root, ".scratch", FEATURE, "issues"), { recursive: true });
  writeFileSync(path.join(root, ".scratch", FEATURE, "issues", `${SLUG}.md`), ticketText());
  if (withContext) {
    mkdirSync(path.join(root, ".scratch", "_context", FEATURE), { recursive: true });
    writeFileSync(path.join(root, ".scratch", "_context", FEATURE, `${SLUG}.md`), "## scripts/a.mjs\nexcerpt\nEnd context.\n");
  }
  if (handoffs.length) {
    mkdirSync(path.join(root, ".scratch", FEATURE, "handoffs"), { recursive: true });
    for (const h of handoffs) writeFileSync(path.join(root, ".scratch", FEATURE, "handoffs", h), "old\n");
  }
  return root;
}

function run(args, { root, cwd } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 60000,
    cwd: cwd ?? root,
    env: { PATH: "/usr/bin:/bin", HOME: tmp("dp147-home-"), DEN_ROOT: root },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const base = (role, mode, extra = []) => [
  "--ticket", REF, "--role", role, ...(mode ? ["--mode", mode] : []), "--base", SHA, "--branch", BRANCH, ...extra,
];

const startLines = (out) => out.split("\n").filter((l) => l.includes("node scripts/agent-start.mjs"));
const tokens = (line) => line.trim().split(/\s+/);
const flagValue = (toks, flag) => {
  const i = toks.indexOf(flag);
  return i === -1 ? undefined : toks[i + 1];
};

// --- Criterion 1: table of agent-start flags and release flag per agent and mode -------------------------------------

const TABLE = [
  // agent, mode, branch-or-detach, release form
  { role: "qa", mode: "specify", style: "branch", release: "keep" },
  { role: "developer", mode: undefined, style: "branch", release: "in-review" },
  { role: "qa", mode: "verify", style: "detach", release: "keep" },
  { role: "security", mode: undefined, style: "detach", release: "keep" },
  { role: "designer", mode: "critique", style: "detach", release: "keep" },
  { role: "architect", mode: undefined, style: "either", release: "in-review" },
  { role: "designer", mode: "spec", style: "either", release: "ready-for-agent" },
  { role: "designer", mode: "direction", style: "either", release: "ready-for-agent" },
  // team-and-den-ux/02 (ADR 0029)
  { role: "code-reviewer", mode: undefined, style: "detach", release: "keep" },
  { role: "release-manager", mode: undefined, style: "detach", release: "keep" },
  { role: "sre", mode: undefined, style: "detach", release: "keep" },
  { role: "technical-writer", mode: undefined, style: "branch", release: "in-review" },
];

for (const row of TABLE) {
  const label = `${row.role}${row.mode ? ` ${row.mode}` : ""}`;

  test(`table: ${label} prints exactly one agent-start line with the right flags`, () => {
    const root = world();
    const r = run(base(row.role, row.mode), { root });
    assert.equal(r.status, 0, r.stderr);
    const lines = startLines(r.stdout);
    assert.equal(lines.length, 1, `expected one agent-start line, got:\n${r.stdout}`);
    const t = tokens(lines[0]);
    assert.equal(flagValue(t, "--base"), SHA);
    assert.equal(flagValue(t, "--ticket"), REF);
    assert.equal(flagValue(t, "--role"), row.role);
    assert.equal(flagValue(t, "--mode"), row.mode);
    if (row.style === "branch") {
      assert.equal(flagValue(t, "--branch"), BRANCH);
      assert.ok(!t.includes("--detach"), "a branch-writing agent must not detach");
    } else if (row.style === "detach") {
      assert.ok(t.includes("--detach"), "a reviewer starts detached");
      assert.ok(!t.includes("--branch"), "a reviewer must not get --branch");
    } else {
      assert.equal(t.includes("--detach") !== t.includes("--branch"), true, "exactly one of --detach / --branch");
    }
    assert.ok(!t.includes("--continue"), "no --continue unless asked");
    assert.ok(!t.includes("--force"), "never --force");
  });

  test(`table: ${label} prints the release flag ${row.release}`, () => {
    const root = world();
    const r = run(base(row.role, row.mode), { root });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/--status resolved/.test(r.stdout), "a relay agent never releases resolved");
    if (row.release === "keep") {
      assert.match(r.stdout, /--keep-status/);
      assert.ok(!/--status (in-review|ready-for-agent|blocked)/.test(r.stdout), r.stdout);
    } else {
      assert.match(r.stdout, new RegExp(`--status ${row.release}`));
      assert.ok(!/--keep-status/.test(r.stdout), r.stdout);
      const others = ["in-review", "ready-for-agent", "blocked"].filter((s) => s !== row.release);
      for (const s of others) assert.ok(!new RegExp(`--status ${s}`).test(r.stdout), `unexpected --status ${s}`);
    }
  });
}

test("table: designer review prints exactly one valid release form", () => {
  const r = run(base("designer", "review"), { root: world() });
  assert.equal(r.status, 0, r.stderr);
  const forms = [/--keep-status/, /--status in-review/, /--status ready-for-agent/].filter((re) => re.test(r.stdout));
  assert.equal(forms.length, 1, r.stdout);
  assert.ok(!/--status resolved/.test(r.stdout));
});

test("agent-start line: a note says it runs inside the agent's worktree", () => {
  const r = run(base("developer"), { root: world() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /worktree/i);
});

test("agent-start line: --continue is added on later hops, for branch and detach agents alike", () => {
  for (const [role, mode] of [["developer"], ["qa", "verify"], ["qa", "specify"], ["security"]]) {
    const r = run(base(role, mode, ["--continue"]), { root: world() });
    assert.equal(r.status, 0, r.stderr);
    const lines = startLines(r.stdout);
    assert.equal(lines.length, 1);
    assert.ok(tokens(lines[0]).includes("--continue"), `${role} ${mode ?? ""}: ${lines[0]}`);
  }
});

test("ticket path: includes issues/ and names the board file", () => {
  const r = run(base("developer"), { root: world() });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`.scratch/${FEATURE}/issues/${SLUG}.md`), r.stdout);
  assert.ok(!r.stdout.includes(`.scratch/${FEATURE}/${SLUG}.md`), "the path without issues/ is the old bug");
});

test("batch: --batch <name> shows the batch name in the prompt", () => {
  const r = run([...base("developer"), "--batch", "batch Z"], { root: world() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /batch Z/);
});

// --- Handoff path, including the re-dispatch scope item -------------------------------------------------------------

const NAME_CASES = [
  { role: "qa", mode: "specify", name: `07-qa-specify` },
  { role: "qa", mode: "verify", name: `07-qa-verify` },
  { role: "developer", mode: undefined, name: `07-developer` },
  { role: "security", mode: undefined, name: `07-security` },
  { role: "architect", mode: undefined, name: `07-architect` },
  { role: "designer", mode: "critique", name: `07-designer-critique` },
];

for (const c of NAME_CASES) {
  test(`handoff path: ${c.role}${c.mode ? ` ${c.mode}` : ""} writes ${c.name}.md first time`, () => {
    const r = run(base(c.role, c.mode), { root: world() });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`(?<![\\w-])${c.name}\\.md`));
    assert.ok(!new RegExp(`${c.name}-\\d+\\.md`).test(r.stdout), "no suffix on a first dispatch");
  });
}

test("handoff path: a re-dispatch after a partial gets a new name (-2) when the plain name is already published", () => {
  const root = world({ handoffs: ["07-qa-specify.md"] });
  const r = run(base("qa", "specify", ["--continue"]), { root });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /07-qa-specify-2\.md/);
  assert.ok(!/(?<![\w-])07-qa-specify\.md/.test(r.stdout), "the old name would be refused by board handoff");
});

test("handoff path: the suffix keeps counting (-3 once -2 exists)", () => {
  const root = world({ handoffs: ["07-developer.md", "07-developer-2.md"] });
  const r = run(base("developer", undefined, ["--continue"]), { root });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /07-developer-3\.md/);
  assert.ok(!/07-developer-2\.md/.test(r.stdout));
  assert.ok(!/(?<![\w-])07-developer\.md/.test(r.stdout));
});

test("handoff path: another agent's or mode's handoff does not bump the suffix", () => {
  const root = world({ handoffs: ["07-qa-specify.md", "07-orchestrator.md", "07-developer.md"] });
  const r = run(base("qa", "verify"), { root });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /(?<![\w-])07-qa-verify\.md/);
  assert.ok(!/07-qa-verify-\d+\.md/.test(r.stdout));
});

// --- Criterion 3: the Start-here line ------------------------------------------------------------------------------

const START_HERE = /Start-here context: \S*\.scratch\/_context\/feat-x\/07-sample-thing\.md/;

for (const [role, mode] of [["architect"], ["qa", "specify"], ["developer"]]) {
  test(`start-here: ${role}${mode ? ` ${mode}` : ""} gets the line when dispatch-context gives a path`, () => {
    const r = run(base(role, mode), { root: world({ withContext: true }) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, START_HERE);
  });

  test(`start-here: ${role}${mode ? ` ${mode}` : ""} gets no line when dispatch-context gives no path`, () => {
    const r = run(base(role, mode), { root: world({ withContext: false }) });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/Start-here/i.test(r.stdout), r.stdout);
  });
}

for (const [role, mode] of [
  ["qa", "verify"], ["security"], ["designer", "spec"], ["designer", "review"], ["designer", "critique"], ["designer", "direction"],
]) {
  test(`start-here: ${role}${mode ? ` ${mode}` : ""} never gets the line, even when a context file exists`, () => {
    const r = run(base(role, mode), { root: world({ withContext: true }) });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/Start-here/i.test(r.stdout), r.stdout);
    assert.ok(!r.stdout.includes("_context"), "the context path must not leak to other agents");
  });
}

// --- Criterion 2 and bad arguments: exit 2, nothing on stdout ------------------------------------------------------

test("ticket ref that does not resolve to .scratch/<feature>/issues/<NN-slug>.md exits 2", () => {
  const r = run(["--ticket", `${FEATURE}/99-nope`, "--role", "developer", "--base", SHA, "--branch", BRANCH], { root: world() });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /99-nope/);
});

test("ticket ref with an unknown feature exits 2", () => {
  const r = run(["--ticket", `no-such/${SLUG}`, "--role", "developer", "--base", SHA, "--branch", BRANCH], { root: world() });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
});

test("the old bug: a ticket file at .scratch/<feature>/<NN-slug>.md (no issues/) does not resolve, exits 2", () => {
  const root = world();
  writeFileSync(path.join(root, ".scratch", FEATURE, "08-stray.md"), ticketText());
  const r = run(["--ticket", `${FEATURE}/08-stray`, "--role", "developer", "--base", SHA, "--branch", BRANCH], { root });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
});

const BAD_ARGS = [
  ["no --ticket", ["--role", "developer", "--base", SHA, "--branch", BRANCH]],
  ["no --role", ["--ticket", REF, "--base", SHA, "--branch", BRANCH]],
  ["unknown role", ["--ticket", REF, "--role", "wizard", "--base", SHA, "--branch", BRANCH]],
  ["qa without --mode", ["--ticket", REF, "--role", "qa", "--base", SHA, "--branch", BRANCH]],
  ["qa with an unknown mode", ["--ticket", REF, "--role", "qa", "--mode", "bogus", "--base", SHA, "--branch", BRANCH]],
  ["designer with an unknown mode", ["--ticket", REF, "--role", "designer", "--mode", "bogus", "--base", SHA, "--branch", BRANCH]],
  ["unknown flag", ["--ticket", REF, "--role", "developer", "--base", SHA, "--branch", BRANCH, "--frobnicate"]],
  ["--ticket without a value", ["--role", "developer", "--ticket"]],
  ["malformed ticket ref", ["--ticket", "../etc/passwd", "--role", "developer", "--base", SHA, "--branch", BRANCH]],
];

for (const [label, args] of BAD_ARGS) {
  test(`bad arguments exit 2 with nothing on stdout: ${label}`, () => {
    const r = run(args, { root: world() });
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.ok(r.stderr.length > 0, "the reason goes to stderr");
  });
}

// --- It writes nothing ----------------------------------------------------------------------------------------------

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[path.relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

test("it writes nothing: the board root and the working directory are unchanged after a run", () => {
  const root = world({ withContext: true, handoffs: ["07-developer.md"] });
  const cwd = tmp("dp147-cwd-");
  const before = { root: snapshot(root), cwd: snapshot(cwd) };
  const r = run(base("developer", undefined, ["--continue"]), { root, cwd });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(root), before.root);
  assert.deepEqual(snapshot(cwd), before.cwd);
  assert.ok(!existsSync(path.join(root, ".scratch", "usage.jsonl")), "no usage row");
});

// --- Criterion 4 (the role definition diff in the handoff) is human-verified: no test. ---------------------------------------
