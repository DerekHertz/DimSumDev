// den-mvp outcome 4: the pure pieces behind a meeting in the den. No DOM, no fetch; Meetings.jsx renders what these
// return. A meeting is the bridge's job that asks a few roles for one take each and has Bao write a decision brief.
// The words here say what the bridge recorded; a brief is shown as the chair's text and decides nothing by itself.
import { CHAIR, SEATS_MAX, SPECIALISTS, TOPIC_MAX_BYTES } from "../../../bridge/meetings/types.mjs";

export { SEATS_MAX, SPECIALISTS };
const USAGE_LIMIT = 90; // the bridge refuses a new run at this five-hour usage (placements/policy.mjs)
const LIVE = new Set(["running", "paused"]);
const shortRef = (ref) => (typeof ref === "string" ? ref.slice(ref.indexOf("/") + 1) : "");
const list = (snapshot) => (Array.isArray(snapshot?.meetings) ? snapshot.meetings.filter((m) => m && typeof m.id === "string" && Array.isArray(m.seats)) : []);
const cap = (s) => `${s[0].toUpperCase()}${s.slice(1)}`;
const bytes = (text) => new TextEncoder().encode(text).length;

const modernStates = { running: 'In discussion', 'waiting-decision': 'Waiting on your decision', 'waiting-budget': 'Waiting for budget approval', pausing: 'Pausing…', paused: 'Paused', 'ready-for-review': 'Ready for review', ended: 'Ended' };
const speaker = role => ({ bao: 'Bao', jiao: 'Jiao', user: 'You' }[role] ?? role);
export const meetingPillLabel = m => `Meeting · ${modernStates[m.state] ?? m.state}`;

export function recentActivity(snapshot, max = 6) {
  const meetings = (snapshot?.meetings ?? []).flatMap(m => (m.activity ?? []).map(e => ({ key: e.id, kind: 'meeting', target: m.id, actor: SPECIALISTS.includes(e.actor) ? e.actor : null, at: e.at, text: e.kind === 'status' ? `${speaker(e.actor)} · ${modernStates[e.state] ?? e.state}` : `${speaker(e.actor)} ${ { message: `contributed in round ${e.round}`, failure: 'could not finish a contribution', effort: 'changed thinking effort', participants: 'updated participants', 'decision-answer': 'answered a question', 'ticket-created': 'created an approved follow-up' }[e.kind] ?? e.kind }` })));
  const agents = (snapshot?.agents ?? []).filter(a => !a.ref?.startsWith('meetings/')).map(a => ({ key: `${a.id}:${a.state}`, kind: 'agent', target: a.id, actor: a.role, at: a.lastEventAt ?? a.startedAt, text: `${a.role} · ${a.state}` }));
  const deliveries = (snapshot?.deliveries ?? []).map(d => ({ key: `${d.id}:${d.state}`, kind: 'delivery', target: d.id, at: d.updatedAt ?? d.startedAt, text: `Delivery ${d.ref ?? d.id} · ${d.state}` }));
  const approvals = (snapshot?.approvals ?? []).filter(a => a.state === 'pending').map(a => ({ key: a.id, kind: 'agent', target: a.agentId, at: a.ts, text: `A specialist asks to use ${a.tool}` }));
  return [...meetings, ...agents, ...deliveries, ...approvals].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)).slice(0, max);
}

/** How many runs a meeting of these roles starts, in words: one take each, then the chair. */
export const runsLine = (count) => (count === 0 ? "Pick who to ask." : `${count + 1} runs: ${count} take${count === 1 ? "" : "s"}, one at a time, then Bao's brief.`);

/** Whether Start is offered, the line under it, and what the meeting will use. First match wins. */
export function setupState({ topic = "", roles = [], usage = null, steer, inflight = false } = {}) {
  const cost = `${runsLine(roles.length)} ${typeof usage === "number" ? `Five-hour usage is ${usage}%.` : "Usage reading unavailable."}`;
  const off = (reason) => ({ enabled: false, reason, cost });
  if (steer?.demo) return off("Demo mode: actions are off");
  if (steer?.state === "none") return off("Couldn't send: not signed in to steer");
  if (inflight) return off("Starting…");
  if (typeof usage === "number" && usage >= USAGE_LIMIT) return off(`Five-hour usage is ${usage}%: nothing new starts at ${USAGE_LIMIT}% or more.`);
  if (!topic.trim()) return off("Write the question first.");
  if (bytes(topic.trim()) > TOPIC_MAX_BYTES) return off(`The question is limited to ${TOPIC_MAX_BYTES} bytes.`);
  if (roles.length === 0) return off("Pick at least one role.");
  if (roles.length > SEATS_MAX) return off(`At most ${SEATS_MAX} roles.`);
  return { enabled: true, reason: null, cost };
}

/** Adds or removes a role, keeping the order the roles are listed in and the cap of six. */
export function toggleRole(roles, role) {
  if (roles.includes(role)) return roles.filter((r) => r !== role);
  if (roles.length >= SEATS_MAX) return roles;
  return SPECIALISTS.filter((r) => r === role || roles.includes(r));
}

/** One line for one seat. */
export function seatLine(seat, meeting) {
  if (seat.status === "taken") return seat.takes > 1 ? `gave ${seat.takes} takes` : "gave its take";
  if (seat.status === "declined") return `declined: ${seat.reason || "no reason given"}`;
  if (seat.status === "failed") return `no take: ${seat.reason || "the run failed"}`;
  return meeting?.live?.role === seat.role ? "giving its take now" : "not asked yet";
}

/** One line saying where a meeting stands. */
export function meetingLine(m) {
  if (m?.schema === 2) return ({ running: `${m.live ? m.live.role + ' is contributing' : 'Starting next response'}`, pausing: 'Pausing… Current work finishes and still counts.', paused: 'Paused', 'waiting-budget': 'Waiting for budget approval', 'waiting-decision': 'Waiting on your decision', 'ready-for-review': 'Ready for review', ended: 'Ended · private record preserved permanently' })[m.state];
  if (m?.state === "paused") return `Waiting: ${m.pause?.reason || "paused"}`;
  if (m?.state === "running") {
    if (!m.live) return "Starting the next run";
    if (m.live.part === "take") return `${cap(m.live.role)} is giving its take`;
    return m.live.part === "chair" ? "Bao is writing the brief" : "Bao is answering your follow-up";
  }
  const last = m?.decisions?.at(-1);
  const tail = m?.retired ? " Only the summary and the brief are kept." : "";
  if (m?.state === "briefed") return `The brief is ready: ${m.brief?.options?.length ?? 0} options, ${m.brief?.recommended ?? "?"} recommended. The choice is yours.`;
  if (m?.state === "decided" && last) return `You chose option ${last.option}. Proposed work: ${last.ticket}.${tail}`;
  if (m?.state === "closed") return `${last ? `Closed. You chose option ${last.option}: ${last.ticket}.` : "Closed without a choice."}${tail}`;
  return "";
}

/** Can a follow-up be asked? Only of a meeting that has its brief, is not running, and still has its takes. */
export const canAsk = (m) => m?.schema === 2 ? m.state !== 'ended' : ["briefed", "decided", "closed"].includes(m?.state) && !!m.brief && !m.retired;
/** Can an option be chosen? Only for a brief that has no decision yet. */
export const canDecide = (m) => m?.schema === 2 ? m.state === 'waiting-decision' : m?.state === "briefed" && !!m.brief && !m.retired;

/** The rows of the Meetings list: the ones under way or waiting for a choice first, then the newest ended. */
export function meetingRows(snapshot, max = 5) {
  const all = list(snapshot);
  const open = (m) => m.schema === 2 ? m.state !== 'ended' : LIVE.has(m.state) || m.state === "briefed";
  const rows = [...all.filter(open), ...all.filter((m) => !open(m)).reverse()].slice(0, max);
  return rows.map((m) => ({
    id: m.id, ref: m.ref, project: m.project ?? 'den', summary: m.summary ?? '', title: m.title || shortRef(m.ref), state: m.state, line: meetingLine(m), stamp: m.updatedAt ?? "",
    seats: m.seats.map((s) => ({ role: s.role, status: s.status, line: seatLine(s, m) })),
    chair: m.live?.role === CHAIR ? "at work now" : m.brief ? `wrote brief ${m.brief.version}` : "after the takes",
    options: (m.brief?.options ?? []).map((o) => ({ key: o.key, title: o.title, recommended: o.key === m.brief.recommended })),
    decisions: (m.decisions ?? []).map((d) => ({ option: d.option, title: d.title, ticket: d.ticket })),
    roles: [...m.seats.filter(s => s.active !== false).map((s) => s.role), ...(m.moderator ? [m.moderator] : [])],
    canStop: m.state === "running", canResume: m.state === "paused", canClose: m.state !== "running" && m.state !== "closed",
    canEnd: m.state !== "closed", // team-and-den-ux/04: End meeting… stops a running one first
    canAsk: canAsk(m), canDecide: canDecide(m), hasBrief: !!m.brief,
    next: m.state === "paused" ? m.pause?.next || "" : "",
  }));
}

// A wait that ends by itself is not the user's to answer.
const SELF_ENDING = new Set(["no-room"]);

/** A meeting that waits on the user, as a Needs you request (the shape overlay-model.mjs lists). Bao chairs, so it is Bao's card. */
export function meetingRequests(snapshot) {
  const modern = list(snapshot).filter(m => m.schema === 2 && ['paused', 'waiting-budget', 'waiting-decision'].includes(m.state)).map(m => ({ key: `meeting:${m.id}`, kind: 'meeting', id: m.id, ref: m.ref ?? m.id, short: m.title, role: 'orchestrator', team: 'pass', eyebrow: `${m.moderator === 'jiao' ? 'Jiao' : 'Bao'} · Meeting`, title: meetingLine(m), reason: m.events?.findLast(e => e.kind === 'status')?.text ?? '', reasonFallback: false, plain: true, next: 'Open the meeting to review.', rowText: m.title, preview: [], detailLabel: '', age: null, primary: { action: 'open', label: 'Open meeting' } }));
  return [...modern, ...legacyRequests(snapshot)];
}
function legacyRequests(snapshot) {
  return list(snapshot)
    .filter((m) => m.schema !== 2 && ((m.state === "paused" && !SELF_ENDING.has(m.pause?.kind)) || m.state === "briefed"))
    .map((m) => {
      const short = shortRef(m.ref);
      const briefed = m.state === "briefed";
      return {
        key: `meeting:${m.id}`, kind: "meeting", id: m.id, ref: m.ref, short, role: CHAIR, team: "pass",
        eyebrow: `Pass · Bao · ${short}`,
        title: briefed ? "A meeting's brief is ready" : "A meeting is waiting",
        reason: briefed ? meetingLine(m) : m.pause?.reason || "The meeting is paused.", reasonFallback: false, plain: true, // the bridge's own words
        next: briefed ? "Read the brief and pick an option, or ask a follow-up." : m.pause?.next || "",
        rowText: `${short} · meeting`, preview: [], detailLabel: "", age: null,
        primary: briefed ? { action: "open", label: "Open the brief" } : { action: "resume", label: "Resume" },
      };
    });
}

/** den-meetings/01: the permission requests in a meeting's chat, oldest first, each with its state: asked, then allowed, denied or expired. */
export function permissionCards(events, now = Date.now()) {
  const list = Array.isArray(events) ? events : [];
  return list.filter((e) => e?.kind === "permission-request").map((e) => {
    const settled = list.find((x) => x?.kind === "permission-settled" && x.approvalId === e.approvalId);
    const left = Date.parse(e.expiresAt) - now;
    const state = settled ? settled.state : left > 0 ? "pending" : "expired";
    return { id: e.approvalId, eventId: e.id, actor: e.actor, tool: e.tool, summary: e.summary, expiresAt: e.expiresAt, state, secondsLeft: state === "pending" ? Math.ceil(left / 1000) : 0 };
  });
}
