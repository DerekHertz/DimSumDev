// organism-infra/202: the S6b comparison run uses the main checkout as its cwd with a temporary allow in
// .claude/settings.local.json. Nothing that already existed there may be lost: the owner's own
// settings.local.json, allowed.txt and the deny target all come back byte for byte. Every test uses a temp
// directory as the fake checkout; the real main checkout is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runSpikes } from "./conformance.mjs";

// A child that never writes allowed.txt in the S6b worktree (so the control's allow is absent and the
// comparisons run). Options, baked in as JSON:
//   writeInCheckout: when its cwd is not the worktree, it writes allowed.txt and denied.txt there
//   hangInCheckout:  when its cwd is not the worktree, it never answers (the turn times out; the parent does not throw)
//   throwViaOut:     when its cwd is not the worktree, it puts a directory at this path, so the parent throws when it saves the capture
//   breakLocalRestore: when its cwd is not the worktree, it clobbers allowed.txt and denied.txt and puts a directory where
//                    settings.local.json was, so restoring settings.local.json fails
// Every start is appended to o.log as "<cwd>\n" so a test can tell which comparisons actually ran.
const fakeSource = (o) => `#!/usr/bin/env node
import readline from "node:readline";
import { writeFileSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
const o = ${JSON.stringify(o)};
const args = process.argv.slice(2);
const sid = args[args.indexOf("--session-id") + 1];
const out = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
const inWorktree = process.cwd().includes("/.claude/worktrees/");
appendFileSync(o.log, process.cwd() + (inWorktree ? " (worktree)" : " (checkout)") + "\\n");
readline.createInterface({ input: process.stdin }).on("line", () => {
  if (!inWorktree && o.hangInCheckout) return;
  if (!inWorktree && o.throwViaOut) {
    // Make the probe's capture file unwritable (a directory sits at its path), so the parent throws right after this child is killed.
    mkdirSync(o.throwViaOut, { recursive: true });
  }
  if (!inWorktree && o.breakLocalRestore) {
    // Make the restore of settings.local.json itself fail (a directory sits at its path).
    rmSync(".claude/settings.local.json", { force: true });
    mkdirSync(".claude/settings.local.json");
  }
  if (!inWorktree && (o.writeInCheckout || o.breakLocalRestore)) {
    writeFileSync("allowed.txt", "CLOBBERED-BY-PROBE");
    writeFileSync("denied.txt", "CLOBBERED-BY-PROBE");
  }
  out({ type: "system", subtype: "init", permissionMode: "default", session_id: sid, mcp_servers: [] });
  out({ type: "result", subtype: "success", is_error: false, result: "PROBE-ROLE-OK", session_id: sid });
}).on("close", () => process.exit(0));
setInterval(() => {}, 1000);
`;

// A throwaway git repository standing in for the main checkout; settings.local.json is ignored like the real one.
function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "c6restore-repo-"));
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  writeFileSync(path.join(repo, ".gitignore"), ".claude/settings.local.json\n");
  git("add", ".gitignore");
  git("commit", "-q", "-m", "init");
  return { repo, git };
}

const status = (repo) => execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim();

async function runS6bWith(repo, fakeOpts) {
  const dir = mkdtempSync(path.join(tmpdir(), "c6restore-"));
  const log = path.join(dir, "starts.log");
  writeFileSync(log, "");
  const fake = path.join(dir, "fake-claude.mjs");
  const throwViaOut = fakeOpts.throwMidProbe ? path.join(dir, "out", "S6b-compare-repo.jsonl") : undefined;
  writeFileSync(fake, fakeSource({ ...fakeOpts, log, throwViaOut }));
  chmodSync(fake, 0o755);
  const [r] = await runSpikes({ spikes: ["S6b"], out: path.join(dir, "out"), claudeBin: fake, env: { PATH: process.env.PATH, HOME: dir }, repo, timeoutMs: fakeOpts.hangInCheckout ? 1500 : 10_000, log: () => {} });
  const starts = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return { r, starts, evidence: (r.evidence ?? []).join("\n"), controlEvidence: (r.control?.evidence ?? []).join("\n") };
}

// The comparison against the main checkout must really have run; a verdict alone does not prove it, since
// the control's allow is already absent before the comparisons start.
function assertCheckoutProbeRan({ starts }) {
  assert.ok(starts.some((l) => l.endsWith("(checkout)")), `no child was started in the main checkout; starts: ${JSON.stringify(starts)}`);
}

test("runSpikes S6b: the main checkout's own settings.local.json is restored byte for byte after the comparison", async () => {
  const { repo } = makeRepo();
  mkdirSync(path.join(repo, ".claude"), { recursive: true });
  const original = '{\n  "permissions": { "allow": ["Bash(ls)"] }\n}\n';
  const local = path.join(repo, ".claude", "settings.local.json");
  writeFileSync(local, original);
  const run = await runS6bWith(repo, {});
  assert.equal(run.r.verdict, "setup-invalid");
  assertCheckoutProbeRan(run);
  assert.match(run.evidence, /comparison 2 \(main checkout/);
  assert.equal(readFileSync(local, "utf8"), original);
  assert.equal(status(repo), "");
});

test("runSpikes S6b: a settings.local.json that did not exist beforehand is removed again after the comparison", async () => {
  const { repo } = makeRepo();
  const local = path.join(repo, ".claude", "settings.local.json");
  assert.equal(existsSync(local), false);
  const run = await runS6bWith(repo, {});
  assertCheckoutProbeRan(run);
  assert.match(run.evidence, /comparison 2 \(main checkout/);
  assert.equal(existsSync(local), false, "the temporary settings.local.json was left in the main checkout");
  assert.equal(status(repo), "");
});

test("runSpikes S6b: a probe that never answers (turn times out) still restores settings.local.json", async () => {
  const { repo } = makeRepo();
  mkdirSync(path.join(repo, ".claude"), { recursive: true });
  const original = '{"permissions":{"allow":["Bash(pwd)"]}}';
  const local = path.join(repo, ".claude", "settings.local.json");
  writeFileSync(local, original);
  // The child in the main checkout never answers, so the probe's turn times out (waitFor resolves null; nothing throws).
  const run = await runS6bWith(repo, { hangInCheckout: true });
  assertCheckoutProbeRan(run);
  assert.notEqual(run.r.verdict, "go");
  assert.equal(readFileSync(local, "utf8"), original);
  assert.equal(status(repo), "");
});

test("runSpikes S6b: a probe that never answers also leaves no settings.local.json that was not there before", async () => {
  const { repo } = makeRepo();
  const local = path.join(repo, ".claude", "settings.local.json");
  const run = await runS6bWith(repo, { hangInCheckout: true });
  assertCheckoutProbeRan(run);
  assert.equal(existsSync(local), false);
});

// These tests make compareS6bAllow itself throw inside its try block (the capture file cannot be written), so
// the finally is what puts the checkout back.
test("runSpikes S6b: a throw mid-probe restores settings.local.json, allowed.txt and denied.txt byte for byte", async () => {
  const { repo, git } = makeRepo();
  mkdirSync(path.join(repo, ".claude"), { recursive: true });
  const original = '{"permissions":{"allow":["Bash(pwd)"]}}';
  const local = path.join(repo, ".claude", "settings.local.json");
  const allowed = path.join(repo, "allowed.txt");
  const denied = path.join(repo, "denied.txt");
  const allowedBytes = Buffer.from([0x6f, 0x77, 0x6e, 0x65, 0x72, 0x00, 0xff]);
  const deniedBytes = Buffer.from("tracked, no newline");
  writeFileSync(local, original);
  writeFileSync(allowed, allowedBytes);
  writeFileSync(denied, deniedBytes);
  git("add", "denied.txt");
  git("commit", "-q", "-m", "add denied.txt");
  const statusBefore = status(repo);
  const run = await runS6bWith(repo, { throwMidProbe: true, writeInCheckout: true });
  assertCheckoutProbeRan(run);
  assert.match(run.controlEvidence, /could not run the control/, "the probe did not throw");
  assert.equal(readFileSync(local, "utf8"), original);
  assert.deepEqual(readFileSync(allowed), allowedBytes);
  assert.deepEqual(readFileSync(denied), deniedBytes);
  assert.equal(status(repo), statusBefore);
});

test("runSpikes S6b: a throw mid-probe removes the files the probe made when none existed before", async () => {
  const { repo } = makeRepo();
  const run = await runS6bWith(repo, { throwMidProbe: true, writeInCheckout: true });
  assertCheckoutProbeRan(run);
  assert.match(run.controlEvidence, /could not run the control/, "the probe did not throw");
  assert.equal(existsSync(path.join(repo, ".claude", "settings.local.json")), false);
  assert.equal(existsSync(path.join(repo, "allowed.txt")), false);
  assert.equal(existsSync(path.join(repo, "denied.txt")), false);
  assert.equal(status(repo), "");
});

test("runSpikes S6b: when restoring settings.local.json fails, allowed.txt and denied.txt are still restored and the failure is reported", async () => {
  const { repo, git } = makeRepo();
  mkdirSync(path.join(repo, ".claude"), { recursive: true });
  const local = path.join(repo, ".claude", "settings.local.json");
  const allowed = path.join(repo, "allowed.txt");
  const denied = path.join(repo, "denied.txt");
  const allowedBytes = Buffer.from("owner allowed\n");
  const deniedBytes = Buffer.from("owner denied");
  writeFileSync(local, "{}");
  writeFileSync(allowed, allowedBytes);
  writeFileSync(denied, deniedBytes);
  git("add", "denied.txt");
  git("commit", "-q", "-m", "add denied.txt");
  const run = await runS6bWith(repo, { breakLocalRestore: true });
  assertCheckoutProbeRan(run);
  assert.match(run.controlEvidence, /could not run the control: S6b could not restore the main checkout.*settings\.local\.json/, "the failed restore was not reported");
  assert.deepEqual(readFileSync(allowed), allowedBytes, "allowed.txt was skipped after the first restore failed");
  assert.deepEqual(readFileSync(denied), deniedBytes, "denied.txt was skipped after the first restore failed");
});

test("runSpikes S6b: an allowed.txt and a denied.txt that already exist in the main checkout survive the comparison byte for byte", async () => {
  const { repo, git } = makeRepo();
  const allowed = path.join(repo, "allowed.txt");
  const denied = path.join(repo, "denied.txt");
  const allowedBytes = Buffer.from([0x6f, 0x77, 0x6e, 0x65, 0x72, 0x0a, 0x00, 0xff, 0xfe, 0x0d, 0x0a]); // not valid UTF-8
  const deniedBytes = Buffer.from("tracked content, no trailing newline");
  writeFileSync(allowed, allowedBytes); // untracked
  writeFileSync(denied, deniedBytes); // tracked
  git("add", "denied.txt");
  git("commit", "-q", "-m", "add denied.txt");
  const statusBefore = status(repo);
  const run = await runS6bWith(repo, { writeInCheckout: true });
  assert.ok(existsSync(allowed), "allowed.txt was deleted");
  assert.ok(existsSync(denied), "denied.txt was deleted");
  assert.deepEqual(readFileSync(allowed), allowedBytes, "allowed.txt was overwritten");
  assert.deepEqual(readFileSync(denied), deniedBytes, "denied.txt was overwritten");
  assert.equal(status(repo), statusBefore);
  // Either the comparison ran and put the files back, or it refused to run and said so. Silence is not allowed.
  const ran = run.starts.some((l) => l.endsWith("(checkout)"));
  assert.ok(ran || /comparison 2.*(skipped|refus|not run)/i.test(run.evidence), `the comparison neither ran nor reported that it was skipped: ${run.evidence}`);
});

test("runSpikes S6b: files the probe made in the main checkout that did not exist before are deleted", async () => {
  const { repo } = makeRepo();
  const run = await runS6bWith(repo, { writeInCheckout: true });
  assertCheckoutProbeRan(run);
  assert.equal(existsSync(path.join(repo, "allowed.txt")), false);
  assert.equal(existsSync(path.join(repo, "denied.txt")), false);
  assert.equal(status(repo), "");
});

test("runSpikes S6b: the comparison probe reaches the main checkout (this fails if the comparison is skipped)", async () => {
  const { repo } = makeRepo();
  const run = await runS6bWith(repo, {});
  assertCheckoutProbeRan(run);
  assert.match(run.evidence, /comparison 1 \(worktree cwd/);
  assert.match(run.evidence, /comparison 2 \(main checkout/);
  rmSync(repo, { recursive: true, force: true });
});
