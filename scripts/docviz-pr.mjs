#!/usr/bin/env node
// portable-den/09: put docviz's pull-request diagram on a PR as one comment that later pushes update.
//   node scripts/docviz-pr.mjs <steps.json> --pr <url> [--title T] [--glossary FILE]
// Run from the PR's checkout after pushing. The `pr-writing` skill calls it, and the bridge's delivery imports the same
// functions. It uses node built-ins only, so a copy of it runs from the den plugin's bin/ in any repo.
//   docviz not on PATH -> prints "skipped: ..." and exits 0.   docviz fails -> a one-line note replaces the comment, exits 0.
//   gh fails -> exits 2.
//   --body-line prints the line the PR body carries about the diagram ("skipped" when docviz is absent); run it before opening the PR.
// `exec` is a test seam with execFile's promise shape: (file, args, options) -> Promise<{ stdout, stderr }>.
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
export const MARKER = "<!-- docviz-pr-diagrams -->"; // the first line of docviz pr's output: how a later push finds its comment
const COMMENT_MAX = 60000; // GitHub refuses a comment past 65536 characters

const oneLine = (v, max = 300) => String(v ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, max);

export function onPath(name = "docviz", env = process.env) {
  return (env.PATH ?? "").split(path.delimiter).filter(Boolean).some((dir) => {
    try {
      accessSync(path.join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** `https://github.com/o/r/pull/7` -> { repo: "o/r", number: 7 } */
export function parsePr(url) {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,9})(?:[/?#].*)?$/.exec(String(url));
  if (!m) throw new Error(`not a pull request url: ${oneLine(url, 100)}`);
  return { repo: m[1], number: Number(m[2]) };
}

/** The one-line comment that stands in for a diagram that could not be made. It carries the marker, so the next push replaces it. */
export const noteComment = (reason) => `${MARKER}\nNo diagram on this push: ${oneLine(reason)}\n`;

/** Runs `docviz pr` in `cwd`. -> the comment text; throws with docviz's own one-line reason. */
export async function runDocviz({ stepsFile, prUrl, title, glossaryFile, cwd, env = process.env, exec = execFileP }) {
  const args = ["pr", stepsFile, "--pr", prUrl, ...(title ? ["--title", title] : []), ...(glossaryFile ? ["--glossary", glossaryFile] : [])];
  let stdout;
  try {
    ({ stdout } = await exec("docviz", args, { cwd, env, timeout: 15 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }));
  } catch (err) {
    const lines = String(err?.stderr || err?.message || err).split("\n").filter((l) => l.trim() && !/^cost:/.test(l));
    throw new Error(oneLine(lines[0] ?? "docviz failed"));
  }
  const body = String(stdout);
  if (body.split("\n", 1)[0].trim() !== MARKER) throw new Error("docviz printed no diagram comment");
  return body.slice(0, COMMENT_MAX);
}

/** Posts `body` as the marked comment of a pull request, or edits the one a former push left. Only a comment of the caller's own login is edited. gh(...args) -> Promise<stdout>. */
export async function upsertComment({ gh, repo = "{owner}/{repo}", number, body }) {
  const login = String(await gh("api", "user", "--jq", ".login")).trim();
  if (!/^[\w-]{1,39}$/.test(login)) throw new Error("the git host gave no usable login");
  const listed = await gh("api", `repos/${repo}/issues/${number}/comments`, "--paginate", "--jq", `.[] | select(.user.login == "${login}" and (.body | startswith("${MARKER}"))) | .id`);
  const id = String(listed).split("\n").map((l) => l.trim()).find((l) => /^\d+$/.test(l));
  if (id) {
    await gh("api", "-X", "PATCH", `repos/${repo}/issues/comments/${id}`, "-f", `body=${body}`);
    return "updated";
  }
  await gh("api", `repos/${repo}/issues/${number}/comments`, "-f", `body=${body}`);
  return "posted";
}

/** The Evidence line of a PR body about the diagram. */
export const bodyLine = (env = process.env) =>
  onPath("docviz", env) ? "- Diagram: a docviz comment follows on the pull request" : "- Diagram: skipped, docviz is not on PATH";

/** The diagram, or the note that says why there is none. -> { body, failed: reason | null } */
export async function diagramOrNote(run) {
  try {
    return { body: await run(), failed: null };
  } catch (err) {
    return { body: noteComment(err?.message), failed: oneLine(err?.message) };
  }
}

export async function main(argv, { exec = execFileP, env = process.env, cwd = process.cwd(), out = (s) => console.log(s) } = {}) {
  if (argv.includes("--body-line")) {
    out(bodyLine(env));
    return 0;
  }
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) opts[argv[i].slice(2)] = argv[(i += 1)];
    else opts._.push(argv[i]);
  }
  if (!opts._[0] || !opts.pr) {
    out("usage: docviz-pr.mjs <steps.json> --pr <url> [--title T] [--glossary FILE]");
    return 1;
  }
  if (!onPath("docviz", env)) {
    out("skipped: docviz is not on PATH, so this pull request has no diagram comment");
    return 0;
  }
  const { repo, number } = parsePr(opts.pr);
  const glossaryFile = opts.glossary ?? (existsSync(path.join(cwd, "CONTEXT.md")) ? "CONTEXT.md" : undefined);
  const { body, failed } = await diagramOrNote(() => runDocviz({ stepsFile: opts._[0], prUrl: opts.pr, title: opts.title, glossaryFile, cwd, env, exec }));
  const gh = async (...args) => String((await exec("gh", args, { cwd, env, maxBuffer: 8 * 1024 * 1024 })).stdout);
  try {
    out(`${await upsertComment({ gh, repo, number, body })}: ${failed ? `docviz failed (${failed}); a one-line note stands in` : "diagram comment"} on ${repo}#${number}`);
  } catch (err) {
    out(`failed: could not post the comment (${oneLine(err?.stderr || err?.message)})`);
    return 2;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
