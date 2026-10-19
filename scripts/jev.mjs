#!/usr/bin/env node
// organism-infra/38: Jev pre-check script (ADR 0010).
// Usage: node scripts/jev.mjs <tier|verify|route|route-bounce|priority|scope> --ticket <feature>/<NN-slug> [--tests <path>] [--mode shadow|live|advisory]
//        node scripts/jev.mjs priority-verdict --ticket <ref> --verdict right|wrong
//        node scripts/jev.mjs advisory-outcome --ticket <ref> --orchestrator <label> --jev <label|none> --user <label> --bounced true|false
// Always exits 0 (fallback on any failure) except invalid arguments, including a refused --tests path (exit 2),
// and a --ticket that names no issue file (exit 1, no row).
// Transport: plain HTTP per https://docs.typesafe.ai/api.md (POST /v1/systemone, Bearer key).
import {
  appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { hasSecret, isDenied } from "./exposure.mjs";
import { resolveRoot, resolveShortRef } from "../apps/board/board-service.mjs";

const MODEL = "jev-1.13.0";
export const MAX_CHARS = 16000;
const MAX_TESTS_BYTES = 1024 * 1024;
const BOUNCE_CAP = 2000;
const WAKE_CAP = 4000;
const ROLES = ["product", "architect", "orchestrator", "developer", "scout", "qa", "security", "designer", "herald"];
const CAP = 0.5;
const PRICE_PER_INPUT_TOKEN = 0.042 / 1e6; // output is free (ADR 0010)
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

const POINTS = {
  tier: {
    labels: ["standard", "hard", "other"],
    map: { standard: "sonnet", hard: "opus" },
    fallback: "sonnet",
    instructions:
      "Which developer model tier does this ticket need? Pick hard when it spans several modules, has a lock, race or migration concern, or its spec is ambiguous; otherwise standard.",
    criteria: {
      standard: "Small or well-specified change in one area",
      hard: "Spans several modules, or a lock, race or migration concern, or an ambiguous spec",
      other: "Cannot tell from this text",
    },
  },
  verify: {
    labels: ["light", "full", "other"],
    map: { light: "light", full: "full" },
    fallback: "full",
    instructions:
      "How deep must qa verification look? Pick light only when the test output shows every test passing with none skipped and the ticket adds no new behavior beyond its listed criteria; otherwise full.",
    criteria: {
      light: "All tests pass, none skipped, no behavior beyond the listed criteria",
      full: "Any failure, skip, or behavior beyond the listed criteria",
      other: "Cannot tell from this text",
    },
  },
  // organism-infra/69: new-ticket route, shadow only (ADR 0015 decision 3). The offered labels vary per ticket.
  route: {
    labels: ["product", "architect", "designer", "qa-specify", "developer-direct", "user", "other"],
    fallback: "orchestrator",
    instructions:
      "Which agent should take this new ticket first? Pick the one whose work the ticket needs next; pick other when the text does not say.",
    criteria: {
      product: "Needs a spec, scope or acceptance criteria before anyone builds",
      architect: "Needs a design or decision before anyone builds",
      designer: "Needs a UI or visual spec, or is a UI or asset ticket",
      "qa-specify": "Well specified code change: failing tests come first",
      "developer-direct": "Non-code ticket that a developer can start without qa tests",
      user: "Needs a decision or verdict from the user first",
      other: "Cannot tell from this text",
    },
  },
  // organism-infra/77: bounce half of route (ADR 0015 decision 3; ticket 70 wires the CLI).
  "route-bounce": {
    labels: ["developer", "qa", "architect", "user", "other"],
    fallback: "orchestrator",
    instructions:
      "This ticket bounced at review. Which agent should take it next? Pick the one the bounce verdict asks for; pick other when the text does not say.",
    criteria: {
      developer: "The code must change to meet the criteria",
      qa: "The tests or the verification must change",
      architect: "The bounce raises a design or decision question",
      user: "Needs a decision or verdict from the user",
      other: "Cannot tell from this text",
    },
  },
  // organism-infra/77: wake-up gate's one Jev question (ADR 0015 decision 6; ticket 72 wires the prelude).
  wake: {
    labels: ["needs-claude", "informational", "other"],
    map: { "needs-claude": "needs-claude", informational: "informational" },
    fallback: "needs-claude",
    instructions:
      "Does this new ticket comment need the orchestrator to act? Pick informational only when it asks for nothing and changes nothing; otherwise needs-claude.",
    criteria: {
      "needs-claude": "Asks for an action, a decision, or changes what the ticket needs",
      informational: "A status note that asks for nothing",
      other: "Cannot tell from this text",
    },
  },
  // organism-infra/71: frontier points, shadow only (ADR 0015 decision 4). The explicit line and code keep the order.
  priority: {
    labels: ["mismatch", "ok", "other"],
    fallback: "orchestrator",
    instructions:
      "Does this ticket's content agree with its explicit Priority line (P0 most urgent, P3 least)? Pick mismatch only when the content clearly reads as a different level, for example it looks P0 but is marked P3; otherwise ok.",
    criteria: {
      mismatch: "The content clearly reads as a different priority level than the line says",
      ok: "The content fits the priority line",
      other: "Cannot tell from this text",
    },
  },
  // den-mvp/40: CI-failure triage, proved by scripts/jev-eval.mjs before the den calls it. The state is triageState's.
  triage: {
    labels: ["flake", "code", "env", "other"],
    fallback: "orchestrator",
    instructions:
      "A CI job failed. Why? Pick flake when the failure is random (a timeout, a race, a test that depends on timing or load) and a rerun of the same commit would likely pass: a failing test the commit's changes cannot reach, or one that also failed on other changes, points here. Pick code when the commit's own change breaks the check and a rerun would fail the same way: the same test failing on earlier pushes of this branch points here. Pick env when the CI runner or a tool is missing something or breaks. Pick other when the commit did not cause it and a rerun would not clear it, such as a new advisory against a dependency, or when the text does not say.",
    criteria: {
      flake: "Random: a timeout, race or timing-dependent test; a rerun would likely pass",
      code: "The commit's own change breaks the check; a rerun would fail the same way",
      env: "The CI runner or a tool is missing something, lacks a permission, or crashes",
      other: "Not caused by the commit and not cleared by a rerun (such as a new dependency advisory), or cannot tell",
    },
  },
  // den-mvp/41: does a handoff show one acceptance criterion is met? Eval only until security review and ADR 0010
  // Amendment 3 allow handoff text for this use (claimCheckState builds the text).
  "claim-check": {
    labels: ["met", "not-met", "unclear"],
    fallback: "orchestrator",
    instructions:
      "Does this handoff show that this one acceptance criterion is met? Pick met only when the handoff gives evidence for it: a named test that covers it and passed, a command run with its result, or a recorded measurement. Pick not-met when the handoff shows it missing, partly done or untested, or claims it with no evidence. Pick unclear when only a person can judge it, such as a live run on another host.",
    criteria: {
      met: "The handoff gives evidence that this criterion holds",
      "not-met": "Missing, partly done, untested, or claimed without evidence",
      unclear: "Only a person can judge it from here",
    },
  },
  // den-mvp/42: one rubric item per call; the caller passes the item as the question's instructions (gradeInstructions).
  grade: {
    labels: ["0", "1", "2", "3", "4", "5"],
    fallback: "orchestrator",
    instructions: "Score this developer handoff on the rubric item, 0 to 5.",
    criteria: {
      0: "Absent: the handoff does not do this at all",
      1: "Barely: one vague mention",
      2: "Weak: partly, with large gaps",
      3: "Adequate: mostly, with some gaps",
      4: "Good: clearly, with small gaps",
      5: "Fully: clearly and completely",
    },
  },
  scope: {
    labels: ["small", "medium", "large", "other"],
    fallback: "orchestrator",
    instructions:
      "How much work does this ticket take compared with a typical ticket on this board? Pick small, medium or large; pick other when the text does not say.",
    criteria: {
      small: "One small, well-specified change in one area",
      medium: "A few files or one module with several criteria",
      large: "Spans several modules, or many criteria, or needs design work first",
      other: "Cannot tell from this text",
    },
  },
};

// organism-infra/77: each point sends only its allowlisted inputs (security review 67). Handoff text is never an input.
const ticketHeader = (t) =>
  [t.match(/^#\s.*$/m)?.[0], t.match(/^\*\*Status:\*\*.*$/m)?.[0]].filter(Boolean).join("\n");
const INPUTS = {
  tier: (a) => a.ticketText,
  verify: (a) => `${a.ticketText}\n\n--- test output ---\n${a.testsText}`,
  route: (a) => a.ticketText,
  "route-bounce": (a) => `${a.ticketText}\n\n--- bounce verdict ---\n${a.bounceComment.slice(0, BOUNCE_CAP)}`,
  wake: (a) => `${ticketHeader(a.ticketText).slice(0, WAKE_CAP)}\n\n--- new comment ---\n${a.newComment.slice(0, WAKE_CAP)}`,
  priority: (a) => a.ticketText,
  scope: (a) => a.ticketText,
};

const PRIORITY_LINE = /^\*\*Priority:\*\*\s*P[0-3]\b/m;
// Shadow points whose pick is any label of a closed set (else other) and is hidden from a shadow result.
const CLOSED_SET = ["route", "route-bounce", "priority", "scope"];

// ADR 0015 decision 6: code, not Jev, wakes on these comments.
export function codeWakes({ newComment, author, verdict }) {
  if (verdict || !newComment || /scope added/i.test(newComment)) return true;
  return author == null || !ROLES.includes(author);
}

// Reserved budget (ADR 0015 decision 7): each point may always spend its own reservation inside CAP.
const RESERVED = { tier: 0.05, verify: 0.05, route: 0.05 };
const SHARED = 0.35;
const EPS = 1e-9;

const NON_CODE_TYPES = ["asset", "research", "review", "grilling", "design", "design-direction", "design-question", "decision", "prototype"];

export function offeredLabels({ codeTicket = true, forbid = [] } = {}) {
  return POINTS.route.labels.filter(
    (l) => l === "other" || (!forbid.includes(l) && (l !== "developer-direct" || !codeTicket)),
  );
}

// den-mvp/40: what triage sends. A header (job, failing test names, and two facts code knows: what the commit
// changed, by top-level area, and where the same tests failed before), then every failing test's lines, as the
// bridge's CI findings quote them (ci-watch.mjs); a log with no failing test gives the lines up to its first error.
// The log alone cannot tell a timing flake from a real failure (the eval's first run, 2026-10-15); the facts can.
export function areasOf(files) {
  const n = {};
  for (const f of files) {
    const parts = String(f).split("/");
    const area = parts[0] === "apps" && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts.length > 1 ? parts[0] : "(root)";
    n[area] = (n[area] ?? 0) + 1;
  }
  return Object.entries(n).sort((a, b) => b[1] - a[1]);
}
const TRIAGE_BLOCK_LINES = 40;
const TRIAGE_TAIL_LINES = 60;
export function triageState({ job, log, changed, history }) {
  const all = String(log ?? "").split("\n").map((l) => l.replace(/^[^\t]*\t[^\t]*\t\S+Z ?/, "").replace(/(?:\x1b|\^\[)\[[0-9;]*m/g, ""));
  // GitHub's own cleanup after a failed step is never the failure.
  const cleanup = all.findIndex((l) => /^Post job cleanup\.$/.test(l.trim()));
  // A secret scanner's finding names the commit's author; triage needs none of it (security review, den-mvp/40).
  const lines = (cleanup === -1 ? all : all.slice(0, cleanup)).filter((l) => !/^\s*(Author|Email):\s/.test(l));
  const starts = lines.flatMap((l, i) => (/^\s*not ok \d+ - /.test(l) ? [i] : []));
  const names = [...new Set(starts.map((i) => lines[i].replace(/^\s*not ok \d+ - /, "").trim()))];
  let body;
  if (starts.length) {
    body = starts.flatMap((at, k) => lines.slice(at, Math.min(at + TRIAGE_BLOCK_LINES, starts[k + 1] ?? Infinity)));
  } else {
    const err = lines.findIndex((l) => /##\[error\]/.test(l));
    body = err === -1 ? lines.slice(-TRIAGE_TAIL_LINES) : lines.slice(Math.max(0, err - TRIAGE_TAIL_LINES), err + 1);
  }
  const head = [`job: ${String(job ?? "").slice(0, 100)}`, `failing tests: ${names.length ? names.join(" | ").slice(0, 2000) : "none named"}`];
  if (Array.isArray(changed)) {
    head.push(`commit changes: ${changed.length ? areasOf(changed).map(([a, k]) => `${a} (${k} files)`).join(", ").slice(0, 500) : "no files"}`);
  }
  if (history) {
    head.push(`same failing tests in the last ${history.days} days: failed on ${history.otherChanges} other changes (main commits or other branches), ` +
      `and on ${history.thisBranch} earlier pushes of this branch`);
  }
  const text = `${head.join("\n")}\n\n--- log ---\n${body.join("\n").trim()}`;
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
}

// den-mvp/41: what claim-check sends: one criterion, the ticket's title, and the developer's handoff, capped at 16k.
// A home path names the user; security review den-mvp/41 asks for it to be scrubbed before anything is sent.
export const scrubHome = (t) => String(t ?? "").replace(/\/(home|Users)\/[^/\s`'"]+/g, "/home/<user>");
export const gradeInstructions = (item) => `Score this developer handoff on one rubric item, from 0 (absent) to 5 (fully met). The item: ${item}`;

export function claimCheckState({ criterion, title, handoff }) {
  const text = scrubHome(`criterion: ${String(criterion ?? "").trim()}\n\n--- ticket ---\n${String(title ?? "").trim()}\n\n--- handoff ---\n${String(handoff ?? "").trim()}`);
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
}

export async function fetchTransport({ point, text, model, apiKey, signal, labels, instructions }) {
  const p = POINTS[point];
  const criteria = labels
    ? Object.fromEntries(Object.entries(p.criteria).filter(([l]) => labels.includes(l)))
    : p.criteria;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      state: text,
      model,
      questions: { [point]: { type: "choice", instructions: instructions ?? p.instructions, criteria } },
    }),
  });
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const body = await res.json();
  const a = body?.answers?.[point];
  return {
    pick: a?.choice,
    probs: a?.probabilities,
    usage: { cost: (body?.usage?.input_tokens ?? 0) * PRICE_PER_INPUT_TOKEN, tokens: body?.usage?.input_tokens ?? 0 },
  };
}

// Today's jev spend: total, and the draw on the shared remainder (each point's spend above its reservation).
function todaysSpend(rows, now, point) {
  const day = now.toISOString().slice(0, 10);
  const byPoint = {};
  let total = 0;
  for (const r of rows) {
    if (r && r.kind === "jev" && typeof r.ts === "string" && r.ts.slice(0, 10) === day) {
      const c = Number(r.cost) || 0;
      total += c;
      byPoint[r.point] = (byPoint[r.point] ?? 0) + c;
    }
  }
  const shared = Object.entries(byPoint).reduce((s, [k, v]) => s + Math.max(0, v - (RESERVED[k] ?? 0)), 0);
  return { total, own: byPoint[point] ?? 0, shared };
}

export async function decide({
  point, ticket, ticketText = "", testsText = "", now = new Date(), usageRows = [],
  env = process.env, mode = "shadow", timeoutMs = 10000, transport = fetchTransport, qaSpecified = true,
  codeTicket = true, forbid = [], status, bounceComment = "", newComment = "", author, verdict,
}) {
  const p = POINTS[point];
  const t0 = Date.now();
  const isBounce = point === "route-bounce";
  const isRoute = point === "route" || isBounce;
  // Both route halves log as point "route" and share its reservation; the row's variant tells them apart.
  const rowPoint = isRoute ? "route" : point;
  const closedSet = CLOSED_SET.includes(point);
  // organism-infra/79: advisory shows route's pick beside the orchestrator's, but never applies it.
  const advisory = mode === "advisory" && isRoute;
  const labels = isBounce
    ? p.labels.filter((l) => l === "other" || !forbid.includes(l))
    : isRoute ? offeredLabels({ codeTicket, forbid }) : closedSet ? p.labels : null;
  const build = (fields) => {
    const fb = fields.fallback ?? null;
    const pick = fb ? null : fields.pick;
    const live = mode === "live" && !fb && pick && pick !== "other";
    // organism-infra/58: verify floors to full when qa never ran specify.
    const floor = point === "verify" && qaSpecified === false ? "full" : null;
    // organism-infra/160: today's verify rule is light after a qa specify, so shadow compares against that.
    const baseline = point === "verify" && qaSpecified !== false ? "light" : p.fallback;
    const actual = floor ? floor : live ? pick : baseline;
    const conf = fb ? null : fields.conf;
    const cost = fb ? 0 : fields.cost;
    const row = {
      kind: "jev", ts: now.toISOString(), ticket, point: rowPoint, pick, actual, cost, conf,
      mode, fallback: fb, floor, ms: Date.now() - t0, model: MODEL,
    };
    if (isRoute) row.variant = isBounce ? "bounce" : "new";
    const result = { pick, conf, effective: actual, applied: Boolean(live) && actual === pick, fallback: fb, floor };
    // ADR 0015 decisions 3 and 4: a shadow result must not show the pick, only the row carries it.
    if (closedSet && !live && !advisory) { delete result.pick; delete result.conf; }
    return { result, row };
  };
  const fail = (reason) => build({ fallback: reason });

  // The state machine dictates the next agent unless the ticket is fresh: no call.
  if (point === "route" && status && status !== "ready-for-agent") return fail("state-machine");
  if (point === "wake" && codeWakes({ newComment, author, verdict })) return fail("code-wake");
  // ADR 0015 decision 4: Jev only flags an explicit line; filling a missing one is out of v1.
  if (point === "priority" && !PRIORITY_LINE.test(ticketText)) return fail("no-line");
  let text = INPUTS[point]({ ticketText, testsText, bounceComment, newComment });
  if (hasSecret(text)) return fail("blocked-input");
  if (text.length > MAX_CHARS) text = text.slice(text.length - MAX_CHARS);
  const apiKey = env.TYPESAFE_API_KEY;
  if (!apiKey) return fail("no-key");
  // Security review 70 (Low): a ticket with no bounce verdict on file has nothing to route; skip the call.
  if (isBounce && !String(bounceComment ?? "").trim()) return fail("no-bounce");
  const spent = todaysSpend(usageRows, now, rowPoint);
  const reserve = RESERVED[rowPoint] ?? 0;
  if (spent.total >= CAP || (spent.own >= reserve - EPS && spent.shared >= SHARED - EPS)) return fail("cap");

  const ctl = new AbortController();
  let timer;
  let answer;
  try {
    answer = await Promise.race([
      Promise.resolve().then(() => transport({ point, text, model: MODEL, apiKey, signal: ctl.signal, ...(isRoute ? { labels } : {}) })),
      new Promise((_, rej) => {
        timer = setTimeout(() => {
          ctl.abort();
          const e = new Error("timeout");
          e.timeout = true;
          rej(e);
        }, timeoutMs);
      }),
    ]);
  } catch (e) {
    if (e?.timeout) return fail("timeout");
    return fail(e && e.status ? "http" : "network");
  } finally {
    clearTimeout(timer);
  }

  const label = answer?.pick;
  const prob = answer?.probs?.[label];
  const cost = Number(answer?.usage?.cost);
  const c = Number.isFinite(cost) ? cost : 0;
  if (closedSet) {
    // Anything outside the offered set (unknown or forbidden) is other, not a fallback.
    const ok = labels.includes(label);
    return build({ pick: ok ? label : "other", conf: ok && typeof prob === "number" ? prob : null, cost: c });
  }
  if (!p.labels.includes(label) || typeof prob !== "number") return fail("unparseable");
  return build({ pick: p.map[label] ?? "other", conf: prob, cost: c });
}

// Security review 67: route-bounce sends only the latest `board comment --verdict bounce` text for the
// ticket, read from events.jsonl (the verdict flag is stored nowhere else). Never a handoff.
export function latestBounceComment(eventsText, feature, slug) {
  const nn = slug.match(/^\d+/)?.[0];
  const same = (t) => (nn ? String(t ?? "").match(/^\d+/)?.[0] === nn : t === slug);
  let text = "";
  for (const line of eventsText.split("\n")) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.op === "comment" && e.verdict === "bounce" && e.feature === feature && same(e.ticket) && typeof e.text === "string") {
      text = e.text;
    }
  }
  return text;
}

// organism-infra/126: the root finder and short-ref resolver are board's own (board-service.mjs).
function boardRoot() {
  try {
    return resolveRoot(process.cwd(), process.env);
  } catch {
    return process.cwd();
  }
}

// A short ref <feature>/<NN> becomes the full slug ref; none or several matches refuse (exit 1, no row).
function resolveRefs(root, refs) {
  try {
    return refs.map((r) => resolveShortRef(root, r));
  } catch (err) {
    process.stderr.write(`jev: ${err.message}\n`);
    return null;
  }
}

const CLI_POINTS = ["tier", "verify", "route", "route-bounce", "priority", "scope"];
// organism-infra/79: log-only points append the orchestrator's own rows and never call Jev.
const LOG_POINTS = {
  "priority-verdict": ["--ticket", "--verdict"],
  "advisory-outcome": ["--ticket", "--orchestrator", "--jev", "--user", "--bounced"],
};
const LABEL = /^[\w-]+$/;
const validRef = (r) => /^[\w.-]+\/[\w.-]+$/.test(r) && !r.includes("..");

function usage(msg) {
  process.stderr.write(
    `jev: ${msg}\nusage: node scripts/jev.mjs <${CLI_POINTS.join("|")}> --ticket <feature>/<NN-slug> [--tests <path>] [--mode shadow|live|advisory]\n` +
      "       node scripts/jev.mjs priority-verdict --ticket <ref> --verdict right|wrong\n" +
      "       node scripts/jev.mjs advisory-outcome --ticket <ref> --orchestrator <label> --jev <label|none> --user <label> --bounced true|false\n" +
      "(--mode advisory is route and route-bounce only)\n",
  );
  return 2;
}

const readOr = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };

// Validates a log-only point's options; returns an error message or null.
function logPointError(point, opts) {
  if (!opts.ticket) return "--ticket is required";
  if (!validRef(opts.ticket)) return "bad --ticket";
  if (point === "priority-verdict") return ["right", "wrong"].includes(opts.verdict) ? null : "--verdict must be right or wrong";
  for (const f of ["orchestrator", "jev", "user"]) if (!LABEL.test(opts[f] ?? "")) return `--${f} must be a label`;
  return ["true", "false"].includes(opts.bounced) ? null : "--bounced must be true or false";
}

function logPointRow(point, opts, now) {
  const base = { ts: now.toISOString(), ticket: opts.ticket };
  if (point === "priority-verdict") return { kind: "jev-priority-verdict", ...base, right: opts.verdict === "right" };
  return {
    kind: "jev-advisory-outcome", ...base, orchestratorPick: opts.orchestrator,
    jevPick: opts.jev === "none" ? null : opts.jev, userChoice: opts.user, bounced: opts.bounced === "true",
  };
}

// organism-infra/77: --tests must be a regular, non-symlink file of at most 1 MB, and neither its path
// nor its realpath may be denied. Returns the text, or an error message.
export function readTests(p) {
  let fd;
  try {
    if (lstatSync(p).isSymbolicLink()) return { error: "--tests must not be a symlink" };
    if (isDenied(p) || isDenied(realpathSync(p))) return { error: "--tests path is denied" };
    fd = openSync(p, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) return { error: "--tests must be a regular file" };
    if (st.size > MAX_TESTS_BYTES) return { error: "--tests file is over 1 MB" };
    return { text: readFileSync(fd, "utf8") };
  } catch (e) {
    return { error: `--tests unreadable (${e.code ?? "error"})` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function main(argv) {
  const point = argv[0];
  const logFlags = Object.hasOwn(LOG_POINTS, point) ? LOG_POINTS[point] : null;
  if (!CLI_POINTS.includes(point) && !logFlags) {
    return usage(`point must be one of ${[...CLI_POINTS, ...Object.keys(LOG_POINTS)].join(", ")}`);
  }
  const flags = logFlags ?? ["--ticket", "--tests", "--mode"];
  const opts = logFlags ? {} : { mode: "shadow" };
  for (let i = 1; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!flags.includes(k) || v === undefined) return usage(`bad argument ${k}`);
    opts[k.slice(2)] = v;
  }
  const readRows = (f) => readOr(f).split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  if (logFlags) {
    const err = logPointError(point, opts);
    if (err) return usage(err);
    const root = boardRoot();
    if (opts.ticket !== undefined) {
      const refs = resolveRefs(root, [opts.ticket]);
      if (!refs) return 1;
      opts.ticket = refs[0];
    }
    const usagePath = path.join(root, ".scratch", "usage.jsonl");
    const row = logPointRow(point, opts, new Date());
    appendFileSync(usagePath, JSON.stringify(row) + "\n");
    process.stdout.write(JSON.stringify(row) + "\n");
    return 0;
  }
  if (!opts.ticket) return usage("--ticket is required");
  if (!validRef(opts.ticket)) return usage("bad --ticket");
  const isRoute = point === "route" || point === "route-bounce";
  if (!(isRoute ? ["shadow", "live", "advisory"] : ["shadow", "live"]).includes(opts.mode)) {
    return usage(isRoute ? "--mode must be shadow, live or advisory" : "--mode must be shadow or live (advisory is route only)");
  }
  let testsText = "";
  if (opts.tests !== undefined) {
    const t = readTests(opts.tests);
    if (t.error) return usage(t.error);
    testsText = t.text;
  }

  const root = boardRoot();
  const resolved = resolveRefs(root, [opts.ticket]);
  if (!resolved) return 1;
  opts.ticket = resolved[0];
  const [feature, slug] = opts.ticket.split("/");
  const ticketPath = path.join(root, ".scratch", feature, "issues", `${slug}.md`);
  const usagePath = path.join(root, ".scratch", "usage.jsonl");
  // organism-infra/47: a ref naming no issue file is a typo; log nothing.
  if (!existsSync(ticketPath)) {
    process.stderr.write(`jev: ticket not found: ${opts.ticket} (no issue file at .scratch/${feature}/issues/${slug}.md)\n`);
    return 1;
  }
  const usageRows = readRows(usagePath);

  const nn = slug.match(/^\d+/)?.[0];
  let qaSpecified = false;
  if (nn) {
    try {
      qaSpecified = readdirSync(path.join(root, ".scratch", feature, "handoffs"))
        .some((f) => f.startsWith(`${nn}-qa-specify`) && f.endsWith(".md"));
    } catch {}
  }

  // Route: Status comes from the ticket; a ticket is non-code only when its **Type:** says so (else code, the safe side).
  const ticketText = readOr(ticketPath);
  const status = ticketText.match(/^\*\*Status:\*\*\s*(\S+)/m)?.[1];
  const type = ticketText.match(/^\*\*Type:\*\*\s*([\w-]+)/m)?.[1]?.toLowerCase();
  const codeTicket = !NON_CODE_TYPES.includes(type);
  const bounceComment = point === "route-bounce"
    ? latestBounceComment(readOr(path.join(root, ".scratch", "events.jsonl")), feature, slug)
    : "";

  const { result, row } = await decide({
    point, ticket: opts.ticket, ticketText, qaSpecified, status, codeTicket,
    testsText, usageRows, mode: opts.mode, bounceComment,
  });
  appendFileSync(usagePath, JSON.stringify(row) + "\n");
  process.stdout.write(JSON.stringify({ ...result, point, ticket: opts.ticket, mode: opts.mode }) + "\n");
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
