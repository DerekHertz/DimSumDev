// organism-infra/81: `board audit`, a read-only scan of every feature's tickets,
// claim locks and handoffs for inconsistencies a session would otherwise find by
// hand. It never writes; the CLI prints one `<ref> <kind> <detail>` line per finding.
import { readdir, readFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { readStatus, OFF_RELAY_STATUSES } from "./board-service.mjs";
import { compareRefs } from "../../packages/board-refs/src/compare-refs.mjs";
import { readGoalsSync } from "./goals.mjs";

const GOAL_LINE_RE = /^\*\*Goal:\*\*[ \t]*(.*?)[ \t]*$/m;

const DAY_MS = 24 * 60 * 60 * 1000;
const REF_RE = /^([a-z0-9-]+)\/(\d{2,})(?:-[a-z0-9-]+)?$/;
const REF_IN_TEXT_RE = /\b([a-z0-9-]+)\/(\d{2,})(?:-[a-z0-9-]+)?\b/g;
const BLOCKED_BY_RE = /^\**Blocked by:?\**:?[ \t]*(.*)$/im;
const COMMENT_DATE_RE = /^- \*\*[a-z-]+, (\d{4}-\d{2}-\d{2}):\*\*/gm;
const TRUNK_BRANCHES = new Set(["main", "master"]);

function stateBlock(text) {
  const m = /```json\s*([\s\S]*?)```/.exec(text);
  try {
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
}

function headerOf(content) {
  const i = content.search(/^## /m);
  return i === -1 ? content : content.slice(0, i);
}

function commentsOf(content) {
  const i = content.search(/^## Comments/m);
  return i === -1 ? "" : content.slice(i);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Splits a `Blocked by` value on commas outside parentheses, so
// "01 (rig, feel), 02" gives two items.
function splitItems(value) {
  const items = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      items.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  items.push(cur);
  return items.map((s) => s.trim()).filter(Boolean);
}

// Refs a ticket's `Blocked by` line names. Free text ("None", "at least 15
// tickets", "jg trial verdict") yields none; an item counts only when it starts
// with `NN` or `<feature>/NN`.
function blockers(content, feature) {
  const m = BLOCKED_BY_RE.exec(headerOf(content));
  if (!m || /^none\b/i.test(m[1].trim())) return [];
  const out = [];
  for (const item of splitItems(m[1])) {
    const r = /^`?(?:([a-z0-9-]+)\/)?(\d{2,})(?:-[a-z0-9-]+)?`?(?=$|[\s(.,;:])/.exec(item);
    if (!r) continue;
    out.push({ feature: r[1] ?? feature, nn: r[2], annotatedResolved: /\(\s*resolved\s*\)/i.test(item) });
  }
  return out;
}

async function loadBoard(root) {
  const scratch = path.join(root, ".scratch");
  const tickets = new Map();
  const locks = [];
  const handoffs = [];
  const dirs = await readdir(scratch, { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const feature = d.name;
    const issuesDir = path.join(scratch, feature, "issues");
    const entries = await readdir(issuesDir).catch(() => null);
    if (!entries) continue;
    for (const name of entries) {
      const nn = /^(\d{2,})-/.exec(name)?.[1];
      if (!nn) continue;
      if (name.endsWith(".md")) {
        const p = path.join(issuesDir, name);
        const content = await readFile(p, "utf8").catch(() => "");
        const slug = name.slice(0, -3);
        tickets.set(`${feature}/${nn}`, {
          feature,
          slug,
          nn,
          ref: `${feature}/${slug}`,
          status: readStatus(content),
          content,
          mtimeMs: (await stat(p)).mtimeMs,
        });
      } else if (name.endsWith(".lock")) {
        const content = await readFile(path.join(issuesDir, name), "utf8").catch(() => "");
        locks.push({ feature, nn, slug: name.slice(0, -5), role: content.trim().split(/\s+/)[0] || "unknown" });
      }
    }
    const handoffDir = path.join(scratch, feature, "handoffs");
    for (const name of await readdir(handoffDir).catch(() => [])) {
      if (!name.endsWith(".md")) continue;
      const text = await readFile(path.join(handoffDir, name), "utf8").catch(() => "");
      handoffs.push({ feature, name, text, state: stateBlock(text) });
    }
  }
  return { tickets, locks, handoffs };
}

async function lastEvents(root) {
  const last = new Map();
  const text = await readFile(path.join(root, ".scratch", "events.jsonl"), "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const t = Date.parse(e.ts);
    if (!e.feature || !e.ticket || Number.isNaN(t)) continue;
    const key = `${e.feature}/${e.ticket}`;
    if (!(last.get(key) >= t)) last.set(key, t);
  }
  return last;
}

// Branch names and linked-worktree paths, or null when git is unavailable.
function gitNames(root) {
  const run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    const branches = run(["for-each-ref", "--format=%(refname:short)", "refs/heads"])
      .split("\n")
      .map((s) => s.trim())
      .filter((b) => b && !TRUNK_BRANCHES.has(b));
    const trees = [...run(["worktree", "list", "--porcelain"]).matchAll(/^worktree (.+)$/gm)].map((m) => m[1].trim());
    return { branches, worktrees: trees.slice(1) };
  } catch {
    return null;
  }
}

function lockBacked(lock, ticket, names, handoffs) {
  const direct = [...names.branches, ...names.worktrees].some(
    (n) =>
      n.includes(lock.slug) ||
      n.includes(`${lock.feature}-${lock.nn}`) ||
      new RegExp(`(^|/)${lock.nn}-`).test(n)
  );
  if (direct) return true;
  const texts = [
    ticket?.content ?? "",
    ...handoffs.filter((h) => h.feature === lock.feature && h.name.startsWith(`${lock.nn}-`)).map((h) => h.text),
  ];
  return names.branches.some((b) => {
    const re = new RegExp(`(?<![\\w/.-])${escapeRe(b)}(?![\\w/-])`);
    return texts.some((t) => re.test(t));
  });
}

export async function audit(root, { staleDays = 7, feature, now = Date.now() } = {}) {
  const { tickets, locks, handoffs } = await loadBoard(root);
  const events = await lastEvents(root);
  const findings = [];
  const add = (ref, kind, detail) => findings.push({ ref, kind, detail });
  const lockKeys = new Set(locks.map((l) => `${l.feature}/${l.nn}`));
  // den-mvp/61: once the board has a goals file, every open ticket names one of its goals.
  const goalsFile = readGoalsSync(root);
  const goalKeys = goalsFile.missing ? null : new Set(goalsFile.goals.map((g) => g.key));
  if (!goalsFile.missing) for (const e of goalsFile.errors) add("goals.md", "goals-file", e);

  for (const [key, t] of tickets) {
    if ((t.status === "claimed" || t.status === "in-review") && !lockKeys.has(key)) {
      add(t.ref, "no-lock", `status is ${t.status} but there is no claim lock`);
    }
    if (t.status === "resolved" || OFF_RELAY_STATUSES.includes(t.status)) continue;

    if (goalKeys) {
      const goal = GOAL_LINE_RE.exec(t.content)?.[1] ?? "";
      if (!goal) add(t.ref, "no-goal", "no Goal line naming one of the goals in .scratch/goals.md");
      else if (!goalKeys.has(goal)) add(t.ref, "unknown-goal", `Goal ${JSON.stringify(goal.slice(0, 40))} is not in .scratch/goals.md`);
    }

    const bs = blockers(t.content, t.feature);
    let allResolved = bs.length > 0;
    for (const b of bs) {
      const target = tickets.get(`${b.feature}/${b.nn}`);
      if (!target && !b.annotatedResolved) {
        add(t.ref, "blocked-by-missing", `Blocked by names ${b.feature}/${b.nn}, which does not exist`);
      }
      const resolved = target ? target.status === "resolved" : b.annotatedResolved;
      if (!resolved) allResolved = false;
    }
    if (t.status === "blocked" && allResolved) {
      const list = bs.map((b) => `${b.feature}/${b.nn}`).join(", ");
      add(t.ref, "unblocked", `status is blocked but every Blocked by ticket is resolved (${list})`);
    }

    const commentDates = [...commentsOf(t.content).matchAll(COMMENT_DATE_RE)].map((m) => Date.parse(m[1]));
    const last = Math.max(t.mtimeMs, events.get(`${t.feature}/${t.slug}`) ?? 0, ...commentDates.filter((d) => !Number.isNaN(d)));
    if (now - last > staleDays * DAY_MS) {
      const days = Math.floor((now - last) / DAY_MS);
      add(t.ref, "stale", `no board event or comment in ${days} days (last ${new Date(last).toISOString().slice(0, 10)})`);
    }
  }

  const names = gitNames(root);
  if (names) {
    for (const lock of locks) {
      const ticket = tickets.get(`${lock.feature}/${lock.nn}`);
      if (!lockBacked(lock, ticket, names, handoffs)) {
        add(`${lock.feature}/${lock.slug}`, "no-branch", `lock held by ${lock.role} but no branch or worktree matches this ticket`);
      }
    }
  }

  const features = new Set([...tickets.values()].map((t) => t.feature));
  for (const h of handoffs) {
    const pending = Array.isArray(h.state?.pending) ? h.state.pending : [];
    const own = REF_RE.exec(typeof h.state?.ticket === "string" ? h.state.ticket : "");
    const ownTicket = own ? tickets.get(`${own[1]}/${own[2]}`) : undefined;
    const ownRef = ownTicket?.ref ?? h.state?.ticket ?? `${h.feature}/handoffs/${h.name}`;
    for (const p of pending) {
      if (!p || typeof p !== "object") continue;
      let named = typeof p.ticket === "string" ? REF_RE.exec(p.ticket) : null;
      if (!named && typeof p.item === "string") {
        named = [...p.item.matchAll(REF_IN_TEXT_RE)].find((m) => features.has(m[1])) ?? null;
      }
      if (!named) continue;
      const key = `${named[1]}/${named[2]}`;
      // Work pending on the handoff's own ticket is tracked by that ticket's relay.
      if (own && key === `${own[1]}/${own[2]}`) continue;
      const target = tickets.get(key);
      if (target && target.status !== "resolved") continue;
      const mention = new RegExp(`\\b${escapeRe(key)}\\b`);
      if ([ownTicket, target].some((t) => t && mention.test(commentsOf(t.content)))) continue;
      add(
        ownRef,
        "orphan-pending",
        `handoffs/${h.name} pending "${p.item}" (owner ${p.owner}) names ${key}, which ${target ? "is resolved" : "does not exist"}, and no ticket comment records it`
      );
    }
  }

  return findings
    .filter((f) => !feature || f.ref.startsWith(`${feature}/`))
    .sort((a, b) => compareRefs(a.ref, b.ref) || a.kind.localeCompare(b.kind));
}
