import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verdict } from "../mods/test-run-guard/hooks/test-run-guard.mjs";

const HOOK = fileURLToPath(new URL("../mods/test-run-guard/hooks/test-run-guard.mjs", import.meta.url));
const noDir = () => false;

test("blocks an uncapped glob, a directory, or more than three files", () => {
  assert.equal(verdict("node --test apps/ui/src/overlay/*.test.mjs", { isDir: noDir }), "block");
  assert.equal(verdict('cd x && node --test "apps/**/*.test.mjs" 2>&1 | tail', { isDir: noDir }), "block");
  assert.equal(verdict("node --test apps/ui", { isDir: (p) => p.endsWith("apps/ui") }), "block");
  assert.equal(verdict("timeout 100 node --test a.test.mjs b.test.mjs c.test.mjs d.test.mjs", { isDir: noDir }), "block");
});

test("allows a capped run, up to three files, and the npm scripts", () => {
  assert.equal(verdict("node --test --test-concurrency=3 apps/**/*.test.mjs", { isDir: noDir }), "allow");
  assert.equal(verdict("node --test a.test.mjs b.test.mjs c.test.mjs", { isDir: noDir }), "allow");
  assert.equal(verdict("npm run test:path -- apps/ui && npm test", { isDir: noDir }), "allow");
  assert.equal(verdict("node scripts/queue.mjs", { isDir: noDir }), "allow");
});

test("as a hook: exit 2 with the message on a block, exit 0 otherwise and on bad input", () => {
  const run = (input) => spawnSync(process.execPath, [HOOK], { input });
  const blocked = run(JSON.stringify({ tool_input: { command: "node --test apps/*.test.mjs" }, cwd: "/" }));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr.toString(), /test:path/);
  assert.equal(run(JSON.stringify({ tool_input: { command: "ls" } })).status, 0);
  assert.equal(run("not json").status, 0);
});
