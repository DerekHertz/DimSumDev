// dimsumden-ui-v0/06: scripts/requests.mjs --list and --handle <id> --outcome <text> (ADR 0011 decision 6).
// Run as a CLI with DEN_ROOT pointing at a disposable checkout holding .scratch/_requests/requests.jsonl.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "scripts", "requests.mjs");
const A = "11111111-1111-4111-8111-111111111111"; // pending
const B = "22222222-2222-4222-8222-222222222222"; // already handled
const C = "33333333-3333-4333-8333-333333333333"; // pending

let root;
let file;
const rows = (rs) => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, DEN_ROOT: root }, cwd: root, encoding: "utf8" });
const fileLines = () => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "requests-cli-"));
  mkdirSync(path.join(root, ".scratch", "_requests"), { recursive: true });
  file = path.join(root, ".scratch", "_requests", "requests.jsonl");
  writeFileSync(
    file,
    rows([
      { id: A, ts: "2026-09-29T05:00:00.000Z", kind: "merge-approve", ref: "fx/04-review", note: "ship it" },
      { id: B, ts: "2026-09-29T05:01:00.000Z", kind: "dispatch-approve", ref: "fx/02-ready-p0" },
      { handled: B, ts: "2026-09-29T05:02:00.000Z", outcome: "dispatched" },
      { id: C, ts: "2026-09-29T05:03:00.000Z", kind: "dispatch-reject", ref: "fx/03-blocked-dep" },
    ]),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("requests.mjs --list", () => {
  test("shows pending requests (id, kind, ref) and hides handled ones", () => {
    const r = run("--list");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(A));
    assert.match(r.stdout, /merge-approve/);
    assert.match(r.stdout, /fx\/04-review/);
    assert.match(r.stdout, new RegExp(C));
    assert.doesNotMatch(r.stdout, new RegExp(B));
  });

  test("with no requests file, exits 0 and lists nothing", () => {
    rmSync(file);
    const r = run("--list");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe("requests.mjs --handle", () => {
  test("appends exactly one handled line with the outcome and a ts, never editing earlier lines", () => {
    const before = readFileSync(file, "utf8");
    const r = run("--handle", A, "--outcome", "merged in PR 47");
    assert.equal(r.status, 0, r.stderr);
    const after = readFileSync(file, "utf8");
    assert.ok(after.startsWith(before), "earlier lines untouched");
    const added = fileLines().slice(4);
    assert.equal(added.length, 1);
    assert.equal(added[0].handled, A);
    assert.equal(added[0].outcome, "merged in PR 47");
    assert.ok(!Number.isNaN(Date.parse(added[0].ts)));
  });

  test("a handled request no longer appears in --list; others stay", () => {
    run("--handle", A, "--outcome", "merged");
    const out = run("--list").stdout;
    assert.doesNotMatch(out, new RegExp(A));
    assert.match(out, new RegExp(C));
  });

  test("an unknown id exits non-zero and writes nothing", () => {
    const before = readFileSync(file, "utf8");
    const r = run("--handle", "99999999-9999-4999-8999-999999999999", "--outcome", "x");
    assert.notEqual(r.status, 0);
    assert.equal(readFileSync(file, "utf8"), before);
  });

  test("an already handled id exits non-zero and writes nothing", () => {
    const before = readFileSync(file, "utf8");
    const r = run("--handle", B, "--outcome", "again");
    assert.notEqual(r.status, 0);
    assert.equal(readFileSync(file, "utf8"), before);
  });

  test("--handle without --outcome exits non-zero and writes nothing", () => {
    const before = readFileSync(file, "utf8");
    const r = run("--handle", A);
    assert.notEqual(r.status, 0);
    assert.equal(readFileSync(file, "utf8"), before);
  });
});
