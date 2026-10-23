// den-mvp/89 fix round: a Run's claim never outlives its run. Whatever goes wrong after the bridge has claimed (the handoff
// cannot be written, the start throws, the bridge itself is killed), the claim is given back and the ticket is in the
// frontier again.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeBridge, until, DISPATCH_REF } from "./agents/host-test-helpers.mjs";
import { claim } from "../board/board-service.mjs";
import { createLibrary } from "./library/library.mjs";
import { parseCatalog } from "./library/catalog.mjs";

const cleanups = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const ticketFile = (root) => path.join(root, ".scratch", "fx", "issues", "02-ready-p0.md");
const lockFile = (root) => ticketFile(root).replace(/\.md$/, ".lock");
const status = (root) => /^\*\*Status:\*\* (.+)$/m.exec(readFileSync(ticketFile(root), "utf8"))[1];
const journalFile = (root) => path.join(root, ".scratch", "_run", "run-claims.json");
const journalWith = (root, entries) => { mkdirSync(path.dirname(journalFile(root)), { recursive: true }); writeFileSync(journalFile(root), JSON.stringify(entries)); };
const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid;
const released = (root) => until(() => !existsSync(lockFile(root)) && status(root) === "ready-for-agent", { what: "the claim released" });

async function setup(opts) {
  const t = await makeBridge(opts);
  cleanups.push(() => t.close());
  return t;
}

test("a Run whose handoff cannot be written still gives the claim back, with a comment", async () => {
  const t = await setup();
  const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.equal(res.status, 201, res.text);
  const rec = await until(() => t.fake.spawns[0], { what: "the spawn" });
  const handoffs = path.join(t.fx.root, ".scratch", "fx", "handoffs");
  rmSync(handoffs, { recursive: true, force: true });
  writeFileSync(handoffs, "not a folder"); // the handoff cannot be published
  rec.emit({ type: "reply", text: "Done." });
  rec.emit({ type: "done", ok: true });
  await released(t.fx.root);
  assert.match(readFileSync(ticketFile(t.fx.root), "utf8"), /^- \*\*architect, [^*]+:\*\* .*could not hand/im);
});

test("a Run whose start throws after the claim gives it back, frees the ref and leaves nothing unhandled", async () => {
  let failing = true;
  const library = createLibrary({ catalog: parseCatalog({ connections: [] }) });
  const real = library.connectionsFor.bind(library);
  library.connectionsFor = async (...args) => { if (failing) throw new Error("the library broke"); return real(...args); };
  const t = await setup({ library });
  const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.ok(res.status >= 500, `a failed start, got ${res.status} ${res.text}`);
  assert.equal(t.fake.spawns.length, 0);
  await released(t.fx.root);
  failing = false;
  const again = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.equal(again.status, 201, `the ref is free again: ${again.text}`);
});

test("after a hard crash, the next boot gives back the claim of a Run that was live, with a comment", async () => {
  const t = await setup({
    preWrite: async (root) => {
      await claim(root, DISPATCH_REF, "architect");
      journalWith(root, [{ id: "c-0123456789abcdef", ref: DISPATCH_REF, project: "den", role: "architect", pid: deadPid() }]);
    },
  });
  assert.equal(existsSync(lockFile(t.fx.root)), false, "the stale claim is gone");
  assert.equal(status(t.fx.root), "ready-for-agent");
  assert.match(readFileSync(ticketFile(t.fx.root), "utf8"), /^- \*\*architect, [^*]+:\*\* .*bridge stopped/im);
  assert.deepEqual(JSON.parse(readFileSync(journalFile(t.fx.root), "utf8")), [], "and the journal forgets it");
  const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.equal(res.status, 201, "and the ticket can be Run again");
});

test("a second bridge on the same root does not give back the claim of a Run the first bridge has live", async () => {
  const a = await setup();
  const res = await a.post("/agents", { ref: DISPATCH_REF, role: "architect" });
  assert.equal(res.status, 201, res.text);
  assert.equal(existsSync(lockFile(a.fx.root)), true, "bridge A holds the claim");
  const b = await makeBridge({ root: a.fx.root });
  cleanups.push(() => b.bridge.close());
  assert.equal(existsSync(lockFile(a.fx.root)), true, "bridge B's boot left it held");
});

test("a stale journal entry does not drop a claim that a different role holds now", async () => {
  const t = await setup({
    preWrite: async (root) => {
      await claim(root, DISPATCH_REF, "developer");
      journalWith(root, [{ id: "c-0123456789abcdef", ref: DISPATCH_REF, project: "den", role: "architect", pid: deadPid() }]);
    },
  });
  assert.equal(existsSync(lockFile(t.fx.root)), true, "the developer's claim stays");
  assert.deepEqual(JSON.parse(readFileSync(journalFile(t.fx.root), "utf8")), [], "the stale entry is forgotten");
});

test("a Run is over for the board before it shows as ended: the ticket is free the moment the agent is done or failed", async () => {
  const t = await setup();
  for (const how of ["done", "failed", "done", "failed", "done", "failed"]) {
    const res = await t.post("/agents", { ref: DISPATCH_REF, role: "architect" });
    assert.equal(res.status, 201, `${how}: ${res.text}`);
    const rec = t.fake.spawns.at(-1);
    if (how === "done") { rec.emit({ type: "reply", text: "Done." }); rec.emit({ type: "done", ok: true }); } else rec.exit({ code: 1 });
    await until(async () => (await t.agent(res.body.agent.id))?.state !== "working", { what: "the agent to show as ended" });
    assert.equal(existsSync(lockFile(t.fx.root)), false, `${how}: the claim is back as soon as the agent shows as ended`);
  }
});
