#!/usr/bin/env node
// Jev shadow report (ADR 0010, decision 10): joins jev rows with agent and resolved rows in
// usage.jsonl, projects counterfactual tokens per ticket and prints the exit-criteria table.
import { isAgentRow, roleOf } from "../apps/board/legacy-terms.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareRefs } from "../packages/board-refs/src/compare-refs.mjs";

const TIER_WEIGHT = { haiku: 0.5, sonnet: 1, opus: 2 };
const VERIFY_WEIGHT = { light: 0.5, full: 1 };
const POINTS = ["tier", "verify"];

function keyOf(ref) {
  // organism-infra/47: segments are [\w.-]+ so control characters and "|" (the id.split("|") join) never pass.
  const m = /^([\w.-]+)\/(\d+)/.exec(String(ref ?? ""));
  return m ? `${m[1]}/${m[2]}` : null;
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ADR 0015 decisions 3 and 5: each route half is scored against the next board claim that maps to one of
// its labels, with its own coverage floor and safety rule.
const ROUTE_VARIANTS = {
  new: {
    labelOf: { product: "product", architect: "architect", designer: "designer", qa: "qa-specify", developer: "developer-direct" },
    minRows: 15,
    // developer-direct on a ticket that got qa tests would have skipped qa specify.
    isMiss: (u, claims) => u.r.pick === "developer-direct" && claims.some((c) => c.key === u.key && roleOf(c) === "qa"),
  },
  bounce: {
    labelOf: { developer: "developer", qa: "qa", architect: "architect", user: "user" },
    minRows: 8,
    // A developer pick is a miss when the ticket resolved with no qa claim (verify) after the route row.
    isMiss: (u, claims, releases) => {
      if (u.r.pick !== "developer") return false;
      const ts = String(u.r.ts ?? "");
      const done = releases.find((e) => e.key === u.key && e.toStatus === "resolved" && e.ts > ts);
      return Boolean(done) && !claims.some((c) => c.key === u.key && roleOf(c) === "qa" && c.ts > ts && c.ts < done.ts);
    },
  },
};

function boardEvents(events, op) {
  return events
    .filter((e) => e && e.op === op && e.feature && keyOf(`${e.feature}/${e.ticket}`))
    .map((e) => ({ key: keyOf(`${e.feature}/${e.ticket}`), role: roleOf(e), mode: e.mode ?? null, toStatus: e.to_status, ts: String(e.ts ?? "") }))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

// organism-infra/124: a route row is written before the dispatch it predicts, so its own `actual` cannot name the
// real next role. This derived view scores each route row against the first claim after it, any agent.
function claimRole(c) {
  return roleOf(c) === "qa" && (c.mode === "specify" || c.mode === "verify") ? `qa-${c.mode}` : roleOf(c);
}

function routeActuals(rows, events) {
  const claims = boardEvents(events, "claim");
  const out = [];
  for (const r of rows) {
    if (r.kind !== "jev" || r.point !== "route") continue;
    const key = keyOf(r.ticket);
    const ts = String(r.ts ?? "");
    const first = key ? claims.find((c) => c.key === key && c.ts > ts) : null;
    out.push({ ticket: r.ticket, ts: r.ts, variant: r.variant ?? "new", pick: r.pick, logged: r.actual, actual: first ? claimRole(first) : null });
  }
  return out;
}

function routeReport(rows, events, variant) {
  const { labelOf, minRows, isMiss } = ROUTE_VARIANTS[variant];
  const latest = new Map();
  for (const r of rows) {
    if (r.kind !== "jev" || r.point !== "route" || (r.variant ?? "new") !== variant) continue;
    // Advisory rows show the user Jev's pick, which can sway the claim; they belong to the advisory section only.
    if (r.mode === "advisory") continue;
    const k = keyOf(r.ticket);
    if (!k) continue;
    const prev = latest.get(k);
    if (!prev || String(r.ts ?? "") >= String(prev.ts ?? "")) latest.set(k, r);
  }
  const claims = boardEvents(events, "claim");
  const releases = boardEvents(events, "release");

  const used = [];
  for (const [key, r] of latest) {
    const first = claims.find((c) => c.key === key && c.ts > String(r.ts ?? "") && labelOf[roleOf(c)]);
    if (first) used.push({ key, r, actual: labelOf[roleOf(first)] });
  }
  const picked = used.filter((u) => u.r.pick);
  const nonOther = picked.filter((u) => u.r.pick !== "other");
  const agreed = nonOther.filter((u) => u.r.pick === u.actual);
  const byLabel = {};
  for (const u of nonOther) {
    const b = (byLabel[u.r.pick] ??= { picks: 0, agreed: 0 });
    b.picks++;
    if (u.r.pick === u.actual) b.agreed++;
  }
  const n = used.length;
  const fallbacks = used.filter((u) => u.r.fallback && u.r.fallback !== "cap").length;
  const capFired = used.filter((u) => u.r.fallback === "cap").length;
  const medianMs = median(used.map((u) => Number(u.r.ms) || 0));
  const other = picked.length - nonOther.length;
  const agreementPct = nonOther.length ? (agreed.length / nonOther.length) * 100 : 0;
  const otherPct = n ? (other / n) * 100 : 0;
  const safetyMisses = used.filter((u) => isMiss(u, claims, releases)).map((u) => u.key);
  return {
    rows: n, fallbacks, capFired, medianMs, other, otherPct, nonOther: nonOther.length, agreed: agreed.length, agreementPct, byLabel,
    disagreements: nonOther.filter((u) => u.r.pick !== u.actual).map((u) => ({ ticket: u.key, pick: u.r.pick, actual: u.actual })),
    safetyMisses,
    checks: {
      coverage: n >= minRows && fallbacks * 5 <= n && medianMs < 2000,
      agreement: nonOther.length > 0 && agreementPct >= 85 && otherPct <= 35,
      safety: safetyMisses.length === 0,
      spend: capFired === 0,
    },
  };
}

// ADR 0015 decision 4: priority goes live on user verdicts. Flags need at least 10 verdicts, 70% right;
// fills (out of v1, so no rows yet) need at least 20, 80% accepted.
const FLAG_BAR = { min: 10, pct: 70 };
const FILL_BAR = { min: 20, pct: 80 };
const SCOPE_BAR = { min: 20, pct: 60, last: 10 };

function verdictBar(rows, kind, field, bar) {
  const v = rows.filter((r) => r.kind === kind && typeof r[field] === "boolean");
  const yes = v.filter((r) => r[field]).length;
  return { verdicts: v.length, yes, pct: v.length ? (yes / v.length) * 100 : 0, pass: v.length >= bar.min && yes * 100 >= v.length * bar.pct };
}

function priorityReport(rows) {
  const pr = rows.filter((r) => r.kind === "jev" && r.point === "priority");
  const flagged = pr.filter((r) => r.pick === "mismatch").length;
  const flags = verdictBar(rows, "jev-priority-verdict", "right", FLAG_BAR);
  const fills = verdictBar(rows, "jev-priority-fill-verdict", "accept", FILL_BAR);
  return {
    rows: pr.length, flagged, flagRate: pr.length ? flagged / pr.length : 0, flags, fills,
    checks: { flagging: flags.pass, fills: fills.pass },
  };
}

// Scope ground truth: terciles of baseline tokens over non-zero-baseline tickets, recomputed every run.
function terciles(tickets) {
  const s = tickets.filter((t) => t.baseline > 0).sort((a, b) => a.baseline - b.baseline);
  const edge = Math.round(s.length / 3);
  return new Map(s.map((t, i) => [t.ticket, i < edge ? "small" : i >= s.length - edge ? "large" : "medium"]));
}

// One row per ticket (its latest answered scope row), like the tier and verify points.
function scopeReport(rows, tickets) {
  const truth = terciles(tickets);
  const latest = new Map();
  for (const r of rows) {
    if (r.kind !== "jev" || r.point !== "scope" || r.fallback || !r.pick) continue;
    const k = keyOf(r.ticket);
    if (!truth.has(k)) continue;
    const prev = latest.get(k);
    if (!prev || String(r.ts ?? "") >= String(prev.ts ?? "")) latest.set(k, r);
  }
  const scored = [...latest]
    .map(([k, r]) => ({ ticket: k, pick: r.pick, tercile: truth.get(k), ts: String(r.ts ?? "") }))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const sameTercile = scored.filter((s) => s.pick === s.tercile).length;
  const farMiss = (s) => (s.pick === "small" && s.tercile === "large") || (s.pick === "large" && s.tercile === "small");
  const smallWasLargeInLast10 = scored.slice(-SCOPE_BAR.last).filter(farMiss).length;
  const n = scored.length;
  const sameTercileRate = n ? sameTercile / n : 0;
  return {
    rows: n, sameTercile, sameTercileRate, smallWasLargeInLast10,
    misses: scored.filter((s) => s.pick !== s.tercile).map(({ ticket, pick, tercile }) => ({ ticket, pick, tercile })),
    checks: { scope: n >= SCOPE_BAR.min && sameTercile * 100 >= n * SCOPE_BAR.pct && smallWasLargeInLast10 === 0 },
  };
}

// ADR 0015 decision 6: the wake bar is at least 15 informational labels, none followed by the board acting on
// that ticket (a claim, comment or release after the row), plus route's coverage and spend limits. One row per
// ticket (its latest wake row), like the tier and verify points.
const WAKE_BAR = { informational: 15 };
const WAKE_ACTS = ["claim", "comment", "release"];

function wakeReport(rows, events) {
  const latest = new Map();
  for (const r of rows) {
    if (r.kind !== "jev" || r.point !== "wake") continue;
    const k = keyOf(r.ticket);
    if (!k) continue;
    const prev = latest.get(k);
    if (!prev || String(r.ts ?? "") >= String(prev.ts ?? "")) latest.set(k, r);
  }
  const acts = WAKE_ACTS.flatMap((op) => boardEvents(events, op));
  const used = [...latest];
  const n = used.length;
  const informational = used.filter(([, r]) => r.pick === "informational");
  const fallbacks = used.filter(([, r]) => r.fallback && r.fallback !== "cap").length;
  const capFired = used.filter(([, r]) => r.fallback === "cap").length;
  const medianMs = median(used.map(([, r]) => Number(r.ms) || 0));
  const missedWakes = informational
    .filter(([k, r]) => acts.some((e) => e.key === k && e.ts > String(r.ts ?? "")))
    .map(([k]) => k);
  return {
    rows: n, informational: informational.length, fallbacks, capFired, medianMs, missedWakes,
    checks: {
      coverage: informational.length >= WAKE_BAR.informational && fallbacks * 5 <= n && medianMs < 2000,
      safety: missedWakes.length === 0,
      spend: capFired === 0,
    },
  };
}

// organism-infra/79: advisory route agreement is Jev's pick against the user's final choice at the dispatch
// gate. Not a go-live bar (ADR 0015 amendment): these rows are the data for revisiting decision 5's bars.
function advisoryReport(rows) {
  const outcomes = rows.filter((r) => r && r.kind === "jev-advisory-outcome");
  const byLabel = {};
  let agreed = 0;
  let total = 0;
  for (const r of outcomes) {
    if (!r.jevPick || r.jevPick === "other") continue;
    const b = (byLabel[r.jevPick] ??= { picks: 0, agreed: 0 });
    b.picks++;
    total++;
    if (r.jevPick === r.userChoice) { b.agreed++; agreed++; }
  }
  return {
    rows: outcomes.length, byLabel, agreed, total, agreementPct: total ? (agreed / total) * 100 : 0,
    bounced: outcomes.filter((r) => r.bounced === true).length,
    orchestratorAgreed: outcomes.filter((r) => r.orchestratorPick && r.orchestratorPick === r.userChoice).length,
  };
}

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
// Own keys only: "constructor" or "toString" must not resolve to an inherited function (NaN weights).
const weightOf = (table, pick) => (typeof pick === "string" && Object.hasOwn(table, pick) ? table[pick] : undefined);

export function buildReport(allRows, events = []) {
  const rows = allRows.filter(isObject); // valid JSON that is not an object (null, 42) is skipped
  const info = new Map(); // key -> { agents, bounces }
  const get = (k) => {
    if (!info.has(k)) info.set(k, { runs: [], bounces: 0, resolved: false });
    return info.get(k);
  };
  const latest = new Map(); // `${key}|${point}` -> jev row
  for (const r of rows) {
    const k = keyOf(r.ticket);
    if (!k) continue;
    if (isAgentRow(r)) get(k).runs.push(r);
    else if (r.kind === "resolved") { get(k).bounces = Number(r.bounces) || 0; get(k).resolved = true; }
    else if (r.kind === "jev" && POINTS.includes(r.point)) {
      const id = `${k}|${r.point}`;
      const prev = latest.get(id);
      if (!prev || String(r.ts ?? "") >= String(prev.ts ?? "")) latest.set(id, r);
    }
  }

  const tickets = [];
  for (const [ticket, { runs, bounces, resolved }] of [...info].sort((a, b) => compareRefs(a[0], b[0]))) {
    const tok = (c) => Number(c.tokens) || 0;
    const baseline = runs.reduce((s, c) => s + tok(c), 0);
    const tierRow = latest.get(`${ticket}|tier`);
    const verifyRow = latest.get(`${ticket}|verify`);
    const tierW = !tierRow?.fallback && weightOf(TIER_WEIGHT, tierRow?.pick) !== undefined ? weightOf(TIER_WEIGHT, tierRow.pick) : 1;
    const verifyW = !verifyRow?.fallback && weightOf(VERIFY_WEIGHT, verifyRow?.pick) !== undefined ? weightOf(VERIFY_WEIGHT, verifyRow.pick) : 1;
    let tier = 0;
    let verify = 0;
    let both = 0;
    for (const c of runs) {
      const isDev = roleOf(c) === "developer";
      const isVerify = roleOf(c) === "qa" && String(c.mode ?? "").startsWith("verify");
      tier += tok(c) * (isDev ? tierW : 1);
      verify += tok(c) * (isVerify ? verifyW : 1);
      both += tok(c) * (isDev ? tierW : isVerify ? verifyW : 1);
    }
    tickets.push({ ticket, resolved, baseline, projected: { tier, verify, both }, bounces });
  }

  const byKey = Object.fromEntries(tickets.map((t) => [t.ticket, t]));
  const points = {};
  for (const point of POINTS) {
    const jr = [...latest].filter(([id]) => byKey[id.split("|")[0]]?.baseline > 0 && id.endsWith(`|${point}`)).map(([id, r]) => [id.split("|")[0], r]);
    const rv = jr.filter(([k]) => byKey[k].resolved); // value counts resolved tickets only (ADR 0010)
    const baseline = rv.reduce((s, [k]) => s + byKey[k].baseline, 0);
    const projected = rv.reduce((s, [k]) => s + byKey[k].projected[point], 0);
    const fallbacks = jr.filter(([, r]) => r.fallback && r.fallback !== "cap").length;
    const capFired = jr.filter(([, r]) => r.fallback === "cap").length;
    const medianMs = median(jr.map(([, r]) => Number(r.ms) || 0));
    const savedPct = baseline ? ((baseline - projected) / baseline) * 100 : 0;
    points[point] = {
      tickets: jr.length,
      fallbacks,
      capFired,
      medianMs,
      jevCost: jr.reduce((s, [, r]) => s + (Number(r.cost) || 0), 0),
      baseline,
      projected,
      savedPct,
      bounces: rv.reduce((s, [k]) => s + byKey[k].bounces, 0),
      // organism-infra/68 criterion 2. Bars are ADR 0010 decision 10: at least 5 tickets, fallbacks at most
      // 20%, median under 2 s; at least 30% fewer tokens; no cap hit. Safety stays a judgement: the orchestrator
      // reads the handoffs of the tickets listed here (resolved, bounced, with a real pick at this point).
      checks: { coverage: jr.length >= 5 && fallbacks * 5 <= jr.length && medianMs < 2000, value: savedPct >= 30, spend: capFired === 0 },
      safetyBounces: rv
        .filter(([k, r]) => byKey[k].bounces > 0 && !r.fallback && r.pick)
        .map(([k, r]) => ({ ticket: k, pick: r.pick, bounces: byKey[k].bounces })),
    };
  }
  return {
    tickets, points,
    route: { newTicket: routeReport(rows, events, "new"), bounce: routeReport(rows, events, "bounce"), actuals: routeActuals(rows, events) },
    priority: priorityReport(rows),
    scope: scopeReport(rows, tickets),
    wake: wakeReport(rows, events),
    advisory: advisoryReport(rows),
  };
}

const pct = (n) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;

export function formatReport(report) {
  const lines = ["Jev shadow report (ADR 0010)", ""];
  lines.push("Exit criteria per point");
  lines.push("point   | coverage (tickets, fallbacks, cap) | safety (bounces) | value (projected change vs baseline) | spend (jev cost, median ms)");
  for (const p of POINTS) {
    const x = report.points[p];
    const change = x.baseline ? ((x.projected - x.baseline) / x.baseline) * 100 : 0;
    lines.push(
      `${p.padEnd(7)} | ${x.tickets} tickets, ${x.fallbacks} fallbacks, ${x.capFired} cap | ${x.bounces} bounces | ` +
        `savings ${pct(x.savedPct)} (projected ${x.projected} vs baseline ${x.baseline} tokens; positive = fewer tokens, ` +
        `token change ${pct(change)}) | $${x.jevCost.toFixed(4)}, ${x.medianMs} ms`,
    );
  }
  const verdict = (x) => (x ? "PASS" : "FAIL");
  lines.push("", "Verdict inputs per point (ADR 0010 decision 10)");
  for (const p of POINTS) {
    const x = report.points[p];
    lines.push(`${p} coverage: ${verdict(x.checks.coverage)} (${x.tickets} tickets of 5, ${x.fallbacks} fallbacks, median ${x.medianMs} ms)`);
    lines.push(`${p} value: ${verdict(x.checks.value)} (${pct(x.savedPct)} tokens saved, bar +30.0%)`);
    lines.push(`${p} spend: ${verdict(x.checks.spend)} (${x.capFired} cap hits)`);
    const sb = x.safetyBounces.map((e) => `${e.ticket} (pick ${e.pick}, ${e.bounces} bounces)`);
    lines.push(`${p} safety: judge from handoffs, ${x.bounces} bounces; with a pick: ${sb.length ? sb.join(", ") : "none"}`);
  }
  lines.push("", "Per ticket (weighted tokens: baseline, projected tier / verify / both)");
  for (const t of report.tickets) {
    lines.push(`${t.ticket}: baseline ${t.baseline}, tier ${t.projected.tier}, verify ${t.projected.verify}, both ${t.projected.both}, bounces ${t.bounces}`);
  }
  const r = report.route?.newTicket;
  if (r) {
    lines.push("", "Route (new ticket, shadow; ADR 0015)");
    for (const [label, b] of Object.entries(r.byLabel)) lines.push(`route agreement ${label}: ${b.agreed}/${b.picks} agreed`);
    lines.push(...goLiveLines("route new-ticket", r, ROUTE_VARIANTS.new.minRows));
    for (const d of r.disagreements) lines.push(`route disagreement ${d.ticket}: pick ${d.pick}, actual ${d.actual}`);
  }
  const b = report.route?.bounce;
  if (b) {
    lines.push("", "Route (bounce, shadow; ADR 0015)");
    for (const [label, x] of Object.entries(b.byLabel)) lines.push(`route bounce agreement ${label}: ${x.agreed}/${x.picks} agreed`);
    lines.push(...goLiveLines("route bounce", b, ROUTE_VARIANTS.bounce.minRows));
    for (const d of b.disagreements) lines.push(`route bounce disagreement ${d.ticket}: pick ${d.pick}, actual ${d.actual}`);
  }
  for (const a of report.route?.actuals ?? []) lines.push(`route actual ${a.ticket}: pick ${a.pick ?? "none"}, actual ${a.actual ?? "none yet"}`);
  const ok = (x) => (x ? "PASS" : "FAIL");
  const p = report.priority;
  if (p) {
    lines.push("", "Priority (shadow; ADR 0015)");
    lines.push(`priority flagging: ${ok(p.checks.flagging)} (${p.flags.verdicts} verdicts of ${FLAG_BAR.min}, ${p.flags.pct.toFixed(1)}% right; ${p.flagged} flags in ${p.rows} rows)`);
    lines.push(`priority fills: ${ok(p.checks.fills)} (${p.fills.verdicts} verdicts of ${FILL_BAR.min}, ${p.fills.pct.toFixed(1)}% accepted; fills are out of v1)`);
  }
  const s = report.scope;
  if (s) {
    lines.push("", "Scope (shadow; ADR 0015)");
    lines.push(`scope: ${ok(s.checks.scope)} (${s.rows} rows of ${SCOPE_BAR.min}, ${(s.sameTercileRate * 100).toFixed(1)}% same-tercile, ${s.smallWasLargeInLast10} small-vs-large in last ${SCOPE_BAR.last})`);
    for (const m of s.misses) lines.push(`scope miss ${m.ticket}: pick ${m.pick}, tercile ${m.tercile}`);
  }
  const w = report.wake;
  if (w) {
    lines.push("", "Wake-up gate (shadow; ADR 0015)");
    lines.push(`wake coverage: ${ok(w.checks.coverage)} (${w.informational} informational of ${WAKE_BAR.informational}, ${w.rows} rows, ${w.fallbacks} fallbacks, ${w.capFired} cap, median ${w.medianMs} ms)`);
    lines.push(`wake safety: ${ok(w.checks.safety)} (${w.missedWakes.length} missed wakes${w.missedWakes.length ? ": " + w.missedWakes.join(", ") : ""})`);
    lines.push(`wake spend: ${ok(w.checks.spend)} (${w.capFired} cap hits)`);
  }
  const a = report.advisory;
  if (a) {
    lines.push("", "Advisory route (advisory-live; ADR 0015 amendment, not a go-live bar)");
    for (const [label, x] of Object.entries(a.byLabel)) lines.push(`advisory agreement ${label}: ${x.agreed}/${x.picks} agreed`);
    lines.push(
      `advisory summary: ${a.agreed}/${a.total} = ${a.agreementPct.toFixed(1)}% of non-other Jev picks matched the user; ` +
        `orchestrator matched the user ${a.orchestratorAgreed}/${a.rows}; ${a.bounced} bounced, ${a.rows} rows`,
    );
  }
  return lines.join("\n") + "\n";
}

function goLiveLines(name, r, minRows) {
  const ok = (b) => (b ? "PASS" : "FAIL");
  return [
    `${name} coverage: ${ok(r.checks.coverage)} (${r.rows} rows of ${minRows}, ${r.fallbacks} fallbacks, ${r.capFired} cap, median ${r.medianMs} ms)`,
    `${name} agreement: ${ok(r.checks.agreement)} (${r.agreed}/${r.nonOther} = ${r.agreementPct.toFixed(1)}% of non-other, other ${r.otherPct.toFixed(1)}%)`,
    `${name} safety: ${ok(r.checks.safety)} (${r.safetyMisses.length} misses${r.safetyMisses.length ? ": " + r.safetyMisses.join(", ") : ""})`,
    `${name} spend: ${ok(r.checks.spend)} (${r.capFired} cap hits)`,
  ];
}

function main(argv) {
  let usage = path.join(process.env.DEN_ROOT || process.env.ORGANISM_ROOT || process.cwd(), ".scratch", "usage.jsonl");
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--usage") usage = argv[++i];
    else if (argv[i] === "--json") json = true;
  }
  let text;
  try {
    text = readFileSync(usage, "utf8");
  } catch (e) {
    process.stderr.write(`jev-report: cannot read ${usage}: ${e.message}\n`);
    return 1;
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row !== null && typeof row === "object") rows.push(row);
    } catch {
      // skip malformed lines
    }
  }
  const events = [];
  try {
    for (const line of readFileSync(path.join(path.dirname(usage), "events.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch {}
    }
  } catch {}
  const report = buildReport(rows, events);
  process.stdout.write(json ? JSON.stringify(report, null, 2) + "\n" : formatReport(report));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
