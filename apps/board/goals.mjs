// den-mvp/61: the user's goals. `.scratch/goals.md` holds one markdown table whose rows are
// | `key` | name | why | done when |; every ticket names the goal it serves on a `**Goal:**` line.
// A bad row is reported in `errors`, never dropped silently, so the den can say what is wrong with the file.
import { readFileSync } from "node:fs";
import path from "node:path";

export const GOAL_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ROW_RE = /^\s*\|(.*)\|\s*$/;
const RULE_RE = /^\s*\|[\s:|-]+\|\s*$/;
export const GOALS_MAX_BYTES = 16 * 1024; // a short list; a larger file is refused rather than parsed

export function parseGoals(md) {
  const goals = [];
  const errors = [];
  const seen = new Set();
  let inTable = false;
  let header = false;
  for (const [i, line] of String(md).split(/\r?\n/).entries()) {
    const row = ROW_RE.exec(line);
    if (!row) {
      inTable = false;
      continue;
    }
    if (!inTable) {
      // The first row of a table is its header; the rule under it follows.
      inTable = true;
      header = true;
      continue;
    }
    if (header && RULE_RE.test(line)) {
      header = false;
      continue;
    }
    header = false;
    const cells = row[1].split("|").map((c) => c.trim());
    const at = `goals.md line ${i + 1}`;
    if (cells.length !== 4) {
      errors.push(`${at}: a goal row needs four cells (key, goal, why, done when), found ${cells.length}`);
      continue;
    }
    const key = cells[0].replace(/^`(.*)`$/, "$1");
    if (!GOAL_KEY_RE.test(key)) {
      errors.push(`${at}: ${JSON.stringify(key.slice(0, 40))} is not a goal key (lowercase letters, digits and -)`);
      continue;
    }
    if (seen.has(key)) {
      errors.push(`${at}: goal ${key} is listed more than once`);
      continue;
    }
    seen.add(key);
    goals.push({ key, name: cells[1], why: cells[2], doneWhen: cells[3] });
  }
  if (goals.length === 0 && errors.length === 0) errors.push("goals.md has no goals table");
  return { goals, errors };
}

const goalsPath = (root) => path.join(root, ".scratch", "goals.md");

// Sync so the bridge can check a board_file call when its ask arrives. The file is small and read per call.
export function readGoalsSync(root) {
  let md;
  try {
    md = readFileSync(goalsPath(root), "utf8");
  } catch {
    return { goals: [], errors: ["no goals file (.scratch/goals.md)"], missing: true };
  }
  if (Buffer.byteLength(md) > GOALS_MAX_BYTES) return { goals: [], errors: [`goals.md is over ${GOALS_MAX_BYTES} bytes`], missing: false };
  return { ...parseGoals(md), missing: false };
}

export async function readGoals(root) {
  return readGoalsSync(root);
}

// null when `goal` names a goal in the file; otherwise the reason, listing the valid keys.
export function goalProblem(root, goal) {
  const { goals, missing } = readGoalsSync(root);
  if (missing) return "this board has no goals file (.scratch/goals.md), so a ticket cannot name a goal";
  if (typeof goal !== "string" || !GOAL_KEY_RE.test(goal) || !goals.some((g) => g.key === goal)) {
    return `goal must be one of: ${goals.map((g) => g.key).join(", ")}`;
  }
  return null;
}
