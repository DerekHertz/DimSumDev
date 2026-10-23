#!/usr/bin/env node
// ci-cd/07: split the suite into the browser files (each starts Chromium) and the rest, so CI
// runs them as two parallel jobs. `all` (what `npm test` runs) does rest, then browser with the
// browser cap: an unbounded glob started about 85 Chromium processes (7 GB) on 2026-10-23.
//   node scripts/test-split.mjs browser|rest|all
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const TOP = ["apps", "packages", "scripts"];

// A file is a browser file when it imports Playwright (found by reading it, so a new browser test
// cannot silently land in `rest`), or when it drives the browser through `npm run smoke`.
export const BROWSER_FILES = ["apps/ci-cd/smoke.test.mjs", "apps/ci-cd/smoke-ui.test.mjs"];
const PLAYWRIGHT_IMPORT = /(?:from|import\()\s*["']playwright["']/;

function collect(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (e.isFile() && e.name.endsWith(".test.mjs")) out.push(path.relative(ROOT, p).split(path.sep).join("/"));
  }
}

export function allTestFiles() {
  const out = [];
  for (const t of TOP) collect(path.join(ROOT, t), out);
  return out.sort();
}

export function isBrowserFile(f, root = ROOT) {
  if (f.endsWith(".browser.test.mjs") || BROWSER_FILES.includes(f)) return true;
  try {
    return PLAYWRIGHT_IMPORT.test(readFileSync(path.join(root, f), "utf8"));
  } catch {
    return false;
  }
}

export function split(files = allTestFiles()) {
  return { browser: files.filter((f) => isBrowserFile(f)), rest: files.filter((f) => !isBrowserFile(f)) };
}

// Each browser file loads the complete garden. Bound file concurrency so
// model decoding and Chromium contexts do not exhaust the CI runner (ci-cd/08).
export function nodeTestArgs(mode, env = process.env) {
  if (mode !== "browser") return [];
  const n = Number(env.BROWSER_FILE_CONCURRENCY);
  return [`--test-concurrency=${Number.isInteger(n) && n > 0 ? n : 3}`];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const groups = split();
  if (mode === "all") {
    let status = 0;
    for (const m of ["rest", "browser"]) {
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), m], { cwd: ROOT, stdio: "inherit" });
      if (r.status !== 0) status = r.status ?? 1;
    }
    process.exit(status);
  }
  if (!groups[mode]) {
    process.stderr.write("usage: test-split.mjs browser|rest|all\n");
    process.exit(2);
  }
  // npm test runs the BOM check first (pretest); the rest job keeps it.
  if (mode === "rest") {
    const bom = spawnSync(process.execPath, ["scripts/bom-check.mjs"], { cwd: ROOT, stdio: "inherit" });
    if (bom.status !== 0) process.exit(bom.status ?? 1);
  }
  const r = spawnSync(process.execPath, ["--test", ...nodeTestArgs(mode), ...groups[mode]], { cwd: ROOT, stdio: "inherit" });
  process.exit(r.status ?? 1);
}
