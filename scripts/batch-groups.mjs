#!/usr/bin/env node
// organism-infra/93: propose 2-3 ticket batches. Advisory only: reads the board, writes nothing.
// Usage: node scripts/batch-groups.mjs [--max 3] [--json]
// Root is $DEN_ROOT, else the current directory. Exit 0 always except bad arguments (2).
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { compareRefs } from "../packages/board-refs/src/compare-refs.mjs";

const run = promisify(execFile);
const CODE_TYPES = new Set(["feature", "task", "fix", "bug", "chore", "refactor"]);
const KNOWN_DIRS = new Set(["apps", "scripts", "docs", "assets", "src", "public", "tests"]);

export const field = (text, name) => text.match(new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*(.*)$`, "mi"))?.[1].trim() ?? "";

function section(text, heading) {
  const m = text.match(new RegExp(`^## ${heading}[ \\t]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "mi"));
  return m ? m[1] : "";
}

function isPath(tok) {
  if (!tok.includes("/") || /^[a-z]+:\/\//i.test(tok)) return false;
  const last = tok.split("/").pop();
  return /\.[A-Za-z0-9]+$/.test(last) || (tok.endsWith("/") && KNOWN_DIRS.has(tok.split("/")[0]));
}

export function pathsOf(text) {
  const advisory = text.match(/^Paths \(advisory\):.*$/m)?.[0] ?? "";
  const body = [section(text, "What to build"), section(text, "Acceptance criteria"), section(text, "Paths \\(advisory\\)"), advisory].join("\n");
  const found = new Set();
  for (const m of body.matchAll(/`([^`\s]+)`/g)) {
    const p = m[1].replace(/^\.\//, "");
    if (isPath(p) && !p.startsWith(".scratch/") && !p.startsWith(".claude/")) found.add(p);
  }
  return [...found];
}

const num = (s) => Number.parseInt(s, 10);

// Every `Blocked by` entry must name a ticket on the board that is resolved. "None ..." means no blockers.
export function unblocked(ticket, status, byNumber) {
  const raw = field(ticket.text, "Blocked by");
  if (!raw || /^none/i.test(raw)) return true;
  const feature = ticket.ref.split("/")[0];
  return raw.split(",").every((piece) => {
    const m = piece.trim().match(/^(?:([\w.-]+)\/)?(\d+)/);
    return m && status.get(byNumber.get(`${m[1] ?? feature}/${num(m[2])}`)) === "resolved";
  });
}

export function groupTickets({ tickets, inFlight, max = 3 }) {
  const status = new Map(tickets.map((t) => [t.ref, field(t.text, "Status")]));
  const byNumber = new Map();
  for (const t of tickets) {
    const [feature, name = ""] = t.ref.split("/");
    const n = name.match(/^(\d+)/);
    if (n) byNumber.set(`${feature}/${num(n[1])}`, t.ref);
  }

  const considered = tickets
    .filter((t) => !t.locked && status.get(t.ref) === "ready-for-agent" && unblocked(t, status, byNumber))
    .map((t) => ({ ref: t.ref, code: CODE_TYPES.has(field(t.text, "Type").toLowerCase()), paths: pathsOf(t.text) }));

  const unknown = considered.filter((t) => !t.paths.length).map((t) => t.ref);
  const withPaths = considered.filter((t) => t.paths.length);

  // Agglomerative clustering: merge the pair sharing the most paths first, never past `max` tickets.
  const edges = [];
  for (let i = 0; i < withPaths.length; i++) {
    for (let j = i + 1; j < withPaths.length; j++) {
      const a = withPaths[i], b = withPaths[j];
      const shared = a.paths.filter((p) => b.paths.includes(p)).length;
      if (shared && a.code === b.code) edges.push({ i, j, shared, sameFeature: a.ref.split("/")[0] === b.ref.split("/")[0] });
    }
  }
  edges.sort((x, y) => y.shared - x.shared || Number(y.sameFeature) - Number(x.sameFeature) || x.i - y.i || x.j - y.j);
  const cluster = withPaths.map((_, i) => [i]);
  const owner = withPaths.map((_, i) => i);
  for (const { i, j } of edges) {
    const ci = owner[i], cj = owner[j];
    if (ci === cj || cluster[ci].length + cluster[cj].length > max) continue;
    for (const k of cluster[cj]) owner[k] = ci;
    cluster[ci] = cluster[ci].concat(cluster[cj]).sort((x, y) => x - y);
    cluster[cj] = [];
  }

  const busy = new Set((inFlight ?? []).flatMap((b) => b.files));
  const groups = [];
  const grouped = new Set();
  for (const members of cluster.filter((c) => c.length >= 2).sort((x, y) => x[0] - y[0])) {
    const ts = members.map((i) => withPaths[i]);
    if (ts.some((t) => t.paths.some((p) => busy.has(p)))) continue;
    const count = new Map();
    for (const t of ts) for (const p of t.paths) count.set(p, (count.get(p) ?? 0) + 1);
    const paths = [...count].filter(([, n]) => n >= 2).map(([p]) => p).sort();
    groups.push({ refs: ts.map((t) => t.ref), paths, reason: `${ts.length} tickets overlap on ${paths.length} path${paths.length === 1 ? "" : "s"}` });
    for (const t of ts) grouped.add(t.ref);
  }

  return {
    groups,
    singles: withPaths.map((t) => t.ref).filter((r) => !grouped.has(r)),
    unknown,
    inFlight: { available: inFlight !== null },
  };
}

function parseArgs(argv) {
  const opts = { max: 3, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") opts.json = true;
    else if (argv[i] === "--max" && /^\d+$/.test(argv[i + 1] ?? "") && num(argv[i + 1]) >= 1) opts.max = num(argv[++i]);
    else return null;
  }
  return opts;
}

export async function main(argv, { readBoard, inFlightFiles }) {
  const opts = parseArgs(argv);
  if (!opts) return { code: 2, stdout: "", stderr: "usage: batch-groups.mjs [--max N] [--json]  (N is an integer >= 1)\n" };
  const tickets = await readBoard();
  const inFlight = await inFlightFiles().catch(() => null);
  const res = groupTickets({ tickets, inFlight, max: opts.max });
  if (opts.json) return { code: 0, stdout: JSON.stringify(res) + "\n", stderr: "" };

  const lines = [];
  if (!res.inFlight.available) lines.push("note: no in-flight data (gh or git failed); overlap with open branches is unchecked");
  lines.push("Groups:");
  for (const g of res.groups) lines.push(`  ${g.refs.join(", ")} | shares ${g.paths.join(", ")} | ${g.reason}`);
  if (!res.groups.length) lines.push("  (none)");
  lines.push("Singles:");
  for (const r of res.singles) lines.push(`  ${r}`);
  if (!res.singles.length) lines.push("  (none)");
  if (res.unknown.length) lines.push(`unknown files: ${res.unknown.join(", ")}`);
  return { code: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

export function defaultReadBoard() {
  const root = path.resolve(process.env.DEN_ROOT || process.env.ORGANISM_ROOT || process.cwd());
  const scratch = path.join(root, ".scratch");
  const tickets = [];
  if (!existsSync(scratch)) return tickets;
  for (const feature of readdirSync(scratch, { withFileTypes: true })) {
    const dir = path.join(scratch, feature.name, "issues");
    if (!feature.isDirectory() || feature.name.startsWith("_") || !existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".md")).sort(compareRefs)) {
      const slug = f.slice(0, -3);
      tickets.push({
        ref: `${feature.name}/${slug}`,
        text: readFileSync(path.join(dir, f), "utf8"),
        locked: existsSync(path.join(dir, `${slug}.lock`)),
      });
    }
  }
  return tickets;
}

// Open PR heads from gh, then each head's files against origin/main. Any failure rejects (no in-flight data).
async function defaultInFlightFiles() {
  const { stdout } = await run("gh", ["pr", "list", "--state", "open", "--json", "headRefName"], { timeout: 30000 });
  const out = [];
  for (const { headRefName: branch } of JSON.parse(stdout)) {
    const diff = await run("git", ["diff", "--name-only", `origin/main...origin/${branch}`], { timeout: 30000 });
    out.push({ branch, files: diff.stdout.split("\n").filter(Boolean) });
  }
  return out;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const r = await main(process.argv.slice(2), { readBoard: async () => defaultReadBoard(), inFlightFiles: defaultInFlightFiles });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exit(r.code);
}
