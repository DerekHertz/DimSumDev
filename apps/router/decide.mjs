// den-mvp/88 (ADR 0027 decisions 3, 5-8): what the router does next, as a pure function of what it read. No process, clock
// or network here; router.mjs reads, calls this, and acts. The contract is in decide.test.mjs's header.
import { field, pathsOf, unblocked } from "../../scripts/batch-groups.mjs";

export const STOP_AT_PERCENT = 90;
export const BRIDGE_DOWN_MS = 10 * 60_000;
// The pauses the router may resume (decision 8); every other pause is the user's.
const RESUMABLE = new Set(["bridge-restart", "usage", "no-room"]);

// "fx/01-slug" and "fx/01" both become "fx/1", so order refs and board refs compare.
const shortOf = (ref) => {
  const m = /^([^/]+)\/(\d+)/.exec(String(ref));
  return m ? `${m[1]}/${Number(m[2])}` : String(ref);
};

function readingProblem(usage) {
  if (!usage || typeof usage !== "object") return "no usage reading";
  if (usage.error) return `the live usage reading failed: ${usage.error}`;
  if (usage.unknown || usage.stale || usage.source !== "live") return "the usage reading is not live";
  if (!Number.isFinite(usage["5-hour"]?.percent)) return "the usage reading has no 5-hour percent";
  return null;
}

export function decide({ order, tickets = [], state, usage, stops: known = [], downForMs = 0 }) {
  const seen = new Set(known);
  const stops = [];
  const actions = [];
  const stop = (s) => void (seen.has(s.key) || (seen.add(s.key), stops.push(s)));
  const done = (waiting = null) => ({ actions, stops, waiting });

  if (!state) {
    if (downForMs >= BRIDGE_DOWN_MS) stop({ key: "bridge-down", kind: "bridge-down", text: `the bridge has not answered for ${Math.round(downForMs / 60_000)} minutes` });
    return done("the bridge does not answer");
  }
  const deliveries = Array.isArray(state.deliveries) ? state.deliveries : [];
  const paused = deliveries.filter((d) => d?.state === "paused");
  // A pause key names its occurrence, so a later pause of the same delivery is a new stop.
  for (const d of paused) {
    const kind = d.pause?.kind ?? "unknown";
    if (!RESUMABLE.has(kind)) stop({ key: `pause:${d.id}:${kind}:${d.updatedAt ?? ""}`, kind, ref: d.ref, text: `${d.ref} is paused (${kind}) and waits for you` });
  }
  if (state.update?.draining) return done("the bridge is draining for an update");
  const problem = readingProblem(usage);
  if (problem) {
    stop({ key: "usage-reading", kind: "usage-reading", text: `${problem}; the router starts and resumes nothing until a live reading works` });
    return done(problem);
  }
  const percent = usage["5-hour"].percent;
  if (percent >= STOP_AT_PERCENT) return done(`5-hour usage is at ${percent}%`);

  let room = Number.isInteger(state.capacity?.room) ? state.capacity.room : 0;
  for (const d of paused) {
    if (room > 0 && RESUMABLE.has(d.pause?.kind)) {
      actions.push({ type: "resume", id: d.id });
      room -= 1;
    }
  }

  const byRef = new Map(tickets.map((t) => [t.ref, t]));
  const status = new Map(tickets.map((t) => [t.ref, field(t.text, "Status")]));
  const byNumber = new Map(tickets.map((t) => [shortOf(t.ref), t.ref]));
  const apart = new Map();
  for (const e of order?.entries ?? []) for (const other of e.notBeside) {
    const [a, b] = [shortOf(e.ref), shortOf(other)];
    for (const [x, y] of [[a, b], [b, a]]) apart.set(x, (apart.get(x) ?? new Set()).add(y));
  }
  const delivered = new Set(deliveries.map((d) => d?.ref));
  const claimed = new Set((state.capacity?.refs ?? []).map((r) => r?.ref));
  // What holds files now: a running or paused delivery (its pull request is open) and any claim. Unknown files hold everything.
  const holders = [...new Set([...deliveries.filter((d) => d?.state === "running" || d?.state === "paused").map((d) => d.ref), ...claimed])]
    .map((ref) => ({ short: shortOf(ref), paths: byRef.has(ref) ? pathsOf(byRef.get(ref).text) : [] }));

  for (const e of order?.entries ?? []) {
    if (room <= 0) break;
    const short = shortOf(e.ref);
    const ticket = byRef.get(byNumber.get(short));
    if (!ticket || ticket.locked || delivered.has(ticket.ref) || claimed.has(ticket.ref)) continue;
    if (status.get(ticket.ref) !== "ready-for-agent" || !unblocked(ticket, status, byNumber)) continue;
    const paths = pathsOf(ticket.text);
    const clash = holders.some((h) => !h.paths.length || !paths.length || apart.get(short)?.has(h.short) || h.paths.some((p) => paths.includes(p)));
    if (clash) continue;
    actions.push({ type: "start", ref: ticket.ref });
    holders.push({ short, paths });
    room -= 1;
  }
  return done(actions.length ? null : room > 0 ? "no ticket in the order can start now" : "no free slot");
}
