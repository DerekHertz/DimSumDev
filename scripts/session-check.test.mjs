// Acceptance tests for organism-infra/158, part 2: the end-of-session check.
//
// Interface under test (the seam), pinned by QA:
//   `node scripts/session-check.mjs [--root <dir>]`  (also `npm run session-check`)
//   - Root: --root, else $DEN_ROOT, else the cwd (same rule as next-session).
//   - Clean: exit 0.
//   - Any problem: exit non-zero. Every problem is printed (stdout or stderr),
//     one item each, never just the first, and each item carries the command
//     that fixes it.
//   - A root that is not a git repo has nothing to check: exit 0. (The older
//     next-session tests use plain temp dirs as roots.)
// The three conditions (ticket 158 part 2):
//   A. local main is ahead of origin/main      -> fix: `git push origin main`
//   B. uncommitted or untracked files under a board directory
//      `.scratch/<feature>/...`                -> fix: `git add` + `git commit` it
//   C. a ticket at claimed/in-progress/in-review whose branch, named as
//      "Branch `<name>`" in its latest handoff (highest mtime among
//      `.scratch/<feature>/handoffs/<NN>-*.md`), is missing from origin or
//      behind the local branch                -> fix: `git push -u origin <name>`
//      (missing) or `git push origin <name>` (behind), item names the ticket ref.
//   Tickets at other statuses are ignored.
//
// Criterion map (ticket 158):
//   4 refuses on each of 3 + fix command -> the describe blocks A, B, C
//   (clean pass and "lists all items at once" guard the check from over/under-firing)
//   5 next-session same check            -> scripts/next-session-check.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { advanceBranch, makeBranch, makeSessionRepo, setTicketHandoff, write } from "./session-check-fixture.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(REPO, "scripts", "session-check.mjs");

function check(root) {
  const env = { ...process.env };
  delete env.DEN_ROOT;
  const r = spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8", timeout: 20_000, env });
  return { ...r, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

let repo;
function fresh() {
  if (repo) repo.cleanup();
  repo = makeSessionRepo();
  return repo;
}
after(() => repo?.cleanup());

describe("session-check: package script and clean state", () => {
  it("npm run session-check points at scripts/session-check.mjs", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
    assert.match(pkg.scripts["session-check"] ?? "", /scripts\/session-check\.mjs/);
  });

  it("a fully committed and pushed repo passes", () => {
    const r = check(fresh().root);
    assert.equal(r.status, 0, r.out);
  });

  it("a root that is not a git repo passes (nothing to check)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "session-nogit-"));
    try {
      const r = check(dir);
      assert.equal(r.status, 0, r.out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dirty files outside .scratch do not trigger a refusal", () => {
    const rp = fresh();
    write(rp.root, "scratch-notes.txt", "not a board file\n");
    write(rp.root, "README.md", "edited\n");
    const r = check(rp.root);
    assert.equal(r.status, 0, r.out);
  });
});

describe("session-check A: local main ahead of origin/main", () => {
  it("refuses and prints the push command", () => {
    const rp = fresh();
    write(rp.root, "code.txt", "unpushed\n");
    rp.commit("local only");
    const r = check(rp.root);
    assert.notEqual(r.status, 0, "must refuse");
    assert.match(r.out, /main/);
    assert.match(r.out, /ahead/i);
    assert.ok(r.out.includes("git push origin main"), r.out);
  });

  it("passes again once main is pushed", () => {
    const rp = fresh();
    write(rp.root, "code.txt", "unpushed\n");
    rp.commit("local only");
    rp.push();
    assert.equal(check(rp.root).status, 0);
  });
});

describe("session-check B: uncommitted or untracked board files", () => {
  it("refuses an untracked file under a feature directory, naming it and the fix", () => {
    const rp = fresh();
    write(rp.root, ".scratch/sample/issues/02-new-ticket.md", "# 02\n");
    const r = check(rp.root);
    assert.notEqual(r.status, 0, "must refuse");
    assert.ok(r.out.includes(".scratch/sample/issues/02-new-ticket.md"), r.out);
    assert.match(r.out, /git add/);
    assert.match(r.out, /git commit/);
  });

  it("refuses an uncommitted edit to a tracked board file", () => {
    const rp = fresh();
    write(rp.root, ".scratch/sample/issues/01-thing.md", "# 01 edited, not committed\n");
    const r = check(rp.root);
    assert.notEqual(r.status, 0);
    assert.ok(r.out.includes(".scratch/sample/issues/01-thing.md"), r.out);
    assert.match(r.out, /git add/);
  });

  it("refuses an untracked handoff", () => {
    const rp = fresh();
    write(rp.root, ".scratch/sample/handoffs/01-qa-specify.md", "handoff\n");
    const r = check(rp.root);
    assert.notEqual(r.status, 0);
    assert.ok(r.out.includes(".scratch/sample/handoffs/01-qa-specify.md"), r.out);
  });
});

describe("session-check C: in-flight ticket whose branch is not on origin", () => {
  for (const status of ["claimed", "in-review"]) {
    it(`${status}: branch missing from origin is refused, with the ticket ref and push -u command`, () => {
      const rp = fresh();
      makeBranch(rp, "feat/unpushed-thing");
      setTicketHandoff(rp, status, "feat/unpushed-thing");
      const r = check(rp.root);
      assert.notEqual(r.status, 0, "must refuse");
      assert.ok(r.out.includes("sample/01-thing"), r.out);
      assert.ok(r.out.includes("feat/unpushed-thing"), r.out);
      assert.ok(r.out.includes("git push -u origin feat/unpushed-thing"), r.out);
    });
  }

  it("branch on origin but behind the local branch is refused with the push command", () => {
    const rp = fresh();
    makeBranch(rp, "feat/behind-thing", { push: true });
    advanceBranch(rp, "feat/behind-thing");
    setTicketHandoff(rp, "in-review", "feat/behind-thing");
    const r = check(rp.root);
    assert.notEqual(r.status, 0, "must refuse");
    assert.ok(r.out.includes("sample/01-thing"), r.out);
    assert.match(r.out, /behind/i);
    assert.ok(r.out.includes("git push origin feat/behind-thing"), r.out);
  });

  it("branch pushed and level with local passes", () => {
    const rp = fresh();
    makeBranch(rp, "feat/pushed-thing", { push: true });
    setTicketHandoff(rp, "in-review", "feat/pushed-thing");
    const r = check(rp.root);
    assert.equal(r.status, 0, r.out);
  });

  it("a resolved ticket with an unpushed branch is ignored", () => {
    const rp = fresh();
    makeBranch(rp, "feat/old-thing");
    setTicketHandoff(rp, "resolved", "feat/old-thing");
    const r = check(rp.root);
    assert.equal(r.status, 0, r.out);
  });

  it("uses the latest handoff: an old handoff's unpushed branch is ignored", () => {
    const rp = fresh();
    makeBranch(rp, "feat/stale-branch"); // unpushed, named only by the old handoff
    makeBranch(rp, "feat/current-branch", { push: true });
    setTicketHandoff(rp, "in-review", "feat/stale-branch", {
      handoffName: "01-qa-specify.md",
      mtime: new Date("2026-10-01T00:00:00Z"),
    });
    setTicketHandoff(rp, "in-review", "feat/current-branch", {
      handoffName: "01-developer.md",
      mtime: new Date("2026-10-05T00:00:00Z"),
    });
    const r = check(rp.root);
    assert.equal(r.status, 0, r.out);
  });
});

describe("session-check: several problems at once", () => {
  it("lists every condition in one run, each with its fix command", () => {
    const rp = fresh();
    makeBranch(rp, "feat/unpushed-thing");
    setTicketHandoff(rp, "in-review", "feat/unpushed-thing");
    write(rp.root, "code.txt", "unpushed\n");
    rp.commit("local only"); // A
    write(rp.root, ".scratch/sample/issues/02-new-ticket.md", "# 02\n"); // B
    const r = check(rp.root);
    assert.notEqual(r.status, 0);
    assert.ok(r.out.includes("git push origin main"), `A missing: ${r.out}`);
    assert.ok(r.out.includes(".scratch/sample/issues/02-new-ticket.md"), `B missing: ${r.out}`);
    assert.ok(r.out.includes("git push -u origin feat/unpushed-thing"), `C missing: ${r.out}`);
  });
});
