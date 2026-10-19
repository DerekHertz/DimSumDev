// organism-infra/80: developer coverage beyond qa's specify tests (jg.test.mjs, bash-guard.jg.test.mjs):
// the usage row on disk, checkout-relative root rules, the version floor, caller flags, and guard edges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runJg } from "./jg.mjs";
import { check } from "./hooks/bash-guard.mjs";

const tmp = (p) => mkdtempSync(path.join(realpathSync(tmpdir()), p));
// A root that has its own .git: a root with no .git ancestor and no explicit checkout is refused (batch B, security Low on 80).
const repo = () => {
  const r = tmp("jg80-r-");
  mkdirSync(path.join(r, ".git"));
  return r;
};
const ok = (files = 2) => {
  const calls = [];
  const stdout = Array.from({ length: files }, (_, i) => `## f${i}.mjs`).concat("End context.").join("\n");
  return { calls, run: async (argv) => { calls.push(argv); return { stdout, exitCode: 0 }; } };
};
const rows = (root) => readFileSync(path.join(root, ".scratch", "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

// A fake checkout: a .git directory with a worktree checkout under .claude/worktrees/.
function checkout() {
  const top = tmp("jg80-co-");
  mkdirSync(path.join(top, ".git"));
  const wt = path.join(top, ".claude", "worktrees", "agent");
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, ".git"), "gitdir: elsewhere\n");
  mkdirSync(path.join(top, "apps"));
  return { top, wt };
}

test("a successful call appends one kind:jg row to usageRoot/.scratch/usage.jsonl", async () => {
  const usageRoot = tmp("jg80-u-");
  let t = 1000;
  const { stdout, row } = await runJg({ query: "where is x", root: repo(), run: ok(3).run, usageRoot, now: () => (t += 5) });
  assert.match(stdout, /## f0/);
  assert.deepEqual(rows(usageRoot), [row]);
  assert.deepEqual({ ...row, ts: undefined }, { kind: "jg", ts: undefined, queryLen: 10, filesReturned: 3, fallback: false, ms: 5 });
});

test("a refused call logs a row with refused and still rejects", async () => {
  const usageRoot = tmp("jg80-u-");
  await assert.rejects(() => runJg({ query: "q", root: tmp("jg80-r-"), extraArgs: ["--hidden=1"], run: ok().run, usageRoot }), /forbidden/);
  assert.equal(rows(usageRoot)[0].refused, "flag");
});

test("any caller flag is refused, not only the forbidden four", async () => {
  const { run, calls } = ok();
  await assert.rejects(() => runJg({ query: "q", root: tmp("jg80-r-"), extraArgs: ["--json"], run }), /not allowed/);
  assert.equal(calls.length, 0);
});

test("a query starting with '-' is refused so jg cannot read it as a flag", async () => {
  const { run, calls } = ok();
  await assert.rejects(() => runJg({ query: "--hidden", root: tmp("jg80-r-"), run }), /invalid/);
  assert.equal(calls.length, 0);
});

test("zero files returned counts as a fallback with no stdout", async () => {
  const r = await runJg({ query: "q", root: repo(), run: ok(0).run });
  assert.equal(r.stdout, undefined);
  assert.equal(r.row.fallback, true);
  assert.equal(r.row.reason, "no-files");
});

test("a worktree root under .claude/worktrees/ is allowed; .claude/ of the main checkout is not", async () => {
  const { top, wt } = checkout();
  const { run, calls } = ok();
  await runJg({ query: "q", root: wt, run });
  assert.equal(calls.length, 1);
  await assert.rejects(() => runJg({ query: "q", root: path.join(top, ".claude"), run }), /refused root/);
  assert.equal(calls.length, 1);
});

test("a root outside the given checkout is refused; a subdirectory is allowed", async () => {
  const { top } = checkout();
  const { run, calls } = ok();
  await assert.rejects(() => runJg({ query: "q", root: tmp("jg80-r-"), checkout: top, run }), /outside the checkout/);
  await assert.rejects(() => runJg({ query: "q", root: path.dirname(top), checkout: top, run }), /outside the checkout/);
  await runJg({ query: "q", root: path.join(top, "apps"), checkout: top, run });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at(-1), path.join(top, "apps"));
});

test("a missing root is refused", async () => {
  await assert.rejects(() => runJg({ query: "q", root: path.join(tmp("jg80-r-"), "nope"), run: ok().run }), /invalid root/);
});

test("jg older than 0.6.0 or an unreadable version falls back without running", async () => {
  for (const v of ["jg 0.5.9", null, "garbage"]) {
    const { run, calls } = ok();
    const r = await runJg({ query: "q", root: repo(), run, version: async () => v });
    assert.equal(calls.length, 0, `version ${v}`);
    assert.equal(r.row.reason, "jg-version");
  }
  const { run, calls } = ok();
  await runJg({ query: "q", root: repo(), run, version: async () => "0.7.0\n" });
  assert.equal(calls.length, 1);
});

const bash = (command) => check({ tool_name: "Bash", tool_input: { command } });

test("bash-guard blocks jg by path, by package name, and after a separator", () => {
  for (const c of ["node_modules/.bin/jg q .", "npx @dzhng/jevgrep q .", "ls; jg q .", "echo $(jg q .)", "bash -c \"jg q .\""]) {
    assert.ok(bash(c), c);
  }
});

test("bash-guard allows searching for the word jg and non-Bash tools", () => {
  for (const c of ["rg \"jg\" scripts/", "rg runJg scripts/", "node ./scripts/jg.mjs q .", "git log -- scripts/jg.mjs"]) {
    assert.equal(bash(c), null, c);
  }
  assert.equal(check({ tool_name: "Read", tool_input: { command: "jg q ." } }), null);
});
