// Public host behavior with fake runtimes; no actual usage API or native CLI calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost } from "./host.mjs";
import { createFakeRuntime } from "./runtime.mjs";
import { makeStateFixture } from "../bridge-fixture.mjs";
import { DISPATCH_REF, until } from "./host-test-helpers.mjs";

async function setup(t) {
  const fx = await makeStateFixture({ git: true });
  const claude = createFakeRuntime({ send: true });
  const codex = createFakeRuntime({ send: true });
  const spawn = codex.spawn.bind(codex);
  codex.spawn = async (args) => {
    const proc = await spawn(args);
    proc.runtimeSessionId = args.runtimeSessionId ?? "thread_usage_fixture";
    return proc;
  };
  const calls = [];
  const usage = { value: 100 };
  const host = createHost({ root: fx.root, runtimes: { claude, codex }, policy: { killGraceMs: 30 },
    readUsage: async (runtime) => { calls.push(runtime); return usage.value; } });
  t.after(async () => {
    for (const fake of [claude, codex]) for (const rec of fake.spawns) rec.exit({ code: 1 });
    await host.shutdown();
    await fx.cleanup();
  });
  await host.ready;
  return { host, claude, codex, calls, usage };
}

test("Codex admission never reads or applies five-hour usage", async (t) => {
  const fx = await setup(t);
  const result = await fx.host.start({ ref: DISPATCH_REF, role: "architect", runtime: "codex" });
  assert.deepEqual(fx.calls, [], "Codex admission must not query five-hour usage");
  assert.equal(result.status, 201, JSON.stringify(result));
  assert.equal(fx.codex.spawns.length, 1);
  assert.equal(fx.claude.spawns.length, 0);
});

test("Codex direct tasks never read five-hour usage before or after ticket creation", async (t) => {
  const fx = await setup(t);
  let created = 0;
  const result = await fx.host.direct({ role: "architect", runtime: "codex", createTicket: async () => {
    created += 1;
    return { ref: DISPATCH_REF };
  } });
  assert.deepEqual(fx.calls, [], "both direct preflight and admission must skip the five-hour reader");
  assert.equal(result.status, 201, JSON.stringify(result));
  assert.equal(created, 1);
  assert.equal(fx.codex.spawns.length, 1);
});

test("Codex follow-up admission resumes its native thread without a five-hour query", async (t) => {
  const fx = await setup(t);
  fx.usage.value = 0; // Prepare a completed run independently of the admission regression.
  const first = await fx.host.start({ ref: DISPATCH_REF, role: "architect", runtime: "codex" });
  assert.equal(first.status, 201, JSON.stringify(first));
  fx.codex.spawns[0].emit({ type: "done", ok: true });
  await until(() => fx.host.snapshot().find((agent) => agent.id === first.agent.id)?.state === "done");
  fx.calls.length = 0;
  fx.usage.value = 100;
  const result = await fx.host.converse("architect", { runtime: "codex", project: "den", runId: first.agent.id, text: "Inspect the returned result." });
  assert.deepEqual(fx.calls, [], "Codex follow-up must not query five-hour usage");
  assert.equal(result.status, 201, JSON.stringify(result));
  assert.equal(fx.codex.spawns.length, 2);
  assert.equal(fx.codex.spawns[1].args.runtimeSessionId, "thread_usage_fixture");
  assert.equal(fx.codex.spawns[1].args.resume, true);
});

test("Claude retains its five-hour admission refusal", async (t) => {
  const fx = await setup(t);
  const result = await fx.host.start({ ref: DISPATCH_REF, role: "architect", runtime: "claude" });
  assert.deepEqual(fx.calls, ["claude"]);
  assert.equal(result.status, 429);
  assert.match(result.error, /five-hour usage/);
  assert.equal(fx.claude.spawns.length, 0);
  assert.equal(fx.codex.spawns.length, 0);
});
