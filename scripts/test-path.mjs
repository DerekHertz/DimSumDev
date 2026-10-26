#!/usr/bin/env node
// organism-infra/54: `npm run test:path -- <file|dir>...` runs `node --test` on
// the given files, expanding each directory to the *.test.mjs files under it.
// Node 22 rejects directory arguments to `node --test`.
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { runNodeTests } from "./test-budget.mjs";
import { isBrowserFile } from "./test-split.mjs";

function fail(msg) {
  process.stderr.write(`test:path: ${msg}\n`);
  process.exit(2);
}

function collect(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(p, out);
    else if (entry.isFile() && entry.name.endsWith(".test.mjs")) out.push(p);
  }
}

const args = process.argv.slice(2);
if (args.length === 0) fail("usage: npm run test:path -- <file|dir>...");

// npm runs scripts from the package root; INIT_CWD is where the user typed the command.
const base = process.env.INIT_CWD || process.cwd();
const files = [];
for (const arg of args) {
  const p = path.resolve(base, arg);
  let st;
  try {
    st = statSync(p);
  } catch {
    fail(`no such file or directory: ${arg}`);
  }
  if (st.isDirectory()) {
    const found = [];
    collect(p, found);
    if (found.length === 0) fail(`no *.test.mjs files under ${arg}`);
    files.push(...found.sort());
  } else {
    files.push(p);
  }
}

// Under a parent `node --test`, NODE_TEST_CONTEXT makes the child a reporter
// that exits 0 on failures; this runner must own its exit code.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
// Browser files get the same file-concurrency cap as `npm run test:browser`, so a directory
// full of them cannot start a Chromium per file all at once.
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const mode = files.some((f) => isBrowserFile(path.relative(ROOT, f), ROOT)) ? "browser" : "rest";
process.exit(await runNodeTests(files, { mode, env }));
