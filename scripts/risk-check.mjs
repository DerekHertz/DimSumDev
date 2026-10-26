#!/usr/bin/env node
// organism-infra/08: the scripted risk check that sizes the review relay to
// the diff. Run by `scout` (or CI) on every code ticket instead of the full
// `security` agent. Exit 0 = clean, the scripted check suffices. Exit non-zero
// = escalate to full security review; each hit is printed as
// "file: reason" (or "reason" for range-wide hits).
//
// Usage: node scripts/risk-check.mjs [gitRange]   (default: main...HEAD)
//
// See .scratch/organism-infra/issues/08-risk-sized-review.md for the rule
// this implements.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SECRET_PATTERNS } from "./exposure.mjs";

export { SECRET_PATTERNS };

// The den kit (`den risk-check`) passes another project's config with --project-config <json>, read from the base
// ref so a branch cannot weaken its own check. Nothing ambient: the den's own run never takes one.
const cfgAt = process.argv.indexOf("--project-config");
const PROJECT = cfgAt === -1 ? null : normalizeProject(JSON.parse(process.argv[cfgAt + 1]));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CODE_PATH_RE = PROJECT
  ? new RegExp(`^(${PROJECT.codePaths.map(escapeRe).join("|")})/`)
  : /^(apps|packages|scripts)\//;

// Entries are plain relative dirs: a trailing slash is dropped, and an empty or non-string list fails closed.
export function normalizeProject(cfg) {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("project config must be an object");
  const list = (v, name, { required }) => {
    if (v === undefined && !required) return [];
    if (!Array.isArray(v) || v.some((e) => typeof e !== "string" || !e.replace(/\/+$/, "").trim())) {
      throw new Error(`project config ${name} must be a list of non-empty paths`);
    }
    return v.map((e) => e.trim().replace(/\/+$/, "").replace(/^\.\//, ""));
  };
  const codePaths = list(cfg.codePaths, "codePaths", { required: true });
  if (codePaths.length === 0) throw new Error("project config codePaths is empty");
  return { codePaths, guardrailPaths: list(cfg.guardrailPaths, "guardrailPaths", { required: false }) };
}

const CODE_RISK_PATTERNS = [
  {
    name: "network/server code",
    re: /\b(https?|net)\.(createServer|request|connect)\s*\(|\.listen\s*\(|\bWebSocket\b/,
  },
  {
    name: "shelling out to another program",
    re: /\bchild_process\b|\b(spawnSync|spawn|execFileSync|execFile|execSync|fork)\s*\(|(?<!\.)\bexec\s*\(/,
  },
  { name: "board, lock, or daemon code", re: /\bdaemon\b|\.lock\b|\bboard\b/i },
  { name: "secrets handling", re: /\b(secret|credential|apiKey|api_key)\b/i },
];

// agent-os/04 (ADR 0021): a file whose content sets what an agent may do. Any change to one goes to a security review,
// whatever the content says.
const GUARDRAIL_PATHS = new Map([
  ["apps/bridge/agents/ceilings.json", "guardrail file changed (role ceilings: what a den agent may do)"],
  ["apps/bridge/agents/governance.json", "guardrail file changed (governance deny list: paths and commands no den agent may touch)"],
  ["apps/bridge/library/connections.json", "guardrail file changed (connections catalog: the servers and tools a den agent is given)"],
]);

function git(args) {
  // 256 MiB: the 1 MiB default made a large diff throw ENOBUFS instead of being checked.
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function parseDiff(range) {
  const raw = git(["diff", "--unified=0", "--end-of-options", range]);
  const files = [];
  let current = null;
  for (const line of raw.split("\n")) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header) {
      current = { path: header[2], addedLines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) current.addedLines.push(line.slice(1));
  }
  return files;
}

function checkFile(file) {
  const hits = [];
  const { path: filePath, addedLines } = file;
  const addedText = addedLines.join("\n");

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(addedText)) {
      hits.push({ file: filePath, reason: `possible secret: ${pattern.name}` });
    }
  }

  if (filePath === "package-lock.json") {
    hits.push({ file: filePath, reason: "lockfile changed" });
  } else if (/(^|\/)package\.json$/.test(filePath)) {
    if (/"(dependencies|devDependencies|peerDependencies|optionalDependencies)"/.test(addedText)) {
      hits.push({ file: filePath, reason: "dependency field changed" });
    }
  }

  if (/^\.github\//.test(filePath)) {
    hits.push({ file: filePath, reason: "CI workflow / branch protection config changed" });
  }

  // ADR 0016 decision 6.10: a spawned agent can edit its own permission surface under .claude/, so any change
  // there (settings, role files, skills, hooks) goes to a security review.
  // The den kit's per-project config sets the test command and these checks' paths.
  if (/^\.den\//.test(filePath)) {
    hits.push({ file: filePath, reason: ".den/** changed (the project's test command and risk-check paths)" });
  }

  if (/^\.claude\//.test(filePath)) {
    hits.push({ file: filePath, reason: ".claude/** changed (agent permission surface)" });
  }

  // hardening/12 (ADR 0031): the agent image is what every agent runs inside, so any Dockerfile change goes to security.
  if (/(^|\/)([^/]*\.)?dockerfile(\.[^/]*)?$/i.test(filePath)) {
    hits.push({ file: filePath, reason: "Dockerfile changed (agent image)" });
  }

  if (PROJECT?.guardrailPaths?.includes(filePath)) {
    hits.push({ file: filePath, reason: "guardrail file changed (listed in .den/project.json)" });
  }
  if (GUARDRAIL_PATHS.has(filePath)) {
    hits.push({ file: filePath, reason: GUARDRAIL_PATHS.get(filePath) });
  }

  if (CODE_PATH_RE.test(filePath)) {
    for (const pattern of CODE_RISK_PATTERNS) {
      if (pattern.re.test(addedText)) {
        hits.push({ file: filePath, reason: pattern.name });
      }
    }
  }

  return hits;
}

function main() {
  const range = (process.argv[2] !== "--project-config" && process.argv[2]) || "main...HEAD";

  if (range.startsWith("-")) {
    console.error(
      `risk-check: refusing option-shaped range argument "${range}" (looks like a git option, not a range)`
    );
    return 1;
  }

  const files = parseDiff(range);
  const hits = files.flatMap(checkFile);

  if (hits.length === 0) {
    console.log(`risk-check: clean (${range})`);
    return 0;
  }

  console.log(`risk-check: ${hits.length} hit(s) on ${range} — escalate to full security review`);
  for (const hit of hits) {
    console.log(`${hit.file}: ${hit.reason}`);
  }
  return 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
