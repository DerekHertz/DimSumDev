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

export function readConfig(root) {
  const file = path.join(root, ".den", "project.json");
  if (!existsSync(file)) return { ...DEFAULT_CONFIG, ...(root === DEN ? { test: "npm run test:path --" } : {}) };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`.den/project.json is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(".den/project.json must be a JSON object");
  return { ...DEFAULT_CONFIG, ...parsed };
}

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: "inherit", ...opts }).status ?? 1;

export function main(argv, cwd = process.cwd()) {
  const [cmd, ...rest] = argv;
  const root = projectRoot(cwd);
  switch (cmd) {
    case "board":
      return run(process.execPath, [path.join(DEN, "apps/board/board.mjs"), ...rest], { cwd });
    case "status":
      return run(process.execPath, [path.join(DEN, "apps/board/board.mjs"), "queue", ...rest], { cwd });
    case "test": {
      if (rest.length === 0) return fail("usage: den test <file|dir>...");
      const { test } = readConfig(root);
      const words = String(test).split(/\s+/).filter(Boolean);
      const env = { ...process.env, INIT_CWD: cwd };
      return run(words[0], [...words.slice(1), ...rest], { cwd: root, env });
    }
    case "risk-check":
      return run(process.execPath, [path.join(DEN, "scripts/risk-check.mjs"), ...rest], {
        cwd: root,
        // The den's own run keeps its built-in paths unless it opts in with a .den/project.json.
        env: root === DEN && !existsSync(path.join(root, ".den", "project.json"))
          ? process.env
          : { ...process.env, DEN_PROJECT_CONFIG: JSON.stringify(readConfig(root)) },
      });
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
