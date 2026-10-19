// den-v1/09 (qa specify): shared helpers for the Demo mode tests. Not a test file (the npm test glob skips it).
import { liveActorsFromSnapshot } from "../review/live-actors.mjs";
import { cardFor } from "../overlay/proximity-card.mjs";

export const START = Date.UTC(2026, 9, 8, 12, 0, 0);
export const STEP = 100;

/** An injected clock: `now()` for the code under test, `at(ms)` to jump to START + ms. */
export function clock() {
  let t = START;
  return { now: () => t, at: (ms) => { t = START + ms; }, advance: (ms) => { t += ms; } };
}

/** One card per live agent in the snapshot, as walking up to that agent's panda would show it. */
export function cardsOf(snapshot) {
  const viewer = { x: 0, z: 0, yaw: Math.PI / 2 };
  return (snapshot?.agents ?? []).map((agent) => cardFor(
    [{ id: agent.id, name: agent.role, role: agent.role, team: "Den", position: { x: -2, z: 0 }, ref: agent.ref, state: agent.state, agent }],
    snapshot.approvals ?? [], viewer,
  )).filter(Boolean);
}

/** Everything a loop restart must reproduce, with wall-clock stamps (rebased onto the clock each loop) left out. */
export function projection(state, nowMs) {
  const snap = state.snapshot;
  return {
    actors: liveActorsFromSnapshot(snap, { now: nowMs }).map(({ role, ref, split, state: s }) => ({ role, ref, split, state: s })),
    agents: (snap.agents ?? []).map(({ id, role, ref, state: s }) => ({ id, role, ref, state: s })),
    approvals: (snap.approvals ?? []).map(({ agentId, status, tool }) => ({ agentId, status, tool })),
    transcripts: Object.fromEntries(Object.entries(state.transcripts ?? {}).map(([id, b]) => [id, {
      dropped: b.dropped, entries: b.entries.map(({ at, ...rest }) => rest),
    }])),
  };
}
