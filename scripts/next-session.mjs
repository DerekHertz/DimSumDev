// organism-infra/122: launcher for a fresh chief-of-staff session (team-and-den-ux/57; once the orchestrator).
//
//   node scripts/next-session.mjs [--root <dir>] [--run]
//
// Finds the latest chief-of-staff session handoff in <root>/.scratch/_handoffs/
// (files named YYYY-MM-DD-chief-of-staff[-cloud]-N.md, or the older -orchestrator- name), then prints
// `claude --agent chief-of-staff "<prompt>"`. With --run it starts claude instead.
// Root is --root, else $DEN_ROOT, else the cwd. It first runs the
// end-of-session check (scripts/session-check.mjs, organism-infra/158) and
// refuses, printing each problem and its fix command, instead of launching.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { formatProblems, sessionCheck } from "./session-check.mjs";
import { CHIEF_OF_STAFF } from "./context-budget.mjs";

const HANDOFF = /^(\d{4}-\d{2}-\d{2})-(?:chief-of-staff|orchestrator)(?:-cloud)?-(\d+)\.md$/;

function fail(msg) {
  process.stderr.write(`next-session: ${msg}\n`);
  process.exit(1);
}

export function latestHandoff(root) {
  let names;
  try {
    names = readdirSync(path.join(root, ".scratch", "_handoffs"), { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  for (const e of names) {
    if (!e.isFile()) continue;
    const m = HANDOFF.exec(e.name);
    if (!m) continue;
    const key = [m[1], Number(m[2])];
    if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && key[1] > best.key[1])) {
      best = { name: e.name, key };
    }
  }
  return best ? best.name : null;
}

export function buildPrompt(root, name) {
  const file = path.join(root, ".scratch", "_handoffs", name);
  return `Read ${file}, then propose the next ticket from the frontier.`;
}

function shellQuote(s) {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function parseArgs(argv) {
  const opts = { root: null, run: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run") opts.run = true;
    else if (a === "--root") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) fail("--root needs a value");
      opts.root = v;
    } else fail(`unknown argument ${a}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = path.resolve(opts.root ?? (process.env.DEN_ROOT || process.env.ORGANISM_ROOT) ?? process.cwd());
  // organism-infra/158: refuse to hand out a launch command while work is stranded on this machine.
  const problems = sessionCheck(root);
  if (problems.length) {
    process.stderr.write(formatProblems(problems));
    process.exit(1);
  }
  const name = latestHandoff(root);
  if (!name) fail(`no chief-of-staff handoff found in ${path.join(root, ".scratch", "_handoffs")}`);
  const prompt = buildPrompt(root, name);
  if (opts.run) {
    const r = spawnSync("claude", ["--agent", CHIEF_OF_STAFF, prompt], { stdio: "inherit" });
    if (r.error) fail(`could not start claude: ${r.error.message}`);
    process.exit(r.status ?? 1);
  }
  process.stdout.write(`claude --agent ${CHIEF_OF_STAFF} ${shellQuote(prompt)}\n`);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
