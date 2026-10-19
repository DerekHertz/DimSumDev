// den-v1/09: the replay driver. Turns the recorded events (demo-fixture.mjs) into the snapshot and transcript buffers
// the den already reads, advancing with an injected clock. Pure and DOM-free; it makes no request.
//
// State at a time depends only on the clock: tick() works out which events have passed since start() and rebuilds the
// state from them, so a late tick catches up in one call. Stamps (cells[].lastEventAt, ticket holder.since, approval
// expiresAt, transcript at) are the event time rebased onto the pass's start, so they stay constant between events.
import { DEMO_FIXTURE } from "./demo-fixture.mjs";
import { appendTranscript } from "../state/transcript-buffer.mjs";

const APPROVAL_TTL_MS = 60000;
const ENDED = new Set(["done", "failed", "terminated"]);
const PREVIEW_CHARS = 40;

// The card line quotes the first 40 characters, like the live composer's status line.
function previewOf(text) {
  const chars = Array.from(String(text).replace(/\s+/g, " "));
  return `“${chars.slice(0, PREVIEW_CHARS).join("")}${chars.length > PREVIEW_CHARS ? "…" : ""}”`;
}

// Rebuild everything from the first `count` events. `base` is the wall-clock time of this pass's start.
function reduce(events, count, base, loops) {
  const stamp = (at) => new Date(base + at).toISOString();
  const tickets = new Map();
  const agents = new Map();
  const cells = new Map();
  const acks = new Map();
  let approvals = [];
  let transcripts = {};
  // Each line carries its number in that agent's transcript, as a bridge entry does, so a request's answer can
  // replace the waiting line (transcript-buffer.mjs).
  const counts = new Map();
  const waiting = new Map(); // agentId -> the permission line still pending
  const line = (agentId, entry, at) => {
    const id = (counts.get(agentId) ?? 0) + 1;
    counts.set(agentId, id);
    const full = { ...entry, id, at: stamp(at) };
    transcripts = appendTranscript(transcripts, agentId, full);
    return full;
  };
  const updateTicket = (agent, over) => {
    const ticket = tickets.get(agent.ref);
    if (ticket) tickets.set(agent.ref, { ...ticket, ...over });
  };

  for (const e of events.slice(0, count)) {
    const agent = agents.get(e.agentId);
    switch (e.type) {
      case "ticket":
        tickets.set(e.ref, {
          ref: e.ref, feature: e.ref.split("/")[0], title: e.title, type: "feature", status: e.status,
          ready: e.status === "ready-for-agent", holder: e.role ? { role: e.role, since: stamp(e.at) } : null,
          lastRole: null, gate: null, blockedBy: [],
        });
        break;
      case "agent": {
        agents.set(e.id, {
          id: e.id, ref: e.ref, role: e.role, state: e.state, tool: ENDED.has(e.state) ? null : agents.get(e.id)?.tool ?? null,
          capabilities: { send: true, approve: true },
          // den-v1 loop: a run that ended carries its reply and the cost the CLI reported, as a bridge row does.
          ...(e.reply !== undefined ? { reply: e.reply } : {}), ...(e.costUsd !== undefined ? { costUsd: e.costUsd } : {}),
        });
        const cell = cells.get(`${e.ref}|${e.role}`);
        cells.set(`${e.ref}|${e.role}`, { ref: e.ref, cellType: e.role, state: e.state, tool: cell?.tool ?? null, lastEventAt: stamp(e.at) });
        break;
      }
      case "tool": {
        if (!agent) break;
        const tool = { name: e.name, summary: e.summary };
        agents.set(agent.id, { ...agent, tool });
        cells.set(`${agent.ref}|${agent.role}`, { ref: agent.ref, cellType: agent.role, state: agent.state, tool, lastEventAt: stamp(e.at) });
        if (e.input !== undefined || e.result !== undefined) {
          line(agent.id, { kind: "tool", name: e.name, summary: e.summary, status: "done", input: e.input, result: e.result }, e.at);
        }
        break;
      }
      case "say":
        if (agent) line(agent.id, { kind: "message", role: e.who === "user" ? "user" : "agent", text: e.text }, e.at);
        break;
      case "ask":
        if (!agent) break;
        agents.set(agent.id, { ...agent, state: "needs-you" });
        updateTicket(agent, { status: "ready-for-human" });
        approvals = [...approvals, { id: `demo-approval-${agent.id}`, agentId: agent.id, status: "pending", tool: e.tool, expiresAt: stamp(e.at + APPROVAL_TTL_MS) }];
        waiting.set(agent.id, line(agent.id, { kind: "permission", name: e.tool, status: "pending" }, e.at));
        break;
      case "answer":
        if (!agent) break;
        agents.set(agent.id, { ...agent, state: "working" });
        updateTicket(agent, { status: "claimed" });
        approvals = approvals.filter((a) => a.agentId !== agent.id);
        if (waiting.has(agent.id)) transcripts = appendTranscript(transcripts, agent.id, { ...waiting.get(agent.id), status: "allowed" });
        waiting.delete(agent.id);
        break;
      case "ack":
        if (agent) acks.set(agent.id, { agentId: agent.id, kind: "received", label: "Message received", preview: previewOf(e.text) });
        break;
      default:
        break;
    }
  }

  const list = [...tickets.values()].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const snapshot = {
    schema: 1, seq: count, tickets: list,
    frontier: list.filter((t) => t.ready && !t.holder).map((t) => t.ref),
    usage: null, requests: [], sessions: [],
    agents: [...agents.values()], approvals, cells: [...cells.values()],
  };
  return { running: true, loops, index: count, snapshot, transcripts, acks };
}

/**
 * @param {{ fixture?: typeof DEMO_FIXTURE, now?: () => number }} [opts]
 * getState() -> { running, loops, snapshot, transcripts }; same object until an event passes or the loop restarts.
 */
export function createDemoReplay({ fixture = DEMO_FIXTURE, now = Date.now } = {}) {
  const { events, loopMs } = fixture;
  const listeners = new Set();
  let origin = 0;
  let running = false;
  let state = { ...reduce(events, 0, 0, 0), running: false };

  const at = (t) => {
    const elapsed = Math.max(0, t - origin);
    const loops = Math.floor(elapsed / loopMs);
    const within = elapsed - loops * loopMs;
    let count = 0;
    while (count < events.length && events[count].at <= within) count += 1;
    return { loops, count };
  };

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start() {
      origin = now();
      running = true;
      state = reduce(events, at(origin).count, origin, 0);
    },
    // Halts in place: the state object stays as it was, now marked not running. Nobody is told (the caller is leaving).
    stop() {
      running = false;
      state.running = false;
    },
    tick() {
      if (!running) return;
      const { loops, count } = at(now());
      if (loops === state.loops && count === state.index) return;
      state = reduce(events, count, origin + loops * loopMs, loops);
      for (const fn of [...listeners]) fn();
    },
    statusFor(card) {
      return (card?.agentId && state.acks.get(card.agentId)) || null;
    },
  };
}
