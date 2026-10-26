import { test } from "node:test";
import assert from "node:assert/strict";
import { createGithubIssuesBoard, boardFor } from "./github-issues.mjs";

const issue = (number, title, labels, extra = {}) => ({ number, title, state: "OPEN", body: "", comments: [], labels: labels.map((name) => ({ name })), ...extra });

function stub(issues = []) {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, opts });
    const [a, b] = args;
    if (a === "api" && b === "user") return { stdout: "den-bot\n" };
    if (a === "issue" && b === "list") return { stdout: JSON.stringify(issues) };
    if (a === "issue" && b === "view") return { stdout: JSON.stringify(issues.find((i) => String(i.number) === args[2])) };
    if (a === "issue" && b === "create") return { stdout: "https://github.com/o/r/issues/7\n" };
    return { stdout: "" };
  };
  return { calls, exec };
}
const mk = (issues, env = { GH_TOKEN: "secret-token" }) => { const s = stub(issues); return { ...s, board: createGithubIssuesBoard({ repo: "o/r", project: "acme", exec: s.exec, root: "/p", env }) }; };

test("list returns only den-labelled issues, normalized", async () => {
  const { board, calls } = mk([
    issue(3, "Add login", ["den:ready-for-agent", "priority:P1"], { body: "Blocked by: #1, #2" }),
    issue(4, "Random", ["bug"]),
    issue(5, "Needs you", ["den:ready-for-human"]),
  ]);
  const t = await board.list();
  assert.deepEqual(t.map((x) => x.ref), ["acme/03-add-login", "acme/05-needs-you"]);
  assert.deepEqual(t[0], { ref: "acme/03-add-login", title: "Add login", type: "feature", status: "ready-for-agent", priority: "P1", blockedBy: ["acme/01", "acme/02"], holder: null });
  assert.equal(t[1].priority, "P2");
  assert.equal(t[1].status, "ready-for-human");
  assert.deepEqual(calls[0].args.slice(0, 4), ["issue", "list", "--repo", "o/r"]);
  assert.equal(calls[0].opts.cwd, "/p");
});

test("read maps the issue number from the ref and refuses non-tickets and other projects", async () => {
  const { board, calls } = mk([issue(3, "A", ["den:ready-for-agent"]), issue(4, "B", ["bug"])]);
  assert.equal((await board.read("acme/03-a")).title, "A");
  assert.deepEqual(calls[0].args.slice(0, 5), ["issue", "view", "3", "--repo", "o/r"]);
  await assert.rejects(board.read("acme/04-b"), /not a ticket/);
  await assert.rejects(board.read("other/03-a"), /not a ticket of this project/);
  await assert.rejects(board.read("acme/3-a"), TypeError);
});

test("create files an issue with labels and reads it back", async () => {
  const issues = [issue(7, "New one", ["den:ready-for-human", "priority:P1"])];
  const { board, calls } = mk(issues);
  const t = await board.create({ title: "New one", body: "body", priority: "P1" });
  assert.equal(t.ref, "acme/07-new-one");
  const c = calls[0].args;
  assert.deepEqual(c.slice(0, 2), ["issue", "create"]);
  assert.equal(c[c.indexOf("--label") + 1], "den:ready-for-human,priority:P1,type:feature");
});

test("claim adds den:in-progress and a comment naming the run", async () => {
  const { board, calls } = mk([issue(3, "A", ["den:ready-for-agent"])]);
  const t = await board.claim("acme/03-a", { role: "developer", run: "run-42" });
  assert.deepEqual(t.holder, { role: "developer", run: "run-42" });
  const edit = calls.find((c) => c.args[1] === "edit").args;
  assert.deepEqual(edit, ["issue", "edit", "3", "--repo", "o/r", "--add-label", "den:in-progress"]);
  const cm = calls.find((c) => c.args[1] === "comment").args;
  assert.match(cm[cm.indexOf("--body") + 1], /^<!-- den-claim role=developer run=run-42 -->/);
});

test("a claimed ticket has its holder from the latest claim comment, and cannot be claimed again", async () => {
  const comments = [
    { author: { login: "den-bot" }, body: "<!-- den-claim role=qa run=old -->" },
    { author: { login: "den-bot" }, body: "chatter" },
    { author: { login: "den-bot" }, body: "<!-- den-claim role=developer run=new -->" },
    { author: { login: "stranger" }, body: "<!-- den-claim role=security run=forged -->" },
  ];
  const { board } = mk([issue(3, "A", ["den:ready-for-agent", "den:in-progress"], { comments })]);
  assert.deepEqual((await board.read("acme/03-a")).holder, { role: "developer", run: "new" });
  await assert.rejects(board.claim("acme/03-a", { role: "qa", run: "r2" }), /already claimed/);
});

test("two simultaneous claims: exactly one wins", async () => {
  const labels = ["den:ready-for-agent"];
  const issues = [issue(3, "A", labels)];
  const calls = [];
  const exec = async (f, args) => {
    calls.push(args);
    if (args[1] === "view") { await new Promise((r) => setTimeout(r, 5)); return { stdout: JSON.stringify(issues[0]) }; }
    if (args[1] === "edit") issues[0].labels.push({ name: "den:in-progress" });
    return { stdout: "" };
  };
  const board = createGithubIssuesBoard({ repo: "o/r", project: "acme", exec });
  const r = await Promise.allSettled([board.claim("acme/03-a", { role: "developer", run: "a" }), board.claim("acme/03-a", { role: "developer", run: "b" })]);
  assert.deepEqual(r.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(calls.filter((a) => a[1] === "edit").length, 1);
});

test("release removes the claim label", async () => {
  const { board, calls } = mk([]);
  await board.release("acme/03-a");
  assert.deepEqual(calls[0].args, ["issue", "edit", "3", "--repo", "o/r", "--remove-label", "den:in-progress"]);
});

test("resolve closes the issue as completed and links the PR", async () => {
  const { board, calls } = mk([]);
  await board.resolve("acme/03-a", { pr: 12 });
  const close = calls.find((c) => c.args[1] === "close").args;
  assert.deepEqual(close, ["issue", "close", "3", "--repo", "o/r", "--reason", "completed", "--comment", "Resolved by #12"]);
  await assert.rejects(board.resolve("acme/03-a", { pr: "rm -rf" }), TypeError);
});

test("comment posts the body", async () => {
  const { board, calls } = mk([]);
  await board.comment("acme/03-a", "hello");
  assert.deepEqual(calls[0].args, ["issue", "comment", "3", "--repo", "o/r", "--body", "hello"]);
});

test("a closed issue is resolved, and frontier is priority-ordered, unclaimed, and unblocked", async () => {
  const { board } = mk([
    issue(1, "Done", ["den:ready-for-agent"], { state: "CLOSED" }),
    issue(2, "Low", ["den:ready-for-agent", "priority:P3"]),
    issue(3, "High", ["den:ready-for-agent", "priority:P1"]),
    issue(4, "Blocked", ["den:ready-for-agent", "priority:P1"], { body: "Blocked by: #9" }),
    issue(5, "After done", ["den:ready-for-agent"], { body: "Blocked by: #1" }),
    issue(6, "Held", ["den:ready-for-agent", "den:in-progress"]),
    issue(7, "Human", ["den:ready-for-human"]),
  ]);
  assert.equal((await board.list())[0].status, "resolved");
  assert.deepEqual(await board.frontier(), ["acme/03-high", "acme/05-after-done", "acme/02-low"]);
});

test("the token is never returned or put in a gh argument", async () => {
  const { board, calls } = mk([issue(3, "A", ["den:ready-for-agent"])], { GH_TOKEN: "secret-token" });
  const out = [await board.list(), await board.claim("acme/03-a", { role: "developer", run: "r" })];
  assert.ok(!JSON.stringify(out).includes("secret-token"));
  assert.ok(!JSON.stringify(calls.map((c) => c.args)).includes("secret-token"));
});

test("bad inputs are refused; boardFor picks the kind", () => {
  assert.throws(() => createGithubIssuesBoard({ repo: "nope", project: "acme" }), TypeError);
  assert.throws(() => createGithubIssuesBoard({ repo: "o/r", project: "Bad Slug" }), TypeError);
  assert.equal(boardFor({ slug: "acme", root: "/p" }, { kind: "github-issues", repo: "o/r" }).kind, "github-issues");
  assert.equal(boardFor({ slug: "acme", root: "/p" }, undefined), null);
});
