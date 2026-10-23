// Acceptance tests for organism-infra/158, criterion 5: `npm run next-session`
// runs the same end-of-session check as scripts/session-check.mjs (see
// scripts/session-check.test.mjs for the pinned conditions) and refuses the
// same way.
//
// Pinned: on a refusal next-session exits non-zero, prints each item with its
// fix command (stdout or stderr), prints NO `claude --agent ...` command, and
// with --run never starts claude. On a clean repo it behaves as before. A root
// that is not a git repo is unchecked (the existing next-session tests rely on
// that).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeBranch, makeSessionRepo, setTicketHandoff, write } from "./session-check-fixture.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(REPO, "scripts", "next-session.mjs");
const HANDOFF = "2026-10-06-orchestrator-1.md";

const repos = [];
const tmps = [];
after(() => {
  for (const r of repos) r.cleanup();
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

// A clean, pushed repo that already has an orchestrator session handoff.
function readyRepo() {
  const rp = makeSessionRepo();
  repos.push(rp);
  write(rp.root, `.scratch/_handoffs/${HANDOFF}`, "# handoff\n");
  rp.commit("orchestrator handoff");
  rp.push();
  return rp;
}

function stubClaude() {
  const bin = mkdtempSync(path.join(tmpdir(), "next-session-check-bin-"));
  tmps.push(bin);
  const out = path.join(bin, "argv.json");
  const stub = path.join(bin, "claude");
  writeFileSync(
    stub,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.env.STUB_OUT, JSON.stringify(process.argv.slice(2)));\n`,
  );
  chmodSync(stub, 0o755);
  return { bin, out };
}

function run(root, extra = [], env = {}) {
  const base = { ...process.env };
  delete base.DEN_ROOT;
  const r = spawnSync(process.execPath, [SCRIPT, "--root", root, ...extra], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...base, ...env },
  });
  return { ...r, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("next-session runs the end-of-session check", () => {
  it("a clean, pushed repo still prints the launch command", () => {
    const rp = readyRepo();
    const r = run(rp.root);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /claude --agent chief-of-staff /);
    assert.ok(r.stdout.includes(HANDOFF), r.stdout);
  });

  it("refuses when local main is ahead of origin/main, with the push command", () => {
    const rp = readyRepo();
    write(rp.root, "code.txt", "unpushed\n");
    rp.commit("local only");
    const r = run(rp.root);
    assert.notEqual(r.status, 0, "must refuse");
    assert.ok(!/claude --agent/.test(r.stdout), `no launch command on refusal: ${r.stdout}`);
    assert.ok(r.out.includes("git push origin main"), r.out);
  });

  it("refuses an untracked board file, naming it and the fix", () => {
    const rp = readyRepo();
    write(rp.root, ".scratch/sample/issues/02-new-ticket.md", "# 02\n");
    const r = run(rp.root);
    assert.notEqual(r.status, 0);
    assert.ok(!/claude --agent/.test(r.stdout), r.stdout);
    assert.ok(r.out.includes(".scratch/sample/issues/02-new-ticket.md"), r.out);
    assert.match(r.out, /git add/);
  });

  it("refuses an in-review ticket whose branch is missing from origin, with the push -u command", () => {
    const rp = readyRepo();
    makeBranch(rp, "feat/unpushed-thing");
    setTicketHandoff(rp, "in-review", "feat/unpushed-thing");
    const r = run(rp.root);
    assert.notEqual(r.status, 0);
    assert.ok(!/claude --agent/.test(r.stdout), r.stdout);
    assert.ok(r.out.includes("sample/01-thing"), r.out);
    assert.ok(r.out.includes("git push -u origin feat/unpushed-thing"), r.out);
  });

  it("with --run, a refusal never starts claude", () => {
    const rp = readyRepo();
    write(rp.root, "code.txt", "unpushed\n");
    rp.commit("local only");
    const { bin, out } = stubClaude();
    const r = run(rp.root, ["--run"], { PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_OUT: out });
    assert.notEqual(r.status, 0, "must refuse");
    assert.equal(existsSync(out), false, "claude must not be started");
  });

  it("lists all problems in one run", () => {
    const rp = readyRepo();
    write(rp.root, "code.txt", "unpushed\n");
    rp.commit("local only");
    write(rp.root, ".scratch/sample/issues/02-new-ticket.md", "# 02\n");
    const r = run(rp.root);
    assert.notEqual(r.status, 0);
    assert.ok(r.out.includes("git push origin main"), r.out);
    assert.ok(r.out.includes(".scratch/sample/issues/02-new-ticket.md"), r.out);
  });
});
