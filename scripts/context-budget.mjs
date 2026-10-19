// The context budget thresholds (organism-infra/145): one config value, read by the 162 hook
// (scripts/hooks/context-budget.mjs), agent-start (orchestrator key) and context.mjs --role.
// budgetFor(role) -> {warn, stop} in tokens. The file is scripts/context-budget.json, or the file named
// by CONTEXT_BUDGET_CONFIG (the test seam), read on every call.
//   unknown or missing role                                  -> the config's `default`
//   invalid entry (non-numbers, warn >= stop, missing field) -> the config's `default`
//   missing, unparseable or invalid-default file             -> built-in: the orchestrator 70000 / 80000, every other role 100000 / 150000
// (organism-infra/220: the built-in mirrors the shipped scripts/context-budget.json.)
// It never throws, so every caller still fails open.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED = path.join(HERE, "context-budget.json");

export const BUILT_IN = Object.freeze({
  agent: Object.freeze({ warn: 100_000, stop: 150_000 }),
  orchestrator: Object.freeze({ warn: 70_000, stop: 80_000 }),
});

const valid = (e) => Boolean(e) && typeof e.warn === "number" && typeof e.stop === "number" && Number.isFinite(e.warn) && Number.isFinite(e.stop) && e.warn < e.stop;
const pick = (e) => ({ warn: e.warn, stop: e.stop });

function loadConfig() {
  try {
    const c = JSON.parse(readFileSync(process.env.CONTEXT_BUDGET_CONFIG || SHIPPED, "utf8"));
    return c && typeof c === "object" ? c : null;
  } catch {
    return null;
  }
}

export function budgetFor(role) {
  const cfg = loadConfig();
  if (!cfg || !valid(cfg.default)) return { ...(role === "orchestrator" ? BUILT_IN.orchestrator : BUILT_IN.agent) };
  const fallback = pick(cfg.default);
  let entry;
  // Per-role entries live under `roles` (`cells` before ADR 0028; still read).
  const perRole = cfg.roles ?? cfg.cells;
  if (role === "orchestrator") entry = cfg.orchestrator;
  else if (typeof role === "string" && perRole && typeof perRole === "object" && Object.hasOwn(perRole, role)) entry = perRole[role];
  return valid(entry) ? pick(entry) : fallback;
}
