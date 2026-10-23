import { compareRefs } from "../../../../packages/board-refs/src/compare-refs.mjs";

// Client reducer for SSE `change` frames (ADR 0011 decision 5). Pure: never mutates its inputs.
// Returns null when the caller must refetch GET /state (no baseline, or seq is not state.seq + 1).
export function applyEvent(state, event) {
  if (!state || !event || event.seq !== state.seq + 1) return null;
  const next = { ...state, seq: event.seq };
  switch (event.type) {
    case "agent": {
      if (!event.agent?.id) return null; // An incomplete agent event requires a fresh snapshot.
      const agents = state.agents ?? [];
      const found = agents.some(agent => agent.id === event.agent.id);
      next.agents = found ? agents.map(agent => agent.id === event.agent.id ? event.agent : agent) : [...agents, event.agent];
      break;
    }
    // den-v1 loop (live den runs, 2026-10-10): a permission request and each change to it. Without this case a
    // request raised after the page loaded never reached the card, Needs you or the review. A settled row is kept
    // with its state, as the bridge's own snapshot keeps it; readers ask for "pending".
    case "approval": {
      if (!event.approval?.id) return null; // An incomplete approval event requires a fresh snapshot.
      const approvals = Array.isArray(state.approvals) ? state.approvals : [];
      const found = approvals.some((a) => a.id === event.approval.id);
      next.approvals = found ? approvals.map((a) => (a.id === event.approval.id ? event.approval : a)) : [...approvals, event.approval];
      break;
    }
    // den-mvp outcome 3: a delivery job and each change to it. An ended one is kept with its state, as the snapshot keeps it.
    case "delivery": {
      if (!event.delivery?.id) return null;
      const deliveries = Array.isArray(state.deliveries) ? state.deliveries : [];
      const found = deliveries.some((d) => d.id === event.delivery.id);
      next.deliveries = found ? deliveries.map((d) => (d.id === event.delivery.id ? event.delivery : d)) : [...deliveries, event.delivery];
      break;
    }
    // den-mvp outcome 4: a meeting and each change to it, kept as the snapshot keeps it.
    case "meeting": {
      if (!event.meeting?.id) return null;
      const meetings = Array.isArray(state.meetings) ? state.meetings : [];
      const found = meetings.some((m) => m.id === event.meeting.id);
      next.meetings = found ? meetings.map((m) => (m.id === event.meeting.id ? event.meeting : m)) : [...meetings, event.meeting];
      break;
    }
    // den-mvp/29: the CI watch's red pull requests, whole each time.
    case "ci":
      next.ci = event.ci ?? null;
      break;
    // den-mvp/34: the local runs of ci.yml's checks: { recent, running }.
    case "checks":
      next.checks = event.checks ?? null;
      break;
    // den-mvp/12 (ADR 0026 decision 8): the den's own build after a switch (a go-live or a roll back), or null.
    case "build":
      next.build = event.build ?? null;
      break;
    // hardening/16: the den's Claude accounts after the user's switch: { active, accounts }.
    case "accounts":
      next.accounts = event.accounts ?? null;
      break;
    // den-mvp/45: Bao's release draft (or null once approved or declined).
    case "release":
      next.release = event.release ?? null;
      break;
    // den-mvp outcome 4: something the library card shows has changed. The frame carries no data; the card reads GET /library.
    case "library":
      next.libraryRev = (state.libraryRev ?? 0) + 1;
      break;
    case "ticket": {
      const rest = state.tickets.filter((t) => t.ref !== event.ref);
      if (event.ticket) rest.push(event.ticket);
      rest.sort((a, b) => compareRefs(a.ref, b.ref));
      next.tickets = rest;
      break;
    }
    case "frontier":
      next.frontier = event.refs;
      break;
    case "usage":
      next.usage = event.usage;
      break;
    case "sessions":
      next.sessions = event.sessions;
      break;
    case "requests":
      next.requests = event.requests;
      break;
    default:
      break; // metrics-changed and unknown types: data untouched, seq advanced
  }
  return next;
}
