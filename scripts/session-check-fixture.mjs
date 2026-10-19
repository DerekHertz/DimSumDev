// Test-only helper for organism-infra/158 end-of-session check tests.
// Builds a disposable "main checkout" with a local bare repo as `origin`, with
// one board ticket and a published handoff committed and pushed, so a test can
// dirty exactly one condition at a time. Not a test file (no .test.mjs suffix).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function git(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

export function write(root, rel, text, mtime) {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
  if (mtime) utimesSync(p, mtime, mtime);
  return p;
}

export function ticketText(status) {
  return `# 01: thing\n\n**Type:** feature\n\n**Status:** ${status}\n\n## Comments\n`;
}

// Handoff naming a branch the way real handoffs do: prose `Branch \`name\``.
export function handoffText(ref, branch) {
  const state = { ticket: ref, role: "developer", current_step: "done", artifacts: [], decisions: [], failures: [], pending: [] };
  return "```json\n" + JSON.stringify(state) + "\n```\n\n" + `Branch \`${branch}\`, commit abc1234.\n`;
}

// Everything committed and pushed: the check must pass on this repo untouched.
export function makeSessionRepo() {
  const bare = mkdtempSync(path.join(tmpdir(), "session-origin-"));
  const root = mkdtempSync(path.join(tmpdir(), "session-main-"));
  git(bare, ["init", "-q", "--bare", "-b", "main"]);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "qa@example.com"]);
  git(root, ["config", "user.name", "QA Fixture"]);
  git(root, ["remote", "add", "origin", bare]);
  write(root, "README.md", "fixture\n");
  write(root, ".scratch/sample/issues/01-thing.md", ticketText("ready-for-agent"));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed"]);
  git(root, ["push", "-q", "-u", "origin", "main"]);
  return {
    root,
    bare,
    ref: "sample/01-thing",
    commit(message) {
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", message]);
    },
    push: () => git(root, ["push", "-q", "origin", "main"]),
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    },
  };
}

// Sets the ticket's status and publishes a handoff naming `branch`; commits and
// pushes main so only the branch state under test is out of step.
export function setTicketHandoff(repo, status, branch, { handoffName = "01-developer.md", mtime } = {}) {
  write(repo.root, ".scratch/sample/issues/01-thing.md", ticketText(status));
  write(repo.root, `.scratch/sample/handoffs/${handoffName}`, handoffText(repo.ref, branch), mtime);
  repo.commit(`ticket ${status}, handoff names ${branch}`);
  repo.push();
}

// A local branch with one extra commit, optionally pushed to origin.
export function makeBranch(repo, name, { push = false } = {}) {
  git(repo.root, ["checkout", "-q", "-b", name]);
  write(repo.root, `${name.replaceAll("/", "-")}.txt`, "work\n");
  git(repo.root, ["add", "-A"]);
  git(repo.root, ["commit", "-q", "-m", `work on ${name}`]);
  if (push) git(repo.root, ["push", "-q", "-u", "origin", name]);
  git(repo.root, ["checkout", "-q", "main"]);
}

// One more local commit on an existing branch (leaves origin behind).
export function advanceBranch(repo, name) {
  git(repo.root, ["checkout", "-q", name]);
  write(repo.root, `${name.replaceAll("/", "-")}-more.txt`, "more\n");
  git(repo.root, ["add", "-A"]);
  git(repo.root, ["commit", "-q", "-m", `more on ${name}`]);
  git(repo.root, ["checkout", "-q", "main"]);
}
