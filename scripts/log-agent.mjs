#!/usr/bin/env node
// organism-infra/48: append one validated kind:"agent" row (kind:"cell" before ADR 0028) to .scratch/usage.jsonl (ADR 0008).
// Usage: node scripts/log-agent.mjs --ticket <feature>/<NN-slug>|none --role <role> [--mode <m>] [--model <id>]
//          --tokens <int> --ms <int> --outcome "<text>"
//          [--context <int>]                 (the agent's final `context.mjs --self` reading; organism-infra/119)
//          [--transcript <file.jsonl>]       (the agent's subagent transcript: adds the four billed totals to the row and appends a spend row; organism-infra/211)
//          [--allow-no-handoff "<reason>"]   (skip the recent-handoff check; reason is logged in the row)
// Root is $DEN_ROOT, else the main checkout (git worktree list, as board does), else the current directory.
// A short --ticket <feature>/<NN> resolves to the full slug ref (organism-infra/126).
// A scout row needs no handoff (organism-infra/177): scouts are read-only and never publish one.
// A ticketless (--ticket none) row from any other agent must pass --allow-no-handoff "<reason>" (organism-infra/218).
// Any rejection exits 1 and writes nothing.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { appendUsageRows, agentRow, sessionOf, spendDelta, spendRow, transcriptTotals } from "./spend-lib.mjs";
import { resolveRoot, resolveShortRef } from "../apps/board/board-service.mjs";
import { normalizeLegacyFlags, roleOf } from "../apps/board/legacy-terms.mjs";

const ROLES = ["product", "architect", "orchestrator", "developer", "scout", "qa", "security", "designer"];
const REF_RE = /^([a-z0-9-]+)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const FLAGS = ["ticket", "role", "mode", "model", "tokens", "ms", "outcome", "failures", "allow-no-handoff", "context", "transcript"];
const TOOLS = ["bash-guard", "board-claim", "board-release", "board-comment", "board-handoff", "handoff-state", "git", "npm", "write", "ci", "other"];

function fail(msg) {
  console.error(`log-agent: ${msg}`);
  process.exit(1);
}

const args = normalizeLegacyFlags(process.argv.slice(2), "log-agent");
const f = {};
for (let i = 0; i < args.length; i += 2) {
  const name = args[i].startsWith("--") ? args[i].slice(2) : null;
  if (!name || !FLAGS.includes(name)) fail(`unrecognized argument: ${args[i]}`);
  if (args[i + 1] === undefined) fail(`--${name} requires a value`);
  f[name] = args[i + 1];
}

// organism-infra/218: the exact string "none" logs a run not tied to a ticket (ticket: null).
const ticketless = f.ticket === "none";
let m = ticketless ? null : REF_RE.exec(f.ticket ?? "");
if (!ticketless && (!m || m[2] === ".." || m[2].includes(".."))) fail(`--ticket must be <feature>/<NN-slug>, got ${JSON.stringify(f.ticket)}`);
if (!ROLES.includes(f.role)) fail(`--role must be one of ${ROLES.join(", ")}`);
for (const n of ["tokens", "ms"]) {
  if (!/^[0-9]{1,15}$/.test(f[n] ?? "")) fail(`--${n} must be a non-negative integer`);
}
// organism-infra/119: the agent's final `context.mjs --self` reading, same integer rule as --tokens.
if (f.context !== undefined && !/^[0-9]{1,15}$/.test(f.context)) fail("--context must be a non-negative integer");
if (!f.outcome || !f.outcome.trim()) fail("--outcome must be non-empty");
if (f.mode !== undefined && !f.mode.trim()) fail("--mode must be non-empty when given");
if (f.model !== undefined && !f.model.trim()) fail("--model must be non-empty when given");
if (f.model !== undefined && f.model.length > 64) fail("--model must be at most 64 characters");
if (f.outcome.length > 500) fail("--outcome must be at most 500 characters");
if (f.mode !== undefined && f.mode.length > 32) fail("--mode must be at most 32 characters");

// --failures "<tool>:<what>;..." (organism-infra/50): validated before anything is written.
const incidents = [];
if (f.failures !== undefined) {
  for (const item of f.failures.split(";")) {
    const i = item.indexOf(":");
    if (i < 0) fail(`--failures item needs <tool>:<what>, got ${JSON.stringify(item)}`);
    const tool = item.slice(0, i).trim();
    const what = item.slice(i + 1);
    if (!TOOLS.includes(tool)) fail(`--failures tool must be one of ${TOOLS.join(", ")}, got ${JSON.stringify(tool)}`);
    if (!what.trim()) fail("--failures what must be non-empty");
    if (what.length > 300) fail("--failures what must be at most 300 characters");
    incidents.push({ tool, what });
  }
}

let root;
try {
  root = path.resolve(resolveRoot(process.cwd(), process.env));
} catch {
  root = process.cwd(); // not in a git checkout and no $DEN_ROOT: the old default
}
if (!ticketless) {
  try {
    f.ticket = resolveShortRef(root, f.ticket);
  } catch (err) {
    fail(err.message);
  }
  m = REF_RE.exec(f.ticket);
  if (!existsSync(path.join(root, ".scratch", m[1], "issues", `${m[2]}.md`))) fail(`ticket not found: ${f.ticket}`);
}

// organism-infra/51: an agent row needs a recent handoff from that role/mode, else
// the agent finished without handing off. --allow-no-handoff "<reason>" is the logged escape.
if (f["allow-no-handoff"] !== undefined) {
  if (!f["allow-no-handoff"].trim()) fail("--allow-no-handoff needs a non-empty reason");
  if (f["allow-no-handoff"].length > 300) fail("--allow-no-handoff reason must be at most 300 characters");
} else if (f.role !== "scout" && ticketless) {
  // organism-infra/218: a ticketless run has no handoffs dir to check, so a non-scout agent must say why.
  fail(`a ticketless row from ${f.role} needs --allow-no-handoff "<reason>" (only scout is exempt)`);
} else if (f.role !== "scout") {
  const dir = path.join(root, ".scratch", m[1], "handoffs");
  const nn = /^(\d{2,})-/.exec(m[2])?.[1];
  const refs = new Set([f.ticket, nn && `${m[1]}/${nn}`]);
  const maxAgeMs = 24 * 3600_000;
  let found = false;
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (!nn || !name.startsWith(`${nn}-`) || !name.endsWith(".md")) continue;
    const p = path.join(dir, name);
    let st, state;
    try {
      st = statSync(p);
      state = JSON.parse(/```json\s*([\s\S]*?)```/.exec(readFileSync(p, "utf8"))?.[1]);
    } catch {
      continue;
    }
    if (!st.isFile() || !state || !refs.has(state.ticket)) continue;
    if (roleOf(state) !== f.role || state.mode !== f.mode) continue;
    if (Date.now() - st.mtimeMs > maxAgeMs) continue;
    found = true;
    break;
  }
  if (!found) {
    fail(
      `no handoff for ${f.ticket} from ${f.role}${f.mode !== undefined ? ` (mode ${f.mode})` : ""} published in the last 24 hours; ` +
        `the agent did not hand off. Send it back, or pass --allow-no-handoff "<reason>"`,
    );
  }
}

// organism-infra/211: billed totals from the subagent transcript, read before anything is written.
let billed;
if (f.transcript !== undefined) {
  try {
    billed = transcriptTotals(f.transcript);
  } catch (err) {
    fail(`--transcript unreadable: ${err.message}`);
  }
}

// den-v1 loop S4: the row's shape and the append are shared with the bridge's run ledger (spend-lib.mjs).
const row = agentRow({
  ts: new Date().toISOString(), ticket: ticketless ? null : f.ticket, role: f.role, mode: f.mode, model: f.model,
  tokens: Number(f.tokens), ms: Number(f.ms), outcome: f.outcome,
  context: f.context !== undefined ? Number(f.context) : undefined, billed, allowNoHandoff: f["allow-no-handoff"],
});
const scratch = path.join(root, ".scratch");
if (existsSync(scratch) && lstatSync(scratch).isSymbolicLink()) fail(".scratch is a symlink; refusing to write through it");
const incidentRows = incidents.map(({ tool, what }) => ({
  kind: "incident", ts: row.ts, ticket: row.ticket, role: f.role, tool, what, cost: null, fix: null, rule_change: null, source: "agent-report",
}));
const session = f.transcript !== undefined ? sessionOf(f.transcript) : null;
const spend = billed ? spendRow({ ts: row.ts, session, role: f.role, ticket: row.ticket, delta: spendDelta(root, session, billed) }) : null;
// O_NOFOLLOW: a symlinked usage.jsonl is refused (organism-infra/49).
try {
  appendUsageRows(root, [row, ...(spend ? [spend] : []), ...incidentRows]);
} catch (err) {
  fail(err.message);
}
