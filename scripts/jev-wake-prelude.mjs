#!/usr/bin/env node
// organism-infra/72: wake-up gate prelude, shadow (ADR 0015 decision 6).
// Usage: node scripts/jev-wake-prelude.mjs --since <iso-timestamp|last>
// Runs once at orchestrator session start and exits: no daemon, no timer. Code decides every condition it can;
// Jev labels only agent-authored, non-verdict ticket comments posted after --since (`last` = the orchestrator's
// latest board event). Prints one JSON line and appends one jev row per Jev call to usage.jsonl.
// Exits 2 on bad arguments; any other failure prints wake:true and exits 0.
import { roleOf } from "../apps/board/legacy-terms.mjs";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codeWakes, decide } from "./jev.mjs";
import { parseJsonl } from "./metrics.mjs";
import { buildSnapshot } from "../apps/bridge/snapshot.mjs";
import { resolveRoot } from "../apps/board/board-service.mjs";

const USAGE_WIND_DOWN = 0.9;
const GH_TIMEOUT_MS = 15000;
const CI_BAD = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];

// Scope added (user verdict, 2026-09-30): usage alone never wakes. At 90%+ it suppresses the frontier wake, and
// only wind-down items wake: CI red or unreadable, a merge conflict, a gate request, an agent in flight.
export function codeDecides({
  frontierCount = 0, usagePct = 0, ciRed = false, conflicted = false, openVerdictRequest = false, ciUnknown = false,
  inFlightCount = 0,
} = {}) {
  if (ciRed) return { wake: true, reason: "CI red on an open PR" };
  if (conflicted) return { wake: true, reason: "merge conflict on an open PR" };
  if (ciUnknown) return { wake: true, reason: "CI state unreadable" };
  if (openVerdictRequest) return { wake: true, reason: "open gate request" };
  if (inFlightCount > 0) return { wake: true, reason: `${inFlightCount} agent(s) in flight` };
  if (frontierCount === 0) return { wake: false };
  if (usagePct < USAGE_WIND_DOWN) return { wake: true, reason: `frontier has ${frontierCount} ticket(s)` };
  return { wake: false, reason: `usage at ${Math.round(usagePct * 100)}%: frontier wake suppressed` };
}

function codeWakeKind({ newComment, author, verdict }) {
  if (verdict) return "verdict comment";
  if (!newComment) return "empty comment";
  if (/scope added/i.test(newComment)) return "Scope added comment";
  return `comment by ${author ?? "unknown author"}`;
}

// ADR 0015 decision 6: code-decidable conditions and code-wake comments wake with no Jev call. Otherwise every
// input gets a shadow label, and anything but informational (other, needs-claude, any fallback) wakes.
export async function runPrelude({
  context = {}, inputs = [], usageRows = [], env = process.env, now = new Date(), transport, mode = "shadow",
} = {}) {
  const code = codeDecides(context);
  if (code.wake) return { wake: true, reason: code.reason, rows: [] };
  const woken = inputs.find((i) => codeWakes(i));
  if (woken) return { wake: true, reason: `code wake: ${codeWakeKind(woken)} on ${woken.ticket}`, rows: [] };

  const rows = [];
  const wakes = [];
  for (const input of inputs) {
    const { row } = await decide({
      point: "wake", ticket: input.ticket, ticketText: input.ticketText ?? "", newComment: input.newComment ?? "",
      author: input.author, verdict: input.verdict, usageRows: [...usageRows, ...rows], env, now, mode, transport,
    });
    rows.push(row);
    if (row.fallback) wakes.push(`jev fallback ${row.fallback} on ${input.ticket}`);
    else if (row.pick !== "informational") wakes.push(`jev ${row.pick} on ${input.ticket}`);
  }
  if (wakes.length) return { wake: true, reason: wakes.join("; "), rows };
  const quiet = inputs.length ? "all new inputs informational" : "no new inputs";
  return { wake: false, reason: code.reason ? `${quiet}; ${code.reason}` : quiet, rows };
}

// The cutoff for "new": the orchestrator's latest board event, or null when it has none.
export function lastOrchestratorTs(events) {
  let ts = null;
  for (const e of events) {
    if (roleOf(e) === "orchestrator" && typeof e.ts === "string" && (ts === null || e.ts > ts)) ts = e.ts;
  }
  return ts;
}

// Security review 67: a wake input is the ticket plus one new comment; the orchestrator's own comments are not new.
export function newInputs(events, since, ticketTextOf) {
  return events
    // Security review 72 (Low): feature and ticket become path segments in ticketTextOf, so a separator or ".." is dropped here.
    .filter((e) => e?.op === "comment" && e.feature && e.ticket && roleOf(e) !== "orchestrator" && String(e.ts ?? "") > since)
    .filter((e) => [e.feature, e.ticket].every((s) => typeof s === "string" && !s.includes("..") && !/[\\/\0]/.test(s)))
    .map((e) => ({
      ticket: `${e.feature}/${e.ticket}`,
      ticketText: ticketTextOf(e.feature, e.ticket),
      newComment: typeof e.text === "string" ? e.text : "",
      author: roleOf(e),
      verdict: e.verdict,
    }));
}

export function ciFromPrs(prs) {
  let ciRed = false;
  let conflicted = false;
  for (const pr of prs) {
    if (pr?.mergeable === "CONFLICTING") conflicted = true;
    for (const c of pr?.statusCheckRollup ?? []) {
      if (CI_BAD.includes(c?.conclusion) || CI_BAD.includes(c?.state)) ciRed = true;
    }
  }
  return { ciRed, conflicted };
}

function readCi(root) {
  try {
    const out = execFileSync("gh", ["pr", "list", "--state", "open", "--json", "number,mergeable,statusCheckRollup"], {
      cwd: root, encoding: "utf8", timeout: GH_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"],
    });
    return ciFromPrs(JSON.parse(out));
  } catch {
    return { ciUnknown: true };
  }
}

function readJsonl(file) {
  try { return parseJsonl(readFileSync(file, "utf8")); } catch { return []; }
}

function usage(msg) {
  process.stderr.write(`jev-wake-prelude: ${msg}\nusage: node scripts/jev-wake-prelude.mjs --since <iso-timestamp|last>\n`);
  return 2;
}

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== "--since") return usage("--since is required");
  if (argv[1] !== "last" && !Number.isFinite(Date.parse(argv[1]))) return usage("--since must be an ISO timestamp or last");
  const print = (o) => process.stdout.write(JSON.stringify({ ...o, mode: "shadow" }) + "\n");
  try {
    const root = resolveRoot(process.cwd(), process.env);
    const scratch = path.join(root, ".scratch");
    const events = readJsonl(path.join(scratch, "events.jsonl"));
    const since = argv[1] === "last" ? lastOrchestratorTs(events) : new Date(argv[1]).toISOString();
    if (since === null) {
      print({ wake: true, reason: "no orchestrator event to measure new inputs from", jevCalls: 0 });
      return 0;
    }
    const snap = await buildSnapshot(root);
    const local = {
      frontierCount: snap.frontier.length,
      usagePct: (snap.usage?.fiveHour ?? 0) / 100,
      openVerdictRequest: snap.requests.some((r) => r.state === "pending"),
      inFlightCount: snap.tickets.filter((t) => t.holder).length,
    };
    const context = codeDecides(local).wake ? local : { ...local, ...readCi(root) };
    const ticketTextOf = (feature, ticket) => {
      try { return readFileSync(path.join(scratch, feature, "issues", `${ticket}.md`), "utf8"); } catch { return ""; }
    };
    const usagePath = path.join(scratch, "usage.jsonl");
    const { wake, reason, rows } = await runPrelude({
      context, inputs: newInputs(events, since, ticketTextOf), usageRows: readJsonl(usagePath),
    });
    for (const row of rows) appendFileSync(usagePath, JSON.stringify(row) + "\n");
    print({ wake, reason, since, jevCalls: rows.length });
  } catch (e) {
    print({ wake: true, reason: `prelude error: ${e?.message ?? e}`, jevCalls: 0 });
  }
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
