// Hierarchy audit replay: a recorded run from the board's own log. Until the runtime emits tree events (the Codex
// track's owner -> manager -> runner runtime; docs/agents/hierarchy-replay.md), the closest real record of a run is
// .scratch/events.jsonl: every claim, release, verdict, park and close, in one serialized sequence. This turns one
// ticket's rows into a schema-1 replay. It reads only; every event carries the board line it came from (sourceRef).
// What the board does not record stays unknown: the owner's name, wait reasons, runner leaves, and any model the
// usage ledger has no row for. Comment text is never copied; only a verdict, a cited commit and handoff paths are.
//   node scripts/hierarchy-replay-export.mjs <feature/ticket> [--owner Bao|Jiao] [--pr URL] [--out file]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REVIEWERS = new Set(["code-reviewer", "qa", "security"]);
const SHA_RE = /\b([0-9a-f]{7,40})\b/;
const HANDOFF_RE = /\bhandoffs\/([A-Za-z0-9_.-]+\.md)\b/g;
const PR_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d{0,8}$/;
const clean = (v, max) => (typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : null);
const shaOf = (text) => { const m = typeof text === "string" ? SHA_RE.exec(text) : null; return m && /[a-f]/.test(m[1]) && /\d/.test(m[1]) ? m[1] : null; };

/** The single model a role's ledger rows for this ticket recorded, or null when none or several. */
function modelsByRole(usageRows, ref) {
  const seen = new Map();
  for (const r of usageRows) {
    if (r?.kind !== "agent" || r.ticket !== ref || typeof r.role !== "string" || typeof r.model !== "string") continue;
    const set = seen.get(r.role) ?? new Set();
    set.add(r.model.slice(0, 80)); seen.set(r.role, set);
  }
  return (role) => (seen.get(role)?.size === 1 ? [...seen.get(role)][0] : null);
}

/**
 * rows: parsed events.jsonl lines; usageRows: parsed usage.jsonl lines -> a schema-1 run (not yet validated).
 * Throws when the ticket has no rows.
 */
export function fromBoardEvents({ ref, rows, usageRows = [], owner = null, pr = null }) {
  const [feature, ticket] = ref.split("/");
  const mine = rows.filter((r) => r && r.feature === feature && r.ticket === ticket && Number.isInteger(r.seq)).sort((a, b) => a.seq - b.seq);
  if (!mine.length) throw new Error(`no board events for ${ref}`);
  if (owner !== null && !["Bao", "Jiao"].includes(owner)) throw new Error("--owner is Bao or Jiao");
  if (pr !== null && !PR_RE.test(pr)) throw new Error("--pr must be a GitHub pull request URL");
  const model = modelsByRole(usageRows, ref);
  const runId = `board-${feature}-${ticket}`.slice(0, 80).replace(/[^A-Za-z0-9._-]/g, "-");
  const ownerRole = mine.some((r) => r.role === "orchestrator") ? "orchestrator" : "owner";
  const events = [];
  const nodes = new Map();
  let unmapped = 0;
  const push = (row, agentId, kind, extra = {}) => {
    const n = nodes.get(agentId);
    events.push({
      runId, eventId: `b${row.seq}-${events.length + 1}`, sequence: events.length + 1, timestamp: row.ts,
      agentId, parentId: n.parentId, name: n.name, role: n.role, layer: n.layer, runtime: n.runtime, model: n.model, tier: null,
      kind, taskSummary: extra.task ?? n.task, relatedAgentId: extra.related ?? null, reason: extra.reason ?? null, blockedOn: [],
      commit: extra.commit ?? null, pr: extra.pr ?? null, evidenceRefs: extra.evidence ?? [], attempt: n.attempt, verdict: extra.verdict ?? null,
      sourceRef: { log: ".scratch/events.jsonl", line: row.seq },
    });
  };
  const evidenceOf = (text) => [...new Set([...(typeof text === "string" ? text.matchAll(HANDOFF_RE) : [])].map((m) => m[1]))].slice(0, 8)
    .map((file) => ({ label: "handoff", ref: `${feature}/handoffs/${file}` }));

  nodes.set("owner", { parentId: null, name: owner, role: ownerRole, layer: "owner", runtime: null, model: model(ownerRole), task: ref, attempt: 1 });
  push(mine[0], "owner", "started", { task: ref });
  const pending = new Map(); // role -> { commit, evidence } cited in its comments, attached to its next release
  let ownerKind = "started";
  const ownerPush = (row, kind, extra) => { ownerKind = kind; push(row, "owner", kind, extra); };
  for (const row of mine) {
    const role = typeof row.role === "string" ? row.role : null;
    const isOwner = role === "orchestrator";
    if (row.op === "claim" || row.op === "reclaim") {
      if (!role) { unmapped++; continue; }
      if (isOwner) { ownerPush(row, "working"); continue; }
      // The board reuses in-review for the next role's turn, so an owner's gate is only known to last until the
      // next claim; after that the owner's state is not recorded (a result: handed on, nothing claimed for it).
      if (ownerKind === "awaiting") ownerPush(row, "result", { reason: `${role} claimed the ticket; the owner's state is not recorded after this` });
      const existing = nodes.get(role);
      if (!existing) {
        nodes.set(role, { parentId: "owner", name: role, role, layer: "manager", runtime: null, model: model(role), task: `${role}${row.mode ? ` (${row.mode})` : ""} on ${ticket}`, attempt: 1 });
        push(row, role, "started");
        push(row, "owner", "delegated", { related: role, task: `Hand ${ticket} to ${role}` });
      } else {
        existing.attempt++;
        push(row, role, "started", { reason: row.op === "reclaim" ? "Reclaimed on the board" : null });
      }
      const n = nodes.get(role);
      push(row, role, role === "developer" && n.attempt > 1 ? "rework" : "working");
    } else if (row.op === "comment") {
      if (!role || isOwner) { unmapped++; continue; }
      const p = pending.get(role) ?? { commit: null, evidence: [] };
      p.commit = shaOf(row.text) ?? p.commit;
      p.evidence = [...p.evidence, ...evidenceOf(row.text)].slice(0, 8);
      pending.set(role, p);
      if ((row.verdict === "pass" || row.verdict === "bounce") && nodes.has(role)) {
        push(row, role, "review", { related: nodes.has("developer") && role !== "developer" ? "developer" : null, verdict: row.verdict, commit: p.commit, evidence: p.evidence, task: `${role} verdict: ${row.verdict}` });
        pending.delete(role);
      } else if (!nodes.has(role)) unmapped++;
    } else if (row.op === "release") {
      if (!role) { unmapped++; continue; }
      const status = clean(row.to_status, 40) ?? "unknown";
      if (isOwner) {
        if (status === "resolved") ownerPush(row, "completed", { reason: "Board status resolved", pr });
        else if (status === "in-review") ownerPush(row, "awaiting", { reason: "Board status in-review after the owner released it (a review or approval gate)" });
        else ownerPush(row, "result", { reason: `Board status ${status}` });
        continue;
      }
      if (!nodes.has(role)) { unmapped++; continue; }
      const p = pending.get(role) ?? { commit: null, evidence: [] };
      pending.delete(role);
      push(row, role, "result", { related: "owner", reason: `Board status ${status}`, commit: p.commit, evidence: p.evidence });
    } else if (row.op === "park") {
      ownerPush(row, "blocked", { reason: clean(row.reason, 200) ?? "Parked on the board (no reason recorded)" });
    } else if (row.op === "unpark") {
      ownerPush(row, "waiting", { reason: "Unparked; ready for an agent" });
    } else if (row.op === "close") {
      ownerPush(row, "cancelled", { reason: "Ticket closed on the board" });
    } else if (row.op !== "create") unmapped++;
  }
  return {
    schemaVersion: 1, runId, label: `Recorded relay for ${ref}`.slice(0, 100), illustrative: false,
    source: { kind: "board-events", description: `Derived from ${mine.length} board rows (seq ${mine[0].seq}-${mine.at(-1).seq}); ${unmapped} not mapped. Owner name, wait reasons and runners are not recorded by the board.${pr ? " PR link supplied by the exporter." : ""}`.slice(0, 300) },
    events,
  };
}

const readJsonl = (file) => { try { return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; } };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null; };
  const ref = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!ref || !/^[a-z0-9-]+\/\d{2,3}-[a-z0-9-]+$/.test(ref)) { console.error("usage: hierarchy-replay-export.mjs <feature/ticket> [--owner Bao|Jiao] [--pr URL] [--out file]"); process.exit(2); }
  const root = process.env.DEN_ROOT || process.cwd();
  const run = fromBoardEvents({ ref, rows: readJsonl(path.join(root, ".scratch", "events.jsonl")), usageRows: readJsonl(path.join(root, ".scratch", "usage.jsonl")), owner: flag("--owner"), pr: flag("--pr") });
  const text = `${JSON.stringify(run, null, 1)}\n`;
  if (flag("--out")) writeFileSync(flag("--out"), text); else process.stdout.write(text);
}
