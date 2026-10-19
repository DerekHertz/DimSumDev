#!/usr/bin/env node
// organism-infra/147: print the mandatory lines of a relay dispatch prompt, so the orchestrator pastes them instead of
// writing them by hand (wrong ticket paths and agent-start run from the main checkout cost agents retries).
// Usage: node scripts/dispatch-prompt.mjs --ticket <feature>/<NN-slug> --role <role> [--mode <m>]
//                                         [--base <sha> | --branch <b>] [--continue] [--batch <name>] [--tests <file>]
// Prints: the ticket path (with issues/, checked to exist), the agent-start line with the flags for this agent and mode, a note
// that it runs inside the agent's worktree, the handoff path to write (a new name when an earlier one is already published),
// the context line (architect, qa specify and developer only, and only when dispatch-context.mjs gives a path), and the
// release flag for this hop. With --tests <file> (qa verify only; organism-infra/198) it also prints one line naming the saved
// developer suite output, which qa uses as the suite result instead of re-running it; the file must pass the same exposure
// check as `jev.mjs verify --tests` (regular non-symlink file, not denied, at most 1 MB). The only side effect is that dispatch-context may write its own context file and usage row.
// qa verify also prints one "Verify mode: light|full" line (organism-infra/207): light when a published <NN>-qa-specify[-k].md handoff
// exists for the ticket, full otherwise, so the verifier follows the line instead of inferring the mode.
// Bad arguments exit 2 with the reason on stderr and nothing on stdout.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRoot } from "../apps/board/board-service.mjs";
import { normalizeLegacyFlags } from "../apps/board/legacy-terms.mjs";
import { readTests } from "./jev.mjs";

const USAGE =
  "usage: node scripts/dispatch-prompt.mjs --ticket <feature>/<NN-slug> --role <role> [--mode <m>] [--base <sha> | --branch <b>] [--continue] [--batch <name>] [--tests <file>]";

// style: "branch" starts on a branch (writes code or tests), "detach" starts detached (a reviewer), "either" uses --branch when given.
// release: "keep" = --keep-status, otherwise the --status value.
const SPECS = {
  architect: { modes: null, style: "either", release: "in-review", context: true },
  developer: { modes: null, style: "branch", release: "in-review", context: true },
  security: { modes: null, style: "detach", release: "keep", context: false },
  qa: {
    modes: {
      specify: { style: "branch", release: "keep", context: true },
      verify: { style: "detach", release: "keep", context: false },
    },
  },
  designer: {
    modes: {
      spec: { style: "either", release: "ready-for-agent", context: false },
      direction: { style: "either", release: "ready-for-agent", context: false },
      review: { style: "detach", release: "keep", context: false },
      critique: { style: "detach", release: "keep", context: false },
    },
  },
};

const VALUE_FLAGS = new Set(["--ticket", "--role", "--mode", "--base", "--branch", "--batch", "--tests"]);

function parseArgs(argv) {
  const opts = { continue: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--continue") opts.continue = true;
    else if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      opts[a.slice(2)] = v;
    } else return { error: `unknown argument ${a}` };
  }
  if (!opts.ticket) return { error: "--ticket <feature>/<NN-slug> is required" };
  if (!opts.role) return { error: "--role <role> is required" };
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.ticket) || opts.ticket.split("/").some((s) => s.startsWith("."))) {
    return { error: `bad ticket ref ${opts.ticket}` };
  }
  const roleSpec = SPECS[opts.role];
  if (!roleSpec) return { error: `unknown role ${opts.role} (one of ${Object.keys(SPECS).join(", ")})` };
  let spec = roleSpec;
  if (roleSpec.modes) {
    if (!opts.mode) return { error: `${opts.role} needs --mode (one of ${Object.keys(roleSpec.modes).join(", ")})` };
    spec = roleSpec.modes[opts.mode];
    if (!spec) return { error: `unknown ${opts.role} mode ${opts.mode} (one of ${Object.keys(roleSpec.modes).join(", ")})` };
  } else if (opts.mode) return { error: `${opts.role} takes no --mode` };
  if (opts.tests !== undefined && !(opts.role === "qa" && opts.mode === "verify")) return { error: "--tests applies to qa verify only" };
  if (!opts.base) return { error: "--base <sha> is required (agent-start needs it)" };
  if (spec.style === "branch" && !opts.branch) return { error: `${opts.role}${opts.mode ? ` ${opts.mode}` : ""} needs --branch <name>` };
  return { ...opts, spec };
}

// The highest published handoff number for a stem (<NN>-<agent>[-<mode>].md is 1, -2.md is 2, ...); 0 when none.
function maxHandoff(dir, stem) {
  let max = 0;
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    /* no handoffs yet */
  }
  for (const n of names) {
    const m = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-(\\d+))?\\.md$`).exec(n);
    if (m) max = Math.max(max, m[1] ? Number(m[1]) : 1);
  }
  return max;
}

// The next free handoff name: <NN>-<agent>[-<mode>].md, then -2, -3 (board handoff refuses to overwrite an earlier claim's file).
function handoffName(dir, stem) {
  const max = maxHandoff(dir, stem);
  return max === 0 ? `${stem}.md` : `${stem}-${max + 1}.md`;
}

// organism-infra/207: the qa verify mode. Light when a qa specify handoff is published for this ticket, full otherwise.
function verifyModeLine(dir, num) {
  const stem = `${num}-qa-specify`;
  const max = maxHandoff(dir, stem);
  if (max === 0) return "Verify mode: full (no qa specify handoff for this ticket)";
  const file = path.join(dir, max === 1 ? `${stem}.md` : `${stem}-${max}.md`);
  return `Verify mode: light (qa specify ran for this ticket: ${file})`;
}

// dispatch-context prints one JSON line {path, ...}; any failure or a null path means no context line.
function contextPath(ref, env) {
  const script = fileURLToPath(new URL("./dispatch-context.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [script, "--ticket", ref], { encoding: "utf8", timeout: 120000, env });
  if (r.status !== 0) return null;
  try {
    const last = r.stdout.trim().split("\n").pop();
    return JSON.parse(last).path ?? null;
  } catch {
    return null;
  }
}

function main(argv) {
  const opts = parseArgs(normalizeLegacyFlags(argv, "dispatch-prompt"));
  if (opts.error) {
    process.stderr.write(`dispatch-prompt: ${opts.error}\n${USAGE}\n`);
    return 2;
  }
  let root;
  try {
    root = resolveRoot(process.cwd(), process.env);
  } catch (e) {
    process.stderr.write(`dispatch-prompt: ${e.message}\n`);
    return 2;
  }
  let testsFile;
  if (opts.tests !== undefined) {
    const t = readTests(opts.tests);
    if (t.error) {
      process.stderr.write(`dispatch-prompt: ${t.error}\n${USAGE}\n`);
      return 2;
    }
    testsFile = path.resolve(opts.tests);
  }
  const [feature, slug] = opts.ticket.split("/");
  const ticketFile = path.join(root, ".scratch", feature, "issues", `${slug}.md`);
  if (!existsSync(ticketFile)) {
    process.stderr.write(`dispatch-prompt: no ticket at ${ticketFile} (${opts.ticket} must resolve to .scratch/<feature>/issues/<NN-slug>.md)\n`);
    return 2;
  }

  const { spec } = opts;
  const detach = spec.style === "detach" || (spec.style === "either" && !opts.branch);
  const startFlags = ["--base", opts.base, ...(detach ? ["--detach"] : ["--branch", opts.branch]), "--ticket", opts.ticket, "--role", opts.role];
  if (opts.mode) startFlags.push("--mode", opts.mode);
  if (opts.continue) startFlags.push("--continue");

  const num = /^\d+/.exec(slug)?.[0] ?? slug;
  const stem = `${num}-${opts.role}${opts.mode ? `-${opts.mode}` : ""}`;
  const handoffsDir = path.join(root, ".scratch", feature, "handoffs");
  const name = handoffName(handoffsDir, stem);
  const release = spec.release === "keep" ? "--keep-status" : `--status ${spec.release}`;

  const lines = [`Ticket: ${ticketFile}`];
  if (opts.batch) lines.push(`Batch: ${opts.batch}. Claim, hand off and release every ticket in the batch.`);
  lines.push(
    "Start with this one command, run inside your worktree (never in the main checkout):",
    `node scripts/agent-start.mjs ${startFlags.join(" ")}`,
    "If it refuses the claim, stop and report.",
  );
  if (spec.context) {
    const ctx = contextPath(opts.ticket, process.env);
    if (ctx) lines.push(`Start-here context: ${ctx} (jg output; read before searching; may be incomplete or stale)`);
  }
  if (opts.role === "qa" && opts.mode === "verify") lines.push(verifyModeLine(handoffsDir, num));
  if (testsFile) lines.push(`Suite result: the developer's full npm test output is saved at ${testsFile}. Use it as the suite result; do not re-run the suite.`);
  lines.push(
    `Write your handoff to ${path.join(handoffsDir, name)} with the handoff skill: draft it under /tmp, then publish it with \`npm run board -- handoff ${opts.ticket} --from <draft> --name ${name}\`, before release.`,
    `Release with \`npm run board -- release ${opts.ticket} ${release}\`.`,
  );
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
