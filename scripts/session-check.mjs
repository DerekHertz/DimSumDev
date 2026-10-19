// organism-infra/158: end-of-session check. Work never stays on one machine.
//
//   node scripts/session-check.mjs [--root <dir>]      (npm run session-check)
//
// Root is --root, else $DEN_ROOT, else the cwd. Exit 0 when clean; else
// exit 1 after printing every problem with the command that fixes it:
//   A. local main is ahead of origin/main
//   B. uncommitted or untracked files in a board directory
//      (.scratch/<feature>/ or .scratch/_handoffs/; the append-only logs
//      directly under .scratch/ and other underscore dirs never block)
//   C. a ticket at claimed / in-progress / in-review whose branch, named as
//      "Branch `<name>`" in its latest handoff, is missing from origin or
//      behind the local branch
// A root that is not a git repo has nothing to check. The check reads local
// refs only (no fetch), so it works offline.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IN_FLIGHT = new Set(["claimed", "in-progress", "in-review"]);

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

function gitOk(root, args) {
  try {
    git(root, args);
    return true;
  } catch {
    return false;
  }
}

function isRepoRoot(root) {
  try {
    const top = git(root, ["rev-parse", "--show-toplevel"]).trim();
    return realpathSync(top) === realpathSync(root);
  } catch {
    return false;
  }
}

function checkMainAhead(root, problems) {
  if (!gitOk(root, ["rev-parse", "--verify", "-q", "refs/heads/main"])) return;
  if (!gitOk(root, ["rev-parse", "--verify", "-q", "refs/remotes/origin/main"])) return;
  const n = Number(git(root, ["rev-list", "--count", "origin/main..main"]).trim());
  if (n > 0) {
    problems.push({
      what: `local main is ${n} commit${n === 1 ? "" : "s"} ahead of origin/main`,
      fix: "git push origin main",
    });
  }
}

// Board directory of a repo-relative path, or null when the path is not board content.
function boardDir(rel) {
  const m = /^\.scratch\/([^/]+)\/./.exec(rel);
  if (!m) return null;
  if (m[1] === "_handoffs") return ".scratch/_handoffs";
  if (m[1].startsWith("_")) return null;
  return `.scratch/${m[1]}`;
}

function checkBoardClean(root, problems) {
  const raw = git(root, ["status", "--porcelain", "-z", "-uall", "--", ".scratch"]);
  const entries = raw.split("\0").filter(Boolean);
  const byDir = new Map();
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i].slice(0, 2);
    const rel = entries[i].slice(3);
    if (code[0] === "R" || code[0] === "C") i++; // the next entry is the rename source
    const dir = boardDir(rel);
    if (!dir) continue;
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(rel);
  }
  for (const [dir, files] of byDir) {
    problems.push({
      what: `uncommitted board files in ${dir}:\n${files.map((f) => `    ${f}`).join("\n")}`,
      fix: `git add ${dir} && git commit -m "Board: sync ${path.basename(dir)}"`,
    });
  }
}

function ticketStatus(text) {
  const m = /^\*\*Status:\*\*[ \t]*(\S+)/m.exec(text);
  return m ? m[1] : null;
}

function latestHandoffBranch(handoffDir, nn) {
  let best = null;
  let names;
  try {
    names = readdirSync(handoffDir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".md") || !name.startsWith(`${nn}-`)) continue;
    const file = path.join(handoffDir, name);
    const mtime = statSync(file).mtimeMs;
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  if (!best) return null;
  // The State block's JSON can mention the pattern; only the prose names the branch.
  const prose = readFileSync(best.file, "utf8").replace(/```json[\s\S]*?```/, "");
  const m = /Branch\s+`([^`\s]+)`/.exec(prose);
  return m ? m[1] : null;
}

function checkTicketBranches(root, problems) {
  const scratch = path.join(root, ".scratch");
  if (!existsSync(scratch)) return;
  for (const feature of readdirSync(scratch, { withFileTypes: true })) {
    if (!feature.isDirectory() || feature.name.startsWith("_")) continue;
    const issuesDir = path.join(scratch, feature.name, "issues");
    let tickets;
    try {
      tickets = readdirSync(issuesDir);
    } catch {
      continue;
    }
    for (const file of tickets) {
      const m = /^(\d+)-.*\.md$/.exec(file);
      if (!m) continue;
      let status;
      try {
        status = ticketStatus(readFileSync(path.join(issuesDir, file), "utf8"));
      } catch {
        continue;
      }
      if (!IN_FLIGHT.has(status)) continue;
      const branch = latestHandoffBranch(path.join(scratch, feature.name, "handoffs"), m[1]);
      if (!branch) continue;
      const ref = `${feature.name}/${file.replace(/\.md$/, "")}`;
      const local = gitOk(root, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
      const remote = gitOk(root, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`]);
      if (local && !remote) {
        problems.push({
          what: `${ref} (${status}): branch ${branch} is missing from origin`,
          fix: `git push -u origin ${branch}`,
        });
      } else if (local && remote) {
        const n = Number(git(root, ["rev-list", "--count", `origin/${branch}..${branch}`]).trim());
        if (n > 0) {
          problems.push({
            what: `${ref} (${status}): origin/${branch} is behind the local branch by ${n} commit${n === 1 ? "" : "s"}`,
            fix: `git push origin ${branch}`,
          });
        }
      } else if (!local && !remote) {
        problems.push({
          what: `${ref} (${status}): branch ${branch} is in neither the local refs nor origin's; it may live on the other machine`,
          fix: `git fetch origin   (if it is still missing, push it from the machine that has it: git push -u origin ${branch})`,
        });
      }
    }
  }
}

// Returns a list of {what, fix}; empty when clean or when root is not a git repo.
export function sessionCheck(root) {
  const problems = [];
  if (!isRepoRoot(root)) return problems;
  checkMainAhead(root, problems);
  checkBoardClean(root, problems);
  checkTicketBranches(root, problems);
  return problems;
}

export function formatProblems(problems) {
  const lines = [`session-check: ${problems.length} problem${problems.length === 1 ? "" : "s"}, work would stay on this machine:`];
  for (const p of problems) lines.push(`- ${p.what}\n    fix: ${p.fix}`);
  return `${lines.join("\n")}\n`;
}

function main() {
  const argv = process.argv.slice(2);
  let rootArg = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") {
      rootArg = argv[++i];
      if (!rootArg || rootArg.startsWith("--")) {
        process.stderr.write("session-check: --root needs a value\n");
        process.exit(1);
      }
    } else {
      process.stderr.write(`session-check: unknown argument ${argv[i]}\n`);
      process.exit(1);
    }
  }
  const root = path.resolve(rootArg ?? (process.env.DEN_ROOT || process.env.ORGANISM_ROOT) ?? process.cwd());
  const problems = sessionCheck(root);
  if (problems.length) {
    process.stderr.write(formatProblems(problems));
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
