// multi-project/01: the bridge's routes act on the project's own board. A GitHub project's board is snapshot-shaped (not 501),
// approve and tasks write to its issues, and the den's own routes are unchanged (tickets-approve.test.mjs, bridge-state.test.mjs).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addProject } from "./projects.mjs";
import { fakeGh } from "./board/fake-gh.mjs";
import { makeBridge } from "./agents/host-test-helpers.mjs";

const cleanups = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const sh = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "pipe" });
const label = (...names) => names.map((name) => ({ name }));

async function boot() {
  const gh = fakeGh();
  gh.issues.push(
    { number: 1, title: "First", body: "", state: "OPEN", comments: [], labels: label("den:ready-for-agent", "priority:P1") },
    { number: 2, title: "Ask", body: "the ask", state: "OPEN", comments: [], labels: label("den:ready-for-human") },
  );
  const denState = realpathSync(mkdtempSync(path.join(tmpdir(), "den-state-")));
  const t = await makeBridge({ denState, extra: { ghExec: gh.exec } });
  cleanups.push(() => t.close());
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "acme-")));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "remote", "add", "origin", "https://github.com/o/r.git");
  sh(dir, "commit", "-q", "--allow-empty", "-m", "init");
  assert.deepEqual(await addProject(denState, { slug: "acme", path: dir, board: { kind: "github-issues", repo: "o/r" } }), { ok: true });
  return { t, gh, get: (p) => fetch(`${t.bridge.url}${p}`, { headers: t.headers }).then(async (r) => ({ status: r.status, body: await r.json() })) };
}

test("GET /projects/<github project>/board returns a snapshot-shaped { tickets, frontier }", async () => {
  const { get } = await boot();
  const res = await get("/projects/acme/board");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.tickets.map((x) => [x.ref, x.status]), [["acme/01-first", "ready-for-agent"], ["acme/02-ask", "ready-for-human"]]);
  assert.deepEqual(res.body.frontier, ["acme/01-first"]);
});

test("POST /tickets/approve with a project approves on that project's board; the den's ticket stays where it was", async () => {
  const { t, gh } = await boot();
  const res = await t.post("/tickets/approve", { ref: "acme/02-ask", project: "acme" });
  assert.equal(res.status, 200, res.text);
  assert.ok(gh.issues[1].labels.some((l) => l.name === "den:ready-for-agent"));
  assert.ok(!gh.issues[1].labels.some((l) => l.name === "den:ready-for-human"));
  assert.equal(res.body.ordered, false, "the den's work order lists the den's tickets only");
  assert.equal((await t.post("/tickets/approve", { ref: "acme/02-ask", project: "acme" })).status, 409);
  assert.equal((await t.post("/tickets/approve", { ref: "acme/02-ask", project: "nope" })).status, 404);
});

test("POST /tasks with a project files the task's ticket as an issue on that board", async () => {
  const { t, gh } = await boot();
  assert.equal((await t.post("/projects/active", { slug: "acme" })).status, 200);
  const res = await t.post("/tasks", { role: "developer", text: "do the thing", project: "acme" });
  assert.match(res.body.ticket?.ref ?? "", /^acme\/03-/, res.text);
  const created = gh.calls.find((c) => c[1] === "create");
  assert.ok(created, "an issue was created on the project's repo");
  assert.ok(created.includes("o/r"));
  assert.ok(created[created.indexOf("--label") + 1].includes("den:ready-for-agent"));
});
