#!/usr/bin/env node
// organism-infra/80: the only sanctioned way to run jg (handoffs/67-security.md, Q2).
// Usage: node scripts/jg.mjs "<question>" [root]
// The board must not reach jg's provider: every call excludes .scratch/ and .claude/, caller flags are
// never forwarded, and a root inside a dot-directory or outside the checkout is refused. The query is
// checked with exposure.mjs hasSecret before sending. Exit 0 on success or jg failure (the fallback line tells
// the caller to use rg); exit 2 on a refused call. Each call appends a kind:"jg" row to usage.jsonl.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { hasSecret } from "./exposure.mjs";
import { appendUsageLine, resolveRoot } from "../apps/board/board-service.mjs";

export const FORBIDDEN_FLAGS = ["--hidden", "--no-ignore", "--include-sensitive", "--include-dependencies"];
const EXCLUDES = [".scratch/", ".claude/"];
const MIN_VERSION = [0, 6, 0];
const RUN_TIMEOUT_MS = 180000;

class Refused extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

function checkFlags(extraArgs) {
  for (const a of extraArgs) {
    const flag = String(a).split("=")[0];
    if (FORBIDDEN_FLAGS.includes(flag)) throw new Refused("flag", `forbidden flag ${flag}: jg must not widen its default filter`);
  }
  if (extraArgs.length) throw new Refused("flag", "caller flags are not allowed: run as jg.mjs \"<question>\" [root]");
}

// `flags` come from in-process callers (dispatch-context.mjs), never from the CLI: an allowlist, so the only thing they can do is cap the output.
const TRUSTED_FLAGS = ["--max-source-bytes", "--max-output-bytes"];
function checkTrustedFlags(flags) {
  for (let i = 0; i < flags.length; i++) {
    const [flag, ...inline] = String(flags[i]).split("=");
    if (!TRUSTED_FLAGS.includes(flag)) throw new Refused("flag", `forbidden flag ${flag}: in-process callers may only pass ${TRUSTED_FLAGS.join(", ")}`);
    if (!inline.length) i++; // the value token, checked below
    const value = inline.length ? inline.join("=") : String(flags[i]);
    if (!/^\d+$/.test(value)) throw new Refused("flag", `bad value for ${flag}: a byte count is required`);
  }
}

// organism-infra/97: `excludes` also come from in-process callers only (never the CLI). Each entry is a root-relative file path as
// git lists it; the wrapper anchors and escapes it into a gitignore pattern, so an exclude can only hide that one file.
function excludePatterns(excludes) {
  if (!Array.isArray(excludes)) throw new Refused("exclude", "invalid excludes: an array of root-relative file paths is required");
  return excludes.map((p) => {
    if (typeof p !== "string" || !p) throw new Refused("exclude", "invalid exclude: a non-empty path string is required");
    if (p.startsWith("/") || path.isAbsolute(p)) throw new Refused("exclude", `invalid exclude ${JSON.stringify(p)}: must be relative to the root`);
    if (p.split(/[\\/]/).includes("..") || /[\u0000-\u001f]/.test(p)) throw new Refused("exclude", `invalid exclude ${JSON.stringify(p)}`);
    return "/" + p.replace(/[\\*?[\]]/g, "\\$&").replace(/ +$/, (sp) => "\\ ".repeat(sp.length));
  });
}

function checkQuery(query) {
  if (typeof query !== "string" || !query.trim()) throw new Refused("query", "invalid query: a question is required");
  if (query.startsWith("-")) throw new Refused("query", "invalid query: it must not start with '-'");
  if (hasSecret(query)) throw new Refused("secret", "refused: the query looks like it contains a secret");
}

// Nearest ancestor holding .git (a directory in the main checkout, a file in a worktree).
function checkoutOf(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return null;
  }
}

// Dot-directories are judged below the checkout, so a worktree under .claude/worktrees/ stays usable.
function checkRoot(root, checkout) {
  let abs;
  try {
    abs = realpathSync(root);
  } catch {
    throw new Refused("root", `invalid root: ${root} does not exist`);
  }
  if (!statSync(abs).isDirectory()) throw new Refused("root", `invalid root: ${root} is not a directory`);
  const top = checkout ? realpathSync(checkout) : checkoutOf(abs);
  if (!top) throw new Refused("root", `refused root ${root}: no checkout (.git ancestor) bounds it`);
  const rel = path.relative(top, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Refused("root", `refused root ${root}: it is outside the checkout`);
  const hidden = rel.split(path.sep).find((s) => s.startsWith("."));
  if (hidden) throw new Refused("root", `refused root ${root}: it lies inside ${hidden}/`);
  return abs;
}

// true or false for a version found in the text, null when none can be read.
export function versionAtLeast(text, min) {
  const m = String(text ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const v = m.slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}
const versionOk = (text) => versionAtLeast(text, MIN_VERSION) === true;

// jg 0.8.0 opens a search with "Jevgrep: N relevant files." (no per-file "## " headers); the test fakes use "## <path>".
function countFiles(stdout) {
  const text = String(stdout ?? "");
  const headers = text.split("\n").filter((l) => l.startsWith("## ")).length;
  const stated = Number(/^Jevgrep: (\d+) relevant files?\b/m.exec(text)?.[1] ?? 0);
  return Math.max(headers, stated);
}

export async function runJg({
  query, root = ".", extraArgs = [], flags = [], excludes = [], run = spawnJg, now = () => Date.now(), usageRoot, checkout, version,
}) {
  const t0 = now();
  const row = (fields) => ({
    kind: "jg", ts: new Date(t0).toISOString(), queryLen: String(query ?? "").length,
    filesReturned: 0, fallback: true, ms: Math.max(0, now() - t0), ...fields,
  });
  const log = async (r) => {
    if (!usageRoot) return;
    try {
      await appendUsageLine(usageRoot, JSON.stringify(r) + "\n");
    } catch (e) {
      process.stderr.write(`jg: usage row not logged (${e.code ?? e.message})\n`);
    }
  };

  let absRoot;
  let extra;
  try {
    checkFlags(extraArgs);
    checkTrustedFlags(flags);
    extra = excludePatterns(excludes);
    checkQuery(query);
    absRoot = checkRoot(root, checkout);
  } catch (e) {
    if (e instanceof Refused) await log(row({ refused: e.kind }));
    throw e;
  }

  if (version && !versionOk(await version())) {
    const r = row({ reason: "jg-version" });
    await log(r);
    return { row: r };
  }

  const argv = [...[...EXCLUDES, ...extra].flatMap((x) => ["--exclude", x]), ...flags, query, absRoot];
  let result;
  try {
    result = await run(argv);
  } catch {
    const r = row({ reason: "jg-error" });
    await log(r);
    return { row: r };
  }
  const filesReturned = countFiles(result.stdout);
  const reason = result.exitCode !== 0 ? `jg-exit-${result.exitCode}` : filesReturned === 0 ? "no-files" : null;
  const r = row({ filesReturned, fallback: reason !== null, ...(reason && { reason }) });
  await log(r);
  return reason ? { row: r } : { stdout: result.stdout, row: r };
}

function spawnJg(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn("jg", argv, { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    const timer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, exitCode: code ?? 1 }); });
  });
}

function jgVersion() {
  try {
    return execFileSync("jg", ["--version"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function gitTop() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function usageRootOr(cwd) {
  try {
    return resolveRoot(cwd, process.env);
  } catch {
    return cwd;
  }
}

async function main(argv) {
  const [query, root = ".", ...extraArgs] = argv;
  try {
    const { stdout, row } = await runJg({
      query, root, extraArgs, usageRoot: usageRootOr(process.cwd()), checkout: gitTop(), version: jgVersion,
    });
    process.stdout.write(row.fallback ? `jg: no result (${row.reason}); fall back to rg\n` : stdout);
    return 0;
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    process.stderr.write(`jg: ${e.message}\nusage: node scripts/jg.mjs "<question>" [root]\n`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
