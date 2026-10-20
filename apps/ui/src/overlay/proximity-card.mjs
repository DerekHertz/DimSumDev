import { DESK_THREAD } from './transcript-panel.mjs';
import { DESK_REF } from '../../../bridge/agents/policy.mjs';
import { sameResident, runtimeOf, boundAgentKey, RUNTIME_UNAVAILABLE, LIVE_AGENT_STATES } from '../shell/resident-inventory.mjs';

// den-v1/04: pure proximity selection. Positions and yaw use the walk core's world coordinates.
// The scene supplies {id, name, role, team, position:{x,z}, ref?, state?, tool?, agent?} per panda.
// den-v1 loop S1: the roles the bridge starts from the den (apps/bridge/agents/policy.mjs ROLES; a test keeps the two
// equal). T on a resident with one of these roles opens the task box. A scenery panda (dispatchable: false) never does,
// even when it shares a role's name: the Drummer stays scenery until team-and-den-ux/03 seats the release manager.
export const START_ROLES = ['product', 'architect', 'orchestrator', 'developer', 'scout', 'qa', 'security', 'designer', 'herald', 'code-reviewer', 'release-manager', 'sre', 'technical-writer'];

// The card's line for each state: the bridge's live states (policy.mjs LIVE_STATES) and the board-driven ones.
export const STATE_LABELS = {
  resident: 'Resident · no agent running', working: 'Working', 'needs-you': 'Needs your answer', waiting_on_user: 'Needs your answer',
  blocked: 'Blocked', throttled: 'Throttled', idle: 'Idle',
};
const ENDED = ['done', 'failed', 'terminated'];
const LAST = { done: 'done', failed: 'failed', terminated: 'stopped' };

// den-v1 loop S4: the cost badge. The figure is the runtime's own (the CLI's total_cost_usd), shown to two figures.
// "API-equiv" because a subscription run is not billed this amount: it is what the same tokens cost at API prices.
export function costLabel(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return null;
  const cents = usd * 100;
  const text = usd === 0 ? '0¢' : cents < 0.01 ? '<0.01¢' : cents >= 99.5 ? `≈$${usd.toFixed(2)}` : `≈${Number(cents.toPrecision(2))}¢`;
  return `${text} API-equiv`;
}

// den-v1 loop S4: which bridge agent a panda's card reads. A panda the board binds to a ticket (`ref`) reads that
// ticket's agent of its role, or none. Any other panda reads the newest agent of its role that no bound panda shows:
// a den-started agent runs before it claims its ticket, and its result outlives the claim. Live comes before ended.
export function agentFor(identity = {}, agents, boundRefs = new Set()) {
  if (!Array.isArray(agents)) return null;
  const {ref}=identity;
  const mine = (row) => !!row?.id && sameResident(row,identity) && (identity.agentId ? row.id===identity.agentId : ref ? row.ref === ref : !boundRefs.has(boundAgentKey(row))&&!boundRefs.has(row.ref));
  return agents.findLast((row) => mine(row) && LIVE_AGENT_STATES.includes(row.state)) ?? agents.findLast(mine) ?? null;
}

export function cardFor(scenePandas, approvals, viewer) {
  if (!viewer || ![viewer.x, viewer.z, viewer.yaw].every(Number.isFinite)) return null;
  let nearest = null, distance = Infinity;
  for (const panda of scenePandas) {
    const dx = panda.position?.x - viewer.x, dz = panda.position?.z - viewer.z;
    const d = Math.hypot(dx, dz);
    if (!Number.isFinite(d) || d > 3.25 || d >= distance) continue;
    const facing = d === 0 ? 1 : (-Math.sin(viewer.yaw) * dx - Math.cos(viewer.yaw) * dz) / d;
    if (facing < Math.cos(Math.PI / 4)) continue;
    nearest = panda; distance = d;
  }
  if (!nearest) return null;
  return { ...cardOf(nearest, approvals), distance };
}

// Overview (live den run, 2026-10-10): the card of the panda the user clicked, the same card walking up to it gives.
export function pickedCard(scenePandas, approvals, id) {
  const panda = id == null || !Array.isArray(scenePandas) ? null : scenePandas.find(p => p?.id === id);
  return panda ? cardOf(panda, approvals ?? []) : null;
}

function cardOf(nearest, approvals) {
  const runtime=runtimeOf(nearest),unknownState=nearest.agent?.id&&!LIVE_AGENT_STATES.includes(nearest.agent.state)&&!ENDED.includes(nearest.agent.state),unavailable=runtime==='codex'?RUNTIME_UNAVAILABLE:runtime===null?'Runtime identity unavailable.':unknownState?'Agent state unavailable.':null;
  // A reported Codex run can be shown, but legacy Claude endpoints cannot act on it.
  if(unavailable){const actions=Object.fromEntries(['Q','E','R','T'].map(key=>[key,{enabled:false,reason:unavailable}]));return {...nearest,runtime,agentId:null,threadId:null,start:false,approval:null,actions,last:null};}
  const agent = nearest.agent?.id && LIVE_AGENT_STATES.includes(nearest.agent.state) ? nearest.agent : null;
  const past = nearest.agent?.id && ENDED.includes(nearest.agent.state) ? nearest.agent : null; // den-v1 loop S4: the newest agent has ended
  const cost = past ? costLabel(past.costUsd) : null;
  const approval = agent ? approvals.find(a => a.agentId === agent.id && (a.status ?? a.state ?? 'pending') === 'pending' && !a.decision) ?? null : null;
  const action = reason => ({ enabled: !reason, reason });
  const state = agent?.state ?? (nearest.agent ? 'resident' : nearest.state ?? 'resident');
  const inactive = agent ? null : state === 'resident' ? 'no agent running' : 'agent controls unavailable';
  const permissionReason = inactive || (agent.capabilities?.approve !== true ? 'runtime cannot answer permissions' : !approval ? 'no pending permission request' : null);
  const start = !agent && state === 'resident' && START_ROLES.includes(nearest.role) && nearest.dispatchable !== false;
  // den-mvp/30: Bao's thread always opens. With no live run it is the desk's: its last desk run, else the empty desk. An
  // ended run on another ticket (a meeting, an old task) is not followed up from here; its worktree may be gone.
  const desk = nearest.role === 'orchestrator' && runtime === 'claude';
  const actions = {
    // The QERT row (live den run, 2026-10-10): A and D walk, so no action sits on them.
    Q: action(permissionReason), E: action(permissionReason),
    // den-mvp outcome 2: the thread also opens on the newest run that has ended, so it can be read and followed up.
    R: action(past || desk ? null : inactive),
    T: action(start ? null : inactive || (agent.capabilities?.send !== true ? 'runtime cannot send messages' : null)),
  };
  return {
    id: nearest.id, name: nearest.name, role: nearest.role, team: nearest.team, runtime, projectId:nearest.projectId,
    agentId: agent?.id ?? null, threadId: agent?.id ?? (desk ? (past?.ref === DESK_REF ? past.id : DESK_THREAD) : past?.id ?? null), ref: agent?.ref ?? nearest.ref ?? null, start,
    state, tool: agent ? agent.tool ?? null : nearest.agent ? null : nearest.tool ?? null, approval, actions,
    last: past ? {
      state: past.state, ref: typeof past.ref === 'string' ? past.ref : null, label: `Last task: ${LAST[past.state]}`,
      reply: typeof past.reply === 'string' && past.reply ? past.reply : null,
      cost, costExact: cost ? `$${past.costUsd.toFixed(6)} reported by the CLI` : null,
    } : null,
  };
}

// den-v1/06: the card's pending line. The card follows the snapshot, so the line goes when the approval leaves pending.
export function pendingLine(card) {
  return card?.approval ? `Waiting on you · ${card.approval.tool ?? 'a tool'}` : null;
}
