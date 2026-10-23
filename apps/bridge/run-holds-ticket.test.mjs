// den-mvp/23, 89 (with den-v1/15): what a Run from the den leaves on the board. The agent runs no board command (its board is
// read-only behind the wall); the bridge holds the ticket's claim for the run (run-claims-ticket.test.mjs) and, when the run
// finishes, publishes its last message as the ticket's handoff and releases the claim: the ticket is back in the frontier, to
// be Run again or Delivered. A den task's ticket, written for that task alone, then goes to in-review
// (den-v1/15). A run that fails publishes nothing.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeBridge, until, DISPATCH_REF } from "./agents/host-test-helpers.mjs";

const cleanups = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=fx", "-c", "user.email=fx@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
const ticketFile = (root, ref) => path.join(root, ".scratch", ...ref.split("/").toSpliced(1, 0, "issues")) + ".md";
async function setup() {
  const t = await makeBridge();
  cleanups.push(() => t.close());
  const handoffsOf = (ref) => {
    const [feature, ticket] = ref.split("/");
    const dir = path.join(t.fx.root, ".scratch", feature, "handoffs");
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`${ticket.slice(0, 2)}-`)).map((f) => readFileSync(path.join(dir, f), "utf8")) : [];
  };
  const status = (ref) => /^\*\*Status:\*\* (.+)$/m.exec(readFileSync(ticketFile(t.fx.root, ref), "utf8"))[1];
  const locked = (ref) => existsSync(ticketFile(t.fx.root, ref).replace(/\.md$/, ".lock"));
  return { ...t, handoffsOf, status, locked };
}

test("a Run holds the board lock while it runs; a finished run publishes its report as the ticket's handoff and the lock is gone, the ticket as it was", async () => {
  const t = await setup();
  const before = t.status(DISPATCH_REF);
  const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.equal(res.status, 201, res.text);
  assert.equal(t.locked(DISPATCH_REF), true, "the bridge holds the claim for the run");
  const rec = await until(() => t.fake.spawns[0], { what: "the spawn" });
  assert.match(rec.args.prompt, /run no board command/);
  writeFileSync(path.join(rec.args.cwd, "adr.md"), "# ADR\n");
  git(rec.args.cwd, "add", "adr.md");
  git(rec.args.cwd, "commit", "-q", "-m", "draft the ADR");
  rec.emit({ type: "reply", text: "Drafted the routing ADR in adr.md and checked it against the spec." });
  rec.emit({ type: "done", ok: true });
  // An async write creates the file before its contents are available.
  const [handoff] = await until(() => { const h = t.handoffsOf(DISPATCH_REF); return h.length && h.every(text => text.trim()) ? h : null; }, { what: "the written handoff" });
  assert.match(handoff, /architect committed [0-9a-f]{12}/);
  assert.match(handoff, /branch den\/fx\/02-ready-p0-/);
  assert.match(handoff, /Drafted the routing ADR/);
  await until(() => !t.locked(DISPATCH_REF), { what: "the claim released" });
  assert.equal(t.status(DISPATCH_REF), before, "it can be Run again or Delivered");
  const again = await until(async () => { const r = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" }); return r.status === 201 ? r : null; }, { what: "a second Run once the first has ended" });
  assert.ok(again);
});

test("a run that ends with no commit still hands off its report; a failed run hands off nothing", async () => {
  const t = await setup();
  const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.equal(res.status, 201, res.text);
  const rec = await until(() => t.fake.spawns[0], { what: "the spawn" });
  rec.emit({ type: "reply", text: "Read the ticket; the open question is the router. Nothing to commit yet." });
  rec.emit({ type: "done", ok: true });
  const [handoff] = await until(() => { const h = t.handoffsOf(DISPATCH_REF); return h.length && h.every(text => text.trim()) ? h : null; }, { what: "the written handoff" });
  assert.match(handoff, /architect made no commit/);

  const second = await until(async () => { const r = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" }); return r.status === 201 ? r : null; }, { what: "a second run" });
  const failing = await until(() => t.fake.spawns[1], { what: "the second spawn" });
  failing.emit({ type: "done", ok: false });
  await until(async () => (await t.agent(second.body.agent.id))?.state !== "working", { what: "the failed run to end" });
  assert.equal(t.handoffsOf(DISPATCH_REF).length, 1, "the failed run published nothing");
});

test("a den task (POST /tasks) hands off its report, and its own ticket goes to in-review, not back to ready (den-v1/15)", async () => {
  const t = await setup();
  for (const role of ["developer", "qa"]) {
    const res = await t.post("/tasks", { role, text: `A ${role} task from the den.` });
    assert.equal(res.status, 201, res.text);
    const ref = res.body.ticket.ref;
    const rec = await until(() => t.fake.spawns.find((s) => s.args.ref === ref), { what: `the ${role} spawn` });
    rec.emit({ type: "reply", text: `Did the ${role} task.` });
    rec.emit({ type: "done", ok: true });
    await until(() => t.status(ref) === "in-review" && !t.locked(ref), { what: `the ${role} task's ticket in review` });
    assert.match(t.handoffsOf(ref).join("\n"), new RegExp(`Did the ${role} task\\.`));
  }
});
