// den-mvp/106: the branches a ticket's own handoffs record, for the sweep that resolves work merged outside a delivery.
// Only a handoff's State `artifacts` lines count ("branch den/fx/01-slug-ab12"): that is the agent's record of what it made.
// The ticket's prose and a handoff's report also name other tickets' branches ("built on branch X"), and a merged PR for
// one of those must never close this ticket. Read-only; a name is looked up on the git host.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const SKIP = new Set(["main", "master"]);
const STATE = /```json\s*\n([\s\S]*?)\n```/;

/** The branch names in one handoff's State block artifacts. A file with no readable State block names none. */
export function branchNames(handoff) {
  let state;
  try {
    state = JSON.parse(STATE.exec(handoff)?.[1] ?? "null");
  } catch {
    return [];
  }
  const artifacts = Array.isArray(state?.artifacts) ? state.artifacts : [];
  const names = artifacts.map((a) => /^\s*branch\s+`?([A-Za-z0-9][A-Za-z0-9._/-]{2,100})/i.exec(String(a))?.[1].replace(/[.,;:]+$/, ""));
  return names.filter((b) => b && !SKIP.has(b) && /[/-]/.test(b));
}

/** ref "feature/NN-slug" -> the branch names its handoffs record, newest handoff first. */
export async function branchesOf(root, ref) {
  const [feature, ticket] = ref.split("/");
  const nn = /^(\d+)-/.exec(ticket ?? "")?.[1];
  if (!nn) return [];
  const dir = path.join(root, ".scratch", feature, "handoffs");
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith(".md") && n.startsWith(`${nn}-`)).sort().reverse();
  const found = [];
  for (const n of names) found.push(...branchNames(await readFile(path.join(dir, n), "utf8").catch(() => "")));
  return [...new Set(found)];
}
