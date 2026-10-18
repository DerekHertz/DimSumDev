#!/usr/bin/env node
// den-mvp/70: the test-tamper guard, run beside risk-check on every candidate. Against the merge base it flags a change
// that weakens the tests: a test file deleted or renamed away, a test removed, a skip/todo/only or an early return added,
// an assertion removed or loosened (down a strict > equal > ok > constant rank, a regex or a tolerance widened), comments ignored, and a NEW test that passes on the
// merge base (it can't fail). A hit blocks nothing: it is listed for the verifier, which accepts or bounces each one.
// Exit 0 = clean. Exit 1 = hits, printed as "file: reason". Exit 2 = bad usage. Notes print as "test-guard: ...".
//
// Usage: node scripts/test-guard.mjs [A...B | A..B] [--no-rerun] [--no-box] [--json]   (default: main...HEAD)
//   --no-rerun     skip the can't-fail check (static checks only)
//   --no-box       run the can't-fail check unboxed, with the caller's network and environment: local use on your own change only
//   --json         print one JSON object { hits: [{ file, reason }], notes: [string] } and nothing else (the bridge reads this)
//   --require-box  accepted and ignored: the box is the default (the changed tests are not trusted)
// The changed tests run in bubblewrap inside a resource group (the checks limits), and are refused, as a hit, when the group
// cannot be enforced.
//
// The can't-fail check puts the merge base in a temp worktree, drops the head's changed test files over it, and runs
// them there under `timeout`. A new test whose name shows up as passing is flagged. Limits (shortcut): tests are found by
// literal names in test()/it()/describe() calls, so a generated name is not seen; assertions are read line by line.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBwrap } from "../apps/bridge/build/box.mjs";
import { CHECKS_SLICE, checksLimits, createResourceLauncher } from "../apps/bridge/cells/resource-group.mjs";
import { checkBoxArgv } from "../apps/bridge/delivery/checks.mjs";
import { isBrowserFile } from "./test-split.mjs";

export const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const NAME_RE = /\b(?:test|it|describe|suite)(?:\.\w+)*\s*\(\s*(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
const ASSERT_RE = /\b(?:assert(?:\.\w+)*|expect|t\.assert\.\w+)\s*\(/g;
const SKIP_RE = /\b(?:test|it|describe|suite)\.(?:skip|todo|only)\b|\bt\.(?:skip|todo)\s*\(|\b(?:skip|todo|only)\s*:\s*(?!false\b)\S/;
const EARLY_RETURN_RE = /^\s*(?:if\s*\(.*\)\s*)?return\s*;?\s*$/;
const STRICT_NAME_RE = /^(?:not)?(?:deep)?strictEqual$/i;
const CALL_RE = /\b(assert(?:\.\w+)*|expect|t\.assert\.\w+)\s*\(\s*([^,)]*)/g;
const CONSTANT_ARG_RE = /^(?:true|1|!0|(["'`]).*\1)$/;
const RANK_NAMES = ["constant", "ok", "equal", "strict"];
// Strings are kept whole so a "//" inside one survives; comments go, block comments leave their newlines.
const COMMENT_RE = /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g; // an unclosed /* runs to the end: one pass, not one per /*
const REGEX_RE = /(?<=[(,=:\s])\/((?:\\.|[^/\n\\])+)\/([a-z]*)/;
const NUMBER_RE = /\d+(?:\.\d+)?(?:e-?\d+)?/g;
const TOLERANCE_WORD_RE = /toler|epsilon|\beps\b|delta|within|closeTo/i;
const WORKTREES_DIR = ".claude/worktrees";
const HITS_MAX = 50;
const STATIC_MAX_BYTES = 256 * 1024; // a test file over this is not read line by line: a hit sends it to the verifier
const STALE_MS = 15 * 60 * 1000; // a guard worktree older than this belongs to a guard that was killed
const GUARD_PREFIX = "test-guard-";
let launches = 0;

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const show = (cwd, rev, file) => {
  try {
    return git(cwd, "show", `${rev}:${file}`);
  } catch {
    return "";
  }
};
const count = (re, text) => (text.match(re) ?? []).length;

/** A source text without its comments (shortcut: a quote inside a regex literal can fool it). */
export const stripComments = (text) => text.replace(COMMENT_RE, (m, str) => str ?? m.replace(/[^\n]/g, ""));

/** The literal test and suite names of a source text; a commented-out test has no name. */
export function testNames(text) {
  return new Set([...stripComments(text).matchAll(NAME_RE)].map((m) => m[2]).filter((n) => !n.includes("${")));
}

const STRING_RE = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/y;

// The index just past the ")" that closes the "(" at code[open] (shortcut: a paren inside a regex literal is counted).
function callEnd(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (/["'`]/.test(code[i])) {
      STRING_RE.lastIndex = i;
      const str = STRING_RE.exec(code);
      if (str) i += str[0].length - 1;
    } else if (code[i] === "(") depth += 1;
    else if (code[i] === ")" && (depth -= 1) === 0) return i + 1;
  }
  return code.length;
}

// name -> { count, text }: the assertions inside each named test() or it() call (a suite holds tests, not assertions).
function testBodies(text) {
  const code = stripComments(text);
  const out = new Map();
  for (const m of code.matchAll(NAME_RE)) {
    if (m[2].includes("${") || /^(?:describe|suite)\b/.test(m[0])) continue;
    const body = code.slice(m.index, callEnd(code, m.index + m[0].indexOf("(")));
    const was = out.get(m[2]) ?? { count: 0, text: "" };
    out.set(m[2], { count: was.count + count(ASSERT_RE, body), text: was.text + body });
  }
  return out;
}

function resolveRange(range, cwd) {
  const m = /^([^.\s][^\s]*?)(\.\.\.?)([^.\s][^\s]*)$/.exec(range);
  if (!m) throw new RangeError(`test-guard: range must look like A...B or A..B, got "${range}"`);
  const rev = (r) => git(cwd, "rev-parse", "--verify", "--end-of-options", `${r}^{commit}`).trim();
  const [a, head] = [rev(m[1]), rev(m[3])];
  return { base: m[2] === "..." ? git(cwd, "merge-base", a, head).trim() : a, head };
}

// -U0 hunks of one file pair -> [{ removed: [line], added: [line] }]. Each line is read from the comment-stripped
// text (oldCode, newCode: its lines) by its number, so a comment line carries no assertion.
function hunks(cwd, base, head, files, [oldCode, newCode]) {
  const hs = [];
  for (const line of git(cwd, "diff", "--unified=0", "--no-color", "--no-ext-diff", "-M", base, head, "--", ...files).split("\n")) {
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (at) hs.push({ removed: [], added: [], from: Number(at[1]), to: Number(at[2]) });
    else if (hs.length && line.startsWith("-") && !line.startsWith("---")) hs.at(-1).removed.push(oldCode[hs.at(-1).from - 1 + hs.at(-1).removed.length] ?? line.slice(1));
    else if (hs.length && line.startsWith("+") && !line.startsWith("+++")) hs.at(-1).added.push(newCode[hs.at(-1).to - 1 + hs.at(-1).added.length] ?? line.slice(1));
  }
  return hs;
}

// How loose a regex is: wildcards, alternation and quantifiers raise it, anchors lower it, a case-insensitive flag raises it.
const looseness = ([, source, flags]) => {
  const bare = source.replace(/\\./g, "");
  return count(/[.*+?|]/g, bare) - count(/[\^$]/g, bare) + (flags.includes("i") ? 1 : 0);
};

// How strong an assertion call is: 3 strict, 2 any other comparison, 1 ok or a bare assert(x), 0 a constant ok(true).
const rank = ([, callee, arg]) => {
  const name = callee.split(".").at(-1);
  if (name === "assert" || name === "ok") return CONSTANT_ARG_RE.test(arg.trim()) ? 0 : 1;
  return STRICT_NAME_RE.test(name) ? 3 : 2;
};
const ranks = (line) => [...line.matchAll(CALL_RE)].map(rank).sort((a, b) => b - a);

// Why `after` is a weaker assertion than `before`, or null.
function loosened(before, after) {
  const [rb, ra] = [ranks(before), ranks(after)];
  const k = ra.findIndex((r, i) => i < rb.length && r < rb[i]); // strongest to weakest, as many as both lines have
  if (k >= 0) return `assertion loosened (${RANK_NAMES[rb[k]]} to ${RANK_NAMES[ra[k]]})`;
  const [xb, xa] = [REGEX_RE.exec(before), REGEX_RE.exec(after)];
  if (xb && xa && looseness(xa) > looseness(xb)) return "regex widened";
  const [nb, na] = [before.match(NUMBER_RE) ?? [], after.match(NUMBER_RE) ?? []];
  if (nb.length === na.length && (count(ASSERT_RE, after) > 0 || TOLERANCE_WORD_RE.test(after))) {
    const i = nb.findIndex((n, k) => Number(n) !== Number(na[k]));
    if (i >= 0) {
      const [was, now] = [Number(nb[i]), Number(na[i])];
      if ((/<=?/.test(after) || TOLERANCE_WORD_RE.test(after)) && now > was) return "tolerance widened";
      if (/>=?/.test(after) && !/<=?/.test(after) && now < was) return "tolerance widened";
    }
  }
  return null;
}

/** The changed paths between two commits: [{ status, path, oldPath }], renames followed. */
function changes(cwd, base, head) {
  const parts = git(cwd, "diff", "--name-status", "-M", "-z", base, head).split("\0");
  const out = [];
  for (let i = 0; i < parts.length - 1;) {
    const status = parts[i][0];
    if (status === "R" || status === "C") (out.push({ status, oldPath: parts[i + 1], path: parts[i + 2] }), (i += 3));
    else (out.push({ status, oldPath: parts[i + 1], path: parts[i + 1] }), (i += 2));
  }
  return out;
}

function staticHits(cwd, base, head) {
  const hits = [];
  const add = (file, reason) => hits.push({ file, reason });
  const newTests = []; // files whose NEW tests the can't-fail check reruns: { path, names }
  for (const c of changes(cwd, base, head)) {
    const wasTest = TEST_FILE_RE.test(c.oldPath);
    const isTest = TEST_FILE_RE.test(c.path) && c.status !== "D";
    if (c.status === "D" && wasTest) add(c.path, "test file deleted");
    else if (c.status === "R" && wasTest && !isTest) add(c.oldPath, `test file renamed away to ${c.path}`);
    if (!isTest) continue;
    const [before, after] = [c.status === "A" ? "" : show(cwd, base, c.oldPath), show(cwd, head, c.path)];
    if (Math.max(before.length, after.length) > STATIC_MAX_BYTES) {
      add(c.path, `test file over ${STATIC_MAX_BYTES / 1024} KB: not analysed, the verifier reads it by hand`);
      continue;
    }
    const [namesBefore, namesAfter] = [testNames(before), testNames(after)];
    const removedNames = [...namesBefore].filter((n) => !namesAfter.has(n));
    for (const n of removedNames) add(c.path, `test removed or renamed away: "${n}"`);
    const fresh = [...namesAfter].filter((n) => !namesBefore.has(n));
    if (fresh.length) newTests.push({ path: c.path, names: fresh });
    const hs = hunks(cwd, base, head, c.status === "R" ? [c.oldPath, c.path] : [c.path], [stripComments(before).split("\n"), stripComments(after).split("\n")]);
    const lineRemoved = [];
    const addedAll = new Set(hs.flatMap((h) => h.added.map((l) => l.trim())));
    for (const h of hs) {
      for (const l of h.added) {
        if (SKIP_RE.test(l)) add(c.path, `skip, todo or only added: ${l.trim()}`);
        if (EARLY_RETURN_RE.test(l)) add(c.path, `early return added: ${l.trim()}`);
      }
      const paired = Math.min(h.removed.length, h.added.length);
      for (let i = 0; i < paired; i += 1) {
        const why = loosened(h.removed[i], h.added[i]);
        if (why) add(c.path, `${why}: ${h.added[i].trim()}`);
      }
      const removesATest = h.removed.some((l) => [...testNames(l)].some((n) => removedNames.includes(n)));
      if (!removesATest) {
        for (const l of h.removed.slice(paired)) if (count(ASSERT_RE, l) > 0 && !addedAll.has(l.trim())) (lineRemoved.push(l.trim()), add(c.path, `assertion removed: ${l.trim()}`));
      }
    }
    // A test that keeps its name but has fewer assertions (a body emptied, an assertion commented out or moved away).
    const [bodiesBefore, bodiesAfter] = [testBodies(before), testBodies(after)];
    for (const [name, was] of bodiesBefore) {
      const now = bodiesAfter.get(name);
      if (now && now.count < was.count && !lineRemoved.some((l) => was.text.includes(l))) add(c.path, `assertion count dropped in "${name}" (${was.count} to ${now.count})`);
    }
  }
  return { hits, newTests };
}

// The names of the tests that passed in a TAP report.
const passedNames = (tap) =>
  new Set([...tap.matchAll(/^\s*ok \d+ - (.*?)(?: # (SKIP|TODO).*)?$/gm)].filter((m) => !m[2]).map((m) => m[1].replace(/\\#/g, "#").trim()));

// The launcher a guard run uses: the checks limits and the checks slice, as checks.mjs does.
export const guardLauncher = (env = process.env) => createResourceLauncher({ env, limits: checksLimits(), slice: CHECKS_SLICE });

const OUTPUT_KEPT = 16 * 1024 * 1024;

// One command through the launcher, in its resource group. -> { stdout, stderr, timedOut, status, exhausted }; throws when the
// group cannot be had. exhausted is read before the kill, while the group still holds its counters.
async function runGrouped({ launcher, bwrap, argv, timeoutSec }) {
  const { child, group } = await launcher.launch({ slotClass: "worker", id: `test-guard-${process.pid}-${(launches += 1)}`, bin: bwrap, args: argv, cwd: "/", env: {} });
  if (!group) {
    child.kill("SIGKILL");
    throw new Error("the launcher gave no resource group");
  }
  const out = { stdout: "", stderr: "" };
  for (const k of ["stdout", "stderr"]) child[k].on("data", (c) => out[k].length < OUTPUT_KEPT && (out[k] += c));
  child.stdin.on("error", () => {});
  child.stdin.end();
  let timedOut = false;
  const timer = setTimeout(() => ((timedOut = true), group.kill()), timeoutSec * 1000);
  const status = await new Promise((resolve) => child.once("exit", (code, signal) => resolve(code ?? signal))); // "exit", not "close": the launcher's anchor holds the pipes until the group is killed
  clearTimeout(timer);
  const exhausted = group.exhausted?.() ?? null;
  group.kill();
  await group.settled(5000);
  await Promise.race([new Promise((resolve) => child.once("close", resolve)), new Promise((resolve) => setTimeout(resolve, 1000))]);
  return { ...out, timedOut, status, exhausted };
}

// Guard worktrees left by a guard that was killed (their name carries the start time).
function sweepStale(repo, dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {}
  for (const name of names) {
    const at = Number(/^test-guard-\d+-(\d+)(?:-nm)?$/.exec(name)?.[1]);
    if (at && Date.now() - at > STALE_MS) rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  try {
    execFileSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
  } catch {}
}

async function cantFail({ cwd, base, head, newTests, box, bwrap, launcher, timeoutSec }) {
  const hits = [];
  const notes = [];
  const files = [];
  const notRun = (why) => ({ hits: [{ file: "(guard)", reason: `can't-fail check not run: ${why}` }], notes });
  for (const t of newTests) {
    if (isBrowserFile(t.path, cwd)) notes.push(`test-guard: not rerun (browser test): ${t.path}`);
    else files.push(t);
  }
  if (!files.length) return { hits, notes };
  if (box === "require" && !bwrap) return notRun("no bubblewrap to box the changed tests");
  if (box === "require" && (launcher?.enforced !== true || typeof launcher.launch !== "function")) return notRun("no resource group to run the changed tests in");
  const repo = realpathSync(git(cwd, "rev-parse", "--show-toplevel").trim());
  const dir = path.join(repo, ...WORKTREES_DIR.split("/"));
  const wt = path.join(dir, `${GUARD_PREFIX}${process.pid}-${Date.now()}`);
  const emptyModules = `${wt}-nm`;
  mkdirSync(dir, { recursive: true });
  sweepStale(repo, dir);
  let gitDir = null;
  try {
    // The change's code is not trusted here: no hooks, no filters.
    execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", "-c", "filter.lfs.process=", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.required=false", "worktree", "add", "--detach", wt, base],
      { stdio: "pipe", env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" } });
    gitDir = git(wt, "rev-parse", "--absolute-git-dir").trim();
    for (const t of files) {
      mkdirSync(path.dirname(path.join(wt, t.path)), { recursive: true });
      writeFileSync(path.join(wt, t.path), show(cwd, head, t.path));
    }
    const modules = path.join(repo, "node_modules");
    const node = realpathSync(process.execPath);
    const test = [node, "--test", "--test-concurrency=2", "--test-reporter=tap", ...files.map((t) => t.path)];
    let r;
    let timedOut;
    if (box !== "never") {
      mkdirSync(path.join(emptyModules, ".vite"), { recursive: true }); // the box mounts a tmpfs over it
      if (existsSync(modules)) try { mkdirSync(path.join(modules, ".vite"), { recursive: true }); } catch {}
      const argv = checkBoxArgv({ repo, worktree: realpathSync(wt), gitDir, nodeDir: path.dirname(path.dirname(node)), browsers: null, command: test, packages: existsSync(modules) ? modules : emptyModules });
      try {
        r = await runGrouped({ launcher, bwrap, argv, timeoutSec });
      } catch (err) {
        return notRun(String(err?.reason ?? err?.message ?? err).replace(/\s+/g, " ").slice(0, 200));
      }
      timedOut = r.timedOut;
    } else {
      const env = { ...process.env, CI: "true" };
      delete env.NODE_TEST_CONTEXT; // a guard run inside a test run must not look recursive
      r = spawnSync(test[0], test.slice(1), { cwd: wt, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: timeoutSec * 1000, killSignal: "SIGKILL" });
      timedOut = r.signal === "SIGKILL";
    }
    if (timedOut) return { hits: [{ file: "(guard)", reason: `can't-fail check did not finish in ${timeoutSec} s on the merge base: run the changed tests there by hand` }], notes };
    const bwrapError = /^bwrap: .*$/m.exec(r.stderr ?? "");
    if (bwrapError) return notRun(bwrapError[0].slice(0, 200));
    // A rerun cut short, or one with no TAP plan, never got to say which tests pass: that is not a clean result.
    // A non-zero exit with a plan is the expected case (a good new test fails on the merge base).
    if (r.exhausted) return notRun(`the rerun ran out of ${r.exhausted}`);
    if (!/^\s*1\.\.\d+/m.test(String(r.stdout ?? ""))) return notRun(`the rerun gave no test report (exit ${r.status ?? "unknown"})`);
    const passed = passedNames(String(r.stdout ?? ""));
    for (const t of files) for (const n of t.names) if (passed.has(n)) hits.push({ file: t.path, reason: `can't fail: "${n}" passes on the merge base ${base.slice(0, 12)}` });
  } finally {
    // The change's tests could write the git admin dir, so remove the known paths by hand, then let git forget them.
    for (const p of [wt, gitDir, emptyModules]) if (p) rmSync(p, { recursive: true, force: true });
    try {
      execFileSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
    } catch {}
  }
  return { hits, notes };
}

const dedupe = (hits) => {
  const seen = new Set();
  return hits.filter((h) => !seen.has(`${h.file}|${h.reason}`) && seen.add(`${h.file}|${h.reason}`)).slice(0, HITS_MAX);
};

/** The static checks alone, synchronously. -> { base, head, hits, newTests } */
export function staticGuard({ range = "main...HEAD", cwd = process.cwd() } = {}) {
  const { base, head } = resolveRange(range, cwd);
  const r = staticHits(cwd, base, head);
  return { base, head, hits: dedupe(r.hits), newTests: r.newTests, all: r.hits };
}

/** -> { hits: [{ file, reason }], notes: [string] } for the change base...head. box: "require" (default) or "never" (unboxed). */
export async function testGuard({ range = "main...HEAD", cwd = process.cwd(), rerun = true, box = "require", bwrap = findBwrap(), launcher = null, timeoutSec = 60 } = {}) {
  const { base, head, newTests, all } = staticGuard({ range, cwd });
  const hits = [...all];
  const notes = [];
  if (rerun && newTests.length) {
    const r = await cantFail({ cwd, base, head, newTests, box, bwrap, launcher, timeoutSec });
    hits.push(...r.hits);
    notes.push(...r.notes);
  }
  return { hits: dedupe(hits), notes };
}

async function main(argv) {
  const flags = argv.filter((a) => a.startsWith("--"));
  const range = argv.find((a) => !a.startsWith("--")) ?? "main...HEAD";
  if (argv.some((a) => a.startsWith("-") && !a.startsWith("--")) || flags.some((f) => !["--no-rerun", "--require-box", "--no-box", "--json"].includes(f)) || /^-/.test(range)) {
    console.error(`test-guard: refusing option-shaped argument (looks like a git option, not a range): ${argv.join(" ")}`);
    return 2;
  }
  const json = flags.includes("--json");
  try {
    const box = flags.includes("--no-box") ? "never" : "require";
    const { hits, notes } = await testGuard({ range, rerun: !flags.includes("--no-rerun"), box, launcher: box === "require" ? guardLauncher(process.env) : null });
    if (json) console.log(JSON.stringify({ hits, notes }));
    else {
      for (const n of notes) console.log(n);
      if (hits.length === 0) console.log(`test-guard: clean (${range})`);
      else {
        console.log(`test-guard: ${hits.length} hit(s) on ${range} — the verifier accepts or bounces each`);
        for (const h of hits) console.log(`${h.file}: ${h.reason}`);
      }
    }
    return hits.length === 0 ? 0 : 1;
  } catch (err) {
    console.error(String(err?.message ?? err));
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
