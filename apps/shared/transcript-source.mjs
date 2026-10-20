// A durable locator is complete or unavailable; never fill a missing tuple from a nearby run.
export function sourceKey(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const { project, runtime, role, runId, entryId } = source;
  if (![project, runtime, role, runId].every(v => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(v))) return null;
  if (!Number.isSafeInteger(entryId) || entryId < 0) return null;
  return JSON.stringify([project, runtime, role, runId, entryId]);
}
export const sameSource = (a, b) => sourceKey(a) !== null && sourceKey(a) === sourceKey(b);
