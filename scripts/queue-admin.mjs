#!/usr/bin/env node
// queue/04: the user-only entry point that sets the Queue's active feature and admits a ticket the admission gate
// refuses (ADR 0015 Amendment 3 B; spec decisions 3 and 7). Run it as `npm run queue-admin -- <command>`, or
// `!npm run queue-admin -- <command>` inside Claude Code.
//
//   node scripts/queue-admin.mjs [--root <repoRoot>] active <feature>
//   node scripts/queue-admin.mjs [--root <repoRoot>] admit <ref> --reason "<why>"
//
// Each command prints what it will write, reads ONE line from stdin and writes only when that line, trimmed, is
// exactly `y`. An empty line, EOF, a /dev/null stdin or any other answer writes nothing and exits nonzero. There is
// no flag that stands in for the y. This is a convention plus a permission rule, not an identity check (ADR 0008
// decision 7): the settings deny rules keep an agent's tool call out, and the stdin prompt skips a call with no input.
//
// Rows go to <root>/.scratch/usage.jsonl, appended through the board service's O_NOFOLLOW append, never rewritten:
//   {"kind":"config","ts","queue_active":"<feature>","by":"user"}
//   {"kind":"queue-admit","ts","ref","reason","by":"user"}
// <root> is --root, else $DEN_ROOT, else the main checkout (the first line of `git worktree list`), as `board`
// resolves it. The Queue (apps/board/frontier-queue.mjs) reads only rows that carry by:"user".
//
// Exit codes: 0 written; 1 declined or refused; 2 bad arguments.
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { appendUsageLine, resolveRoot } from "../apps/board/board-service.mjs";
import { loadSnapshot } from "../apps/board/frontier-queue.mjs";

const FEATURE_RE = /^[a-z0-9-]+$/; // ADR 0008 decision 6
const REF_RE = /^([a-z0-9-]+)\/(\d{2,}-[a-z0-9-]+)$/;

class Refusal extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

// Text that came from argv or a file goes to a terminal: drop control characters (escape sequences, newlines).
const printable = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, "?");

export function parseArgs(argv) {
  let root = null;
  let reason = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root" || arg === "--reason") {
      if (i + 1 >= argv.length) throw new Refusal(`${arg} needs a value`, 2);
      const value = argv[++i];
      if (arg === "--root") root = path.resolve(value);
      else reason = value;
    } else if (arg.startsWith("-")) {
      throw new Refusal(`unknown argument: ${printable(arg)} (there is no flag that stands in for the y)`, 2);
    } else {
      positional.push(arg);
    }
  }
  return { root, reason, positional };
}

// One line from stdin, or null at EOF. Reads no further, so a piped "x\ny\n" answers "x".
async function readAnswer() {
  const rl = readline.createInterface({ input: process.stdin });
  try {
    const { value, done } = await rl[Symbol.asyncIterator]().next();
    return done ? null : value;
  } finally {
    rl.close();
  }
}

async function confirm(summary) {
  process.stdout.write(`${summary}\nWrite this row? Type y and Enter to confirm: `);
  const answer = await readAnswer();
  process.stdout.write("\n");
  if (answer === null || answer.trim() !== "y") throw new Refusal("not confirmed: nothing written");
}

// Whether <root>/.scratch/usage.jsonl ends in a newline (true when it is empty or absent), so an appended row never
// glues itself to a last line that lacks one.
async function endsCleanly(root) {
  let fh;
  try {
    fh = await open(path.join(root, ".scratch", "usage.jsonl"), "r");
  } catch {
    return true;
  }
  try {
    const { size } = await fh.stat();
    if (size === 0) return true;
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    await fh.close();
  }
}

async function writeRow(root, row) {
  const prefix = (await endsCleanly(root)) ? "" : "\n";
  await appendUsageLine(root, prefix + JSON.stringify(row) + "\n");
}

// The ref must name a ticket file that exists as a plain file under the root (a symlink is not followed).
async function ticketExists(root, ref) {
  const m = REF_RE.exec(ref);
  if (!m) return false;
  const info = await lstat(path.join(root, ".scratch", m[1], "issues", `${m[2]}.md`)).catch(() => null);
  return Boolean(info?.isFile());
}

async function active(root, positional) {
  if (positional.length !== 2) throw new Refusal("usage: queue-admin active <feature>", 2);
  const feature = positional[1];
  if (!FEATURE_RE.test(feature)) {
    throw new Refusal(`refused: ${JSON.stringify(printable(feature))} is not a feature name (^[a-z0-9-]+$)`);
  }
  const old = (await loadSnapshot(root)).active;
  await confirm(`Set the active feature in ${root}\n  old: ${old ?? "(none)"}\n  new: ${feature}`);
  await writeRow(root, { kind: "config", ts: new Date().toISOString(), queue_active: feature, by: "user" });
  console.log(`active feature is now ${feature}`);
}

async function admit(root, positional, reason) {
  if (positional.length !== 2) throw new Refusal('usage: queue-admin admit <ref> --reason "<why>"', 2);
  const ref = positional[1];
  if (reason === null || reason.trim() === "") throw new Refusal('refused: admit needs --reason "<why>"', 2);
  if (!(await ticketExists(root, ref))) {
    throw new Refusal(`refused: ${JSON.stringify(printable(ref))} is not a ticket on the board (use feature/NN-slug)`);
  }
  await confirm(`Admit ${ref} past the admission gate in ${root}\n  reason: ${printable(reason)}`);
  await writeRow(root, { kind: "queue-admit", ts: new Date().toISOString(), ref, reason, by: "user" });
  console.log(`admitted ${ref}`);
}

export async function main(argv, env = process.env, cwd = process.cwd()) {
  const { root: rootArg, reason, positional } = parseArgs(argv);
  const command = positional[0];
  if (command !== "active" && command !== "admit") {
    throw new Refusal('usage: queue-admin active <feature> | admit <ref> --reason "<why>"  [--root <dir>]', 2);
  }
  let root = rootArg;
  if (!root) {
    try {
      root = resolveRoot(cwd, env);
    } catch (err) {
      throw new Refusal(`refused: ${err.message}; pass --root`);
    }
  }
  if (command === "active") await active(root, positional);
  else await admit(root, positional, reason);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (err) => {
      console.error(err instanceof Refusal ? err.message : `queue-admin failed: ${err?.message ?? err}`);
      process.exit(err instanceof Refusal ? err.exitCode : 1);
    }
  );
}
