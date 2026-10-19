// queue/02: the Queue, the frontier in its computed order (ADR 0015 Amendment 3, decisions 1, 2, 4, 5, 9, 12, 14).
//
// Two exports:
//   loadSnapshot(root)    the one reader: tickets, the active-feature row, resolved rows, picks (async, read only)
//   buildQueue(snapshot)  a pure function of a plain snapshot object, no I/O, no clock
//
// Snapshot shape:
//   { active: "<feature>" | null, activeSince?: "<ts>",
//     tickets: [{ ref, feature, num, status, priority: 0..3, blockedBy: [full refs],
//                 origin: "spec" | "added" | null, p0Reason: string | null, readySince?: "<ts>" }],
//     resolved?: [{ ts }], picks?: [{ ts, picked }],
//     admitted?: [ref] }   refs the user admitted past the gate (queue-admit rows with by:"user"; queue/04)
// loadSnapshot reads queue_active and queue-admit rows only when they carry by:"user".
//
// Order: tier (P0 with a reason, then the active feature, then the rest); inside a tier, unblock count (most first),
// then the P line (lowest first), then the lowest ticket number. Scope is not used.
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readStatus, TICKET_CLASSES, P0_REASONS } from "./board-service.mjs";
import { parsePriority } from "./priority.mjs";
import { compareRefs } from "../../packages/board-refs/src/compare-refs.mjs";

const DECAY_LIMIT = 5;
const TIER_RANK = { p0: 0, active: 1, rest: 2 };
const FEATURE_RE = /^[a-z0-9-]+$/;
const TICKET_FILE_RE = /^(\d{2,})-[a-z0-9-]+\.md$/;

function tierOf(ticket, active) {
  if (ticket.priority === 0 && ticket.p0Reason) return "p0";
  if (active && ticket.feature === active) return "active";
  return "rest";
}

function tsMs(ts) {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? -Infinity : ms;
}

// Decay count left (Amendment 3 decision 9 and Consequences): 5 minus the resolved rows after the ticket's readySince
// or its last pick, whichever is later. A ticket in the active feature never decays (null).
function decayLeftFor(ticket, snapshot) {
  if (snapshot.active && ticket.feature === snapshot.active) return null;
  let since = ticket.readySince === undefined ? -Infinity : tsMs(ticket.readySince);
  for (const pick of snapshot.picks ?? []) {
    if (pick.picked === ticket.ref) since = Math.max(since, tsMs(pick.ts));
  }
  const resolvedSince = (snapshot.resolved ?? []).filter((r) => tsMs(r.ts) > since).length;
  return Math.max(0, DECAY_LIMIT - resolvedSince);
}

function whyLine(tier, ticket, unblock, decayLeft) {
  const tierText = tier === "p0" ? `p0 tier (${ticket.p0Reason})` : `${tier} tier`;
  const decayText = decayLeft === null ? "never decays" : `decay in ${decayLeft} resolved`;
  return `${tierText}, unblocks ${unblock}, P${ticket.priority}, ${decayText}`;
}

export function buildQueue(snapshot) {
  const tickets = snapshot.tickets ?? [];
  const active = snapshot.active ?? null;
  const resolvedRefs = new Set(tickets.filter((t) => t.status === "resolved").map((t) => t.ref));

  // Unblock count: tickets still open that name this one in Blocked by.
  const unblockCount = new Map();
  for (const t of tickets) {
    if (t.status === "resolved" || t.status === "closed") continue;
    for (const dep of new Set(t.blockedBy ?? [])) unblockCount.set(dep, (unblockCount.get(dep) ?? 0) + 1);
  }

  const ordered = tickets
    .filter((t) => t.status === "ready-for-agent" && (t.blockedBy ?? []).every((dep) => resolvedRefs.has(dep)))
    .map((t) => {
      const tier = tierOf(t, active);
      const unblock = unblockCount.get(t.ref) ?? 0;
      const decayLeft = decayLeftFor(t, { ...snapshot, active });
      return { ref: t.ref, tier, unblock, p: t.priority, decayLeft, why: whyLine(tier, t, unblock, decayLeft), num: t.num };
    })
    .sort(
      (a, b) =>
        TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
        b.unblock - a.unblock ||
        a.p - b.p ||
        a.num - b.num ||
        compareRefs(a.ref, b.ref)
    )
    .map(({ num, ...item }) => item);

  const unplanned = {};
  for (const t of tickets) {
    const row = (unplanned[t.feature] ??= { planned: 0, added: 0 });
    if (t.origin === "added") row.added += 1;
    else row.planned += 1;
  }

  // gated: tickets the gate parked and that are still parked. expired: ready tickets whose decay count is used up;
  // `board gate --apply` parks them (queue/05). They stay in `ordered` until then.
  const gated = (snapshot.gateParks ?? []).map((g) => ({ ref: g.ref, reasons: [g.reason] }));
  const expired = ordered.filter((item) => item.decayLeft === 0).map((item) => item.ref);
  return { ordered, gated, expired, unplanned };
}

// --- the admission gate (ADR 0015 Amendment 3 A and C, ADR 0019 decision 8) ------------------------------------
//
// Machine form of a Serves line (prose after the form is free):
//   spec:<feature> "<heading text>"   a heading line of .scratch/<feature>/spec.md contains the text, case-insensitive
//   incident:<ts>[, incident:<ts>...] each ts is a kind:"incident" row of usage.jsonl
//   finding:<ref>                     that ticket exists
// checkAdmission is pure: spec headings and incidents arrive in the snapshot (loadSnapshot reads them), so a path in
// ticket text is never turned into a file read. The <feature> in a spec form is looked up as a key, nothing more.

const GATE_PREFIX = "admission gate: ";
const INCIDENT_TS = String.raw`\d{4}-\d{2}-\d{2}T[\d:.]+Z`;
const SPEC_FORM_RE = /^spec:(\S+)\s+"([^"]*)"/;
const INCIDENT_FORM_RE = new RegExp(String.raw`^incident:${INCIDENT_TS}(?:\s*,\s*incident:${INCIDENT_TS})*`);
const FINDING_FORM_RE = /^finding:(\S+)/;
const PIPELINE_INCIDENTS = 3;

export const gateReason = (reasons) => `${GATE_PREFIX}${reasons.join("; ")}`;

// A short, one-line, printable form of ticket text for use inside a reason.
function quoted(text) {
  const flat = String(text).replace(/[^\x20-\x7e]/g, "?");
  return `"${flat.length > 60 ? `${flat.slice(0, 57)}...` : flat}"`;
}

// Checks the Serves line. Returns { reasons, incidentTs } where incidentTs are the incident rows it names (found or not).
function checkServes(ticket, snapshot) {
  const serves = typeof ticket.serves === "string" ? ticket.serves.trim() : "";
  if (!serves) return { reasons: ["serves: no Serves line"], incidentTs: [] };

  const spec = SPEC_FORM_RE.exec(serves);
  if (spec) {
    const [, feature, heading] = spec;
    if (!FEATURE_RE.test(feature)) return { reasons: [`serves: spec feature ${quoted(feature)} is not a feature name`], incidentTs: [] };
    if (!heading.trim()) return { reasons: ["serves: spec heading text is empty"], incidentTs: [] };
    if (ticket.class !== "pipeline" && feature !== snapshot.active) {
      return { reasons: [`serves: spec:${feature} is not the active feature's spec (active: ${snapshot.active ?? "none"})`], incidentTs: [] };
    }
    const headings = Object.hasOwn(snapshot.specs ?? {}, feature) ? snapshot.specs[feature] : null;
    if (!headings) return { reasons: [`serves: spec:${feature} has no readable spec file`], incidentTs: [] };
    const want = heading.trim().toLowerCase();
    if (!headings.some((h) => h.toLowerCase().includes(want))) {
      return { reasons: [`serves: no heading containing ${quoted(heading.trim())} in the ${feature} spec`], incidentTs: [] };
    }
    return { reasons: [], incidentTs: [] };
  }

  const incidents = INCIDENT_FORM_RE.exec(serves);
  if (incidents) {
    const incidentTs = [...incidents[0].matchAll(new RegExp(String.raw`incident:(${INCIDENT_TS})`, "g"))].map((m) => m[1]);
    const known = new Set((snapshot.incidents ?? []).map((i) => i.ts));
    const missing = [...new Set(incidentTs)].filter((ts) => !known.has(ts));
    return {
      reasons: missing.map((ts) => `incident: ${ts} is not an incident row of usage.jsonl`),
      incidentTs,
    };
  }

  const finding = FINDING_FORM_RE.exec(serves);
  if (finding) {
    const exists = (snapshot.tickets ?? []).some((t) => t.ref === finding[1]);
    return { reasons: exists ? [] : [`serves: finding ${quoted(finding[1])} is not a ticket on the board`], incidentTs: [] };
  }

  return {
    reasons: [`serves: not a machine form (spec:<feature> "<heading>", incident:<ts>, or finding:<ref>): ${quoted(serves)}`],
    incidentTs: [],
  };
}

// True when the pipeline ticket is listed in the Blocked by of an open active-feature ticket (ADR 0019 decision 8).
function blocksActiveFeature(ticket, snapshot) {
  if (!snapshot.active) return false;
  return (snapshot.tickets ?? []).some(
    (t) =>
      t.feature === snapshot.active &&
      t.status !== "resolved" &&
      t.status !== "closed" &&
      (t.blockedBy ?? []).includes(ticket.ref)
  );
}

// Three distinct, existing incident rows that share one tool (a mechanical stand-in for "same cause").
function threeIncidentsOfOneTool(incidentTs, snapshot) {
  const toolOf = new Map();
  for (const i of snapshot.incidents ?? []) if (!toolOf.has(i.ts)) toolOf.set(i.ts, i.tool ?? null);
  const perTool = new Map();
  for (const ts of new Set(incidentTs)) {
    const tool = toolOf.get(ts);
    if (typeof tool !== "string" || !tool) continue;
    perTool.set(tool, (perTool.get(tool) ?? 0) + 1);
  }
  return [...perTool.values()].some((n) => n >= PIPELINE_INCIDENTS);
}

// The unplanned cap (ADR 0015 Amendment 3 decision 10): once a feature has at least 3 planned tickets, an Origin-added
// ticket is refused when the added tickets already filed (every status, the ticket itself left out) pass a third of
// the planned count, i.e. added * 3 > planned. Planned is every ticket not Origin: added (as in buildQueue). A security
// finding (Serves finding:<ref>) is never refused by the cap, but the tickets it filed count toward it.
const UNPLANNED_BASELINE = 3;

function checkUnplannedCap(ticket, snapshot) {
  if (ticket.origin !== "added") return null;
  if (FINDING_FORM_RE.test(typeof ticket.serves === "string" ? ticket.serves.trim() : "")) return null;
  let planned = 0;
  let added = 0;
  for (const t of snapshot.tickets ?? []) {
    if (t.feature !== ticket.feature || t.ref === ticket.ref) continue;
    if (t.origin === "added") added += 1;
    else planned += 1;
  }
  if (planned < UNPLANNED_BASELINE || added * 3 <= planned) return null;
  return `unplanned: ${added} added tickets already filed in ${ticket.feature} against ${planned} planned, past a third; admitting another needs the user's yes (queue-admin admit)`;
}

export function checkAdmission(ticket, snapshot) {
  const reasons = [];
  if (!TICKET_CLASSES.includes(ticket.class)) reasons.push("class: no Class line, or not product or pipeline");

  const serves = checkServes(ticket, snapshot);
  reasons.push(...serves.reasons);

  const capReason = checkUnplannedCap(ticket, snapshot);
  if (capReason) reasons.push(capReason);

  if (ticket.class === "pipeline" && !blocksActiveFeature(ticket, snapshot) && !threeIncidentsOfOneTool(serves.incidentTs, snapshot)) {
    reasons.push(`incident: a pipeline ticket needs ${PIPELINE_INCIDENTS} distinct incidents with the same tool, or to block an active-feature ticket`);
  }

  if (ticket.priority === 0 && !P0_REASONS.includes(ticket.p0Reason)) {
    reasons.push(`p0: a P0 ticket needs a P0-reason of ${P0_REASONS.join("|")}`);
  }
  return { ok: reasons.length === 0, reasons };
}

// The tickets the gate would park: every ready-for-agent ticket checkAdmission refuses, except one the user admitted
// (a `queue-admit` row, written by `queue-admin admit`; the snapshot lists the admitted refs), plus every ticket whose
// decay has run out (queue/05; an admitted ticket still decays).
export function gateRefusals(snapshot) {
  const refused = [];
  const admitted = new Set(snapshot.admitted ?? []);
  const expired = new Set(buildQueue(snapshot).expired);
  for (const t of snapshot.tickets ?? []) {
    if (t.status !== "ready-for-agent") continue;
    const reasons = admitted.has(t.ref) ? [] : checkAdmission(t, snapshot).reasons;
    if (expired.has(t.ref)) reasons.push(`decay: ${DECAY_LIMIT} tickets resolved since it was ready or last picked, and it was not picked`);
    if (reasons.length) refused.push({ ref: t.ref, reasons });
  }
  return refused;
}

// --- the reader ------------------------------------------------------------------------------------------------

function header(markdown) {
  const section = /^## /m.exec(markdown);
  return section ? markdown.slice(0, section.index) : markdown;
}

// "Blocked by" text to refs. Reads `feature/NN` (optionally with a slug) and bare `NN` (same feature). A number with no
// ticket behind it stays as `feature/NN`, which is never resolved, so the ticket stays blocked.
function parseBlockedBy(text, feature, byNum) {
  const refs = [];
  const link = (f, nn) => refs.push(byNum.get(`${f}/${Number(nn)}`) ?? `${f}/${nn}`);
  const rest = text.replace(/([a-z0-9][a-z0-9-]*)\/(\d{2,})(?:-[a-z0-9-]*)?/g, (_m, f, nn) => {
    link(f, nn);
    return " ";
  });
  for (const m of rest.matchAll(/(?<![\w.-])(\d{1,})(?![\w-])/g)) link(feature, m[1]);
  return refs;
}

async function readJsonLines(file) {
  const raw = await readFile(file, "utf8").catch(() => "");
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object") rows.push(row);
    } catch {
      // a junk line is skipped
    }
  }
  return rows;
}

// Heading texts of a spec file, '#' marks stripped, fenced code skipped. null when the file is missing, is not a plain
// file (a symlink is not followed) or is too large to be a spec.
const SPEC_MAX_BYTES = 1_000_000;
async function readSpecHeadings(file) {
  const info = await lstat(file).catch(() => null);
  if (!info || !info.isFile() || info.size > SPEC_MAX_BYTES) return null;
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  const headings = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line);
    if (m && m[1]) headings.push(m[1]);
  }
  return headings;
}

export async function loadSnapshot(root) {
  const scratch = path.join(root, ".scratch");
  const usage = await readJsonLines(path.join(scratch, "usage.jsonl"));
  const events = await readJsonLines(path.join(scratch, "events.jsonl"));

  let active = null;
  let activeSince;
  for (const row of usage) {
    // Only the user's rows count (queue/04 ruling 2): `queue-admin` writes by:"user"; a row without it is ignored.
    if (row.by !== "user") continue;
    if (row.kind === "config" && typeof row.queue_active === "string" && FEATURE_RE.test(row.queue_active)) {
      active = row.queue_active;
      activeSince = row.ts;
    }
  }
  const admitted = new Set(
    usage.filter((r) => r.kind === "queue-admit" && r.by === "user" && typeof r.ref === "string").map((r) => r.ref)
  );
  const resolved = usage.filter((r) => r.kind === "resolved" && typeof r.ts === "string").map((r) => ({ ts: r.ts }));
  const picks = usage
    .filter((r) => r.kind === "queue-pick" && typeof r.ts === "string" && typeof r.picked === "string")
    .map((r) => ({ ts: r.ts, picked: r.picked }));

  // The last time each ticket went to ready-for-agent (create, release back to ready, unpark or reopen). Claim and
  // release events carry `to_status`; the park path's unpark and reopen events carry `to`.
  const readyAt = new Map();
  for (const e of events) {
    if ((e.to_status === "ready-for-agent" || e.to === "ready-for-agent") && typeof e.ts === "string") {
      readyAt.set(`${e.feature}/${e.ticket}`, e.ts);
    }
  }

  const raw = [];
  const entries = await readdir(scratch, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !FEATURE_RE.test(entry.name)) continue;
    const dir = path.join(scratch, entry.name, "issues");
    for (const file of (await readdir(dir).catch(() => [])).sort()) {
      const m = TICKET_FILE_RE.exec(file);
      if (!m) continue;
      const markdown = await readFile(path.join(dir, file), "utf8").catch(() => null);
      if (markdown === null) continue;
      raw.push({ feature: entry.name, slug: file.slice(0, -3), num: Number(m[1]), markdown, file: path.join(dir, file) });
    }
  }
  const byNum = new Map(raw.map((r) => [`${r.feature}/${r.num}`, `${r.feature}/${r.slug}`]));

  const tickets = [];
  for (const r of raw) {
    const head = header(r.markdown);
    const ref = `${r.feature}/${r.slug}`;
    const status = readStatus(r.markdown);
    const blockedText = /^\*\*Blocked by:\*\*(.*)$/m.exec(head)?.[1] ?? "";
    const origin = /^\*\*Origin:\*\*[ \t]*(spec|added)\b/m.exec(head)?.[1] ?? null;
    const ticketClass = /^\*\*Class:\*\*[ \t]*(product|pipeline)[ \t]*$/m.exec(head)?.[1] ?? null;
    const serves = /^\*\*Serves:\*\*[ \t]*(\S.*?)[ \t]*$/m.exec(head)?.[1] ?? null;
    const p0Reason = /^\*\*P0-reason:\*\*[ \t]*(\S.*?)[ \t]*$/m.exec(head)?.[1] ?? null;
    const ticket = {
      ref,
      feature: r.feature,
      num: r.num,
      status,
      priority: Number(parsePriority(head).slice(1)),
      blockedBy: parseBlockedBy(blockedText, r.feature, byNum),
      origin,
      p0Reason,
      class: ticketClass,
      serves,
    };
    if (status === "ready-for-agent") {
      ticket.readySince = readyAt.get(ref) ?? new Date((await stat(r.file)).mtimeMs).toISOString();
    }
    tickets.push(ticket);
  }

  const incidents = usage
    .filter((r) => r.kind === "incident" && typeof r.ts === "string")
    .map((r) => ({ ts: r.ts, tool: typeof r.tool === "string" ? r.tool : null }));

  // Spec headings, per feature. Only real files in real feature directories: the feature names come from the directory
  // listing above (never from ticket text), and a symlinked directory or spec.md is not read.
  const specs = {};
  for (const feature of new Set(raw.map((r) => r.feature))) {
    const headings = await readSpecHeadings(path.join(scratch, feature, "spec.md"));
    if (headings) specs[feature] = headings;
  }

  // Tickets the gate parked and that are still parked: the last park event carries the gate's reason prefix.
  const parkReason = new Map();
  for (const e of events) {
    const ref = `${e.feature}/${e.ticket}`;
    if (e.op === "park") parkReason.set(ref, typeof e.reason === "string" ? e.reason : "");
    else if (e.op === "unpark" || e.op === "reopen" || e.op === "close") parkReason.delete(ref);
  }
  const gateParks = tickets
    .filter((t) => t.status === "parked" && parkReason.get(t.ref)?.startsWith(GATE_PREFIX))
    .map((t) => ({ ref: t.ref, reason: parkReason.get(t.ref).slice(GATE_PREFIX.length) }));

  return { active, activeSince, tickets, resolved, picks, specs, incidents, gateParks, admitted: [...admitted] };
}

// --- the printed form ------------------------------------------------------------------------------------------

export function formatQueue(queue, snapshot = {}) {
  const lines = [];
  lines.push(
    snapshot.active
      ? `Queue (active feature: ${snapshot.active}${snapshot.activeSince ? `, set ${snapshot.activeSince}` : ""})`
      : "Queue (no active feature)"
  );
  if (!queue.ordered.length) lines.push("  (nothing ready)");
  queue.ordered.forEach((item, i) => lines.push(`${i + 1}. ${item.ref}  ${item.why}`));
  lines.push("");
  lines.push("Planned and added per feature:");
  for (const feature of Object.keys(queue.unplanned).sort()) {
    const { planned, added } = queue.unplanned[feature];
    lines.push(`  ${feature}: ${planned} planned, ${added} added`);
  }
  lines.push("");
  lines.push("Parked by gate:");
  if (!queue.gated.length) lines.push("  (none)");
  for (const g of queue.gated) lines.push(`  ${g.ref}: ${g.reasons.join("; ")}`);
  return lines.join("\n");
}
