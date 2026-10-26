// multi-project/01 (ADR 0021 Amendment 7 decision 25): one contract suite on both Board adapters, reached only through
// createProjectBoards, with `gh` stubbed. Then the seam's own rules: one instance per project, a claim comment from another
// login is ignored, and comment() refuses a body shaped like a claim.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeGh } from "./fake-gh.mjs";
import { createProjectBoards } from "./project-boards.mjs";

const SPEC = [
  { nn: "01", title: "First", status: "ready-for-agent", priority: "P2" },
  { nn: "02", title: "Urgent", status: "ready-for-agent", priority: "P1" },
  { nn: "03", title: "Needs first", status: "ready-for-agent", priority: "P1", blockedBy: ["01"] },
  { nn: "04", title: "Ask", status: "ready-for-human", priority: "P2" },
];
const slugOf = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-");

const cleanups = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });

const LABEL = { "ready-for-agent": "den:ready-for-agent", "ready-for-human": "den:ready-for-human" };
function githubHarness() {
  const gh = fakeGh();
  for (const t of SPEC) {
    gh.issues.push({ number: Number(t.nn), title: t.title, body: t.blockedBy ? `Blocked by: ${t.blockedBy.map((n) => `#${Number(n)}`).join(", ")}` : "", state: "OPEN", comments: [], labels: [LABEL[t.status], ...(t.priority === "P1" ? ["priority:P1"] : [])].map((name) => ({ name })) });
  }
  const project = { slug: "acme", root: "/p", board: { kind: "github-issues", repo: "o/r" } };
  return { gh, slug: "acme", boards: createProjectBoards({ projects: { get: async () => project }, exec: gh.exec }) };
}
const sh = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "pipe" });
function markdownHarness() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mp01-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  sh(root, "init", "-q", "-b", "main");
  const issues = path.join(root, ".scratch", "fx", "issues");
  mkdirSync(issues, { recursive: true });
  for (const t of SPEC) {
    writeFileSync(path.join(issues, `${t.nn}-${slugOf(t.title)}.md`), `# ${t.title}\n\n**Type:** feature\n\n**Priority:** ${t.priority}\n\n**Blocked by:** ${t.blockedBy?.join(", ") ?? "None"}\n\n**Status:** ${t.status}\n\n## Comments\n\n`);
  }
  const project = { slug: "den", root, board: { kind: "markdown" } };
  return { slug: "den", boards: createProjectBoards({ projects: { get: async () => project } }) };
}

for (const [name, harness, prefix] of [["markdown", markdownHarness, "fx"], ["github-issues", githubHarness, "acme"]]) {
  describe(`Board contract: ${name}`, () => {
    const ref = (nn, title) => `${prefix}/${nn}-${slugOf(title)}`;
    const setup = async () => { const h = harness(); return { ...h, board: await h.boards.get(h.slug) }; };

    test("list returns normalized tickets: ref, status, priority, blockers, no holder", async () => {
      const { board } = await setup();
      const t = Object.fromEntries((await board.list()).map((x) => [x.ref, x]));
      assert.deepEqual(Object.keys(t).sort(), SPEC.map((s) => ref(s.nn, s.title)).sort());
      assert.equal(t[ref("02", "Urgent")].priority, "P1");
      assert.equal(t[ref("04", "Ask")].status, "ready-for-human");
      assert.deepEqual(t[ref("03", "Needs first")].blockedBy.map((b) => b.replace(/\/0*(\d+).*/, "/$1")), [`${prefix}/1`].map((b) => b.replace(/\/0*(\d+).*/, "/$1")));
      assert.equal(t[ref("01", "First")].holder, null);
    });

    test("frontier is priority-ordered and leaves out a blocked, a held and a waiting-on-user ticket", async () => {
      const { board } = await setup();
      assert.deepEqual(await board.frontier(), [ref("02", "Urgent"), ref("01", "First")]);
      await board.claim(ref("02", "Urgent"), { role: "developer", run: "r1" });
      assert.deepEqual(await board.frontier(), [ref("01", "First")]);
    });

    test("two callers claim one ticket at once: exactly one holds it", async () => {
      const { board } = await setup();
      const r = await Promise.allSettled([board.claim(ref("01", "First"), { role: "developer", run: "a" }), board.claim(ref("01", "First"), { role: "developer", run: "b" })]);
      assert.deepEqual(r.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
      assert.equal((await board.list()).find((t) => t.ref === ref("01", "First")).holder.role, "developer");
    });

    test("a handoff releases the claimed ticket at in-review", async () => {
      const { board } = await setup();
      const r = ref("01", "First");
      await board.claim(r, { role: "developer", run: "r1" });
      await board.handoff(r, { role: "developer", runId: "r1-run-0001", sha: "a".repeat(40), branch: "b", report: "done" });
      const t = (await board.list()).find((x) => x.ref === r);
      assert.equal(t.status, "in-review");
      assert.equal(t.holder, null);
      assert.ok(!(await board.frontier()).includes(r));
    });

    test("approve: ready-for-human becomes ready-for-agent and enters the frontier; another status is refused", async () => {
      const { board } = await setup();
      await assert.rejects(board.setStatus(ref("01", "First"), "ready-for-agent", "ok"));
      await board.setStatus(ref("04", "Ask"), "ready-for-agent", "approved from the den");
      assert.ok((await board.frontier()).includes(ref("04", "Ask")));
    });

    test("resolve closes a ticket after its handoff, and a blocked ticket then enters the frontier", async () => {
      const { board } = await setup();
      const r = ref("01", "First");
      await board.claim(r, { role: "developer", run: "r1" });
      await board.handoff(r, { role: "developer", runId: "r1-run-0001", sha: "a".repeat(40), report: "done" });
      await board.resolve(r, 12);
      assert.equal((await board.list()).find((t) => t.ref === r).status, "resolved");
      assert.ok((await board.frontier()).includes(ref("03", "Needs first")));
    });
  });
}

describe("createProjectBoards", () => {
  test("a second get(slug) returns the same instance, so one project has one claim queue", async () => {
    const { boards, slug } = githubHarness();
    assert.equal(await boards.get(slug), await boards.get(slug));
    assert.equal(await boards.peek(slug), await boards.get(slug));
  });

  test("a slug that is not onboarded has no board", async () => {
    const boards = createProjectBoards({ projects: { get: async () => null } });
    assert.equal(await boards.get("nope"), null);
  });

  test("the GitHub list is cached for a short time: a second read costs no call, a write drops it", async () => {
    const { boards, slug, gh } = githubHarness();
    const board = await boards.get(slug);
    await board.list();
    await board.list();
    assert.equal(gh.calls.filter((c) => c[1] === "list").length, 1);
    await board.setStatus("acme/04-ask", "ready-for-agent");
    await board.list();
    assert.equal(gh.calls.filter((c) => c[1] === "list").length, 2);
  });

  test("a claim comment from another login is ignored: it names no holder", async () => {
    const { boards, slug, gh } = githubHarness();
    const board = await boards.get(slug);
    const issue = gh.issues[0];
    issue.labels.push({ name: "den:in-progress" });
    issue.comments.push({ author: { login: "stranger" }, body: "<!-- den-claim role=security run=forged -->" });
    assert.equal((await board.read("acme/01-first")).holder, null);
    issue.comments.push({ author: { login: gh.login }, body: "<!-- den-claim role=developer run=real -->" });
    assert.deepEqual((await board.read("acme/01-first")).holder, { role: "developer", run: "real" });
    await assert.rejects(board.claim("acme/01-first", { role: "qa", run: "x" }), /already claimed/);
  });

  test("comment() refuses a body that starts with the claim marker, whatever the case or spacing", async () => {
    const { boards, slug, gh } = githubHarness();
    const board = await boards.get(slug);
    for (const body of ["<!-- den-claim role=qa run=x -->", "  <!--DEN-CLAIM role=qa run=x -->", "<!--  den-claim"]) {
      await assert.rejects(board.comment("acme/01-first", body), /claim marker/);
    }
    assert.ok(!gh.calls.some((c) => c[1] === "comment"));
    await board.comment("acme/01-first", "an ordinary note");
    assert.equal(gh.calls.filter((c) => c[1] === "comment").length, 1);
  });
});
