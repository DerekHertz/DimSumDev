#!/usr/bin/env node
// organism-infra/108: apply the patches agents leave for edits only the user may
// make (.claude/, CLAUDE.md). Run it as `npm run apply-gated`, or
// `!npm run apply-gated` inside Claude Code. See docs/agents/gated-patches.md.
//
//   node scripts/apply-gated.mjs [--root <repoRoot>]
//
// Reads *.patch from <root>/.scratch/_handoffs/gated/ in file-name order. For
// each one it shows the target and the diff, runs `git apply --check`, and
// applies only on an exact `y` answer (read from stdin, one line per prompt).
// An applied patch is committed (only the paths it touches) with its own
// message, then moved to gated/applied/. Patch content is data: every git call
// is execFile with an argument array, there is no shell, and nothing in
// gated/ is ever executed (.sh and .mjs files there are ignored).
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";

// Git calls. `--literal-pathspecs` so a path like `a*b` is never a glob.
function git(root, args, input) {
  try {
    const stdout = execFileSync("git", ["--literal-pathspecs", ...args], {
      cwd: root,
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    return {
      ok: false,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? err.message ?? "").trim(),
    };
  }
}

// Patch text goes to a terminal: drop control characters (escape sequences,
// carriage returns) but keep newlines and tabs.
const printable = (s) => String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "?");

function parseArgs(argv) {
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") {
      if (!argv[i + 1]) throw new Error("--root needs a path");
      root = path.resolve(argv[++i]);
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return root;
}

// Paths a patch touches. `--numstat -z` lists new paths; a rename's old path
// only shows in the `rename from` header, so read those too.
function patchPaths(root, patchFile) {
  const num = git(root, ["apply", "--numstat", "-z", "--", patchFile]);
  if (!num.ok) return { ok: false, error: num.stderr };
  const paths = new Set();
  const tokens = num.stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i]);
    if (!m) continue;
    if (m[3] === "") {
      // Rename or copy in -z form: the next two tokens are old and new path.
      if (tokens[i + 1]) paths.add(tokens[i + 1]);
      if (tokens[i + 2]) paths.add(tokens[i + 2]);
      i += 2;
    } else {
      paths.add(m[3]);
    }
  }
  for (const line of readFileSync(patchFile, "utf8").split("\n")) {
    const r = /^rename from (.+)$/.exec(line);
    if (!r) continue;
    let p = r[1];
    if (p.startsWith('"')) {
      try {
        p = JSON.parse(p);
      } catch {
        return { ok: false, error: `cannot read quoted rename path: ${p}` };
      }
    }
    paths.add(p);
  }
  return { ok: true, paths: [...paths] };
}

// The patch's own commit message, via `git mailinfo` (handles [PATCH], folded
// subjects and the `---` cut). A plain diff has none, so name the patch.
function commitMessage(root, patchFile, stem) {
  const dir = mkdtempSync(path.join(tmpdir(), "apply-gated-"));
  try {
    const info = git(root, ["mailinfo", path.join(dir, "msg"), path.join(dir, "patch")], readFileSync(patchFile));
    const subject = info.ok ? (/^Subject: ?(.*)$/m.exec(info.stdout)?.[1] ?? "").trim() : "";
    const body = existsSync(path.join(dir, "msg")) ? readFileSync(path.join(dir, "msg"), "utf8").trim() : "";
    if (!subject) return body ? `${body}\n\nApplied from gated patch ${stem}` : `Apply gated patch ${stem}`;
    return body ? `${subject}\n\n${body}` : subject;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function listPatches(gated) {
  if (!existsSync(gated)) return [];
  return readdirSync(gated, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".patch"))
    .map((e) => e.name)
    .sort();
}

function moveToApplied(gated, name) {
  const dest = path.join(gated, "applied");
  mkdirSync(dest, { recursive: true });
  let target = path.join(dest, name);
  if (existsSync(target)) {
    const ext = ".patch";
    target = path.join(dest, `${name.slice(0, -ext.length)}.${Date.now()}${ext}`);
  }
  renameSync(path.join(gated, name), target);
  return target;
}

async function main() {
  const root = parseArgs(process.argv.slice(2));
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`root is not a directory: ${root}`);
  if (!git(root, ["rev-parse", "--git-dir"]).ok) throw new Error(`root is not a git repository: ${root}`);

  const gated = path.join(root, ".scratch", "_handoffs", "gated");
  const names = listPatches(gated);
  if (names.length === 0) {
    console.log(`nothing to apply (no *.patch in ${path.relative(root, gated) || gated})`);
    return 0;
  }

  const lines = readline.createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const ask = async (prompt) => {
    process.stdout.write(prompt);
    const { value, done } = await lines.next();
    return done ? "" : String(value).trim();
  };

  let failed = 0;
  let applied = 0;
  for (const name of names) {
    const file = path.join(gated, name);
    console.log(`\n=== ${printable(name)}`);
    console.log(`target: ${printable(root)}`);

    const paths = patchPaths(root, file);
    const check = paths.ok ? git(root, ["apply", "--check", "--", file]) : { ok: false, stderr: paths.error };
    if (!check.ok) {
      failed++;
      console.log(`FAILED: ${printable(name)} does not apply: ${printable(check.stderr)}`);
      console.log("left in place; nothing was changed");
      continue;
    }

    const stat = git(root, ["apply", "--stat", "--", file]);
    console.log(printable(stat.stdout.trimEnd()));
    console.log("--- patch ---");
    console.log(printable(readFileSync(file, "utf8").trimEnd()));
    console.log("--- end ---");

    // The commit takes the patch's paths whole, so refuse if any already
    // carries other uncommitted work that would be swept in with it.
    const dirty = git(root, ["status", "--porcelain", "--", ...paths.paths]);
    if (dirty.ok && dirty.stdout.trim() !== "") {
      failed++;
      console.log(`FAILED: ${printable(name)} touches paths with uncommitted changes; commit or stash them first:`);
      console.log(printable(dirty.stdout.trimEnd()));
      console.log("left in place; nothing was changed");
      continue;
    }

    const answer = await ask(`Apply ${printable(name)} to ${printable(root)}? [y/N] `);
    process.stdout.write("\n");
    if (answer !== "y") {
      console.log(`skipped ${printable(name)} (left in place)`);
      continue;
    }

    const stem = name.slice(0, -".patch".length);
    const message = commitMessage(root, file, stem);
    const apply = git(root, ["apply", "--", file]);
    if (!apply.ok) {
      failed++;
      console.log(`FAILED: git apply: ${printable(apply.stderr)}`);
      continue;
    }
    const add = git(root, ["add", "-A", "--", ...paths.paths]);
    const commit = add.ok ? git(root, ["commit", "-m", message, "--", ...paths.paths]) : add;
    if (!commit.ok) {
      git(root, ["reset", "-q", "--", ...paths.paths]);
      const undo = git(root, ["apply", "-R", "--", file]);
      failed++;
      console.log(`FAILED: commit: ${printable(commit.stderr || commit.stdout)}`);
      console.log(undo.ok ? "reverted the patch; left in place" : `COULD NOT REVERT: ${printable(undo.stderr)}; fix the tree by hand`);
      continue;
    }
    const sha = git(root, ["rev-parse", "--short", "HEAD"]).stdout.trim();
    moveToApplied(gated, name);
    applied++;
    console.log(`applied and committed ${sha}: ${printable(message.split("\n")[0])}`);
    console.log(`moved ${printable(name)} to gated/applied/`);
  }

  console.log(`\n${applied} applied, ${failed} failed, ${names.length - applied - failed} skipped`);
  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`apply-gated: ${err.message}`);
    process.exit(2);
  },
);
