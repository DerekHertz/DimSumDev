// den-mvp outcome 3: the pure parts of a delivery. The plan over a job's record, the paths whose change is the user's
// to merge, a reviewer's verdict line, the step prompts, the delivery log's replay, and the git-host argument lists.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { nextStep, isCiPath, isUserMergePath, MAX_BOUNCES, MAX_SYNC_ROUNDS } from "./plan.mjs";
import { deliveryPrompt, readLookAt, readVerdict } from "./prompts.mjs";
import { createJobLog, validateJob } from "./jobs.mjs";
import { createGitHost } from "./git-host.mjs";

const BASE = "a".repeat(40), SHA = "b".repeat(40), OLD = "c".repeat(40), RUN = "c-0123456789abcdef";
const BRANCH = "den/fx/08-plain-01234567";
const riskOf = (more = {}) => ({ sha: SHA, clean: true, hits: 0, secret: false, security: false, userMerge: false, ...more });
const job = (evidence = {}, more = {}) => ({ base: BASE, candidate: { sha: SHA }, bounces: 0, visual: false, evidence, ...more });
// F29: before the push the candidate is merged with main (a dry run); a clean result is part of "passed".
const MAIN = "d".repeat(40);
const synced = (more = {}) => ({ sha: SHA, main: MAIN, conflicts: [], at: "push", ...more });
const passed = { qa: { sha: SHA, verdict: "pass" }, risk: riskOf(), sync: synced() };
const open = { ...passed, pr: { sha: SHA, state: "OPEN", mergeable: "MERGEABLE" } };
const green = { ...open, ci: { sha: SHA, state: "green" } };

describe("the delivery plan", () => {
  test("local checks that could not run wait for the user, and red twice is failed-twice", () => {
    const err = nextStep(job({ ...passed, tests: { sha: SHA, state: "error", reason: "bwrap is not installed" } }, { localChecks: true }));
    assert.equal(err.pause, "checks-error");
    assert.match(err.reason, /bwrap is not installed/);
    assert.equal(nextStep(job({ ...passed, tests: { sha: SHA, state: "red" } }, { localChecks: true, bounces: MAX_BOUNCES })).pause, "failed-twice");
  });

  // den-mvp/70: with the test guard on, it runs on the candidate before any verifier sees it.
  test("the test guard runs before qa verifies, once per candidate, and only for a job that has it", () => {
    assert.deepEqual(nextStep(job({}, { testGuard: true })), { kind: "guard" });
    assert.deepEqual(nextStep(job({ guard: { sha: OLD, hits: [] } }, { testGuard: true })), { kind: "guard" });
    assert.deepEqual(nextStep(job({ guard: { sha: SHA, hits: ["a.test.mjs: test file deleted"] } }, { testGuard: true })), { kind: "run", role: "qa", mode: "verify", at: SHA, since: BASE });
    assert.deepEqual(nextStep(job({}, {})), { kind: "run", role: "qa", mode: "verify", at: SHA, since: BASE });
  });

  const rows = [
    ["no candidate: a developer at the base", { base: BASE, candidate: null, bounces: 0, evidence: {} }, { kind: "run", role: "developer", at: BASE, since: BASE }],
    ["a candidate: qa verifies it", job(), { kind: "run", role: "qa", mode: "verify", at: SHA, since: BASE }],
    ["a qa pass for an older commit does not count", job({ qa: { sha: OLD, verdict: "pass" } }), { kind: "run", role: "qa", mode: "verify", at: SHA, since: BASE }],
    ["a qa bounce: the developer fixes it, from the candidate", job({ qa: { sha: SHA, verdict: "bounce" } }, { bounces: 1 }), { kind: "run", role: "developer", at: SHA, since: BASE, fix: true }],
    ["qa passed: the scripted checks", job({ qa: passed.qa }), { kind: "check" }],
    ["a risk hit: security reviews", job({ ...passed, risk: riskOf({ clean: false, hits: 2, security: true }) }), { kind: "run", role: "security", at: SHA, since: BASE }],
    ["a red check, counted as a bounce: the developer fixes it from the candidate", job({ ...open, ci: { sha: SHA, state: "red", failed: ["test"] } }, { bounces: 1 }), { kind: "run", role: "developer", at: SHA, since: BASE, fix: true }],
    ["a timed-out check: run again", job({ ...open, ci: { sha: SHA, state: "timeout", failed: ["test"] } }), { kind: "ci-rerun" }],
    ["a security bounce: the developer fixes it", job({ ...passed, risk: riskOf({ security: true }), security: { sha: SHA, verdict: "bounce" } }, { bounces: 1 }), { kind: "run", role: "developer", at: SHA, since: BASE, fix: true }],
    ["clean: publish", job(passed), { kind: "publish" }],
    ["security passed: publish", job({ ...passed, risk: riskOf({ security: true }), security: { sha: SHA, verdict: "pass" } }), { kind: "publish" }],
    ["a pull request: its checks", job(open), { kind: "ci" }],
    ["green and mergeable: merge", job(green), { kind: "merge" }],
    ["merged: resolve the ticket", job({ ...passed, pr: { sha: SHA, state: "MERGED" } }), { kind: "resolve" }],
    ["a ui ticket with the user's verdict: merge", job({ ...green, verdict: { sha: SHA, ok: true } }, { visual: true }), { kind: "merge" }],
    // den-mvp/34: the checks of ci.yml, run here, between the scripted check and security or the push.
    ["local checks: run after the scripted check", job(passed, { localChecks: true }), { kind: "tests" }],
    ["local checks of an older commit do not count", job({ ...passed, tests: { sha: OLD, state: "green" } }, { localChecks: true }), { kind: "tests" }],
    ["local checks green: publish", job({ ...passed, tests: { sha: SHA, state: "green" } }, { localChecks: true }), { kind: "publish" }],
    ["local checks only flaked: publish", job({ ...passed, tests: { sha: SHA, state: "flaky" } }, { localChecks: true }), { kind: "publish" }],
    ["local checks skipped (the lockfile changed): GitHub decides", job({ ...passed, tests: { sha: SHA, state: "skipped" } }, { localChecks: true }), { kind: "publish" }],
    ["local checks green and a risk hit: security next", job({ ...passed, risk: riskOf({ security: true }), tests: { sha: SHA, state: "green" } }, { localChecks: true }), { kind: "run", role: "security", at: SHA, since: BASE }],
    ["local checks red, counted as a bounce: the developer fixes it", job({ ...passed, tests: { sha: SHA, state: "red" } }, { localChecks: true, bounces: 1 }), { kind: "run", role: "developer", at: SHA, since: BASE, fix: true }],
    ["a job started without local checks never runs them", job(passed), { kind: "publish" }],
    // F29: a branch that no longer merges with main goes back to the developer to merge it, before anything is pushed.
    ["checked and clean, not yet merged with main: the merge check", job({ qa: passed.qa, risk: riskOf() }), { kind: "sync" }],
    ["a merge check of an older commit does not count", job({ ...passed, sync: synced({ sha: OLD }) }), { kind: "sync" }],
    ["it conflicts with main: the developer merges main, and it is not a bounce", job({ ...passed, sync: synced({ conflicts: ["apps/bridge/cells/host.mjs"] }) }), { kind: "run", role: "developer", at: SHA, since: BASE, fix: true, sync: MAIN }],
    ["the pull request conflicts though the push-time check was clean (main moved): check again", job({ ...green, pr: { sha: SHA, state: "OPEN", mergeable: "CONFLICTING" } }), { kind: "sync", at: "pr" }],
    ["a conflicting pull request is checked before its missing checks are waited on", job({ ...open, pr: { sha: SHA, state: "OPEN", mergeable: "CONFLICTING" }, ci: { sha: SHA, state: "none" } }), { kind: "sync", at: "pr" }],
    ["the check after the pull request finds the conflict: the developer merges main", job({ ...green, pr: { sha: SHA, state: "OPEN", mergeable: "CONFLICTING" }, sync: synced({ at: "pr", conflicts: ["a.mjs"] }) }), { kind: "run", role: "developer", at: SHA, since: BASE, fix: true, sync: MAIN }],
  ];
  for (const [name, input, want] of rows) test(name, () => assert.deepEqual(nextStep(input), want));

  const pauses = [
    ["the second bounce", job({ qa: { sha: SHA, verdict: "bounce" } }, { bounces: MAX_BOUNCES }), "failed-twice"],
    ["a line that looks like a secret", job({ ...passed, risk: riskOf({ secret: true }) }), "possible-secret"],
    ["a red check after the work was sent back twice", job({ ...open, ci: { sha: SHA, state: "red", failed: ["test"] } }, { bounces: MAX_BOUNCES }), "failed-twice"],
    ["no check at all", job({ ...open, ci: { sha: SHA, state: "none" } }), "no-checks"],
    ["checks still running", job({ ...open, ci: { sha: SHA, state: "pending" } }), "ci-pending"],
    ["a guardrail path, even when all is green", job({ ...green, risk: riskOf({ security: true, userMerge: true }), security: { sha: SHA, verdict: "pass" } }), "guardrail"],
    ["a ui ticket with no verdict", job(green, { visual: true }), "visual-verdict"],
    ["a ui verdict for an older commit", job({ ...green, verdict: { sha: OLD, ok: true } }, { visual: true }), "visual-verdict"],
    ["the git host says conflict, a fresh merge of main says clean", job({ ...green, pr: { sha: SHA, state: "OPEN", mergeable: "CONFLICTING" }, sync: synced({ at: "pr" }) }), "conflict"],
    ["still conflicting after the merge rounds", job({ ...passed, sync: synced({ conflicts: ["a.mjs"] }) }, { syncRounds: MAX_SYNC_ROUNDS }), "conflict"],
    ["mergeability not known", job({ ...green, pr: { sha: SHA, state: "OPEN", mergeable: "UNKNOWN" } }), "not-mergeable"],
  ];
  // den-mvp/10 (ADR 0026 decisions 5 and 6): a candidate that changes apps/ui/ is previewed and approved before the push,
  // and goes live after the merge.
  const unreviewed = { qa: passed.qa, risk: riskOf({ ui: true }), sync: synced() };
  const ui = { ...unreviewed, security: { sha: SHA, verdict: "pass" } };
  const built = { ...ui, preview: { sha: SHA, ok: true } };
  const approved = { ...built, verdict: { sha: SHA, ok: true } };
  const merged = { ...approved, pr: { sha: SHA, state: "MERGED" } };
  const uiRows = [
    ["a change under apps/ui/: its preview is built before anything is pushed", job(ui), { kind: "preview" }],
    ["a ui ticket type whose change is under apps/ui/: the same", job(ui, { visual: true }), { kind: "preview" }],
    ["a preview for an older commit does not count", job({ ...ui, preview: { sha: OLD, ok: true } }), { kind: "preview" }],
    ["UI code is reviewed by security before its preview, whatever the scripted check said", job(unreviewed), { kind: "run", role: "security", at: SHA, since: BASE }],
    ["a security pass for an older commit does not count", job({ ...unreviewed, security: { sha: OLD, verdict: "pass" } }), { kind: "run", role: "security", at: SHA, since: BASE }],
    ["approved: publish", job(approved), { kind: "publish" }],
    ["approved, open: its checks", job({ ...approved, pr: open.pr }), { kind: "ci" }],
    ["approved and green: merge, with no second verdict", job({ ...approved, pr: open.pr, ci: green.ci }, { visual: true }), { kind: "merge" }],
    ["declined: the developer runs again with the note", job({ ...built, verdict: { sha: SHA, ok: false } }), { kind: "run", role: "developer", at: SHA, since: BASE, fix: true }],
    ["declined many times over: still the developer, never failed-twice", job({ ...built, verdict: { sha: SHA, ok: false } }, { declines: 5, bounces: 1 }), { kind: "run", role: "developer", at: SHA, since: BASE, fix: true }],
    ["a decline of an older commit does not count: the new one is verified", job({ verdict: { sha: OLD, ok: false }, preview: { sha: OLD, ok: true } }, { declines: 2 }), { kind: "run", role: "qa", mode: "verify", at: SHA, since: BASE }],
    ["a security bounce of UI code: the developer fixes it, and no preview is built", job({ ...unreviewed, security: { sha: SHA, verdict: "bounce" } }, { bounces: 1 }), { kind: "run", role: "developer", at: SHA, since: BASE, fix: true }],
    ["a preview that did not build: back to the developer as a failed check", job({ ...ui, preview: { sha: SHA, ok: false } }, { bounces: 1 }), { kind: "run", role: "developer", at: SHA, since: BASE, fix: true }],
    ["merged: the change goes live", job(merged), { kind: "go-live" }],
    ["merged and live: resolve the ticket", job({ ...merged, live: { sha: SHA, state: "live", release: OLD } }), { kind: "resolve" }],
    ["a go-live for an older commit does not count", job({ ...merged, live: { sha: OLD, state: "live", release: OLD } }), { kind: "go-live" }],
    ["merged with nothing under apps/ui/: no release, resolve", job({ ...passed, pr: { sha: SHA, state: "MERGED" } }, { visual: true }), { kind: "resolve" }],
  ];
  for (const [name, input, want] of uiRows) test(name, () => assert.deepEqual(nextStep(input), want));

  const uiPauses = [
    ["a built preview with no verdict", job(built), "visual-verdict"],
    ["a verdict for an older commit", job({ ...built, verdict: { sha: OLD, ok: true } }), "visual-verdict"],
    ["a preview that did not build, the second failed check", job({ ...ui, preview: { sha: SHA, ok: false } }, { bounces: MAX_BOUNCES }), "failed-twice"],
    ["red checks after the approval, the second bounce: nothing is merged and nothing goes live", job({ ...approved, pr: open.pr, ci: { sha: SHA, state: "red", failed: ["test"] } }, { bounces: MAX_BOUNCES }), "failed-twice"],
    ["a guardrail path with a ui change: the merge is the user's", job({ ...approved, risk: riskOf({ ui: true, security: true, userMerge: true }), pr: open.pr, ci: green.ci }), "guardrail"],
    ["a merged commit the running bridge is behind", job({ ...merged, live: { sha: SHA, state: "needs-update", reason: "the merged commit changes apps/bridge" } }), "needs-update"],
    ["a go-live build that failed", job({ ...merged, live: { sha: SHA, state: "failed", reason: "the build failed (exit 1)" } }), "go-live-failed"],
  ];
  for (const [name, input, kind] of [...uiPauses]) {
    test(`pauses for ${name}`, () => {
      const step = nextStep(input);
      assert.equal(step.kind, "pause");
      assert.equal(step.pause, kind);
      assert.ok(step.reason && step.next, "a pause says why and what to do next");
    });
  }
  test("two declines then a pass does not pause as failed-twice", () => {
    const after = job({ ...approved }, { declines: 2, bounces: 0 });
    assert.deepEqual(nextStep(after), { kind: "publish" });
    assert.notEqual(nextStep(job(built, { declines: MAX_BOUNCES + 3 })).pause, "failed-twice");
  });

  for (const [name, input, kind] of pauses) {
    test(`pauses for ${name}`, () => {
      const step = nextStep(input);
      assert.equal(step.kind, "pause");
      assert.equal(step.pause, kind);
      assert.ok(step.reason && step.next, "a pause says why and what to do next");
    });
  }

  test("every missing or stale prerequisite keeps the merge away", () => {
    for (const key of ["qa", "risk", "pr", "ci"]) {
      const without = { ...green, [key]: undefined };
      const stale = { ...green, [key]: { ...green[key], sha: OLD } };
      assert.notEqual(nextStep(job(without)).kind, "merge", `without ${key}`);
      assert.notEqual(nextStep(job(stale)).kind, "merge", `with ${key} for another commit`);
    }
  });

  test("the paths whose change the user merges: the guardrails, the bridge, the checks and the manifest", () => {
    for (const p of [".claude/agents/developer.md", ".github/workflows/ci.yml", "apps/bridge/cells/host.mjs", "apps/bridge/delivery/plan.mjs", "apps/bridge/cells/governance.json", "scripts/risk-check.mjs", "package.json"]) assert.equal(isUserMergePath(p), true, p);
    for (const p of ["apps/ui/src/App.jsx", "docs/adr/0001.md", "apps/bridgework/x.mjs", "apps/ui/package.json", "apps/ui/.eslintrc", "CONTEXT.md", "packages/board-refs/index.mjs"]) assert.equal(isUserMergePath(p), false, p);
    // What runs by itself on the user's machine or on the git host, the board and gate code, and every root dot path.
    for (const p of ["scripts/session-start.mjs", "scripts/hooks/bash-guard.mjs", "scripts/metrics.mjs", "apps/organism-infra/board-service.mjs", "apps/ci-cd/smoke.mjs", "mods/queue/hooks.mjs", "CLAUDE.md", "AGENTS.md", "skills-lock.json", ".gitattributes", ".gitmodules", ".npmrc", ".mcp.json", ".agents/skills/tdd/SKILL.md", ".cursor/settings.json", ".codex/config.toml", ".claude-plugin/plugin.json", ".gitleaks.toml"]) assert.equal(isUserMergePath(p), true, p);
    for (const p of [".github/workflows/ci.yml", ".github/actions/setup/action.yml", ".github/CODEOWNERS"]) assert.deepEqual([isCiPath(p), isUserMergePath(p)], [true, true], p);
    for (const p of ["apps/bridge/cells/host.mjs", "package-lock.json"]) assert.deepEqual([isCiPath(p), isUserMergePath(p)], [false, true], p);
  });
});

describe("a reviewer's verdict and the step prompts", () => {
  test("the verdict is the last verdict line, whatever dresses it", () => {
    assert.equal(readVerdict("All good.\nVERDICT: pass"), "pass");
    assert.equal(readVerdict("**VERDICT: bounce**\n"), "bounce");
    assert.equal(readVerdict("VERDICT: pass\nOn reflection:\n- `VERDICT: bounce`"), "bounce");
    assert.equal(readVerdict("I would say the verdict: pass is likely"), null);
    assert.equal(readVerdict("VERDICT: maybe"), null);
    assert.equal(readVerdict(null), null);
  });

  test("readLookAt reads the last Look at list of a report, as plain one-line items", () => {
    assert.deepEqual(readLookAt("Done.\n\n**Look at:**\n\n- the Needs you card: a note box\n2. Esc closes it\n\nChecks: pass"), ["the Needs you card: a note box", "Esc closes it"]);
    assert.deepEqual(readLookAt("Look at: the logo pill only"), ["the logo pill only"]);
    assert.deepEqual(readLookAt("Look at:\n- old\n\nLook at:\n- new"), ["new"]);
    assert.deepEqual(readLookAt("No list here."), []);
    assert.deepEqual(readLookAt(null), []);
    assert.equal(readLookAt("Look at:\n" + "- x\n".repeat(9)).length, 6);
    assert.deepEqual(readLookAt("Look at:\n- a\u202eb\u0007c"), ["a b c"]);
    assert.match(deliveryPrompt({ role: "developer", ref: "fx/08-plain", ticketFile: "/t.md", since: BASE }), /end the report with a `Look at:` line/);
  });

  test("a prompt names the ticket file and the commit, tells the agent the bridge does the board and the push, and asks a reviewer for a verdict line", () => {
    const dev = deliveryPrompt({ role: "developer", ref: "fx/08-plain", ticketFile: "/r/.scratch/fx/issues/08-plain.md", since: BASE });
    assert.match(dev, /developer cell for ticket fx\/08-plain/);
    assert.match(dev, /Run no board command, and do not push/);
    // Friction log F2 and F4: foreground checks under timeout, throwaway scripts under .den/.
    assert.match(dev, /in the foreground under `timeout`.*never in the background/);
    assert.match(dev, /throwaway script under \.den\/ in this worktree/);
    // Friction log F17: the Bash tool's own timeout, and node --test under the process limit.
    assert.match(dev, /set the Bash tool's own timeout/);
    assert.match(dev, /--test-concurrency=2/);
    assert.match(dev, /\/r\/\.scratch\/fx\/issues\/08-plain\.md/);
    assert.doesNotMatch(dev, /findings\.md|VERDICT/);
    assert.match(deliveryPrompt({ role: "developer", ref: "fx/08-plain", ticketFile: "/t.md", since: BASE, fix: true }), /read \.den\/findings\.md first/);
    const qa = deliveryPrompt({ role: "qa", mode: "verify", ref: "fx/08-plain", ticketFile: "/t.md", since: BASE });
    assert.match(qa, /qa cell in verify mode/);
    assert.match(qa, new RegExp(`git diff ${BASE}\\.\\.HEAD`));
    assert.match(qa, /`VERDICT: pass` or `VERDICT: bounce`/);
    assert.match(deliveryPrompt({ role: "security", ref: "fx/08-plain", ticketFile: "/t.md", since: BASE }), /for security/);
  });
});

describe("the delivery log", () => {
  const record = (more = {}) => ({
    id: "d-0123456789abcdef", ref: "fx/08-plain", title: "08: Plain", type: "feature", state: "running", base: BASE, branch: BRANCH, startedAt: "2026-10-13T00:00:00.000Z",
    candidate: { sha: SHA, runId: RUN }, evidence: { qa: { sha: SHA, runId: RUN, verdict: "pass" } }, bounces: 1, live: { runId: RUN, role: "qa", mode: "verify" }, claimed: true, runs: [], ...more,
  });

  test("a record reads back with its checked fields, and nothing the git host said is kept as evidence", () => {
    const job = validateJob(record({ evidence: { qa: { sha: SHA, runId: RUN, verdict: "pass" }, pr: { sha: SHA, state: "MERGED" }, ci: { sha: SHA, state: "green" } }, evil: "rm -rf" }));
    assert.equal(job.evil, undefined);
    assert.deepEqual(job.evidence.qa, { sha: SHA, runId: RUN, verdict: "pass" });
    assert.equal(job.evidence.pr, null, "the pull request is asked for again");
    assert.equal(job.evidence.ci, null, "the checks are asked for again");
    assert.deepEqual(job.live, { runId: RUN, role: "qa", mode: "verify" });
  });

  test("den-mvp/34: a local run of the checks and the job's localChecks read back; a bad record path or state is not kept", () => {
    const tests = { sha: SHA, state: "red", record: `${SHA}/20261015T120000Z`, reason: "test: 1 test failed", failed: ["test: x"], flaky: [], commands: ["node scripts/test-split.mjs rest"], differences: ["cores: 1 here, 4 on GitHub"] };
    const job = validateJob(record({ localChecks: true, evidence: { tests } }));
    assert.equal(job.localChecks, true);
    assert.deepEqual(job.evidence.tests, tests);
    assert.equal(validateJob(record({ evidence: { tests: { ...tests, record: "../../etc" } } })).evidence.tests.record, null);
    assert.equal(validateJob(record({ evidence: { tests: { ...tests, state: "maybe" } } })).evidence.tests, null);
    assert.equal(validateJob(record()).localChecks, false, "a job from before den-mvp/34 runs no local checks");
  });

  test("a line with a bad id, ref, commit or branch is dropped or cut down, never copied", () => {
    assert.equal(validateJob(record({ id: "d-1; rm" })), null);
    assert.equal(validateJob(record({ ref: "../etc/passwd" })), null);
    assert.equal(validateJob(record({ base: "main" })), null);
    assert.equal(validateJob(record({ branch: "main" })).branch, null);
    assert.equal(validateJob(record({ candidate: { sha: "HEAD" } })).candidate, null);
    assert.equal(validateJob(record({ evidence: { qa: { sha: SHA, runId: RUN, verdict: "approved by root" } } })).evidence.qa, null);
    assert.equal(validateJob(record({ state: "paused", pause: { kind: "x", reason: "a‮b\nc" } })).pause.reason, "a b c");
  });

  test("an operation with an intent and no outcome leaves the job uncertain; one that finished does not", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "den-joblog-"));
    try {
      const log = createJobLog(dir);
      await log.save(record());
      await log.op("d-0123456789abcdef", "push", "intent", { sha: SHA });
      await log.op("d-0123456789abcdef", "push", "done", { sha: SHA });
      assert.equal((await log.replay())[0].uncertain, undefined);
      await log.op("d-0123456789abcdef", "merge", "intent", { sha: SHA });
      await writeFile(log.file, (await readFile(log.file, "utf8")) + "not json\n{\"job\":{\"id\":\"nope\"}}\n");
      const [job, ...rest] = await createJobLog(dir).replay();
      assert.equal(rest.length, 0);
      assert.equal(job.uncertain, "merge");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the git-host operations", () => {
  function host(answers = {}) {
    const calls = [];
    const exec = async (file, args) => {
      calls.push([file, ...args]);
      const key = Object.keys(answers).find((k) => `${file} ${args.join(" ")}`.includes(k));
      const answer = key ? answers[key] : "";
      if (answer instanceof Error) throw answer;
      return { stdout: typeof answer === "string" ? answer : JSON.stringify(answer), stderr: "" };
    };
    return { calls, git: createGitHost("/repo", { exec, waitMs: 1, riskScript: "/nonexistent/risk-check.mjs" }) };
  }

  // den-mvp/70: the test guard is run like the risk check, with the box required for the changed tests.
  test("the test guard: clean, hits without its own header and notes, a crash, and no script", async () => {
    const run = (answer) => {
      const calls = [];
      const exec = async (file, args, options) => {
        calls.push([file, ...args, options]);
        if (answer instanceof Error) throw answer;
        return { stdout: answer, stderr: "" };
      };
      return { calls, git: createGitHost("/repo", { exec, guardScript: new URL(import.meta.url).pathname }) };
    };
    const guard = (g) => g.git.guard({ base: BASE, sha: SHA });
    const json = (hits, notes = []) => JSON.stringify({ hits, notes });
    const clean = run(json([]));
    assert.deepEqual(await guard(clean), { hits: [] });
    assert.deepEqual(clean.calls[0].slice(1, 4), [new URL(import.meta.url).pathname, `${BASE}...${SHA}`, "--json"]);
    // M2: the run has a time limit and is killed hard.
    const options = clean.calls[0].at(-1);
    assert.ok(options.timeout >= 60_000 && options.timeout <= 600_000, `timeout ${options.timeout}`);
    assert.equal(options.killSignal, "SIGKILL");
    // M3: the hits come from the JSON, so a file named like a note is still a hit, and notes are not hits.
    const hits = [{ file: "test-guard: x.test.mjs", reason: "skip, todo or only added: test.skip" }, { file: "(guard)", reason: "can't-fail check not run: no bubblewrap" }];
    const hit = run(Object.assign(new Error("x"), { code: 1, stdout: json(hits, ["test-guard: not rerun (browser test): b.test.mjs"]) }));
    assert.deepEqual(await guard(hit), { hits: ["test-guard: x.test.mjs: skip, todo or only added: test.skip", "(guard): can't-fail check not run: no bubblewrap"] });
    // L5: a failure with nothing to read, or output that is not the result, is a hit and not clean.
    for (const bad of [Object.assign(new Error("boom"), { code: 1, stdout: "" }), Object.assign(new Error("bad range"), { code: 2, stdout: "", stderr: "no" }), Object.assign(new Error("x"), { code: 1, stdout: "test-guard: clean\n" })]) {
      const r = await guard(run(bad));
      assert.equal(r.hits.length, 1);
      assert.match(r.hits[0], /^\(guard\): the test guard did not give a result/);
    }
    assert.match((await guard(run("test-guard: clean\n"))).hits[0], /did not give a result/); // exit 0 with no JSON
    assert.match((await guard(run(json("nope")))).hits[0], /did not give a result/);
    // M2: a run killed at the time limit is a hit.
    const killed = await guard(run(Object.assign(new Error("timed out"), { killed: true, signal: "SIGKILL", code: null, stdout: "" })));
    assert.match(killed.hits[0], /^\(guard\): the test guard did not finish in \d+ s/);
    // L8: line and paragraph separators in a hit are blanks.
    assert.deepEqual(await guard(run(json([{ file: "a.test.mjs", reason: "x\u2028y\u2029z" }]))), { hits: ["a.test.mjs: x y z"] });
    const none = createGitHost("/repo", { exec: async () => ({ stdout: "" }), guardScript: "/nonexistent/test-guard.mjs" });
    assert.match((await none.guard({ base: BASE, sha: SHA })).hits[0], /no test guard here/);
  });

  test("each operation is one fixed argument list over checked values", async () => {
    const t = host({ "pr list": [{ number: 9, url: "https://github.com/o/r/pull/9", state: "OPEN", headRefOid: SHA }], "rev-parse": `${SHA}\n` });
    assert.equal(await t.git.mainSha(), SHA);
    await t.git.push({ branch: BRANCH, sha: SHA });
    assert.deepEqual(await t.git.findPr({ branch: BRANCH }), { number: 9, url: "https://github.com/o/r/pull/9", state: "OPEN", sha: SHA });
    await t.git.openPr({ branch: BRANCH, title: "fx/08: a\ntitle", body: "body" });
    await t.git.merge({ number: 9, sha: SHA });
    assert.deepEqual(t.calls, [
      ["git", "-C", "/repo", "fetch", "--quiet", "origin", "main"],
      ["git", "-C", "/repo", "rev-parse", "--verify", "refs/remotes/origin/main^{commit}"],
      ["git", "-C", "/repo", "push", "--porcelain", "origin", `${SHA}:refs/heads/${BRANCH}`],
      ["gh", "pr", "list", "--head", BRANCH, "--state", "all", "--limit", "10", "--json", "number,url,state,headRefOid"],
      ["gh", "pr", "create", "--head", BRANCH, "--base", "main", "--title", "fx/08: a title", "--body", "body"],
      ["gh", "pr", "merge", "9", "--merge", "--match-head-commit", SHA],
    ]);
  });

  test("a value that is not a commit id, a den branch or a number reaches no command", async () => {
    const t = host();
    await assert.rejects(t.git.push({ branch: "main", sha: SHA }), /not a den branch/);
    await assert.rejects(t.git.push({ branch: BRANCH, sha: "HEAD; rm -rf /" }), /full commit id/);
    await assert.rejects(t.git.push({ branch: `${BRANCH} --force`, sha: SHA }), /not a den branch/);
    await assert.rejects(t.git.merge({ number: "9 --admin", sha: SHA }), /pull request number/);
    await assert.rejects(t.git.changed({ base: "--output=/tmp/x", sha: SHA }), /full commit id/);
    assert.deepEqual(t.calls, []);
  });

  // den-mvp/29: the CI watch's calls.
  test("the CI watch's calls are fixed argument lists over checked ids", async () => {
    const t = host({ "pr list": [
      { number: 9, url: "https://github.com/o/r/pull/9", title: "a\u0007 change", headRefName: "x", headRefOid: SHA, files: [{ path: "a.mjs" }], statusCheckRollup: [] },
      { number: 10, headRefOid: "not a sha" },
    ], "annotations": [{ message: "The job has exceeded the maximum execution time of 15m0s" }], "--log-failed": "log text" });
    assert.deepEqual(await t.git.openPrs(), [{ number: 9, url: "https://github.com/o/r/pull/9", title: "a  change", branch: "x", sha: SHA, files: ["a.mjs"], checks: [] }]);
    assert.deepEqual(await t.git.annotations({ jobId: "2" }), ["The job has exceeded the maximum execution time of 15m0s"]);
    assert.equal(await t.git.failedLog({ jobId: "2" }), "log text");
    await t.git.rerunFailed({ runId: "901" });
    assert.deepEqual(t.calls.slice(1), [
      ["gh", "api", "repos/{owner}/{repo}/check-runs/2/annotations"], ["gh", "run", "view", "--job", "2", "--log-failed"], ["gh", "run", "rerun", "901", "--failed"],
    ]);
    for (const bad of ["0", "1 --repo x", "-1", "", 5, "1".repeat(21)]) {
      await assert.rejects(t.git.rerunFailed({ runId: bad }), /not a run id/);
      await assert.rejects(t.git.failedLog({ jobId: bad }), /not a job id/);
      await assert.rejects(t.git.annotations({ jobId: bad }), /not a job id/);
    }
    assert.equal(t.calls.length, 4);
  });

  test("a pull request's state is read into the few values the runner uses", async () => {
    const t = host({ "pr view": { number: 9, url: "https://github.com/o/r/pull/9", state: "OPEN", headRefOid: SHA, mergeable: "MERGEABLE", statusCheckRollup: [
      { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/o/r/actions/runs/900/job/1" }, { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: "" },
      { __typename: "StatusContext", context: "ci/x", state: "FAILURE" },
      { __typename: "CheckRun", name: "slow", status: "COMPLETED", conclusion: "CANCELLED", detailsUrl: "https://github.com/o/r/actions/runs/901/job/2?pr=9" },
    ] } });
    const st = await t.git.prState({ number: 9 });
    const bare = { cancelled: false, jobId: null, runId: null };
    assert.deepEqual(st.checks, [
      { name: "test", done: true, ok: true, cancelled: false, jobId: "1", runId: "900" }, { name: "lint", done: false, ok: false, ...bare },
      { name: "ci/x", done: true, ok: false, ...bare }, { name: "slow", done: true, ok: false, cancelled: true, jobId: "2", runId: "901" },
    ]);
    assert.equal(st.mergeable, "MERGEABLE");
    assert.equal(st.sha, SHA);
  });

  test("a secret in an added line is seen; a removed one is not; with no risk script every change goes to security", async () => {
    const key = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
    assert.equal(await host({ "log --format": `+++ b/x\n+const k = "${key}";\n` }).git.addsSecret({ base: BASE, sha: SHA }), true);
    assert.equal(await host({ "log --format": `--- a/x\n-const k = "${key}";\n+const k = env.KEY;\n` }).git.addsSecret({ base: BASE, sha: SHA }), false);
    assert.equal((await host().git.risk({ base: BASE, sha: SHA })).clean, false);
  });

  test("in a real repository, a file moved out of the bridge is listed under the path it left", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "den-githost-"));
    try {
      const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=fx", "-c", "user.email=fx@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
      git("init", "-q", "-b", "main");
      mkdirSync(path.join(dir, "apps", "bridge"), { recursive: true });
      writeFileSync(path.join(dir, "apps", "bridge", "wall.mjs"), "export const wall = 1;\n".repeat(20));
      git("add", "-A");
      git("commit", "-q", "-m", "one");
      const base = git("rev-parse", "HEAD");
      mkdirSync(path.join(dir, "lib"));
      git("mv", "apps/bridge/wall.mjs", "lib/wall.mjs");
      git("commit", "-q", "-m", "move");
      const sha = git("rev-parse", "HEAD");
      assert.equal(await createGitHost(dir).descends({ base, sha }), true);
      assert.equal(await createGitHost(dir).descends({ base: sha, sha: base }), false, "a commit that is not built on the base");
      const files = await createGitHost(dir).changed({ base, sha });
      assert.deepEqual(files.sort(), ["apps/bridge/wall.mjs", "lib/wall.mjs"]);
      assert.equal(files.some(isUserMergePath), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("in a real repository, a dry-run merge with main lists the conflicting files, and a clean one lists none (F29)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "den-githost-"));
    try {
      const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=fx", "-c", "user.email=fx@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
      git("init", "-q", "-b", "main");
      writeFileSync(path.join(dir, "host.mjs"), "line one\nline two\n");
      writeFileSync(path.join(dir, "other.mjs"), "x\n");
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      git("switch", "-q", "-c", "den/fx/01-work-01234567");
      writeFileSync(path.join(dir, "host.mjs"), "line one\nthe branch's line\n");
      git("commit", "-qam", "branch");
      const branch = git("rev-parse", "HEAD");
      git("switch", "-q", "main");
      writeFileSync(path.join(dir, "other.mjs"), "y\n");
      git("commit", "-qam", "main, elsewhere");
      const clean = git("rev-parse", "HEAD");
      assert.deepEqual(await createGitHost(dir).conflicts({ main: clean, sha: branch }), [], "main changed another file: no conflict");
      writeFileSync(path.join(dir, "host.mjs"), "line one\nmain's line\n");
      git("commit", "-qam", "main, same line");
      const moved = git("rev-parse", "HEAD");
      assert.deepEqual(await createGitHost(dir).conflicts({ main: moved, sha: branch }), ["host.mjs"]);
      assert.equal(git("rev-parse", "HEAD"), moved, "the dry run leaves the checkout as it was");
      await assert.rejects(createGitHost(dir).conflicts({ main: "main", sha: branch }), /full commit id/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("in a real repository, every commit that would be pushed is read for a secret, binary files and file names included", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "den-githost-"));
    try {
      const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=fx", "-c", "user.email=fx@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
      const key = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
      const commitAll = (message) => (git("add", "-A"), git("commit", "-q", "-m", message), git("rev-parse", "HEAD"));
      git("init", "-q", "-b", "main");
      writeFileSync(path.join(dir, "a.mjs"), "export const a = 1;\n");
      const base = commitAll("one");
      const host = createGitHost(dir);

      writeFileSync(path.join(dir, "a.mjs"), "export const a = 2;\n");
      writeFileSync(path.join(dir, ".env.example"), "KEY=\n");
      assert.equal(await host.addsSecret({ base, sha: commitAll("a clean change") }), false);

      writeFileSync(path.join(dir, "k.mjs"), `export const k = "${key}";\n`);
      commitAll("a key");
      writeFileSync(path.join(dir, "k.mjs"), "export const k = process.env.K;\n");
      const removed = commitAll("the key is taken out again");
      assert.equal(git("diff", base, removed).includes(key), false, "the two ends do not show it");
      assert.equal(await host.addsSecret({ base, sha: removed }), true, "a secret added and then removed is still pushed");

      git("checkout", "-q", "-b", "binary", base);
      writeFileSync(path.join(dir, "blob.bin"), Buffer.concat([Buffer.alloc(16), Buffer.from(`\nkey=${key}\n`)]));
      assert.equal(await host.addsSecret({ base, sha: commitAll("a file git calls binary") }), true);

      for (const name of [".env", "deploy.pem", path.join("keys", "id_ed25519")]) {
        git("checkout", "-q", "-B", "named", base);
        mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
        writeFileSync(path.join(dir, name), "x\n");
        assert.equal(await host.addsSecret({ base, sha: commitAll("a file named like a secret") }), true, name);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("waiting for checks ends when the watch ends, and waits a little for checks that are not registered yet", async () => {
    let tries = 0;
    const exec = async () => {
      tries += 1;
      if (tries < 3) throw Object.assign(new Error("x"), { stderr: "no checks reported on the 'den/x' branch" });
      return { stdout: "", stderr: "" };
    };
    await createGitHost("/repo", { exec, waitMs: 1 }).waitChecks({ number: 9 });
    assert.equal(tries, 3);
    let failed = 0;
    await createGitHost("/repo", { exec: async () => { failed += 1; throw Object.assign(new Error("x"), { stderr: "some checks failed" }); }, waitMs: 1 }).waitChecks({ number: 9 });
    assert.equal(failed, 1, "a red check ends the wait; prState says what it showed");
  });
});
