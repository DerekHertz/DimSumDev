import { compareRefs } from "../../../../packages/board-refs/src/compare-refs.mjs";
import { DISPATCHABLE_ROLES, runtimeOf, projectOf, residentKey, sameResident, boundAgentKey, LIVE_AGENT_STATES } from '../shell/resident-inventory.mjs';

// den-layout/03 (absorbs den-v1/02): the pure adapter from a live-store snapshot to the actor state
// PR #162's role pandas take at createReviewAgents(...).applyLive. No three, React or DOM.
//
// A live agent is a ticket with a holder lock whose cells[] entry (when the bridge reports one) is not
// ended, or an agent the bridge itself runs (agents[]), claimed or not. Only the 9 cell types bind; the scenery roles (release-manager, knowledge-keeper, docs-writer,
// stem-cub) stay simulated.

export const TOOL_BUBBLE_TTL_MS = 8000;

export const LIVE_ROLES = DISPATCHABLE_ROLES;
const BOUND = new Set(LIVE_ROLES);
const ACTIVE = new Set(LIVE_AGENT_STATES);

// The cell row for this ticket and role: the one with the newest event wins.
function cellFor(cells, ref, identity) {
  let best = null;
  for (const c of cells) {
    if (c?.ref !== ref || !sameResident({...c,role:c.cellType||identity.role},identity)) continue;
    if (!best || Date.parse(c.lastEventAt) > Date.parse(best.lastEventAt)) best = c;
  }
  return best;
}

function stateOf(t) {
  if (t.gate || t.status === "ready-for-human") return "needs-you";
  if (t.status === "blocked") return "blocked";
  return "working";
}
const ACTIVITY = { working: "Working", "needs-you": "Needs your answer", blocked: "Blocked", idle:'Idle', throttled:'Throttled' };

function bubbleOf(cell, now) {
  const tool = cell?.tool;
  if (!tool?.name) return "";
  const at = Date.parse(cell.lastEventAt);
  if (Number.isFinite(at) && now - at > TOOL_BUBBLE_TTL_MS) return "";
  return tool.summary ? `${tool.name}: ${tool.summary}` : tool.name;
}

// den-v1 loop (live den run, 2026-10-10): the agent the bridge runs for this ticket and role, if it has not ended.
// It comes from snapshot.agents[] (the steering host), not from the board, so it exists before any claim.
function agentFor(agents, ref, identity) {
  return agents.findLast((a) => a?.id && a.ref === ref && sameResident(a,identity) && ACTIVE.has(a.state)) ?? null;
}

/**
 * A live agent is a ticket with a holder lock, or an agent the bridge is running (claimed or not: a den-started
 * agent runs, and may wait on the user, before it claims). A held permission request shows as needs-you.
 * @param {{tickets?: object[], cells?: object[], agents?: object[]} | null} snapshot
 * @param {{now?: number}} [opts]
 * @returns {{role: string, ref: string, split: boolean, state: string, activity: string, bubble: string, task: string}[]}
 */
export function liveActorsFromSnapshot(snapshot, { now = Date.now(), projectId } = {}) {
  const tickets = snapshot?.tickets ?? [];
  const cells = snapshot?.cells ?? [];
  const agents = Array.isArray(snapshot?.agents) ? snapshot.agents : [];
  const bound = [];
  const shown = new Set();
  const inProject = row => projectOf(row) !== undefined && projectOf(row) === (projectId ?? null);
  const keyOf = (row,ref) => boundAgentKey({...row,ref});
  for (const t of tickets) {
    const role = t.holder?.cell;
    if (!role || !BOUND.has(role)) continue;
    const identity={role,runtime:runtimeOf(t.holder),projectId:t.projectId};
    if(!identity.runtime||!inProject(identity))continue;
    const latestCell = cellFor(cells, t.ref, identity),cell=ACTIVE.has(latestCell?.state)?latestCell:null,agent=agentFor(agents,t.ref,identity);
    if(!cell&&!agent)continue;
    bound.push({ ...identity, t, cell, agent });
    shown.add(keyOf(identity,t.ref));
  }
  for (const agent of agents) {
    if (!agent?.id || typeof agent.ref !== "string" || !BOUND.has(agent.role) || !runtimeOf(agent) || !inProject(agent) || !ACTIVE.has(agent.state)) continue;
    const key = keyOf(agent,agent.ref);
    if (shown.has(key)) continue;
    shown.add(key);
    bound.push({ role: agent.role, runtime:runtimeOf(agent), projectId:agent.projectId, t: tickets.find((t) => t.ref === agent.ref && inProject(t)) ?? { ref: agent.ref }, cell: null, agent: agentFor(agents, agent.ref, agent), unclaimed: true });
  }
  bound.sort((a, b) => compareRefs(a.t.ref, b.t.ref));
  const seen = new Set();
  return bound.map(({ role, runtime, projectId, t, cell, agent, unclaimed }) => {
    const key=residentKey(role,runtime),split = seen.has(key);
    seen.add(key);
    // An unclaimed ticket's own status says nothing about this agent (it is ready-for-agent until the claim).
    const processState=agent?.state??cell?.state;
    const state = processState === "waiting_on_user" ? "needs-you" : processState !== 'working' ? processState : unclaimed ? "working" : stateOf(t);
    return {
      role,
      runtime, projectId, agentId:agent?.id ?? null,
      ref: t.ref,
      split,
      state,
      activity: ACTIVITY[state],
      bubble: bubbleOf(cell, now) || bubbleOf(agent, now),
      task: t.title ? `${t.ref} · ${t.title}` : t.ref,
    };
  });
}
