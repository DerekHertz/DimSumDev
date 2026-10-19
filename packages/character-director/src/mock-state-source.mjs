// A StateSource (ADR 0007, decision 3) satisfying the trimmed daemon event envelope
// (design-brief.md §10: agent_id, state, ts). The throwaway prototype (ticket 01) and the dev
// control in ticket 04 drive the scene with this; a later `daemonStateSource` adapter in
// `apps/ui` will satisfy the same shape once the daemon exists, and this mock becomes Demo mode's
// synthetic feed.

export function createMockStateSource() {
  const listeners = new Set();

  return {
    /** Registers a listener for agent-state-changed events. Returns an unsubscribe function. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Pushes a state change, as a dev control or a test would. */
    setState(agentId, state) {
      const event = { agent_id: agentId, state, ts: new Date().toISOString() };
      for (const listener of listeners) listener(event);
    },
  };
}
