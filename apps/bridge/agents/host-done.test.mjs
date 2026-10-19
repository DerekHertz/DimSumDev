// den-v1 loop S3 (ADR 0016 decision 2, amendment 8): a done event ends the process. The live CLI stays up after its
// result line until its stdin closes (conformance spike S3 ran two turns in one child), so the host closes stdin when
// the runtime reports done. This is not a stop: the end state is still the done event's own verdict.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeBridge, until } from "./host-test-helpers.mjs";

let t;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
const ended = (id, state) =>
  until(async () => {
    const a = await t.agent(id);
    return a?.state === state && a;
  }, { what: `the agent to end ${state}` });
const sessionLines = async () => (await readFile(t.sessionsFile, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("a done event ends the process", () => {
  test("the host closes the child's stdin on done; the agent ends done with no stop recorded", async () => {
    t = await makeBridge();
    const { agent } = (await t.dispatch("scout")).body;
    const rec = t.fake.spawns[0];
    rec.emit({ type: "done", ok: true });
    const a = await ended(agent.id, "done"); // the test never calls rec.exit(): closing stdin is what ends the fake
    assert.deepEqual(rec.calls.map((c) => c.call), ["closeInput"]);
    assert.equal(a.reason ?? null, null, "not a stop: no reason");
    const lines = (await sessionLines()).filter((l) => l.agentId === agent.id);
    assert.deepEqual(lines.map((l) => l.event), ["spawn", "end"]);
    assert.equal(lines[1].state, "done");
    assert.equal((await t.dispatch("scout")).status, 201, "the slot is free again");
  });

  test("a done with ok:false closes stdin too, and the agent ends failed", async () => {
    t = await makeBridge();
    const { agent } = (await t.dispatch("scout")).body;
    const rec = t.fake.spawns[0];
    rec.emit({ type: "done", ok: false });
    await ended(agent.id, "failed");
    assert.deepEqual(rec.calls.map((c) => c.call), ["closeInput"]);
  });

  test("a child that ignores the stdin close is signalled after the grace, and still ends done (not terminated)", async () => {
    t = await makeBridge({ runtimeConfig: { stdinCloseEnds: false }, policy: { killGraceMs: 40 } });
    const { agent } = (await t.dispatch("scout")).body;
    const rec = t.fake.spawns[0];
    rec.emit({ type: "done", ok: true });
    const a = await ended(agent.id, "done");
    assert.deepEqual(rec.calls.map((c) => c.call), ["closeInput", "SIGTERM"]);
    assert.ok(rec.calls[1].at - rec.calls[0].at >= 30, "SIGTERM waits for the grace");
    assert.equal(a.reason ?? null, null);
  });

  test("a second done does not close stdin twice", async () => {
    t = await makeBridge({ runtimeConfig: { stdinCloseEnds: false, sigtermEnds: false }, policy: { killGraceMs: 60 } });
    const { agent } = (await t.dispatch("scout")).body;
    const rec = t.fake.spawns[0];
    rec.emit({ type: "done", ok: true });
    rec.emit({ type: "done", ok: true });
    await ended(agent.id, "done");
    assert.deepEqual(rec.calls.map((c) => c.call), ["closeInput", "SIGTERM", "SIGKILL"]);
  });

  test("a stop after done still ends terminated", async () => {
    t = await makeBridge({ runtimeConfig: { stdinCloseEnds: false }, policy: { killGraceMs: 200 } });
    const { agent } = (await t.dispatch("scout")).body;
    const rec = t.fake.spawns[0];
    rec.emit({ type: "done", ok: true });
    await until(() => rec.calls.length === 1, { what: "the stdin close" });
    assert.equal((await t.post(`/agents/${agent.id}/stop`)).status, 202);
    const a = await ended(agent.id, "terminated");
    assert.equal(a.reason, "stopped-by-user");
  });
});
