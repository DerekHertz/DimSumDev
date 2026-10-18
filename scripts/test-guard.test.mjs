// den-mvp/70: the test-tamper guard. Each case is a fixture repository: a base commit, a head commit, and the guard run
// over base...head. A weakening diff is flagged; the clean twin of it is not.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EnforcementError, LIMITS, checksLimits } from "../apps/bridge/cells/resource-group.mjs";
import { guardLauncher, staticGuard, stripComments, testGuard } from "./test-guard.mjs";

const SCRIPT = fileURLToPath(new URL("./test-guard.mjs", import.meta.url));
const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=fx", "-c", "user.email=fx@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" }).trim();

// A repository whose base commit holds `before` and whose head commit holds `after` (a null value deletes the file).
function fixture(before, after, parent = os.tmpdir()) {
  const root = (mkdirSync(parent, { recursive: true }), mkdtempSync(path.join(parent, "test-guard-")));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  const write = (files) => {
    for (const [file, text] of Object.entries(files)) {
      if (text === null) rmSync(path.join(root, file), { force: true });
      else (mkdirSync(path.dirname(path.join(root, file)), { recursive: true }), writeFileSync(path.join(root, file), text));
    }
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "x");
  };
  write(before);
  git(root, "branch", "base");
  write(after);
  return root;
}
const line = (h) => `${h.file}: ${h.reason}`;
// The static pass, synchronously; with rerun: true the whole guard, as a promise.
const reasons = (root, opts = {}) => (opts.rerun ? testGuard({ range: "base...HEAD", cwd: root, ...opts }).then((r) => r.hits.map(line)) : staticGuard({ range: "base...HEAD", cwd: root }).hits.map(line));
const flagged = (hits, re) => assert.ok(hits.some((h) => re.test(h)), `expected a hit matching ${re}, got ${JSON.stringify(hits)}`);

const T = (body) => `import { test } from "node:test";\nimport assert from "node:assert/strict";\n${body}`;
const SRC = "export const add = (a, b) => a + b;\n";

describe("a weakening diff is flagged", () => {
  test("a deleted test file", () => {
    const root = fixture({ "a.test.mjs": T('test("adds", () => { assert.strictEqual(1, 1); });\n'), "a.mjs": SRC }, { "a.test.mjs": null });
    flagged(reasons(root), /^a\.test\.mjs: test file deleted/);
  });

  test("a test file renamed to a name that is not a test", () => {
    const body = T('test("adds", () => { assert.strictEqual(1, 1); });\n');
    const root = fixture({ "a.test.mjs": body }, { "a.test.mjs": null, "a.check.mjs": body });
    flagged(reasons(root), /a\.test\.mjs: test file renamed away/);
  });

  test("a test removed", () => {
    const root = fixture(
      { "a.test.mjs": T('test("adds", () => { assert.strictEqual(1, 1); });\ntest("subtracts", () => { assert.strictEqual(2, 2); });\n') },
      { "a.test.mjs": T('test("adds", () => { assert.strictEqual(1, 1); });\n') },
    );
    flagged(reasons(root), /a\.test\.mjs: test removed or renamed away: "subtracts"/);
  });

  test("a test renamed away", () => {
    const root = fixture(
      { "a.test.mjs": T('test("adds", () => { assert.strictEqual(1, 1); });\n') },
      { "a.test.mjs": T('test("sums", () => { assert.strictEqual(1, 1); });\n') },
    );
    flagged(reasons(root), /"adds"/);
  });

  for (const [name, line] of [
    ["test.skip", 'test.skip("adds", () => { assert.strictEqual(1, 1); });'],
    ["describe.only", 'test.only("adds", () => { assert.strictEqual(1, 1); });'],
    ["test.todo", 'test.todo("adds", () => { assert.strictEqual(1, 1); });'],
    ["a skip option", 'test("adds", { skip: true }, () => { assert.strictEqual(1, 1); });'],
    ["a todo option", 'test("adds", { todo: "later" }, () => { assert.strictEqual(1, 1); });'],
    ["t.skip()", 'test("adds", (t) => { t.skip("later"); assert.strictEqual(1, 1); });'],
  ]) {
    test(`an added ${name}`, () => {
      const root = fixture({ "a.test.mjs": T('test("adds", () => { assert.strictEqual(1, 1); });\n') }, { "a.test.mjs": T(`${line}\n`) });
      flagged(reasons(root), /a\.test\.mjs: skip, todo or only added/);
    });
  }

  test("an early return in a test", () => {
    const root = fixture(
      { "a.test.mjs": T('test("adds", () => {\n  assert.strictEqual(1, 1);\n});\n') },
      { "a.test.mjs": T('test("adds", () => {\n  return;\n  assert.strictEqual(1, 1);\n});\n') },
    );
    flagged(reasons(root), /a\.test\.mjs: early return added/);
  });

  test("strictEqual loosened to ok", () => {
    const root = fixture(
      { "a.test.mjs": T('test("adds", () => {\n  assert.strictEqual(add(1, 2), 3);\n});\n') },
      { "a.test.mjs": T('test("adds", () => {\n  assert.ok(add(1, 2));\n});\n') },
    );
    flagged(reasons(root), /a\.test\.mjs: assertion loosened \(strict to ok\)/);
  });

  test("an assertion removed", () => {
    const root = fixture(
      { "a.test.mjs": T('test("adds", () => {\n  assert.strictEqual(add(1, 2), 3);\n  assert.strictEqual(add(2, 2), 4);\n});\n') },
      { "a.test.mjs": T('test("adds", () => {\n  assert.strictEqual(add(1, 2), 3);\n});\n') },
    );
    flagged(reasons(root), /a\.test\.mjs: assertion removed/);
  });

  test("a regex widened", () => {
    const root = fixture(
      { "a.test.mjs": T('test("says", () => {\n  assert.match(say(), /^hello world$/);\n});\n') },
      { "a.test.mjs": T('test("says", () => {\n  assert.match(say(), /hello.*/i);\n});\n') },
    );
    flagged(reasons(root), /a\.test\.mjs: regex widened/);
  });

  test("a tolerance widened", () => {
    const root = fixture(
      { "a.test.mjs": T('test("near", () => {\n  assert.ok(Math.abs(a - b) < 0.01);\n});\n') },
      { "a.test.mjs": T('test("near", () => {\n  assert.ok(Math.abs(a - b) < 5);\n});\n') },
    );
    flagged(reasons(root), /a\.test\.mjs: tolerance widened/);
  });

  // The repo's dominant assertion is assert.equal (node:assert/strict), so loosening must be seen beyond strictEqual.
  for (const [name, was, now] of [
    ["equal to ok(true)", "assert.equal(add(1, 2), 3);", "assert.ok(true);"],
    ["deepEqual to ok(x)", "assert.deepEqual(list(), [1]);", "assert.ok(list());"],
    ["match to ok(true)", "assert.match(say(), /^hi$/);", "assert.ok(true);"],
    ["notEqual to ok(1)", "assert.notEqual(add(1, 2), 4);", "assert.ok(1);"],
    ["throws to a bare assert(x)", "assert.throws(() => boom(), /bad/);", "assert(boom);"],
    ["rejects to ok(true)", "await assert.rejects(boom());", "assert.ok(true);"],
    ["t.assert.equal to t.assert.ok(true)", "t.assert.equal(add(1, 2), 3);", "t.assert.ok(true);"],
    ["ok(x) to ok(true)", "assert.ok(add(1, 2) === 3);", "assert.ok(true);"],
    ["strictEqual to equal", "assert.strictEqual(add(1, 2), 3);", "assert.equal(add(1, 2), 3);"],
  ]) {
    test(`${name} is loosened`, () => {
      const root = fixture({ "a.test.mjs": T(`test("adds", async (t) => {\n  ${was}\n});\n`) }, { "a.test.mjs": T(`test("adds", async (t) => {\n  ${now}\n});\n`) });
      flagged(reasons(root), /a\.test\.mjs: assertion loosened \(/);
    });
  }

  test("a test commented out line by line", () => {
    const root = fixture(
      { "a.test.mjs": T('test("adds", () => { assert.equal(1, 1); });\ntest("subtracts", () => { assert.equal(2, 2); });\n') },
      { "a.test.mjs": T('test("adds", () => { assert.equal(1, 1); });\n// test("subtracts", () => { assert.equal(2, 2); });\n') },
    );
    flagged(reasons(root), /a\.test\.mjs: test removed or renamed away: "subtracts"/);
  });

  test("a test commented out in a block", () => {
    const root = fixture(
      { "a.test.mjs": T('test("adds", () => { assert.equal(1, 1); });\ntest("subtracts", () => {\n  assert.equal(2, 2);\n});\n') },
      { "a.test.mjs": T('test("adds", () => { assert.equal(1, 1); });\n/*\ntest("subtracts", () => {\n  assert.equal(2, 2);\n});\n*/\n') },
    );
    flagged(reasons(root), /a\.test\.mjs: test removed or renamed away: "subtracts"/);
  });

  test("an assertion commented out", () => {
    const root = fixture(
      { "a.test.mjs": T('test("adds", () => {\n  assert.equal(add(1, 2), 3);\n  assert.equal(add(2, 2), 4);\n});\n') },
      { "a.test.mjs": T('test("adds", () => {\n  assert.equal(add(1, 2), 3);\n  // assert.equal(add(2, 2), 4);\n});\n') },
    );
    flagged(reasons(root), /a\.test\.mjs: assertion/);
  });

  test("a one-line test with its body emptied", () => {
    const root = fixture(
      { "a.test.mjs": T('test("adds", () => { assert.equal(add(1, 2), 3); });\n') },
      { "a.test.mjs": T('test("adds", () => {});\n') },
    );
    flagged(reasons(root), /a\.test\.mjs: assertion count dropped in "adds" \(1 to 0\)/);
  });

  test("a test that lost one of its assertions to a line elsewhere", () => {
    const root = fixture(
      { "a.test.mjs": T('test("adds", () => { assert.equal(1, 1); assert.equal(2, 2); });\ntest("subs", () => { assert.equal(3, 3); });\n') },
      { "a.test.mjs": T('test("adds", () => { assert.equal(1, 1); });\ntest("subs", () => { assert.equal(3, 3); assert.equal(2, 2); });\n') },
    );
    flagged(reasons(root), /a\.test\.mjs: assertion count dropped in "adds" \(2 to 1\)/);
  });
});

describe("a clean diff passes", () => {
  test("assertions kept or strengthened across the assert family", () => {
    const root = fixture(
      { "a.test.mjs": T('test("t", () => {\n  assert.equal(add(1, 2), 3);\n  assert.deepEqual(list(), [1]);\n  assert.ok(list());\n  assert.throws(() => boom());\n});\n') },
      { "a.test.mjs": T('test("t", () => {\n  assert.strictEqual(add(1, 2), 3);\n  assert.deepStrictEqual(list(), [1]);\n  assert.equal(list().length, 1);\n  assert.throws(() => boom(), /bad/);\n});\n') },
    );
    assert.deepEqual(reasons(root), []);
  });

  test("an equal assertion given another expected value", () => {
    const root = fixture(
      { "a.test.mjs": T('test("adds", () => {\n  assert.equal(add(1, 2), 4);\n});\n') },
      { "a.test.mjs": T('test("adds", () => {\n  assert.equal(add(1, 2), 3);\n});\n') },
    );
    assert.deepEqual(reasons(root), []);
  });

  test("comments added, edited and removed around the tests", () => {
    const root = fixture(
      { "a.test.mjs": T('// test("old", () => {});\n/* assert.equal(1, 1); */\ntest("adds", () => {\n  assert.equal(add(1, 2), 3); // was 4\n});\n') },
      { "a.test.mjs": T('// a note about test("new", ...)\ntest("adds", () => {\n  // adds small numbers\n  assert.equal(add(1, 2), 3);\n});\n') },
    );
    assert.deepEqual(reasons(root), []);
  });

  test("a test inserted ahead of assertions that sit outside any test", () => {
    const rows = 'for (const [a, b] of [[1, 2]]) {\n  assert.equal(add(a, a), b);\n}\n';
    const root = fixture(
      { "a.test.mjs": T(`test("adds", () => {\n  assert.equal(add(1, 2), 3);\n});\n${rows}`) },
      { "a.test.mjs": T(`test("adds", () => {\n  assert.equal(add(1, 2), 3);\n});\ntest("subs", () => {\n  assert.equal(sub(2, 1), 1);\n});\n${rows}`) },
    );
    assert.deepEqual(reasons(root), []);
  });

  test("a test body that gains assertions", () => {
    const root = fixture(
      { "a.test.mjs": T('test("adds", () => { assert.equal(1, 1); });\n') },
      { "a.test.mjs": T('test("adds", () => { assert.equal(1, 1); assert.equal(2, 2); });\n') },
    );
    assert.deepEqual(reasons(root), []);
  });
  test("a source change with no test touched", () => {
    const root = fixture({ "a.mjs": SRC, "a.test.mjs": T('test("adds", () => { assert.strictEqual(1, 1); });\n') }, { "a.mjs": `${SRC}// more\n` });
    assert.deepEqual(reasons(root), []);
  });

  test("a new test with its assertions", () => {
    const root = fixture(
      { "a.test.mjs": T('test("adds", () => { assert.strictEqual(1, 1); });\n') },
      { "a.test.mjs": T('test("adds", () => { assert.strictEqual(1, 1); });\ntest("subtracts", () => { assert.strictEqual(2, 2); assert.deepStrictEqual([1], [1]); });\n') },
    );
    assert.deepEqual(reasons(root), []);
  });

  test("an assertion made stricter, a regex narrowed, a tolerance tightened", () => {
    const root = fixture(
      { "a.test.mjs": T('test("t", () => {\n  assert.ok(add(1, 2) === 3);\n  assert.match(say(), /hello.*/i);\n  assert.ok(Math.abs(a - b) < 5);\n});\n') },
      { "a.test.mjs": T('test("t", () => {\n  assert.strictEqual(add(1, 2), 3);\n  assert.match(say(), /^hello world$/);\n  assert.ok(Math.abs(a - b) < 0.01);\n});\n') },
    );
    assert.deepEqual(reasons(root), []);
  });

  test("a test file renamed to another test name", () => {
    const body = T('test("one", () => { assert.strictEqual(1, 1); });\ntest("two", () => { assert.strictEqual(2, 2); });\n');
    const root = fixture({ "a.test.mjs": body }, { "a.test.mjs": null, "b.test.mjs": body });
    assert.deepEqual(reasons(root), []);
  });

  test("a test moved within its file", () => {
    const one = 'test("one", () => { assert.strictEqual(1, 1); });\n';
    const two = 'test("two", () => { assert.strictEqual(2, 2); });\n';
    const root = fixture({ "a.test.mjs": T(one + two) }, { "a.test.mjs": T(two + one) });
    assert.deepEqual(reasons(root), []);
  });

  test("a source file whose name or content mentions skip is not a test", () => {
    const root = fixture({ "a.mjs": SRC }, { "a.mjs": `${SRC}export const skip = (x) => x.skip(); const only = 1;\n` });
    assert.deepEqual(reasons(root), []);
  });
});

// The can't-fail check runs the head's changed test files on the merge base.
describe("a new test that passes on the merge base", () => {
  const before = { "add.mjs": "export const add = (a, b) => a + b;\n", "add.test.mjs": T('import { add } from "./add.mjs";\ntest("adds", () => { assert.strictEqual(add(1, 2), 3); });\n') };
  const withNew = (extra) => ({ ...before, "add.test.mjs": before["add.test.mjs"] + extra });

  test("is flagged as can't fail", async () => {
    // `add` already works at the base, so a new test of it asserts nothing the change made true.
    const root = fixture(before, withNew('test("adds zero", () => { assert.strictEqual(add(0, 0), 0); });\n'));
    const hits = await reasons(root, { rerun: true, box: "never" });
    flagged(hits, /add\.test\.mjs: can't fail: "adds zero" passes on the merge base/);
    assert.equal(hits.some((h) => /"adds"/.test(h)), false, "the test that was already there is not new");
  });

  test("is not flagged when it fails there", async () => {
    const root = fixture(before, { ...withNew('import { sub } from "./add.mjs";\ntest("subtracts", () => { assert.strictEqual(sub(3, 1), 2); });\n'), "add.mjs": "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n" });
    assert.deepEqual(await reasons(root, { rerun: true, box: "never" }), []);
  });

  test("a new test file that cannot load on the merge base is not flagged", async () => {
    const root = fixture(before, { "new.test.mjs": T('import { nope } from "./nope.mjs";\ntest("n", () => { assert.ok(nope); });\n'), "nope.mjs": "export const nope = 1;\n" });
    assert.deepEqual(await reasons(root, { rerun: true, box: "never" }), []);
  });

  test("leaves no worktree behind, and the checkout is untouched", async () => {
    const root = fixture(before, withNew('test("adds zero", () => { assert.strictEqual(add(0, 0), 0); });\n'));
    await reasons(root, { rerun: true, box: "never" });
    assert.equal(git(root, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1);
    assert.deepEqual(readdirSync(root).filter((f) => !f.startsWith(".")).sort(), ["add.mjs", "add.test.mjs"]);
  });

  test("a rerun that runs past its limit is a hit, not a hang", async () => {
    const hang = ('test("hangs", async () => { await new Promise(() => setInterval(() => {}, 1000)); });\n');
    const root = fixture(before, { ...before, "add.test.mjs": before["add.test.mjs"] + hang });
    const started = Date.now();
    flagged(await reasons(root, { rerun: true, box: "never", timeoutSec: 2 }), /can't-fail check did not finish/);
    assert.ok(Date.now() - started < 20000);
  });

  test("with box required and no bubblewrap, the check says it did not run", async () => {
    const root = fixture(before, withNew('test("adds zero", () => { assert.strictEqual(add(0, 0), 0); });\n'));
    flagged(await reasons(root, { rerun: true, box: "require", bwrap: null }), /can't-fail check not run: no bubblewrap/);
  });

  const boxWorks = (() => {
    const r = spawnSync("bwrap", ["--unshare-all", "--ro-bind", "/", "/", "true"], { stdio: "ignore" });
    return r.status === 0;
  })();
  test("runs boxed when bubblewrap works", { skip: !boxWorks && "no working bubblewrap here" }, async (t) => {
    const launcher = guardLauncher(process.env);
    if (!(await launcher.preflight()).ok) return t.skip("no resource group here");
    const root = fixture(before, withNew('test("adds zero", () => { assert.strictEqual(add(0, 0), 0); });\n'), path.join(os.homedir(), ".cache", "test-guard-fixtures"));  // the box has its own /tmp, so a fixture under /tmp would be hidden
    flagged(await reasons(root, { rerun: true, launcher }), /can't fail: "adds zero"/);
    assert.equal(existsSync(path.join(root, ".claude", "worktrees")) ? readdirSync(path.join(root, ".claude", "worktrees")).length : 0, 0);
  });

  // H1: the rerun of untrusted tests goes through the launcher, in a resource group with the checks limits.
  const addZero = () => fixture(before, withNew('test("adds zero", () => { assert.strictEqual(add(0, 0), 0); });\n'));
  const BWRAP = "/usr/bin/bwrap"; // never run: the fake launcher stands in for it
  function fakeLauncher({ out = "", hang = false, fail = null, exhausted = null, code = 0 } = {}) {
    const l = { enforced: true, launches: [], killed: 0 };
    l.launch = async (req) => {
      l.launches.push(req);
      if (fail) throw fail;
      const script = hang ? "setInterval(() => {}, 1000)" : `process.stdout.write(${JSON.stringify(out)}, () => process.exit(${code}))`;
      const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
      return { child, group: { kill: () => ((l.killed += 1), child.kill("SIGKILL")), settled: async () => true, exhausted: () => exhausted, unit: "fake.scope" } };
    };
    return l;
  }
  const worktrees = (root) => (existsSync(path.join(root, ".claude", "worktrees")) ? readdirSync(path.join(root, ".claude", "worktrees")) : []);

  test("runs the changed tests through the launcher, as a worker, in the box", async () => {
    const root = addZero();
    const launcher = fakeLauncher({ out: "ok 1 - adds zero\n1..1\n" });
    flagged(await reasons(root, { rerun: true, launcher, bwrap: BWRAP }), /can't fail: "adds zero"/);
    assert.equal(launcher.launches.length, 1);
    const [req] = launcher.launches;
    assert.equal(req.slotClass, "worker");
    assert.equal(req.bin, BWRAP);
    assert.match(req.id, /^[a-z0-9][a-z0-9-]{0,63}$/);
    const command = req.args.slice(req.args.indexOf("--") + 1);
    assert.deepEqual(command.slice(1), ["--test", "--test-concurrency=2", "--test-reporter=tap", "add.test.mjs"]);
    assert.ok(req.args.includes("--unshare-all"));
    assert.equal(launcher.killed >= 1, true, "the group is ended when the run is over");
    assert.deepEqual(worktrees(root), []);
  });

  // L9: a rerun that was cut short, or gave no test report, says nothing about "can't fail", so it is a hit, not clean.
  test("a rerun whose group ran out of memory or tasks is a hit", async () => {
    for (const exhausted of ["memory", "processes"]) {
      const launcher = fakeLauncher({ out: "1..1\n", exhausted, code: 137 });
      flagged(await reasons(addZero(), { rerun: true, launcher, bwrap: BWRAP }), new RegExp(`can't-fail check not run: .*ran out of ${exhausted}`));
    }
  });

  test("a rerun that gives no test report is a hit", async () => {
    const launcher = fakeLauncher({ out: "", code: 1 });
    flagged(await reasons(addZero(), { rerun: true, launcher, bwrap: BWRAP }), /can't-fail check not run: .*no test report \(exit 1\)/);
  });

  test("a rerun whose tests fail on the merge base, with a report, is clean", async () => {
    const launcher = fakeLauncher({ out: "not ok 1 - adds zero\n1..1\n", code: 1 });
    assert.deepEqual(await reasons(addZero(), { rerun: true, launcher, bwrap: BWRAP }), []);
  });

  test("the guard's launcher has the checks limits", () => {
    const l = guardLauncher({});
    assert.deepEqual(l.limits.classes.worker, LIMITS.checks);
    assert.deepEqual(l.limits, checksLimits());
  });

  test("with box required and no launcher, the rerun is a hit and runs nothing", async () => {
    const root = addZero();
    flagged(await reasons(root, { rerun: true, bwrap: BWRAP }), /can't-fail check not run: no resource group/);
    assert.deepEqual(worktrees(root), []);
  });

  test("a launcher that cannot enforce the limits makes the rerun a hit, not an unboxed run", async () => {
    const root = addZero();
    const launcher = fakeLauncher({ fail: new EnforcementError("no user bus") });
    flagged(await reasons(root, { rerun: true, launcher, bwrap: BWRAP }), /can't-fail check not run: .*no user bus/);
    assert.deepEqual(worktrees(root), []);
  });

  test("a rerun that outlives its limit has its group killed and is a hit", async () => {
    const root = addZero();
    const launcher = fakeLauncher({ hang: true });
    flagged(await reasons(root, { rerun: true, launcher, bwrap: BWRAP, timeoutSec: 1 }), /can't-fail check did not finish/);
    assert.ok(launcher.killed >= 1);
  });

  test("the default is to require the box", async () => {
    const root = addZero();
    flagged(await reasons(root, { rerun: true, bwrap: null }), /can't-fail check not run: no bubblewrap/);
  });

  // L7: a guard that was killed leaves a worktree; the next run sweeps the stale ones, and only those.
  test("a stale guard worktree is swept at the start of a run, a fresh one is not", async () => {
    const root = addZero();
    const dir = path.join(root, ".claude", "worktrees");
    const [old, fresh] = [`test-guard-1-${Date.now() - 3600_000}`, `test-guard-1-${Date.now()}`];
    for (const name of [`${old}-nm`, fresh]) mkdirSync(path.join(dir, name), { recursive: true });
    git(root, "worktree", "add", "--detach", path.join(dir, old), "base");
    await reasons(root, { rerun: true, box: "never" });
    assert.deepEqual(worktrees(root), [fresh], "only the fresh one is left");
    assert.equal(git(root, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1, "and it is no longer registered");
  });
});

describe("the static pass is bounded", () => {
  test("an unclosed block comment is stripped in linear time", () => {
    const started = Date.now();
    stripComments("/*a".repeat(80000));
    assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
  });

  test("a test file over the size cap is a hit and is not analysed", () => {
    const big = `// ${"x".repeat(300 * 1024)}\n`;
    const root = fixture({ "a.test.mjs": T('test("adds", () => { assert.strictEqual(1, 1); });\n') }, { "a.test.mjs": T(`${big}test("adds", () => { assert.strictEqual(1, 1); });\n`) });
    flagged(reasons(root), /a\.test\.mjs: test file over \d+ KB: not analysed, the verifier reads it by hand/);
  });
});

describe("the script", () => {
  const run = (root, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8" });

  test("exits 1 and prints file: reason for a hit", () => {
    const root = fixture({ "a.test.mjs": T('test("adds", () => { assert.strictEqual(1, 1); });\n') }, { "a.test.mjs": null });
    const r = run(root, "base...HEAD", "--no-rerun");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^test-guard: 1 hit\(s\) on base\.\.\.HEAD/);
    assert.match(r.stdout, /^a\.test\.mjs: test file deleted/m);
  });

  test("exits 0 and says clean for a clean diff", () => {
    const root = fixture({ "a.mjs": SRC }, { "a.mjs": `${SRC}// x\n` });
    const r = run(root, "base...HEAD");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /test-guard: clean/);
  });

  test("refuses a range that looks like an option", () => {
    const root = fixture({ "a.mjs": SRC }, { "a.mjs": `${SRC}// x\n` });
    const r = run(root, "--output=/tmp/x");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /option-shaped/);
  });

  // M3 + L5: --json is the machine channel: one object on stdout, so no file name can pass for a note or hide a hit.
  test("--json prints one object, and a file named like a note is still a hit", () => {
    const name = "test-guard: x.test.mjs";
    const root = fixture({ "a.mjs": SRC }, { "a.mjs": SRC, [name]: T('test.skip("x", () => { assert.strictEqual(1, 1); });\n') });
    const r = run(root, "base...HEAD", "--no-rerun", "--json");
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.ok(out.hits.some((h) => h.file === name && /skip, todo or only added/.test(h.reason)), r.stdout);
    assert.deepEqual(out.notes, []);
  });

  test("--json on a clean diff is an empty hit list and exit 0", () => {
    const root = fixture({ "a.mjs": SRC }, { "a.mjs": `${SRC}// x\n` });
    const r = run(root, "base...HEAD", "--json");
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout).hits, []);
  });

  // L6: with no explicit --no-box, the changed tests never run unboxed.
  test("without --no-box a missing box is a hit, never an unboxed run", () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), "test-guard-bin-"));
    roots.push(bin);
    symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), path.join(bin, "git"));
    const add = "export const add = (a, b) => a + b;\n";
    const root = fixture({ "add.mjs": add, "add.test.mjs": T('test("adds", () => { assert.ok(1); });\n') },
      { "add.mjs": add, "add.test.mjs": T('test("adds", () => { assert.ok(1); });\ntest("adds zero", () => { assert.ok(1); });\n') });
    const env = { PATH: bin, HOME: root };
    const guarded = spawnSync(process.execPath, [SCRIPT, "base...HEAD"], { cwd: root, encoding: "utf8", env });
    assert.equal(guarded.status, 1);
    assert.match(guarded.stdout, /can't-fail check not run/);
    assert.doesNotMatch(guarded.stdout, /can't fail: /);
    const unboxed = spawnSync(process.execPath, [SCRIPT, "base...HEAD", "--no-box"], { cwd: root, encoding: "utf8", env });
    assert.match(unboxed.stdout, /can't fail: "adds zero"/);
  });
});
