#!/usr/bin/env node
// organism-infra/211: append one kind:"spend" row (billed tokens) to .scratch/usage.jsonl.
// Usage: node scripts/spend-log.mjs --transcript <file.jsonl> --role <orchestrator|role>
//          [--ticket <feature>/<NN-slug>] [--session <id>]
// The row holds the delta since earlier spend rows for the same session; an all-zero delta writes
// nothing. stdout is the four delta totals as JSON. Root is $DEN_ROOT, else the main checkout.
// Any rejection exits 1 and writes nothing.
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveRoot, resolveShortRef } from "../apps/board/board-service.mjs";
import { appendUsageRows, sessionOf, spendDelta, spendRow, transcriptTotals } from "./spend-lib.mjs";

const ROLES = ["product", "architect", "orchestrator", "developer", "scout", "qa", "security", "designer"];
const REF_RE = /^([a-z0-9-]+)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const FLAGS = ["transcript", "role", "ticket", "session"];

function fail(msg) {
  console.error(`spend-log: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const f = {};
for (let i = 0; i < args.length; i += 2) {
  const name = args[i].startsWith("--") ? args[i].slice(2) : null;
  if (!name || !FLAGS.includes(name)) fail(`unrecognized argument: ${args[i]}`);
  if (args[i + 1] === undefined) fail(`--${name} requires a value`);
  f[name] = args[i + 1];
}

if (!f.transcript) fail("--transcript is required");
if (!ROLES.includes(f.role)) fail(`--role must be one of ${ROLES.join(", ")}`);
if (f.session !== undefined && (!f.session.trim() || f.session.length > 128)) fail("--session must be 1-128 characters");

let root;
try {
  root = path.resolve(resolveRoot(process.cwd(), process.env));
} catch {
  root = process.cwd();
}

if (f.ticket !== undefined) {
  try {
    f.ticket = resolveShortRef(root, f.ticket);
  } catch (err) {
    fail(`--ticket: ${err.message}`);
  }
  const m = REF_RE.exec(f.ticket);
  if (!m || m[2].includes("..")) fail(`--ticket must be <feature>/<NN-slug>, got ${JSON.stringify(f.ticket)}`);
  if (!existsSync(path.join(root, ".scratch", m[1], "issues", `${m[2]}.md`))) fail(`--ticket not found on the board: ${f.ticket}`);
}

let totals;
try {
  totals = transcriptTotals(f.transcript);
} catch (err) {
  fail(`--transcript unreadable: ${err.message}`);
}
const session = f.session ?? sessionOf(f.transcript);
const delta = spendDelta(root, session, totals);
const row = spendRow({ ts: new Date().toISOString(), session, role: f.role, ticket: f.ticket, delta });
if (row) {
  try {
    appendUsageRows(root, [row]);
  } catch (err) {
    fail(err.message);
  }
}
console.log(JSON.stringify(delta));
