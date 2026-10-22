// den-mvp/106: the branch names a ticket and its handoffs name ("branch den/fx-01-slug" in a State block's artifacts, or
// in prose), for the sweep that resolves work merged outside a delivery. Read-only; a name is looked up on the git host.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const BRANCH = /\bbranch(?:es)?[:\s]+`?([A-Za-z0-9][A-Za-z0-9._/-]{2,100})/gi;
const SKIP = new Set(["main", "master"]);
const text = (p) => readFile(p, "utf8").catch(() => "");

export const branchNames = (...texts) => [...new Set(texts.flatMap((t) => [...t.matchAll(BRANCH)].map((m) => m[1].replace(/[.,;:]+$/, ""))))].filter((b) => !SKIP.has(b) && /[/-]/.test(b));

/** ref "feature/NN-slug" -> the branch names found in its ticket and its handoffs, newest handoff first. */
export async function branchesOf(root, ref) {
  const [feature, ticket] = ref.split("/");
  const nn = /^(\d+)-/.exec(ticket ?? "")?.[1];
  if (!nn) return [];
  const dir = path.join(root, ".scratch", feature, "handoffs");
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith(".md") && n.startsWith(`${nn}-`)).sort().reverse();
  const texts = [];
  for (const n of names) texts.push(await text(path.join(dir, n)));
  texts.push(await text(path.join(root, ".scratch", feature, "issues", `${ticket}.md`)));
  return branchNames(...texts);
}
