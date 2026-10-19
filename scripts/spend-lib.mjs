// organism-infra/211: shared helpers for billed-token spend (spend-log.mjs, log-agent.mjs).
// Reads a Claude session transcript (JSONL) and sums billed usage; appends kind:"spend" rows.
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import path from "node:path";

export const FOUR = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"];

export const zeroTotals = () => Object.fromEntries(FOUR.map((k) => [k, 0]));

const num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

// Sum the four usage fields over a transcript. One API message spans several records with the
// same message.id and usage; it counts once, and the LAST record wins (streamed output grows).
// Lines with no usage, and unparseable lines, are skipped. Throws if the file is unreadable.
export function transcriptTotals(file) {
  if (!statSync(file).isFile()) throw new Error("not a file");
  const byId = new Map();
  let anon = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = rec?.message?.usage;
    if (rec?.type !== "assistant" || !usage || typeof usage !== "object") continue;
    byId.set(rec.message.id ?? `anon-${anon++}`, usage);
  }
  const totals = zeroTotals();
  for (const usage of byId.values()) for (const k of FOUR) totals[k] += num(usage[k]);
  return totals;
}

export function readRows(root) {
  const file = path.join(root, ".scratch", "usage.jsonl");
  if (!existsSync(file)) return [];
  const out = [];
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // skip garbage lines
    }
  }
  return out;
}

// transcript total minus the spend rows already logged for this session (never negative).
export function spendDelta(root, session, totals) {
  const logged = zeroTotals();
  for (const r of readRows(root)) {
    if (r?.kind === "spend" && r.session === session) for (const k of FOUR) logged[k] += num(r[k]);
  }
  return Object.fromEntries(FOUR.map((k) => [k, Math.max(0, totals[k] - logged[k])]));
}

export const isZero = (t) => FOUR.every((k) => t[k] === 0);

// O_NOFOLLOW append: a symlinked usage.jsonl or .scratch is refused (organism-infra/49). Throws on refusal.
export function appendUsageRows(root, rows) {
  const scratch = path.join(root, ".scratch");
  if (existsSync(scratch) && lstatSync(scratch).isSymbolicLink()) throw new Error(".scratch is a symlink; refusing to write through it");
  mkdirSync(scratch, { recursive: true });
  let fd;
  try {
    fd = openSync(path.join(scratch, "usage.jsonl"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
  } catch (err) {
    throw new Error(`cannot open usage.jsonl (${err.code}); symlinks are refused`);
  }
  try {
    writeSync(fd, rows.map((r) => JSON.stringify(r) + "\n").join(""));
  } finally {
    closeSync(fd);
  }
}

// The one shape of a kind:"agent" row (ADR 0008 decision 12; kind:"cell" with a `cell` key before ADR 0028), shared by log-agent.mjs and the bridge's run ledger
// (apps/bridge/agents/ledger.mjs). Callers validate their own fields; this only fixes the keys and their order.
export function agentRow({ ts, ticket, role, mode, model, tokens, ms, outcome, context, billed, allowNoHandoff, extra }) {
  return {
    kind: "agent", ts, ticket, role,
    ...(mode !== undefined ? { mode } : {}),
    ...(model !== undefined ? { model } : {}),
    tokens, ms, outcome,
    ...(context !== undefined ? { context } : {}),
    ...(billed ?? {}),
    ...(allowNoHandoff !== undefined ? { allow_no_handoff: allowNoHandoff } : {}),
    ...(extra ?? {}),
  };
}

export const sessionOf = (transcript) => path.basename(transcript).replace(/\.jsonl$/, "");

// The spend row for a delta, or null when the delta is all zero.
export function spendRow({ ts, session, role, ticket, delta }) {
  if (isZero(delta)) return null;
  return { kind: "spend", ts, session, role, ...(ticket ? { ticket } : {}), ...delta };
}
