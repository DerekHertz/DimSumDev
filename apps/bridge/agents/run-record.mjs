// den-v1 loop S4 (ADR 0016 amendment 11): what a run reports about itself, read as untrusted input. The same checks
// serve the host (a runtime's events) and the registry (lines of sessions.jsonl, which any agent can write): each value
// is kept only if it is a plain value in range, and nothing else on the object is copied. Pure: no fs, no clock.
import { COST_MAX_USD, MODEL_RE } from "./policy.mjs";

export const TIERS = ["input", "cacheWrite", "cacheRead", "output"];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A non-negative safe integer (tokens, milliseconds, turns), or null. */
export const readCount = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

/** Tokens by tier, all four present and whole, or null. */
export function readTiers(raw) {
  if (!isObject(raw)) return null;
  const tiers = {};
  for (const key of TIERS) {
    if (readCount(raw[key]) === null) return null;
    tiers[key] = raw[key];
  }
  return tiers;
}

/** A cost in US dollars as reported, or null. */
export const readCost = (v) => (typeof v === "number" && v >= 0 && v <= COST_MAX_USD ? v : null);

/** A model id, or null. */
export const readModel = (v) => (typeof v === "string" && MODEL_RE.test(v) ? v : null);
