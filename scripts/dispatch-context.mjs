#!/usr/bin/env node
// organism-infra/87: supply jg context to a cold agent at dispatch (docs/adr/0014 decisions 3, 5, 7).
// Usage: node scripts/dispatch-context.mjs --ticket <feature>/<NN-slug> [--root <dir>] [--refresh]
// Runs jg once per ticket through the scripts/jg.mjs wrapper, writes $DEN_ROOT/.scratch/_context/<feature>/<NN-slug>.md
// and prints one JSON line {path, bytes, skipped, fallback}. Exit 0 always, except exit 2 for bad arguments. A skip or a
// fallback writes no file, so the relay runs cold exactly as before. Appends a kind:"jg" row to .scratch/usage.jsonl.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { hasSecret } from "./exposure.mjs";
import { runJg, versionAtLeast } from "./jg.mjs";
import { appendUsageLine, resolveRoot } from "../apps/board/board-service.mjs";

const QUESTION = "Where would this change be made, and which tests cover it?";
const WHAT_MAX = 1500;
const OUTPUT_CAP = 24576;
const ROOT_CAP = 5242880;
const TIMEOUT_MS = 90000;
const CODE_TYPES = new Set(["feature", "task", "fix", "bug", "chore", "refactor"]);
const BOARD_DIRS = [".scratch/", ".claude/"];
// organism-infra/97: jg refuses to read any file over 16 MiB (resource_limit), so each one is excluded per call. --max-output-bytes
// (what keeps a search under OUTPUT_CAP) arrived in jg 0.7.1 (checked against the 0.6.0, 0.7.0 and 0.7.1 packages); an older jg
// also lacks the flag, and 0.4.4 lacks --exclude.
const JG_FILE_LIMIT = 16 * 1024 * 1024;
const MIN_JG_VERSION = [0, 7, 1];

const inBoard = (rel) => BOARD_DIRS.some((d) => rel.startsWith(d));

// organism-infra/95: jg never sends binaries, so neither the size gate nor the secret scan counts them.
const BINARY_EXTS = new Set([
  ".blend", ".blend1", ".glb", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bin", ".zip", ".gz", ".woff", ".woff2",
  ".ttf", ".otf", ".pdf", ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".exr", ".hdr", ".ktx2", ".basis",
]);
const SNIFF_BYTES = 8192;

// A known binary extension, or a NUL byte in the first 8 KB. Unreadable or missing files are not binary (the callers skip them).
function isBinary(root, rel) {
  if (BINARY_EXTS.has(path.extname(rel).toLowerCase())) return true;
  let fd;
  try {
    fd = openSync(path.join(root, rel), "r");
    const buf = Buffer.alloc(SNIFF_BYTES);
    return buf.subarray(0, readSync(fd, buf, 0, SNIFF_BYTES, 0)).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseTicket(text) {
  const type = (/^\*\*Type:\*\*[ \t]*([A-Za-z-]+)/m.exec(text)?.[1] ?? "").toLowerCase();
  // organism-infra/102: board tickets use a `## What to build` section, which runs to the next `## ` heading (a `###` stays inside it).
  const section = /^## What to build[ \t]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1].trim();
  const bold = /^\*\*What to build:\*\*[ \t]*([\s\S]*?)(?=^\*\*[A-Za-z][^*\n]*:\*\*|^## |(?![\s\S]))/m.exec(text)?.[1].trim();
  return { type, what: section || bold || "" };
}

// Distinct file paths (a slash and an extension) in the text that exist under root.
function namedPaths(what, root, exists) {
  const found = new Set();
  for (const m of what.matchAll(/[\w.@-]+(?:\/[\w.@-]+)+\.\w+/g)) if (exists(m[0])) found.add(m[0]);
  return found;
}

// Classify a jg call that produced no usable stdout, from the raw result the wrapper saw.
function failureReason(raw) {
  if (!raw) return "jg-error";
  if (raw.error) return raw.error.code === "ENOENT" ? "jg-missing" : "jg-error";
  const r = raw.result;
  if (r.timedOut) return "timeout";
  if (/not authenticated/i.test(`${r.stderr ?? ""}${r.stdout ?? ""}`)) return "not-authenticated";
  if (r.exitCode !== 0) return `jg-exit-${r.exitCode}`;
  return "jg-error";
}

// `jgVersion` (optional, the CLI passes it) returns the text of `jg --version`. A version it can read below MIN_JG_VERSION falls
// back jg-version before any search; an unreadable one is no verdict, so the search runs and fails as it always did.
export async function buildContext({
  ticketText, root, run = spawnRun, exists, now = () => Date.now(), ticket, trackedBytes = statBytes, jgVersion,
}) {
  const t0 = now();
  const has = exists ?? ((p) => existsSync(path.resolve(root, p)));
  const finish = ({ file, files = 0, skipped = null, fallback = null, secret_path }) => {
    const bytes = file === undefined ? 0 : Buffer.byteLength(file);
    const row = { kind: "jg", ts: new Date(t0).toISOString(), ...(ticket && { ticket }), bytes, files, ms: Math.max(0, now() - t0), skipped, fallback, ...(secret_path && { secret_path }) };
    return file === undefined ? { row } : { file, row };
  };

  const { type, what } = parseTicket(ticketText);
  if (!CODE_TYPES.has(type)) return finish({ skipped: `non-code type${type ? ` (${type})` : ""}` });
  if (namedPaths(what, root, has).size >= 2) return finish({ skipped: "two or more named paths already located" });

  // Text files (tracked, or untracked and not ignored) outside the board are what jg could send; one listing feeds the size check and the secret check.
  let tracked;
  let oversize;
  try {
    const r = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });
    if (r.exitCode !== 0) return finish({ fallback: "git-ls-files-failed" });
    const listed = r.stdout.split("\0").filter((f) => f && !inBoard(f));
    tracked = listed.filter((f) => !isBinary(root, f));
    oversize = overLimit(root, listed); // binaries too: the 97 MB .blend is what jg refuses
  } catch {
    return finish({ fallback: "git-ls-files-failed" });
  }
  if ((await trackedBytes({ root, files: tracked })) > ROOT_CAP) return finish({ skipped: "root over 5 MB eligible" });
  for (const f of tracked) {
    let body;
    try {
      body = readFileSync(path.join(root, f), "utf8");
    } catch {
      continue; // deleted, a symlink to nowhere, a directory (submodule): nothing to send
    }
    if (hasSecret(body)) return finish({ fallback: "secret-in-root", secret_path: f }); // organism-infra/166: the path only, never the match
  }

  if (jgVersion && versionAtLeast(await jgVersion(), MIN_JG_VERSION) === false) return finish({ fallback: "jg-version" });

  let raw;
  const spy = async (argv) => {
    try {
      const result = await run("jg", argv, { timeoutMs: TIMEOUT_MS, env: { NODE_USE_ENV_PROXY: "1" } });
      raw = { result };
      return result;
    } catch (error) {
      raw = { error };
      throw error;
    }
  };
  let out;
  try {
    out = await runJg({
      query: `${QUESTION}\n\n${what.slice(0, WHAT_MAX)}`, root, excludes: oversize,
      flags: ["--max-source-bytes", String(OUTPUT_CAP), "--max-output-bytes", String(OUTPUT_CAP)], run: spy, now,
    });
  } catch (e) {
    if (e.kind) return finish({ fallback: `refused-${e.kind}` });
    throw e;
  }

  if (out.stdout === undefined) return finish({ fallback: raw?.result?.exitCode === 0 && !raw.result.timedOut ? "incomplete" : failureReason(raw) });
  if (!/^End context\.[ \t]*$/m.test(out.stdout)) return finish({ fallback: "incomplete" });
  if (hasSecret(out.stdout)) return finish({ fallback: "secret-in-output" });
  if (Buffer.byteLength(out.stdout) > OUTPUT_CAP) return finish({ fallback: "output-too-large" });
  return finish({ file: out.stdout, files: out.row.filesReturned });
}

function statBytes({ root, files }) {
  let sum = 0;
  for (const f of files) {
    try {
      sum += statSync(path.join(root, f)).size;
    } catch {
      /* gone since the listing */
    }
  }
  return sum;
}

// Listed files over jg's per-file limit; a file that vanished since the listing is skipped.
function overLimit(root, files) {
  const big = [];
  for (const f of files) {
    try {
      if (statSync(path.join(root, f)).size > JG_FILE_LIMIT) big.push(f);
    } catch {
      /* gone since the listing */
    }
  }
  return big;
}

async function installedJgVersion() {
  try {
    const r = await spawnRun("jg", ["--version"], { timeoutMs: 10000 });
    return r.exitCode === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

// Production seam: spawn cmd, resolve {stdout, stderr, exitCode, timedOut}; a missing binary rejects with ENOENT.
function spawnRun(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, opts.timeoutMs) : null;
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: timedOut ? null : (code ?? 1), ...(timedOut && { timedOut }) });
    });
  });
}

function parseArgs(argv) {
  const opts = { refresh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--refresh") opts.refresh = true;
    else if (a === "--ticket" || a === "--root") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      opts[a.slice(2)] = v;
    } else return { error: `unknown argument ${a}` };
  }
  if (!opts.ticket) return { error: "--ticket <feature>/<NN-slug> is required" };
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.ticket) || opts.ticket.split("/").some((s) => s.startsWith("."))) return { error: `bad ticket ref ${opts.ticket}` };
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    process.stderr.write(`dispatch-context: ${opts.error}\nusage: node scripts/dispatch-context.mjs --ticket <feature>/<NN-slug> [--root <dir>] [--refresh]\n`);
    return 2;
  }
  const boardRoot = resolveRoot(process.cwd(), process.env);
  const [feature, slug] = opts.ticket.split("/");
  const ticketFile = path.join(boardRoot, ".scratch", feature, "issues", `${slug}.md`);
  if (!existsSync(ticketFile)) {
    process.stderr.write(`dispatch-context: no ticket at ${ticketFile}\n`);
    return 2;
  }
  const outFile = path.join(boardRoot, ".scratch", "_context", feature, `${slug}.md`);
  const print = (o) => process.stdout.write(JSON.stringify({ path: null, bytes: 0, skipped: null, fallback: null, ...o }) + "\n");

  if (!opts.refresh && existsSync(outFile)) {
    print({ path: outFile, bytes: statSync(outFile).size });
    return 0;
  }
  const { file, row } = await buildContext({
    ticketText: readFileSync(ticketFile, "utf8"), root: path.resolve(opts.root ?? boardRoot), ticket: opts.ticket,
    jgVersion: installedJgVersion,
  });
  if (file !== undefined) {
    mkdirSync(path.dirname(outFile), { recursive: true });
    // Write beside the target and rename, so a reader never sees a partial file.
    const tmpFile = path.join(path.dirname(outFile), `.${path.basename(outFile)}.${process.pid}.tmp`);
    try {
      writeFileSync(tmpFile, file);
      renameSync(tmpFile, outFile);
    } catch (e) {
      rmSync(tmpFile, { force: true });
      throw e;
    }
  }
  try {
    await appendUsageLine(boardRoot, JSON.stringify(row) + "\n");
  } catch (e) {
    process.stderr.write(`dispatch-context: usage row not logged (${e.code ?? e.message})\n`);
  }
  print({ path: file === undefined ? null : outFile, bytes: row.bytes, skipped: row.skipped, fallback: row.fallback, ...(row.secret_path && { secret_path: row.secret_path }) });
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
