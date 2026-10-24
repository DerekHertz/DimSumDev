// team-and-den-ux/19: a relay started from the den runs as a tree rooted at its owner (Bao or Jiao). The run record of
// every worker agent names the owner as its parent; direct work stays outside a tree.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeBridge, DISPATCH_REF, until } from "./host-test-helpers.mjs";

let t;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
const spawnLine = async (id) => {
  const text = await readFile(t.sessionsFile, "utf8");
  return text.trim().split("\n").map((l) => JSON.parse(l)).find((l) => l.agentId === id && l.event === "spawn");
};

test("a worker started on a ticket with no recorded owner has Bao as its parent, in the view and the run record", async () => {
  t = await makeBridge();
  const { agent } = (await t.dispatch("developer", DISPATCH_REF)).body;
  assert.equal(agent.parent, "bao");
  const line = await until(() => spawnLine(agent.id), { what: "the spawn line" });
  assert.equal(line.parent, "bao");
});

test("a worker started on a ticket Jiao owns has Jiao as its parent", async () => {
  t = await makeBridge();
  assert.equal((await t.bridge.host.admission.approve(DISPATCH_REF, { owner: "jiao" })).ok, true);
  const { agent } = (await t.dispatch("developer", DISPATCH_REF)).body;
  assert.equal(agent.parent, "jiao");
  assert.equal((await until(() => spawnLine(agent.id), { what: "the spawn line" })).parent, "jiao");
});

test("every step of a delivery is a child of the owner", async () => {
  t = await makeBridge();
  assert.equal((await t.bridge.host.admission.approve(DISPATCH_REF, { owner: "jiao" })).ok, true);
  const started = await t.bridge.host.start({ ref: DISPATCH_REF, role: "developer" });
  assert.equal(started.agent.parent, "jiao");
});

test("a direct task is outside any tree: it has no parent", async () => {
  t = await makeBridge();
  const res = await t.post("/tasks", { role: "developer", text: "look at the readme" });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.agent.parent, null);
});
