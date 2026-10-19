// Test-only helper for organism-infra/212 (queue script and mod). Not a test file (no *.test.mjs
// suffix), so `npm test` skips it. Builds a disposable board root whose tickets carry the header
// lines the real board uses: a `# NN: Title` heading, Priority, Blocked by, Status. A held claim is
// a `<slug>.lock` file whose content is the real lock line: `<cell> <iso time>[ <mode>][ <prior status>]`.
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function boardRoot() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "queue-")));
  mkdirSync(path.join(root, ".scratch"), { recursive: true });
  return root;
}

// ticket(root, "alpha/04-slug", { title, status, blockedBy, priority, lock })
//   title    -> the heading text after `# 04: ` (default: the slug)
//   priority -> "P1" etc.; omitted means the ticket has no Priority line
//   lock     -> the lock file's content, e.g. "qa 2026-10-09T01:25:07.351Z specify ready-for-agent"
//   headers  -> extra header lines written after Blocked by, e.g. ["**P0-reason:** outage"] (queue/06)
export function ticket(root, ref, { title = null, status = "ready-for-agent", blockedBy = "None (can start immediately)", priority = null, lock = null, headers = [], type = "feature" } = {}) {
  const [feature, slug] = ref.split("/");
  const dir = path.join(root, ".scratch", feature, "issues");
  mkdirSync(dir, { recursive: true });
  const nn = /^(\d+)/.exec(slug)[1];
  const lines = [`# ${nn}: ${title ?? slug}`, "", `**Type:** ${type}`, ""];
  if (priority) lines.push(`**Priority:** ${priority}`, "");
  lines.push(`**Blocked by:** ${blockedBy}`, "");
  for (const h of headers) lines.push(h, "");
  lines.push(`**Status:** ${status}`, "", "## What to build", "", "Something.", "", "## Comments", "");
  writeFileSync(path.join(dir, `${slug}.md`), lines.join("\n"));
  if (lock !== null) writeFileSync(path.join(dir, `${slug}.lock`), `${lock}\n`);
}

// usage(root, rows) writes .scratch/usage.jsonl; a row that is a string is written as-is (to plant garbage).
export function usage(root, rows) {
  writeFileSync(path.join(root, ".scratch", "usage.jsonl"), rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
}
