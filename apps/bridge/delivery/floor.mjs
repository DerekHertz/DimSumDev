// team-and-den-ux/17 (ADR 0029 decision 3): the planner's floor. A pure function over a ticket's type and changed paths:
// the roles the ticket must have. It reads nothing and starts nothing; the runner computes it from the scripted check's
// changed paths and stores it on the job. The owner may add roles (delivery.start's `roles`), never drop one.
//
//   floor({ type, files, riskClean }) -> { roles, why }   roles: FLOOR_ROLES members in their fixed order; why: { [role]: reason }
//   gaps({ roles, evidence, sha })    -> the required roles with no counted result at `sha`, in the same order
import { isUiPath, isUserMergePath } from "./plan.mjs";

export const FLOOR_ROLES = ["technical-writer", "code-reviewer", "qa", "security", "user-verdict"];

// Path classes, as git prints paths. A path is docs only in a docs location AND with a doc file type, so a script, a config
// or an svg under docs/ is code. Anything that is neither docs nor instructions is code. The writer rule keys on location alone.
const DOCS_LOCATION = (p) => p === "CONTEXT.md" || /(^|\/)README[^/]*$/.test(p) || (p.startsWith("docs/") && !p.startsWith("docs/adr/"));
const DOC_TYPE = (p) => /\.(md|mdx|txt|png|jpe?g|gif|webp)$/i.test(p);
const DOCS = (p) => DOCS_LOCATION(p) && DOC_TYPE(p);
const INSTRUCTIONS = (p) => ["CLAUDE.md", "AGENTS.md"].includes(p) || [".claude/agents/", ".claude/skills/", ".agents/", ".codex/", "docs/adr/"].some((d) => p.startsWith(d));
export const isDocsPath = (file) => typeof file === "string" && DOCS(file);
export const isInstructionsPath = (file) => typeof file === "string" && !DOCS(file) && INSTRUCTIONS(file);
export const isCodePath = (file) => typeof file === "string" && !DOCS(file) && !INSTRUCTIONS(file);

const named = (paths) => `${paths[0]}${paths.length > 1 ? ` and ${paths.length - 1} more` : ""}`;

export function floor({ type, files, riskClean } = {}) {
  const paths = Array.isArray(files) ? files : [];
  const why = {};
  const add = (role, reason) => { why[role] = why[role] ? `${why[role]}; ${reason}` : reason; };
  const some = (pred) => paths.filter(pred);
  const [code, instructions, docs, userMerge, ui] = [some(isCodePath), some(isInstructionsPath), some((p) => typeof p === "string" && DOCS_LOCATION(p)), some(isUserMergePath), some(isUiPath)];

  if (code.length) { add("code-reviewer", `${named(code)} is code`); add("qa", `${named(code)} is code`); }
  else if (type !== "docs" && paths.length === 0) { add("code-reviewer", "a code ticket whose paths are not known yet"); add("qa", "a code ticket whose paths are not known yet"); }
  if (instructions.length) add("code-reviewer", `${named(instructions)} is agent instructions or an ADR`);
  if (riskClean === false) add("security", "the scripted risk check had a hit");
  if (userMerge.length) add("security", `${named(userMerge)} is a path the user merges`);
  if (ui.length) add("security", `${named(ui)} is UI code`);
  if (type === "docs") add("technical-writer", "a docs ticket");
  if (docs.length) add("technical-writer", `${named(docs)} is docs`);
  if (ui.length) add("technical-writer", `${named(ui)} changes what the UI shows`);
  if (type === "ui" || type === "asset") add("user-verdict", `a ${type} ticket`);
  if (ui.length) add("user-verdict", `${named(ui)} is UI code`);

  const roles = FLOOR_ROLES.filter((r) => why[r]);
  return { roles, why: Object.fromEntries(roles.map((r) => [r, why[r]])) };
}

// Where each role's result is kept on the job, and what counts as a result for the candidate.
const COUNTED = {
  "technical-writer": (ev, sha) => ev.writer?.sha === sha,
  "code-reviewer": (ev, sha) => ev.review?.sha === sha && ev.review.verdict === "pass",
  qa: (ev, sha) => ev.qa?.sha === sha && ev.qa.verdict === "pass",
  security: (ev, sha) => ev.security?.sha === sha && ev.security.verdict === "pass",
  "user-verdict": (ev, sha) => ev.verdict?.sha === sha && ev.verdict.ok === true,
};

export function gaps({ roles, evidence, sha }) {
  const ev = evidence ?? {};
  return FLOOR_ROLES.filter((r) => roles?.includes(r) && !COUNTED[r](ev, sha));
}
