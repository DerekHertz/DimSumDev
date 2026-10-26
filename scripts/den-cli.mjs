#!/usr/bin/env node
// The den kit's one command, usable from any project the `den` plugin runs in:
//   den board <cmd> ...      the board CLI on this project's .scratch/
//   den test <file|dir>...   this project's test command (.den/project.json "test"), files appended
//   den risk-check [range]   the risk check, with this project's .den/project.json paths
//   den status               the board queue for this project
//   den usage [--provider p] plan usage, as scripts/usage.mjs
//   den init                 write .den/project.json and ignore .scratch/ in this project
//   den install              (from the den checkout) link `den` into ~/.local/bin
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEN = path.resolve(path.dirname(realpathSync(fileURLToPath(import.meta.url))), "..");

export const DEFAULT_CONFIG = {
  test: "npm test --",
  codePaths: ["apps", "packages", "scripts", "src", "server", "lib", "app", "api", "web"],
  guardrailPaths: [],
};

export function projectRoot(cwd = process.cwd()) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return cwd;
  }
}

// The config a check trusts is the base ref's (default main), so a branch cannot weaken its own check; a project
// whose base has none yet runs on the defaults, and risk-check flags the new .den/ file.
export function readConfig(root, base = "main") {
  let text = null;
  try {
    text = execFileSync("git", ["show", `${base}:.den/project.json`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {}
  if (text === null) return { ...DEFAULT_CONFIG, ...(root === DEN ? { test: "npm run test:path --" } : {}) };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`.den/project.json on ${base} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(".den/project.json must be a JSON object");
  return { ...DEFAULT_CONFIG, ...parsed };
}

// The main checkout (first `git worktree list` entry): the board lives there, worktree or not.
export function mainCheckout(cwd) {
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" });
    return out.split("\n").find((l) => l.startsWith("worktree "))?.slice(9) ?? projectRoot(cwd);
  } catch {
    return projectRoot(cwd);
  }
}

const baseOf = (range) => (range && !range.startsWith("-") ? range.split(/\.{2,3}/)[0] || "main" : "main");

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: "inherit", ...opts }).status ?? 1;

export function main(argv, cwd = process.cwd()) {
  const [cmd, ...rest] = argv;
  const root = projectRoot(cwd);
  switch (cmd) {
    // Pinned to this project's board: an exported DEN_ROOT from a den session must not redirect it.
    case "board":
    case "status": {
      const env = { ...process.env, DEN_ROOT: mainCheckout(cwd) };
      delete env.ORGANISM_ROOT;
      const args = cmd === "status" ? ["queue", ...rest] : rest;
      return run(process.execPath, [path.join(DEN, "apps/board/board.mjs"), ...args], { cwd, env });
    }
    case "test": {
      if (rest.length === 0) return fail("usage: den test <file|dir>...");
      const { test } = readConfig(root);
      const words = String(test).split(/\s+/).filter(Boolean);
      const env = { ...process.env, INIT_CWD: cwd };
      return run(words[0], [...words.slice(1), ...rest], { cwd: root, env });
    }
    case "risk-check": {
      const own = root === DEN && !existsSync(path.join(root, ".den", "project.json"));
      const cfg = own ? [] : ["--project-config", JSON.stringify(readConfig(root, baseOf(rest[0])))];
      return run(process.execPath, [path.join(DEN, "scripts/risk-check.mjs"), ...rest, ...cfg], { cwd: root });
    }
    case "usage":
      return run(process.execPath, [path.join(DEN, "scripts/usage.mjs"), ...rest], { cwd: DEN });
    case "init":
      return init(root);
    case "install":
      return install();
    default:
      return fail("usage: den <board|test|risk-check|status|usage|init|install> ...");
  }
}

export const CLAUDE_SECTION = `
## Agents (den kit)

This project is built by the den's roles, loaded with \`claude --plugin-dir <den>/.claude\` as \`den:<role>\`. Every agent follows the \`den:team-protocol\` skill.

- Code tickets run a relay: \`developer\` writes the failing tests first, then \`code-reviewer\` and \`qa\` (verify) review the same commit; one fix round carries both reviews. Then \`den risk-check\`: a clean exit skips \`security\`, a hit dispatches it. Push, PR and merge on green CI follow.
- The board is \`.scratch/\` in the main checkout (\`den board\`, \`den status\`); tests run with \`den test <files>\`.

Everything in \`den:team-protocol\` applies here; swap the den's commands for the \`den\` command on PATH:

| In the den | In another project |
|---|---|
| \`npm run board -- <cmd> ...\` | \`den board <cmd> ...\` |
| \`npm run test:path -- <files>\` | \`den test <files>\` (the project's own test command, from \`.den/project.json\`) |
| \`npm run risk-check\` | \`den risk-check\` |
| \`node scripts/usage.mjs --provider claude\` | \`den usage --provider claude\` |

- The risk path is \`.claude/\`, \`CLAUDE.md\`, \`.den/\`, \`.github/\`, dependency and lockfile changes, secrets handling, and every file in \`.den/project.json\`'s \`guardrailPaths\`.
- Den-only tools (\`node scripts/jg.mjs\`, \`node scripts/test-guard.mjs\`, \`npm run pr-map\`, \`npm run -s session-check\`, \`npm run verify:ui\`, \`den:update\`) don't exist there: skip them and say so in your handoff. Den docs (\`docs/agents/*\`, the den's ADRs) are not in that repo; the rules they back are the ones in \`den:team-protocol\` and your role.
- Roles load as \`den:<role>\`; you still sign the board as the bare role (\`--as qa\`, \`claim <ref> qa\`).
- The user approves new dependencies, accounts and keys, changes to \`.claude/\`, \`CLAUDE.md\`, \`.den/\` and CI, and gives every visual verdict.
`;

function init(root) {
  const dir = path.join(root, ".den");
  const file = path.join(dir, "project.json");
  if (existsSync(file)) {
    process.stdout.write(`den: ${path.relative(root, file)} already exists\n`);
  } else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    process.stdout.write(`den: wrote .den/project.json; set "test" to this project's test command\n`);
  }
  const ignore = path.join(root, ".gitignore");
  const lines = existsSync(ignore) ? readFileSync(ignore, "utf8").split("\n") : [];
  if (!lines.some((l) => /^\/?\.scratch\/?$/.test(l.trim()))) appendFileSync(ignore, `${lines.length && lines.at(-1) !== "" ? "\n" : ""}.scratch/\n`);
  mkdirSync(path.join(root, ".scratch"), { recursive: true });
  const claude = path.join(root, "CLAUDE.md");
  if (!existsSync(claude) || !readFileSync(claude, "utf8").includes("## Agents (den kit)")) {
    appendFileSync(claude, CLAUDE_SECTION);
    process.stdout.write("den: added the relay summary to CLAUDE.md\n");
  }
  process.stdout.write(`den: start agents here with: claude --plugin-dir ${path.join(DEN, ".claude")}\n`);
  return 0;
}

function install() {
  const bin = path.join(os.homedir(), ".local", "bin");
  const link = path.join(bin, "den");
  mkdirSync(bin, { recursive: true });
  try {
    unlinkSync(link);
  } catch {}
  symlinkSync(fileURLToPath(import.meta.url), link);
  process.stdout.write(`den: linked ${link}; make sure ${bin} is on PATH\n`);
  return 0;
}

function fail(msg) {
  process.stderr.write(`den: ${msg}\n`);
  return 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`den: ${err.message}\n`);
    process.exit(1);
  }
}
