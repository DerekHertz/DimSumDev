// queue/06: retire the old frontier order (ADR 0015 Amendment 3: the order leaves jev.mjs; one order, the Queue).
//
// Seams: the jev.mjs CLI (`order` is an unknown point), the jev.mjs exports, the repo's source files (nothing
// calls the old functions or reads jev-order rows), and the Frontier paragraph of docs/agents/issue-tracker.md.
//
// Criterion map:
//   AC1 `jev.mjs order` exits 2 as an unknown command        -> "AC1 jev.mjs order ..."
//   AC1 no code calls rankFrontier or orderRow               -> "AC1 no source file ..." (the scan covers test
//                                                               files too, so the old tests and the two
//                                                               orderRow cases in jev-advisory-*.test.mjs go)
//   AC2 queue.mjs prints its ready list in buildQueue order  -> scripts/queue.test.mjs ("Q6 ...")
//   AC2 nothing reads jev-order rows any more                -> "AC2 no source file reads jev-order rows"
//   AC3 no caller depends on the aging bump, UI snapshot     -> apps/board/priority.test.mjs ("no aging"),
//       still builds                                            apps/bridge/bridge-state.test.mjs ("no aging")
//   AC4 handoff lists every reader of jev-order rows         -> human-verified (a handoff's content)
//   AC5 issue-tracker.md describes the Queue order           -> "AC5 ..." (terms present; the wording is
//                                                               human-verified)
//   AC6 npm test passes                                      -> the whole suite
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../apps/board/board-fixture.mjs";

const SELF = fileURLToPath(import.meta.url);
const JEV = path.join(REPO_ROOT, "scripts", "jev.mjs");

function runJev(argv) {
  const root = mkdtempSync(path.join(tmpdir(), "retire-order-"));
  mkdirSync(path.join(root, ".scratch", "feat", "issues"), { recursive: true });
  const env = { ...process.env, DEN_ROOT: root };
  delete env.TYPESAFE_API_KEY;
  const r = spawnSync(process.execPath, [JEV, ...argv], { cwd: root, env, encoding: "utf8", timeout: 20000 });
  return { ...r, usagePath: path.join(root, ".scratch", "usage.jsonl") };
}

test("AC1 jev.mjs order exits 2 as an unknown command, with or without arguments, and logs nothing", () => {
  for (const argv of [["order"], ["order", "--actual", "feat/01-a,feat/02-b"]]) {
    const r = runJev(argv);
    assert.equal(r.status, 2, `${argv.join(" ")}: ${r.stderr}`);
    assert.equal(r.stdout, "", "no jev-order row is printed");
    assert.equal(existsSync(r.usagePath), false, "no row is written to usage.jsonl");
    assert.doesNotMatch(r.stderr, /order --actual/, "the usage text no longer advertises the point");
  }
});

test("AC1 control: an unknown command and a known log point still behave as before (exit 2 is not a crash code here)", () => {
  assert.equal(runJev(["no-such-point"]).status, 2);
  const ok = runJev(["priority-verdict", "--ticket", "feat/01-a", "--verdict", "right"]);
  // The ticket does not exist on this empty board, so this exits 1 (ref does not resolve), not 2 (bad usage).
  assert.notEqual(ok.status, 2, ok.stderr);
});

test("AC1 jev.mjs no longer exports rankFrontier or orderRow, and still exports decide", async () => {
  const mod = await import("./jev.mjs");
  assert.equal(mod.rankFrontier, undefined);
  assert.equal(mod.orderRow, undefined);
  assert.equal(typeof mod.decide, "function");
});

// Every tracked source file the repo ships or tests. node_modules and the board are not tracked.
function trackedSources() {
  const r = spawnSync("git", ["ls-files", "-z", "--", "scripts", "apps", "packages", "mods"], { cwd: REPO_ROOT, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\0").filter((f) => /\.(mjs|cjs|js|jsx|ts|tsx)$/.test(f) && path.join(REPO_ROOT, f) !== SELF);
}

test("AC1 no source file, test files included, names rankFrontier or orderRow", () => {
  const files = trackedSources();
  assert.ok(files.length > 50, `the scan found the repo's sources (${files.length})`);
  const hits = [];
  for (const f of files) {
    const text = readFileSync(path.join(REPO_ROOT, f), "utf8");
    if (/\b(rankFrontier|orderRow)\b/.test(text)) hits.push(f);
  }
  assert.deepEqual(hits, []);
});

test("AC2 no source file reads jev-order rows (tests may plant one to show it is ignored)", () => {
  const hits = [];
  for (const f of trackedSources()) {
    if (/\.test\.m?js$/.test(f)) continue;
    if (/jev-order/.test(readFileSync(path.join(REPO_ROOT, f), "utf8"))) hits.push(f);
  }
  assert.deepEqual(hits, []);
});

test("AC5 the Frontier paragraph of issue-tracker.md describes the Queue order, not the aging bump", () => {
  const doc = readFileSync(path.join(REPO_ROOT, "docs", "agents", "issue-tracker.md"), "utf8");
  const line = doc.split("\n").find((l) => /^- \*\*Frontier\*\*/.test(l));
  assert.ok(line, "the Frontier line exists");
  assert.match(line, /Queue/, "names the Queue");
  assert.match(line, /active feature/i, "names the active-feature tier");
  assert.match(line, /unblock/i, "names the unblock-count rule");
  assert.doesNotMatch(line, /moves up one level/i, "the aging bump is gone");
  assert.doesNotMatch(line, /3 orchestrator sessions/i);
});
