import { test } from "node:test";
import assert from "node:assert/strict";
import { createBridgeClient } from "./bridge-client.mjs";

test("task, dispatch and conversation helpers preserve selected runtime/project", async () => {
  const calls = [];
  const client = createBridgeClient({ fetch: async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ entries: [], more: false, before: 0 }) };
  } });
  const selectors = { runtime: "codex", project: "acme" };
  await client.startTask("architect", { text: "Inspect", ...selectors });
  await client.dispatch("fx/01-ready", { role: "architect", ...selectors });
  await client.converse("architect", { text: "Continue", runId: "c-0123456789abcdef", ...selectors });
  await client.getConversation("architect", { before: 4, limit: 2, ...selectors });
  for (const { init } of calls.slice(0, 3)) {
    const body = JSON.parse(init.body);
    assert.equal(body.runtime, "codex");
    assert.equal(body.project, "acme");
  }
  const query = new URL(calls[3].url, "http://bridge").searchParams;
  assert.deepEqual(Object.fromEntries(query), { before: "4", limit: "2", ...selectors });
});
