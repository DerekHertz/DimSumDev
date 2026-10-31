#!/usr/bin/env node
// PreToolUse hook for Bash. Reads the hook JSON on stdin; exit 2 blocks the call, exit 0 allows it.
// organism-infra/80: jg runs only through scripts/jg.mjs (handoffs/67-security.md, Q2). This is a
// string check, so shell indirection (eval, aliases, a script file) can bypass it: residual Low.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bareRole } from "../context-budget.mjs";

// The board-identity rule needs the den's board. This file is mirrored into the plugin (.claude/hooks/), where a
// by-name install carries no apps/: with no board beside it the rule does nothing, and the other rules still run.
const BOARD_SERVICE = fileURLToPath(new URL("../../apps/board/board-service.mjs", import.meta.url));
const isBoardRole = existsSync(BOARD_SERVICE) ? (await import(pathToFileURL(BOARD_SERVICE))).isBoardRole : () => false;

// Shell segments split on unquoted ; & | ( ) and newlines; each word keeps whether it was quoted.
export function segments(command) {
  const out = [[]];
  let word = null;
  let quote = null;
  const end = () => { if (word) out.at(-1).push(word); word = null; };
  for (const ch of command.replace(/\\\n/g, " ")) {
    if (quote) {
      if (ch === quote) quote = null;
      else word.text += ch;
    } else if (ch === "'" || ch === '"') {
      word ??= { text: "", quoted: false };
      word.quoted = true;
      quote = ch;
    } else if (/[;&|()\n]/.test(ch)) {
      end();
      if (out.at(-1).length) out.push([]);
    } else if (/\s/.test(ch)) end();
    else (word ??= { text: "", quoted: false }).text += ch;
  }
  end();
  // `bash -c "<script>"`: the script's own segments count too.
  return out.filter((s) => s.length).flatMap((seg) => {
    const c = seg.findIndex((w) => w.text === "-c");
    return /^(?:ba|z|da)?sh$/.test(seg[0].text.split("/").at(-1)) && c !== -1 && seg[c + 1] ? [seg, ...segments(seg[c + 1].text)] : [seg];
  });
}

const base = (w) => w.text.split("/").at(-1);

// jg (or its package name) in command position, bare or by path; scripts/jg.mjs does not match.
const LAUNCHERS = new Set(["npx", "env", "exec", "command", "nohup", "time", "timeout", "sudo", "xargs"]);
const commandWord = (seg) => seg.find((w) => !LAUNCHERS.has(w.text) && !w.text.startsWith("-") && !/^\w+=/.test(w.text) && !/^\d+[smhd]?$/.test(w.text));
const rawJg = (segs) => segs.some((s) => { const w = commandWord(s); return w && /^(?:jg|jevgrep)$/.test(base(w)); });

const VALUE_FLAGS = new Set(["--as", "--role", "--cell", "--mode", "--ticket", "--status", "--pr"]);
const ROLE_FLAGS = new Set(["--as", "--role", "--cell"]);

function isBoardCall(seg) {
  const words = seg.map((w) => w.text);
  if (words.some((w) => /(?:^|\/)(?:board|agent-start|den-cli)\.mjs$/.test(w))) return true;
  if (commandWord(seg)?.text.split("/").at(-1) === "den" && words.includes("board")) return true;
  const run = words.findIndex((w) => w === "run" || w === "run-script");
  return commandWord(seg)?.text === "npm" && run !== -1 && words.slice(run + 1).find((w) => !w.startsWith("-")) === "board";
}

// Roles a board call signs as: --as/--role/--cell values, and claim/reclaim's role positional.
function signedRoles(seg) {
  const roles = [];
  const positionals = [];
  for (let i = 0; i < seg.length; i++) {
    const w = seg[i];
    const [flag, value] = w.text.split(/=(.*)/s);
    if (VALUE_FLAGS.has(flag)) {
      const v = value ?? seg[++i]?.text;
      if (ROLE_FLAGS.has(flag)) roles.push(v);
    } else if (!w.text.startsWith("-")) positionals.push(w.text);
  }
  const verb = positionals.findIndex((p) => p === "claim" || p === "reclaim");
  if (verb !== -1 && positionals[verb + 2] !== undefined) roles.push(positionals[verb + 2]);
  return roles;
}

const signsAsOther = (segs, role) =>
  segs.some((seg) => isBoardCall(seg) && signedRoles(seg).some((r) => r !== role));

const RULES = [
  {
    // A worker signs board writes as its own role; the board trusts --as, so identity is checked here.
    // String check like the jg rule: indirection can bypass it.
    test: (command, input) =>
      isBoardRole(bareRole(input.agent_type)) && signsAsOther(segments(command), bareRole(input.agent_type)),
    reason: "bash-guard: a board call signs as your own role only (--as and claim must name your agent_type). Relay another role's verdict through the chief of staff as a plain comment.",
  },
  {
    test: (command) => rawJg(segments(command)),
    reason: "bash-guard: raw jg calls are blocked. Use the wrapper: node scripts/jg.mjs \"<question>\" [root] (organism-infra/80).",
  },
];

export function check(input) {
  if (input?.tool_name !== "Bash") return null;
  const command = String(input.tool_input?.command ?? "");
  return RULES.find((r) => r.test(command, input))?.reason ?? null;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return 0;
  }
  const reason = check(input);
  if (!reason) return 0;
  // Claude Code feeds stderr back to the model on exit 2; stdout carries it for direct callers.
  process.stdout.write(reason + "\n");
  process.stderr.write(reason + "\n");
  return 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
