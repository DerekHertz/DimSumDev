#!/usr/bin/env node
// organism-infra/110: Claude Code `SessionStart` hook command. For a chief-of-staff session
// (hook input `agent_type: "chief-of-staff"`, or the old "orchestrator"; set by `claude --agent chief-of-staff`) it prints,
// as plain stdout that Claude Code adds to the session context, the pickup the chief of staff
// otherwise gathers by hand: the latest chief-of-staff handoff, open PRs with their check
// state, pending gate requests and plan usage. Capped at 1600 chars (about 400 tokens).
// Any failed read degrades to "unknown"; the hook always exits 0 and never blocks.
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readStdinJson, boardRoot, runUsage, usageWindow, defaultUsageScript } from "./hook-io.mjs";
import { readRequestRows, foldRequests } from "../apps/bridge/requests-log.mjs";
import { isChiefOfStaff } from "./context-budget.mjs";

const CAP = 1600;
const TITLE_MAX = 60;

function latestHandoff(root) {
  let names = [];
  try {
    names = readdirSync(path.join(root, ".scratch", "_handoffs"));
  } catch {
    return null;
  }
  const found = [];
  for (const name of names) {
    const m = /^(\d{4}-\d{2}-\d{2})-(?:chief-of-staff|orchestrator)-(\d+)\.md$/.exec(name);
    if (m) found.push({ name, date: m[1], n: Number(m[2]) });
  }
  found.sort((a, b) => (a.date === b.date ? a.n - b.n : a.date < b.date ? -1 : 1));
  return found.length ? found[found.length - 1].name : null;
}

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

// "pass" | "fail" | "pending" | "no checks" from a gh statusCheckRollup.
function checkState(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return "no checks";
  let pending = false;
  for (const c of rollup) {
    const verdict = String(c?.conclusion || c?.state || "").toUpperCase();
    if (FAILED.has(verdict)) return "fail";
    const done = c?.status ? String(c.status).toUpperCase() === "COMPLETED" : verdict !== "" && verdict !== "PENDING" && verdict !== "EXPECTED";
    if (!done || verdict === "") pending = true;
  }
  return pending ? "pending" : "pass";
}

// PR lines, or null when gh could not answer.
function openPrs(timeout) {
  const bin = process.env.GH_BIN || "gh";
  try {
    const r = spawnSync(bin, ["pr", "list", "--state", "open", "--limit", "30", "--json", "number,title,statusCheckRollup"], { encoding: "utf8", timeout, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] });
    if (r.error || r.status !== 0) return null;
    const prs = JSON.parse(r.stdout);
    if (!Array.isArray(prs)) return null;
    return prs.map((p) => `PR #${p.number} ${checkState(p.statusCheckRollup)}: ${String(p.title ?? "").slice(0, TITLE_MAX)}`);
  } catch {
    return null;
  }
}

// mods-trial/01: the sleep-guard mod is enabled when any settings layer (project, local, user)
// lists it under enabledPlugins. Unreadable or malformed settings count as not enabled.
const MOD_KEY = "sleep-guard@dimsumden-mods";
const modInstallLine = (root) => `Mod sleep-guard is not enabled. Install once per machine: claude plugin marketplace add ${/\s/.test(root) ? JSON.stringify(root) : root} && claude plugin install ${MOD_KEY} --scope project`;

function modEnabled() {
  const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const files = [path.join(project, ".claude", "settings.json"), path.join(project, ".claude", "settings.local.json"), path.join(os.homedir(), ".claude", "settings.json")];
  for (const file of files) {
    try {
      if (JSON.parse(readFileSync(file, "utf8"))?.enabledPlugins?.[MOD_KEY] === true) return true;
    } catch {
      // missing or unreadable layer
    }
  }
  return false;
}

function usageLine(timeout) {
  const u = runUsage(process.env.SESSION_START_USAGE_SCRIPT || defaultUsageScript, timeout);
  const five = usageWindow(u, "5-hour");
  const week = usageWindow(u, "weekly");
  if (!five && !week) return "Plan usage: unknown";
  return `Plan usage: 5h ${five ? `${Math.round(five.percent)}%` : "?"}, wk ${week ? `${Math.round(week.percent)}%` : "?"}`;
}

const input = readStdinJson();
if (isChiefOfStaff(input.agent_type)) {
  const root = boardRoot();
  const timeout = Number(process.env.SESSION_START_TIMEOUT_MS) || 5000;

  const handoff = latestHandoff(root);
  const must = [handoff ? `Latest chief-of-staff handoff: .scratch/_handoffs/${handoff}` : "Latest chief-of-staff handoff: none", usageLine(timeout)];
  const modLine = modEnabled() ? null : modInstallLine(root);

  const prs = openPrs(timeout);
  let requests = [];
  try {
    requests = foldRequests(await readRequestRows(root)).filter((r) => r.state === "pending").map((r) => `Pending request: ${r.kind} ${r.ref}`);
  } catch {
    // unreadable log: no pending lines
  }
  const optional = prs === null ? ["Open PRs: unknown (gh failed)"] : prs.length ? prs : ["Open PRs: none"];
  optional.push(...requests);

  // Budget: the two required lines are never cut; the list lines fill what is left, with a
  // marker for what was dropped.
  const used = must.reduce((n, l) => n + l.length + 1, 0) + (modLine ? modLine.length + 1 : 0);
  const marker = (n) => `... ${n} more lines omitted`;
  let room = CAP - used - marker(999).length - 1;
  const kept = [];
  for (const line of optional) {
    if (room - line.length - 1 < 0) break;
    kept.push(line);
    room -= line.length + 1;
  }
  const dropped = optional.length - kept.length;
  const lines = [must[0], ...kept, ...(dropped ? [marker(dropped)] : []), must[1], ...(modLine ? [modLine] : [])];
  process.stdout.write(lines.join("\n") + "\n");
}
