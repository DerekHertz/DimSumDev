// View-models for the floating cards and the bottom overlays (den-scene-v1/07). Pure: no React, no DOM, time is
// passed in. Copy comes from docs/design/2026-10-01-iso-den.md section 4. Agent text (ticket titles) is untrusted:
// the components render it as React text nodes only.
import { gatesModel } from "../panel/gates-model.mjs";
import { checksView, deliveryRequests } from "./delivery-model.mjs";
import { meetingRequests } from "./meeting-model.mjs";
import { queueModel } from "../panel/queue-model.mjs";
import { roleOf, sceneFromState } from "../scene/scene-from-state.mjs";
import { teamOf } from "../scene/banquet-layout.mjs";
import { toolVerb, reasonText, detailLabel } from "./thread-model.mjs";

export const TEAM_NAME = {
  pass: "Pass", steamers: "Steamers", tea: "Tea", pantry: "Pantry", "front-of-house": "Front of House",
  cubs: "Cubs", library: "Library", drum: "Drum",
};
/** Open teams, in the order the card lists them. */
export const OPEN_TEAMS = ["pass", "steamers", "tea", "pantry", "front-of-house"];
/** Teams not built yet, drawn as dashed pills. Cubs shows how many are asleep instead of "coming online". */
export const DORMANT_TEAMS = ["cubs", "library", "drum"];
/** The one-character mark of each team (tokens.json: Pass 传, Steamers 蒸, Tea 茶, Pantry 仓, Front of House 堂, Cubs 崽, Library 书, Drum 鼓). */
export const TEAM_GLYPH = {
  pass: "传", steamers: "蒸", tea: "茶", pantry: "仓", "front-of-house": "堂", cubs: "崽", library: "书", drum: "鼓",
};
/** The team colour tokens (CSS custom properties) of each open team. */
export const TEAM_HUE = {
  pass: "--team-pass", steamers: "--team-steamers", tea: "--team-tea", pantry: "--team-pantry", "front-of-house": "--team-front",
};

const PASS_TYPES = new Set(["orchestrator", "product", "architect"]);

/** A role's team id: the three Pass types share "pass"; anything unknown is a cub. */
export function teamIdOf(role) {
  const s = teamOf(role);
  return PASS_TYPES.has(s) ? "pass" : s;
}

export const shortRef = (ref) => ref.slice(ref.indexOf("/") + 1);

/** "2 min", "3 h", "2 d"; "now" under a minute; null when the time is unknown. */
export function relativeAge(since, nowMs) {
  const t = Date.parse(since ?? "");
  if (!Number.isFinite(t)) return null;
  const minutes = Math.max(0, Math.floor((nowMs - t) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / (60 * 24))} d`;
}

const ENDED_STATES = new Set(["done", "failed", "terminated"]);
const titled = (word) => (word ? word[0].toUpperCase() + word.slice(1) : "Agent");

function expiresText(expiresAt, nowMs) {
  const left = Date.parse(expiresAt ?? "") - nowMs;
  if (!Number.isFinite(left)) return null;
  // Whole minutes, rounded down: the page's clock ticks every 30 s, so rounding up could show more than the limit.
  return left < 60_000 ? "expires in under a minute" : `expires in ${Math.floor(left / 60_000)} min`;
}

/**
 * den-v1 loop: the permission requests the bridge holds for a live agent, oldest first. Each carries `card`, the
 * shape the permission review opens from (approval-review.mjs); the review shows the full input and sends the answer.
 */
function permissionRequests(snapshot, nowMs) {
  const agents = Array.isArray(snapshot?.agents) ? snapshot.agents : [];
  const approvals = Array.isArray(snapshot?.approvals) ? snapshot.approvals : [];
  const on = { enabled: true, reason: null };
  const out = [];
  for (const a of approvals) {
    if (!a?.id || (a.status ?? a.state ?? "pending") !== "pending") continue;
    if (Date.parse(a.expiresAt ?? "") <= nowMs) continue;
    const agent = agents.find((row) => row?.id === a.agentId);
    if (!agent || ENDED_STATES.has(agent.state) || agent.capabilities?.approve !== true) continue;
    const role = typeof agent.role === "string" ? agent.role : "";
    const ref = typeof agent.ref === "string" ? agent.ref : "";
    const tool = typeof a.tool === "string" && a.tool ? a.tool : "a tool";
    const team = teamIdOf(role);
    const name = titled(role);
    out.push({
      key: `approval:${a.id}`,
      kind: "permission",
      ref,
      short: shortRef(ref),
      role,
      team,
      eyebrow: [name, ref].filter(Boolean).join(" · "),
      // organism-infra/230: the card leads with what is asked in plain words and why; the command is the detail under it.
      title: `Wants to ${toolVerb(a.tool)}`,
      ...(() => { const why = reasonText(a); return { reason: why.text, reasonFallback: why.fallback }; })(),
      detailLabel: detailLabel(a.tool),
      rowText: [shortRef(ref), tool].filter(Boolean).join(" · "),
      preview: typeof a.summary === "string" && a.summary ? [a.summary] : [],
      expires: expiresText(a.expiresAt, nowMs),
      age: null,
      card: { id: null, name, role, team, ref: ref || null, agentId: agent.id, state: agent.state, approval: a, actions: { Q: on, E: on } },
    });
  }
  return out;
}

/** The card E and Q answer: the panda card in view when it holds a request, else the first waiting permission request. */
export function answerCardFor(card, requests) {
  if (card?.approval) return card;
  return (requests ?? []).find((r) => r.kind === "permission")?.card ?? card ?? null;
}

/**
 * Every waiting request: the bridge's permission requests first (they expire), then the board's, in board order:
 * a ticket whose gate is merge or dispatch (gates-model.mjs).
 */
// den-mvp/29: a red pull request the CI watch found, as a Needs you request. A re-run the bridge started is not the
// user's to answer, and a pull request a delivery is waiting on already has the delivery's card.
const CI_NEXT = {
  red: "Look at the failing job on the pull request: fix it, or re-run it if it is flaky.",
  "asks-user": "Red twice on this commit, so the den starts nothing more. Fix it, or re-run it yourself.",
};
const httpsLink = (url) => (typeof url === "string" && /^https:\/\/[A-Za-z0-9.-]+\//.test(url) ? url : null);
export function ciRequests(snapshot) {
  const delivered = new Set((snapshot?.deliveries ?? []).filter((d) => d?.state === "paused" || d?.state === "running").map((d) => d.pr?.number));
  return (Array.isArray(snapshot?.ci?.prs) ? snapshot.ci.prs : [])
    .filter((p) => Number.isInteger(p?.number) && CI_NEXT[p.state] && !delivered.has(p.number))
    .map((p) => {
      const role = p.route === "security" ? "security" : "orchestrator";
      const team = teamIdOf(role);
      const jobs = Array.isArray(p.jobs) ? p.jobs : [];
      const short = `PR #${p.number}`;
      return {
        key: `ci:${p.number}`, kind: "ci", ref: null, short, role, team,
        eyebrow: `${TEAM_NAME[team]} · ${role === "security" ? "security" : "Bao"} · ${short}`,
        title: `${short} is red${p.state === "asks-user" ? " again on the same commit" : ""}: ${jobs.map((j) => j.name).join(", ") || "a check failed"}`,
        reason: jobs.map((j) => `${j.name}: ${j.reason}`).join("; ") || "A check failed.", reasonFallback: false, plain: true,
        next: typeof p.bao === "string" && p.bao ? `${CI_NEXT[p.state]} ${p.bao}.` : CI_NEXT[p.state], rowText: `${short} · red`, preview: typeof p.title === "string" && p.title ? [p.title] : [], detailLabel: "The pull request",
        age: null, pr: httpsLink(p.url), prNumber: p.number,
        // den-mvp/34: the latest local run of this commit's checks beside GitHub's red, and whether one is running now.
        checks: checksView({ here: (snapshot?.checks?.recent ?? []).find((r) => r?.sha === p.sha) ?? null, github: "red" }),
        checksRunning: typeof p.sha === "string" && (snapshot?.checks?.running ?? []).includes(p.sha), canRunChecks: snapshot?.checks != null,
      };
    });
}

// den-mvp/13: a ticket at ready-for-human (a meeting's proposal, a filed task) waits for Approve or Decline.
export function ticketRequests(snapshot) {
  return (Array.isArray(snapshot?.tickets) ? snapshot.tickets : [])
    .filter((t) => t?.status === "ready-for-human" && typeof t.ref === "string")
    .map((t) => {
      const short = shortRef(t.ref);
      const role = "orchestrator";
      const team = teamIdOf(role);
      return {
        key: `ticket:${t.ref}`, kind: "ticket", ref: t.ref, short, role, team,
        eyebrow: `${TEAM_NAME[team]} · ${short}`,
        title: `${short} waits for your answer: ${t.title || "untitled"}`,
        reason: "Approve sends it to the queue. Decline closes it with your reason.", reasonFallback: false, plain: true,
        rowText: `${short} · approve?`, preview: typeof t.text === "string" && t.text ? [t.text] : [], detailLabel: "The ticket",
        age: null,
      };
    });
}

// den-mvp/88: a stop the router met (it already pushed a phone notification). It is the user's to dismiss, not to approve.
export function routerStopRequests(snapshot) {
  return (Array.isArray(snapshot?.requests) ? snapshot.requests : [])
    .filter((r) => r?.kind === "router-stop" && r.state === "pending" && typeof r.id === "string")
    .map((r) => {
      const role = "orchestrator";
      const team = teamIdOf(role);
      const short = typeof r.ref === "string" ? shortRef(r.ref) : "router";
      return {
        key: `router-stop:${r.id}`, kind: "router-stop", id: r.id, ref: r.ref ?? null, short, role, team,
        eyebrow: `${TEAM_NAME[team]} · router · ${short}`,
        title: typeof r.note === "string" && r.note ? r.note : "The router stopped and needs you.",
        reason: "The router will not act on this itself. Dismiss it once you have seen it; it comes back if it is still true.", reasonFallback: false, plain: true,
        rowText: `${short} · router stop`, preview: [], detailLabel: "The router stop", age: null,
      };
    });
}

export function needsYouModel(snapshot, nowMs) {
  const byRef = new Map((snapshot?.tickets ?? []).map((t) => [t.ref, t]));
  const gates = gatesModel(snapshot).cards.map((card) => {
    const t = byRef.get(card.ref);
    const gate = card.approveKind.replace(/-approve$/, "");
    const role = roleOf(t);
    const team = teamIdOf(role);
    const short = shortRef(card.ref);
    return {
      key: card.ref,
      kind: "gate",
      ref: card.ref,
      short,
      gate,
      role,
      team,
      eyebrow: `${TEAM_NAME[team]} · ${role} · ${short}`,
      title: `${short} wants ${gate} approval`,
      rowText: `${short} · ${gate}`,
      preview: [`${card.approveKind} ${card.ref}`, card.title],
      age: relativeAge(t?.holder?.since, nowMs),
      approveKind: card.approveKind,
      rejectKind: card.rejectKind,
      pending: card.pending,
    };
  });
  // den-mvp outcome 3: a delivery that waits on the user sits between the two.
  // den-mvp outcome 4: so does a meeting that is paused, or whose brief waits for the user's choice.
  const requests = [...permissionRequests(snapshot, nowMs), ...deliveryRequests(snapshot), ...ciRequests(snapshot), ...meetingRequests(snapshot), ...ticketRequests(snapshot), ...routerStopRequests(snapshot), ...gates];
  return { count: requests.length, requests };
}

const keyOf = (r) => r.key ?? r.ref;
/** The next (+1) or previous (-1) request after `key`, wrapping; the first when `key` is not in the list. */
export function stepRequest(requests, key, dir) {
  if (requests.length === 0) return null;
  const i = requests.findIndex((r) => keyOf(r) === key);
  if (i < 0) return keyOf(requests[0]);
  return keyOf(requests[(i + dir + requests.length) % requests.length]);
}

/** Pills for the open teams and the dormant ones, the "N open · M ready" summary, and every frontier row (228: the list scrolls, it is not cut). */
export function teamsModel(snapshot) {
  const placements = snapshot ? sceneFromState(snapshot) : [];
  const count = {};
  const waiting = {};
  for (const c of placements) {
    const id = teamIdOf(c.role);
    count[id] = (count[id] ?? 0) + 1;
    if (c.pose === "waiting_on_user") waiting[id] = true;
  }
  const open = OPEN_TEAMS.map((id) => ({ id, name: TEAM_NAME[id], glyph: TEAM_GLYPH[id], count: count[id] ?? 0, waiting: Boolean(waiting[id]) }));
  const dormant = DORMANT_TEAMS.map((id) => ({
    id,
    name: TEAM_NAME[id],
    glyph: TEAM_GLYPH[id],
    text: id === "cubs" ? `${count.cubs ?? 0} asleep` : "coming online",
  }));
  const queue = snapshot ? queueModel(snapshot).frontier : [];
  const types = new Map((snapshot?.tickets ?? []).map((t) => [t.ref, t.type]));
  return {
    open,
    dormant,
    summary: `${open.length} open · ${queue.length} ready`,
    next: queue.map((r) => ({ ref: r.ref, priority: r.priorityLabel, title: r.title, type: types.get(r.ref) ?? null })),
  };
}

/** The Live badge in the logo pill: Live, Offline once the bridge has been gone a while, else Reconnecting. */
export function badgeModel(conn) {
  if (conn.phase === "live") return { label: "Live", tone: "live", ariaLive: null, hint: null };
  if (conn.phase === "offline") return { label: "Offline", tone: "muted", ariaLive: null, hint: "Bridge offline: run npm run ui" };
  return { label: "Reconnecting…", tone: "muted", ariaLive: "polite", hint: null };
}

/** "9:05" (24 hour, hour not padded). */
export function clockText(nowMs) {
  const d = new Date(nowMs);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const TIMELINE_WINDOW_MS = 60 * 60_000;

/**
 * Event dots on the timeline track, from what the board holds: a ticket someone took in the last hour (a Pass
 * dot, or a lantern dot when it waits on the user, or an alarm dot when blocked). `at` is 0 (an hour ago) to 1 (now).
 */
export function timelineMarkers(snapshot, nowMs) {
  const out = [];
  for (const t of snapshot?.tickets ?? []) {
    const since = Date.parse(t.holder?.since ?? "");
    if (!Number.isFinite(since)) continue;
    const age = nowMs - since;
    if (age < 0 || age > TIMELINE_WINDOW_MS) continue;
    const tone = t.gate ? "lantern" : t.status === "blocked" ? "alarm" : "pass";
    out.push({ ref: t.ref, tone, at: 1 - age / TIMELINE_WINDOW_MS });
  }
  return out;
}

export const AUTONOMY_MODES = ["supervised", "gated", "autopilot"];
