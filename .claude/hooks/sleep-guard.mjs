#!/usr/bin/env node
// sleep-guard (mods-trial/01): a PreToolUse hook for Bash, shipped as a project-scope plugin.
// Reads the hook JSON on stdin. Exit 2 blocks the call and feeds stderr back to the model; exit 0
// allows it. It hard-blocks a `sleep` in command position chained to another command (; && || | &
// newline) and poll loops (until / while / for ... sleep). A lone `sleep`, and the word "sleep" in
// a path, an argument, a quoted string, a comment or a heredoc body, stay allowed.
//
// No override, by design: an agent cannot bypass the guard, the user disables the mod. Fail open:
// bad input, a crash or a timeout allows the command.
//
// Each block adds a comment on the standing `mods-trial` ticket through the board CLI (a ticket
// in the `mods-trial` feature whose slug ends `-mods-trial`, not yet resolved). Any failure of
// that log is swallowed: the deny never depends on it.
//
// This is a string check, not a shell parser: `bash -c "sleep 5; x"`, `eval`, a script file or a
// variable can slip past. Residual, accepted for the trial (the verdict weighs it).
//
// Self-contained on purpose: an installed plugin may be copied out of the repo.
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const MESSAGE =
  "sleep-guard: a `sleep` chained to another command (sleep N; cmd, sleep N && cmd, a pipe, a poll loop) is blocked. " +
  "Use `gh pr checks --watch` (with a timeout) to wait for CI, or the Monitor tool to wait on any other condition. " +
  "A lone `sleep N` is still allowed.";

// ---- detection ------------------------------------------------------------------------------

// Reduce a command to a skeleton: quoted text, comments, escapes and heredoc bodies become inert
// so only command structure is left to inspect.
function skeleton(command) {
  let out = "";
  let i = 0;
  const n = command.length;
  const pending = []; // heredoc delimiters waiting for their body
  const atWordStart = () => out === "" || /[\s;&|()]/.test(out[out.length - 1]);
  while (i < n) {
    const c = command[i];
    if (c === "\\") {
      if (command[i + 1] === "\n") out += " ";
      else out += "_";
      i += 2;
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      out += "'_'";
      i = end === -1 ? n : end + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && command[j] !== '"') j += command[j] === "\\" ? 2 : 1;
      out += '"_"';
      i = j + 1;
    } else if (c === "#" && atWordStart()) {
      while (i < n && command[i] !== "\n") i++;
    } else if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      const m = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z0-9_]+))/.exec(command.slice(i));
      if (m) {
        pending.push({ word: m[2] ?? m[3] ?? m[4], strip: m[1] === "-" });
        out += " ";
        i += m[0].length;
      } else {
        out += c;
        i++;
      }
    } else if (c === "\n") {
      out += "\n";
      i++;
      while (pending.length) {
        const { word, strip } = pending.shift();
        while (i < n) {
          let end = command.indexOf("\n", i);
          if (end === -1) end = n;
          const line = command.slice(i, end);
          i = Math.min(end + 1, n);
          if ((strip ? line.replace(/^\t+/, "") : line) === word) break;
        }
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Split on command separators. `&` inside a redirection (2>&1, &>, >&) is not a separator.
function segments(skel) {
  const segs = [];
  let cur = "";
  for (let i = 0; i < skel.length; i++) {
    const c = skel[i];
    if (c === "&" && (skel[i - 1] === ">" || skel[i - 1] === "<" || skel[i + 1] === ">")) {
      cur += c;
    } else if (";&|\n()`".includes(c)) {
      segs.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  segs.push(cur);
  return segs;
}

const PREFIX = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{", "time", "exec", "command", "nohup", "builtin"]);
const STRUCTURAL = new Set(["done", "fi", "esac", "}", "do", "then", "else"]);
const LOOPS = new Set(["while", "until", "for", "select"]);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

// The command word of a segment, past loop/conditional keywords and env assignments; null if none.
function commandWord(words) {
  for (const w of words) {
    if (PREFIX.has(w) || ENV_ASSIGN.test(w)) continue;
    return w;
  }
  return null;
}

export function check(command) {
  if (typeof command !== "string" || !/sleep/.test(command)) return null;
  let real = 0;
  let sleeps = 0;
  let loop = false;
  for (const seg of segments(skeleton(command))) {
    const words = seg.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    if (LOOPS.has(words[0])) loop = true;
    if (words.every((w) => STRUCTURAL.has(w))) continue;
    real++;
    const cmd = commandWord(words);
    if (cmd !== null && path.posix.basename(cmd) === "sleep") sleeps++;
  }
  if (!sleeps) return null;
  return real > 1 || loop ? MESSAGE : null;
}

// ---- block log ------------------------------------------------------------------------------

const ROLES = new Set(["developer", "qa", "security", "architect", "designer", "herald", "product", "orchestrator", "scout", "code-reviewer", "release-manager", "sre", "technical-writer"]);
const HEAD_MAX = 200;
const REDACT_INPUT_MAX = 2000; // cap before redact() so a huge command cannot stall the regexes
const STEP_TIMEOUT_MS = 3000;

function findBoard(cwd) {
  const rel = path.join("apps", "board", "board.mjs");
  const starts = [process.env.CLAUDE_PROJECT_DIR, cwd].filter((p) => typeof p === "string" && p);
  for (const start of starts) {
    let dir = path.resolve(start);
    for (;;) {
      const candidate = path.join(dir, rel);
      if (existsSync(candidate)) return candidate;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

function board(boardPath, cwd, args) {
  const r = spawnSync(process.execPath, [boardPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: STEP_TIMEOUT_MS,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.error || r.status !== 0 ? null : r.stdout;
}

// The board is committed and pushed, so a secret in a blocked command must not reach the comment.
// Best effort by shape (assignments, auth headers, secret-named flags, url credentials, known token
// formats); it errs towards over-redacting. A bare high-entropy string with no marker slips through.
const VALUE = String.raw`(?:'[^']*'|"[^"]*"|\S+)`;
const REDACTIONS = [
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi, "$1[redacted]@"],
  [/\b(bearer|basic)\s+[^\s'"]+/gi, "$1 [redacted]"],
  [/(\bauthorization\s*[:=]\s*)(?!bearer\b|basic\b)[^\s'"]+/gi, "$1[redacted]"],
  [new RegExp(String.raw`(--?[\w-]*(?:token|secret|passw|pwd|api[-_]?key|auth|cred)[\w-]*)(=|\s+)${VALUE}`, "gi"), "$1$2[redacted]"],
  [new RegExp(String.raw`((?<![\w-])[A-Za-z_][A-Za-z0-9_]*=)${VALUE}`, "g"), "$1[redacted]"],
  [/\b(?:gh[pousr]_|github_pat_|sk-|xox[abprs]-|AKIA)[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*/g, "[redacted]"],
];

function redact(text) {
  return REDACTIONS.reduce((t, [re, to]) => t.replace(re, to), text);
}

function logBlock(input, command) {
  try {
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    const boardPath = findBoard(cwd);
    if (!boardPath) return;
    const listing = board(boardPath, cwd, ["list", "--feature", "mods-trial"]);
    if (!listing) return;
    let ref = null;
    for (const line of listing.split("\n")) {
      const [r, status] = line.split("\t");
      if (/^mods-trial\/\d+-mods-trial$/.test(r ?? "") && status !== "resolved") ref = r;
    }
    if (!ref) return;
    const agent = typeof input.agent_type === "string" ? input.agent_type.replace(/[^\w-]/g, "").slice(0, 40) : "";
    const as = ROLES.has(agent) ? agent : "orchestrator";
    const source = agent || "main session";
    const head = redact(command.slice(0, REDACT_INPUT_MAX).replace(/\s+/g, " ").replace(/`/g, "'").trim()).slice(0, HEAD_MAX);
    board(boardPath, cwd, ["comment", ref, "--as", as, `sleep-guard blocked (${source}): \`${head}\``]);
  } catch {
    // the log never affects the decision
  }
}

// ---- entry ----------------------------------------------------------------------------------

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return 0;
  }
  if (!input || typeof input !== "object" || input.tool_name !== "Bash") return 0;
  const command = input.tool_input?.command;
  let reason = null;
  try {
    reason = check(command);
  } catch {
    return 0;
  }
  if (!reason) return 0;
  // Claude Code feeds stderr back to the model on exit 2; stdout carries it for direct callers.
  process.stdout.write(reason + "\n");
  process.stderr.write(reason + "\n");
  logBlock(input, command);
  return 2;
}

try {
  process.exitCode = main();
} catch {
  process.exitCode = 0;
}
