// organism-infra/209 AC4 (statusline half): scripts/statusline.mjs adds a den v1 segment
//   v1 ████░░ 8/12 · 7 to go       (bar glyphs are █ and ░; width is the developer's choice)
// built from scripts/north-star.mjs. It is omitted when the set is empty (so the existing exact-line
// statusline tests keep passing), and it never touches the network or the usage read.
// Seams: `node scripts/statusline.mjs` with DEN_ROOT, HOME, STATUSLINE_USAGE_SCRIPT, STATUSLINE_CACHE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boardRoot, ticket } from "./north-star-fixture.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "statusline.mjs");
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const USAGE = { "5-hour": { percent: 11, resets_at: "2026-10-02T19:59:00.000Z" }, weekly: { percent: 51, resets_at: "2026-10-06T00:00:00.000Z" } };

function run(root, { usageFails = false, freshCache = false, nodeOptions = "" } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "sl-ns-")));
  const home = path.join(dir, "home");
  mkdirSync(home, { recursive: true });
  const usageScript = path.join(dir, "fake-usage.mjs");
  writeFileSync(usageScript, usageFails ? "process.exit(1);\n" : `console.log(${JSON.stringify(JSON.stringify(USAGE))});\n`);
  const cache = path.join(dir, "cache.json");
  if (freshCache) writeFileSync(cache, JSON.stringify(USAGE));
  const env = { ...process.env, HOME: home, DEN_ROOT: root, STATUSLINE_USAGE_SCRIPT: usageScript, STATUSLINE_CACHE: cache, NODE_OPTIONS: nodeOptions };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CODE_REMOTE;
  const r = spawnSync("node", [SCRIPT], { cwd: root, env, input: JSON.stringify({ session_id: "s", context_window: { current_usage: null } }), encoding: "utf8", timeout: 20000 });
  return { ...r, text: strip(r.stdout ?? ""), dir };
}

function board(statuses) {
  const root = boardRoot();
  statuses.forEach((status, i) => ticket(root, `den-v1/${String(i + 1).padStart(2, "0")}-t`, { status }));
  return root;
}

test("AC4 the line carries `v1 <bar> <done>/<total> · <n> to go`", () => {
  const r = run(board(["resolved", "ready-for-agent", "ready-for-agent", "ready-for-agent"]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.text, /v1 [█░]+ 1\/4 · 3 to go/);
  assert.equal(r.text.trim().split("\n").length, 1);
});

test("AC4 the bar tracks progress: partial has both glyphs, none done has no fill, all done has no gap", () => {
  const partial = /v1 ([█░]+) 1\/4/.exec(run(board(["resolved", "ready-for-agent", "ready-for-agent", "ready-for-agent"])).text);
  assert.ok(partial && partial[1].includes("█") && partial[1].includes("░"));
  const none = /v1 ([█░]+) 0\/2/.exec(run(board(["ready-for-agent", "ready-for-agent"])).text);
  assert.ok(none && !none[1].includes("█"));
  const all = /v1 ([█░]+) 2\/2 · 0 to go/.exec(run(board(["resolved", "closed"])).text);
  assert.ok(all && !all[1].includes("░"));
});

test("AC4 parked tickets are not in the segment's total", () => {
  assert.match(run(board(["resolved", "parked", "ready-for-agent"])).text, /v1 [█░]+ 1\/2 · 1 to go/);
});

test("AC4 with no den-v1 tickets the segment is omitted", () => {
  const r = run(boardRoot());
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.text, /v1/);
});

test("AC4 the segment does not depend on the usage read: it shows when the usage script fails", () => {
  const r = run(board(["resolved", "ready-for-agent"]), { usageFails: true });
  assert.equal(r.status, 0);
  assert.match(r.text, /v1 [█░]+ 1\/2 · 1 to go/);
});

test("AC4 the segment makes no network call (fetch and socket connects are trapped; usage cache is fresh)", () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "sl-ns-trap-")));
  const hit = path.join(dir, "network-hit.txt");
  const trap = path.join(dir, "trap.mjs");
  writeFileSync(
    trap,
    [
      `import net from "node:net"; import { appendFileSync } from "node:fs";`,
      `const note = (w) => appendFileSync(${JSON.stringify(hit)}, w + "\\n");`,
      `const f = globalThis.fetch; globalThis.fetch = (...a) => { note("fetch"); return f(...a); };`,
      `const c = net.Socket.prototype.connect; net.Socket.prototype.connect = function (...a) { note("connect"); return c.apply(this, a); };`,
    ].join("\n"),
  );
  const r = run(board(["resolved", "ready-for-agent"]), { freshCache: true, nodeOptions: `--import ${pathToFileURL(trap).href}` });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.text, /v1 [█░]+ 1\/2 · 1 to go/);
  assert.ok(!existsSync(hit), "a network call was made");
});
