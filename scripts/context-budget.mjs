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

// team-and-den-ux/57: the chief of staff (Bao, Jiao) replaced the orchestrator. Every check for the
// executive session goes through here; `orchestrator` stays an alias for sessions started before the rename.
// Its budget is still read from the config's `orchestrator` key.
export const CHIEF_OF_STAFF = "chief-of-staff";
// The `den` plugin namespaces its roles (agent_type "den:qa"); the role is the part after it.
export const bareRole = (agentType) => (typeof agentType === "string" ? agentType.replace(/^den:/, "") : agentType);

export function isChiefOfStaff(agentType) {
  const role = bareRole(agentType);
  return role === CHIEF_OF_STAFF || role === "orchestrator";
}

export function budgetFor(agentType) {
  const role = bareRole(agentType);
  const cfg = loadConfig();
  if (!cfg || !valid(cfg.default)) return { ...(isChiefOfStaff(role) ? BUILT_IN.orchestrator : BUILT_IN.agent) };
  const fallback = pick(cfg.default);
  let entry;
  // Per-role entries live under `roles` (`cells` before ADR 0028; still read).
  const perRole = cfg.roles ?? cfg.cells;
  if (isChiefOfStaff(role)) entry = cfg.orchestrator;
  else if (typeof role === "string" && perRole && typeof perRole === "object" && Object.hasOwn(perRole, role)) entry = perRole[role];
  return valid(entry) ? pick(entry) : fallback;
}
