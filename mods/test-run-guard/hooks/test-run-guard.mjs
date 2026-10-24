#!/usr/bin/env node
// test-run-guard: a PreToolUse hook for Bash. On 2026-10-23 an ad-hoc `node --test` over a glob
// ran every browser file at once: about 85 Chromium processes and 7 GB, and stopping the shell
// did not stop the runner. This blocks a `node --test` that names a glob, a directory or more
// than MAX_FILES files without a `--test-concurrency` cap, and points to the capped scripts.
//
// Exit 2 blocks and feeds stderr to the model; exit 0 allows. Fail open on bad input.
// A string check, not a shell parser; self-contained so an installed copy still works.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export const MAX_FILES = 3;
export const MESSAGE =
  "test-run-guard: an uncapped `node --test` over a glob, a directory or many files runs every browser test at once " +
  "(a Chromium each; about 85 processes and 7 GB on 2026-10-23). Use `npm run test:path -- <files|dirs>` " +
  "(it caps browser files), `npm test`, or add `--test-concurrency=3`.";

// Each `node ... --test ...` invocation in the command, as its argument words.
export function testRuns(command) {
  const runs = [];
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    const i = words.findIndex((w) => /(^|\/)node$/.test(w));
    if (i < 0 || !words.slice(i + 1).includes("--test")) continue;
    runs.push(words.slice(i + 1));
  }
  return runs;
}

export function verdict(command, { cwd = process.cwd(), isDir = defaultIsDir } = {}) {
  for (const args of testRuns(command)) {
    if (args.some((a) => a.startsWith("--test-concurrency"))) continue;
    const targets = args.filter((a) => !a.startsWith("-")).map((a) => a.replace(/^["']|["']$/g, ""));
    if (targets.some((a) => /[*?]/.test(a))) return "block";
    if (targets.some((a) => isDir(path.resolve(cwd, a)))) return "block";
    if (targets.filter((a) => a.endsWith(".mjs") || a.endsWith(".js")).length > MAX_FILES) return "block";
  }
  return "allow";
}

function defaultIsDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const command = input?.tool_input?.command;
    if (typeof command === "string" && verdict(command, { cwd: input.cwd || process.cwd() }) === "block") {
      process.stderr.write(MESSAGE + "\n");
      process.exit(2);
    }
  } catch {
    // fail open
  }
  process.exit(0);
}
