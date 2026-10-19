// organism-infra/226 (ADR 0016 amendment 14, ADR 0011 decision 3): the one capacity rule, pure.
// The steering host's admission and the snapshot's `capacity` key both ask it, so a Run button and the host cannot disagree.
//   capacity({ liveRefs, lockedRefs, max, cap }) -> { max, cap, load, live, room, refs }
//   liveRefs    refs of the host's reserved or running agents
//   lockedRefs  refs of tickets that hold a claim lock (agents the host did not start, and host agents that claimed their own)
//   max         max_concurrent_agents: load (live agents plus locks) may not pass it
//   cap         the session cap: live host agents may not pass it (locks are not sessions)
// A ref that is both live and locked is one slot, and is reported as "live".
export function capacity({ liveRefs = [], lockedRefs = [], max, cap }) {
  const live = new Set(liveRefs);
  const refs = [...live].map((ref) => ({ ref, kind: "live" }));
  for (const ref of new Set(lockedRefs)) if (!live.has(ref)) refs.push({ ref, kind: "lock" });
  const load = refs.length;
  return { max, cap, load, live: live.size, room: Math.max(0, Math.min(max - load, cap - live.size)), refs };
}
