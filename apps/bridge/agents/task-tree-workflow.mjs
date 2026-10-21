// Fixed-contract evidence and phase selection. Reports are data from a trusted fresh
// execution role; they never grant publication, a model override or a new child.
import { hasSecret } from "../../../scripts/exposure.mjs";

export const REVIEW_PHASES = Object.freeze({ "code-review": "code-reviewer", qa: "qa", security: "security", "writer-review": "technical-writer" });
export const phaseRole = (node, phase) => REVIEW_PHASES[phase] ?? node.role;
export const isReviewPhase = (phase) => Object.hasOwn(REVIEW_PHASES, phase);
export const phaseOfRole = (role) => Object.keys(REVIEW_PHASES).find((phase) => REVIEW_PHASES[phase] === role);
export const freshWorkflow = () => ({ version: 1, status: "planned", attempts: [], pendingPhase: null, waitingChildren: [], integratedChildren: [], receipt: null, reviews: {}, completion: null, acceptance: null });
const text = (value) => typeof value === "string" && value.trim() !== "" && Buffer.byteLength(value) <= 2000 && !hasSecret(value);
const exact = (object, keys) => object && typeof object === "object" && !Array.isArray(object) && Object.keys(object).every((key) => keys.includes(key));

export function readTreeEvidence(contract, input, { review = false, candidate, guardHits = [] } = {}) {
  const keys = review ? ["candidate", "verdict", "criteria", "checks", "findings", "guardVerdicts"] : ["unused", "criteria", "checks"];
  if (!exact(input, keys) || Buffer.byteLength(JSON.stringify(input)) > 16000) throw new Error("the evidence has an invalid or oversized shape");
  if (review && (input.candidate !== candidate || !["pass", "bounce"].includes(input.verdict))) throw new Error("the verdict must name the exact frozen candidate");
  const criteria = contract?.acceptanceCriteria;
  const commands = contract?.verificationCommands;
  if (!Array.isArray(criteria) || criteria.length === 0 || !Array.isArray(commands)) throw new Error("the approved contract has no acceptance criteria or checks");
  if (!Array.isArray(input.criteria) || input.criteria.length !== criteria.length || new Set(input.criteria.map((row) => row?.criterion)).size !== criteria.length || input.criteria.some((row) => !exact(row, ["criterion", "evidence"]) || !criteria.includes(row.criterion) || !text(row.evidence))) throw new Error("each exact approved criterion needs its own bounded evidence");
  if (!Array.isArray(input.checks) || input.checks.length !== commands.length || new Set(input.checks.map((row) => row?.command)).size !== commands.length || input.checks.some((row) => !exact(row, ["command", "passed", "evidence"]) || !commands.includes(row.command) || typeof row.passed !== "boolean" || !text(row.evidence))) throw new Error("each exact approved verification command needs its result and evidence");
  const findings = input.findings ?? [];
  if (!Array.isArray(findings) || findings.length > 30 || findings.some((finding) => !text(finding))) throw new Error("review findings must be bounded non-secret text");
  const guardVerdicts = input.guardVerdicts ?? [];
  if (!Array.isArray(guardVerdicts) || guardVerdicts.length !== guardHits.length || new Set(guardVerdicts.map((row) => row?.hit)).size !== guardHits.length || guardVerdicts.some((row) => !exact(row, ["hit", "verdict", "reason"]) || !guardHits.includes(row.hit) || !["accept", "bounce"].includes(row.verdict) || !text(row.reason))) throw new Error("every test-guard hit needs an exact verdict and reason");
  if (!review && input.unused !== undefined && (!Array.isArray(input.unused) || input.unused.length > 20 || input.unused.some((id) => typeof id !== "string"))) throw new Error("unused nodes must be a bounded list of planned node identities");
  return structuredClone({ ...(review ? { candidate, verdict: input.verdict, findings, guardVerdicts } : { unused: input.unused ?? [] }), criteria: input.criteria, checks: input.checks });
}

export function reviewPassed(report) {
  return report?.verdict === "pass" && report.checks.every((row) => row.passed === true) && report.guardVerdicts.every((row) => row.verdict === "accept");
}
