// den-mvp/89 (from den-mvp/23), qa specify: a Run from the den is settled by the bridge, not the agent.
// The bridge claims the ticket for the run's role before the agent starts (and refuses the Run with the board's own
// reason when the claim fails), the agent is never asked to run a board command, and when the run ends the bridge
// publishes its handoff and releases the claim: a failed or stopped run releases it with a comment on the ticket.
// This replaces the earlier "a Run takes no board lock" rule pinned in run-holds-ticket.test.mjs, which the developer
// updates with the change (a Run's lock is now held for the run, then released; the ticket returns to the frontier).
//
// Fixture is the small shared one (apps/bridge/bridge-fixture.mjs) and the fake runtime: no real agent, no browser.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeBridge, until, DISPATCH_REF } from "./agents/host-test-helpers.mjs";

const cleanups = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const ticketFile = (root, ref) => path.join(root, ".scratch", ...ref.split("/").toSpliced(1, 0, "issues")) + ".md";
const OTHER_REF = DISPATCH_REF.replace("02-ready-p0", "07-bumpable");

async function setup(opts) {
  const t = await makeBridge(opts);
  cleanups.push(() => t.close());
  const root = t.fx.root;
  const handoffsOf = (ref) => {
    const [feature, ticket] = ref.split("/");
    const dir = path.join(root, ".scratch", feature, "handoffs");
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`${ticket.slice(0, 2)}-`)).map((f) => readFileSync(path.join(dir, f), "utf8")) : [];
  };
  const text = (ref) => readFileSync(ticketFile(root, ref), "utf8");
  const status = (ref) => /^\*\*Status:\*\* (.+)$/m.exec(text(ref))[1];
  const lockPath = (ref) => ticketFile(root, ref).replace(/\.md$/, ".lock");
  const locked = (ref) => existsSync(lockPath(ref));
  const lockText = (ref) => (locked(ref) ? readFileSync(lockPath(ref), "utf8") : null);
  // The board's own event log: one row per claim and release the board service made.
  const ops = (ref) => {
    const file = path.join(root, ".scratch", "events.jsonl");
    if (!existsSync(file)) return [];
    const [feature, ticket] = ref.split("/");
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.feature === feature && e.ticket === ticket).map((e) => e.op);
  };
  // What the board looked like at the instant the runtime was asked to start the agent.
  const atSpawn = [];
  const realSpawn = t.fake.spawn.bind(t.fake);
  t.fake.spawn = (args) => {
    atSpawn.push({ ref: args.ref, locked: locked(args.ref), lock: lockText(args.ref), status: status(args.ref) });
    return realSpawn(args);
  };
  return { ...t, handoffsOf, text, status, locked, lockText, ops, atSpawn };
}

const released = (t, ref) => until(() => !t.locked(ref) && t.status(ref) !== "claimed", { what: `${ref} released` });

test("a Run claims the ticket for its role before the agent starts", async () => {
  const t = await setup();
  const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.equal(res.status, 201, res.text);
  await until(() => t.fake.spawns[0], { what: "the spawn" });
  assert.equal(t.atSpawn.length, 1);
  assert.equal(t.atSpawn[0].locked, true, "the claim lock exists when the agent is started");
  assert.match(t.atSpawn[0].lock, /^architect /, "the lock is the role's");
  assert.equal(t.atSpawn[0].status, "claimed");
  assert.equal(t.locked(DISPATCH_REF), true, "and it is held while the run is live");
});

test("a ticket the board will not claim for the role is refused with the board's reason, and no agent starts", async () => {
  const t = await setup();
  const before = t.status(DISPATCH_REF);
  // The board refuses a qa claim with no mode; the ticket itself is in the frontier, so the gate lets the Run through.
  const res = await t.post("/agents", { ref: DISPATCH_REF, role: "qa" });
  assert.ok(res.status >= 400 && res.status < 500, `a refusal, got ${res.status} ${res.text}`);
  assert.match(res.body.error, /--mode is required for role "qa"/, "the board's reason, not a generic one");
  assert.equal(t.fake.spawns.length, 0, "no agent started");
  assert.equal(t.atSpawn.length, 0);
  assert.equal(t.locked(DISPATCH_REF), false, "the refusal leaves no lock");
  assert.equal(t.status(DISPATCH_REF), before);
  // Nothing was left half-registered: the same ticket can be Run by a role the board accepts.
  const again = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.equal(again.status, 201, again.text);
});

test("a finished Run publishes its handoff and releases the claim; the ticket is back in the frontier", async () => {
  const t = await setup();
  const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.equal(res.status, 201, res.text);
  const rec = await until(() => t.fake.spawns[0], { what: "the spawn" });
  assert.equal(t.atSpawn[0]?.locked, true, "claimed for the run");
  rec.emit({ type: "reply", text: "Drafted the routing ADR and checked it against the spec." });
  rec.emit({ type: "done", ok: true });
  const [handoff] = await until(() => { const h = t.handoffsOf(DISPATCH_REF); return h.length && h.every((x) => x.trim()) ? h : null; }, { what: "the written handoff" });
  assert.match(handoff, /Drafted the routing ADR/);
  await until(async () => (await t.agent(res.body.agent.id))?.state === "done", { what: "the Run to finish settling its claim" });
  await released(t, DISPATCH_REF);
  assert.equal(t.status(DISPATCH_REF), "ready-for-agent", "it can be Run again or Delivered");
  assert.deepEqual(t.ops(DISPATCH_REF).filter((o) => o === "claim" || o === "release"), ["claim", "release"], "the board saw one claim and one release");
  const again = await until(async () => { const r = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" }); return r.status === 201 ? r : null; }, { what: "a second Run" });
  assert.ok(again);
});

test("a Run that fails releases the claim with a comment and publishes no handoff", async () => {
  const t = await setup();
  const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.equal(res.status, 201, res.text);
  const rec = await until(() => t.fake.spawns[0], { what: "the spawn" });
  assert.equal(t.atSpawn[0]?.locked, true, "claimed for the run");
  rec.emit({ type: "done", ok: false });
  await until(async () => (await t.agent(res.body.agent.id))?.state === "failed", { what: "the run to fail" });
  await released(t, DISPATCH_REF);
  assert.equal(t.status(DISPATCH_REF), "ready-for-agent");
  assert.match(t.text(DISPATCH_REF), /^- \*\*architect, [^*]+:\*\* .*failed/im, "a comment on the ticket says the run failed");
  assert.equal(t.handoffsOf(DISPATCH_REF).length, 0);
});

test("a Run that is stopped releases the claim with a comment", async () => {
  const t = await setup();
  const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.equal(res.status, 201, res.text);
  await until(() => t.fake.spawns[0], { what: "the spawn" });
  assert.equal(t.atSpawn[0]?.locked, true, "claimed for the run");
  const stop = await t.post(`/agents/${res.body.agent.id}/stop`, {});
  assert.equal(stop.status, 202, stop.text);
  await until(async () => (await t.agent(res.body.agent.id))?.state === "terminated", { what: "the run to stop" });
  await released(t, DISPATCH_REF);
  assert.equal(t.status(DISPATCH_REF), "ready-for-agent");
  assert.match(t.text(DISPATCH_REF), /^- \*\*architect, [^*]+:\*\* .*(stopped|terminated)/im, "a comment on the ticket says the run was stopped");
});

test("a Run whose agent never starts does not leave the claim behind", async () => {
  const t = await setup({ runtimeConfig: { failSpawn: true } });
  const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.ok(res.status >= 400, `the spawn failure is a refusal, got ${res.status} ${res.text}`);
  await released(t, DISPATCH_REF);
  assert.equal(t.status(DISPATCH_REF), "ready-for-agent");
  // The claim was made (the bridge claims first), and given back.
  assert.deepEqual(t.ops(DISPATCH_REF).filter((o) => o === "claim" || o === "release"), ["claim", "release"]);
});

test("a Run takes its own lock only once: a second Run on another ticket still fits under max_concurrent_agents", async () => {
  const t = await setup();
  const first = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.equal(first.status, 201, first.text);
  assert.equal(t.locked(DISPATCH_REF), true, "the first run holds its claim");
  const second = await t.post("/agents", { ref: OTHER_REF, role: "architect" });
  assert.equal(second.status, 201, second.text);
  assert.equal(t.locked(OTHER_REF), true, "and so does the second");
});

// A real agent's .scratch is read-only behind the wall (apps/bridge/agents/claude-runtime-wall.test.mjs holds that wall).
// This agent behaves as one: if its prompt told it to run a board command, the write fails (EROFS) and it ends failed.
// The Run must complete, because the bridge does every board call.
test("a Run completes behind a read-only .scratch: the agent writes nothing to the board and the bridge settles it", async () => {
  const t = await setup();
  const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.equal(res.status, 201, res.text);
  const rec = await until(() => t.fake.spawns[0], { what: "the spawn" });
  const asksForBoardWrite = /npm run board|board\s+(claim|release|handoff|comment)\b/i.test(rec.args.prompt);
  rec.emit({ type: "reply", text: "Read the ticket; wrote the ADR in my worktree." });
  rec.emit({ type: "done", ok: !asksForBoardWrite });
  await until(async () => (await t.agent(res.body.agent.id))?.state === "done", { what: "the run to complete" });
  assert.equal(asksForBoardWrite, false, "the prompt asks the agent for no board command");
  await until(() => t.handoffsOf(DISPATCH_REF).length === 1, { what: "the bridge's handoff" });
  await released(t, DISPATCH_REF);
  assert.equal(t.atSpawn[0]?.locked, true, "the bridge held the claim for the whole run");
  assert.equal(t.status(DISPATCH_REF), "ready-for-agent");
});

test("the Run prompt tells the agent the den holds the claim and asks for no board command", async () => {
  const t = await setup();
  const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.equal(res.status, 201, res.text);
  const { prompt } = (await until(() => t.fake.spawns[0], { what: "the spawn" })).args;
  assert.doesNotMatch(prompt, /npm run board|board\s+(claim|release|handoff|comment)\b|\bclaim (the|this) ticket\b|\brelease (the|this) (claim|ticket)\b/i);
  assert.match(prompt, /\b(den|bridge)\b[^.]*\bholds?\b[^.]*\b(claim|ticket)\b/i, "it says the den holds the claim");
});

test("the direct-mode prompt (a task from the Start box) asks for no board command either", async () => {
  const t = await setup();
  const res = await t.post("/tasks", { role: "developer", text: "Tidy the README." });
  assert.equal(res.status, 201, res.text);
  const { prompt } = (await until(() => t.fake.spawns[0], { what: "the spawn" })).args;
  assert.match(prompt, /direct mode/);
  assert.doesNotMatch(prompt, /npm run board|board\s+(claim|release|handoff|comment)\b|\bclaim (the|this) ticket\b|\brelease (the|this) (claim|ticket)\b/i);
});
