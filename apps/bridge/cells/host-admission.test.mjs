// codex-residents/05: the host's start paths all go through the one admission transaction.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createFakeRuntime } from "./runtime.mjs";
import { makeBridge, DISPATCH_REF, NO_GATE_REF, until } from "./host-test-helpers.mjs";
import { FEATURE } from "../bridge-fixture.mjs";

let t;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
const HUMAN = `${FEATURE}/06-human`;

describe("one attempt", () => {
  test("concurrent dispatch, start and direct on one ticket start one agent", async () => {
    t = await makeBridge();
    const results = await Promise.all([
      t.dispatch("developer", DISPATCH_REF),
      t.dispatch("developer", DISPATCH_REF),
      t.bridge.host.start({ ref: DISPATCH_REF, role: "developer" }),
      t.bridge.host.start({ ref: DISPATCH_REF, role: "developer" }),
    ]);
    const ok = results.filter((r) => r.ok || r.status === 201);
    assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.status)));
    assert.equal(t.fake.spawns.length, 1);
  });
  test("the attempt is journalled before the spawn and settled when the agent ends", async () => {
    t = await makeBridge();
    assert.equal((await t.dispatch("developer", DISPATCH_REF)).status, 201);
    const journal = path.join(t.fx.root, ".scratch", "_run", "admission.jsonl");
    const lines = () => readFile(journal, "utf8").then((x) => x.trim().split("\n").map((l) => JSON.parse(l)));
    assert.equal((await lines()).filter((l) => l.event === "intent").length, 1);
    await until(() => t.fake.spawns[0]);
    t.fake.spawns[0].exit();
    await until(async () => (await lines()).some((l) => l.event === "settled"));
    assert.equal((await t.dispatch("developer", DISPATCH_REF)).status, 201);
  });
  test("an unsettled intent from a crash blocks a blind respawn", async () => {
    t = await makeBridge({
      preWrite: async (root) => {
        const dir = path.join(root, ".scratch", "_run");
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "admission.jsonl"), JSON.stringify({ event: "intent", id: "i-aaaaaaaaaaaaaaaa", ref: DISPATCH_REF, project: "den", runtime: "claude", entry: "start" }) + "\n");
      },
    });
    const r = await t.dispatch("developer", DISPATCH_REF);
    assert.equal(r.status, 409);
    assert.match(r.text, /unconfirmed/);
    assert.equal(t.fake.spawns.length, 0);
  });
});

describe("runtime allowlist and ownership over HTTP", () => {
  test("a disallowed runtime is refused at dispatch, and the setting is validated", async () => {
    t = await makeBridge();
    assert.equal((await t.post("/admission/runtime", { allow: "none" })).status, 400);
    assert.equal((await t.post("/admission/runtime", { allow: "codex" })).status, 200);
    const r = await t.dispatch("developer", DISPATCH_REF);
    assert.equal(r.status, 409);
    assert.match(r.text, /not allowed/);
    assert.equal(t.fake.spawns.length, 0);
    assert.equal((await t.post("/admission/runtime", { allow: "both" })).status, 200);
  });
  test("approval takes the user's coordinator and defaults to Bao; transfer waits for the attempt", async () => {
    t = await makeBridge();
    assert.equal((await t.post("/tickets/approve", { ref: HUMAN, owner: "nobody" })).status, 400);
    assert.equal((await t.post("/tickets/approve", { ref: HUMAN, owner: "jiao" })).status, 200);
    assert.equal(t.bridge.host.admission.ownerOf(HUMAN).owner, "jiao");
    assert.equal((await t.post("/tickets/transfer", { ref: HUMAN, owner: "bao" })).status, 200);
    assert.equal(t.bridge.host.admission.ownerOf(HUMAN).epoch, 2);
    assert.equal((await t.dispatch("developer", DISPATCH_REF)).status, 201);
    assert.equal((await t.post("/tickets/transfer", { ref: DISPATCH_REF, owner: "jiao" })).status, 409);
  });
});
