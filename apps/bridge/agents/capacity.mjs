// organism-infra/226 (ADR 0016 amendment 14), cut down by portable-den/10: who is running, pure. There is no count limit.
// The snapshot's `capacity` key and the router both read it, so a Run button and the host cannot disagree.
//   capacity({ liveRefs, lockedRefs }) -> { load, live, refs }
//   liveRefs    refs of the host's reserved or running agents
//   lockedRefs  refs of tickets that hold a claim lock (agents the host did not start, and host agents that claimed their own)
// A ref that is both live and locked is one entry, and is reported as "live".
export function capacity({ liveRefs = [], lockedRefs = [] }) {
  const live = new Set(liveRefs);
  const refs = [...live].map((ref) => ({ ref, kind: "live" }));
  for (const ref of new Set(lockedRefs)) if (!live.has(ref)) refs.push({ ref, kind: "lock" });
  return { load: refs.length, live: live.size, refs };
}
