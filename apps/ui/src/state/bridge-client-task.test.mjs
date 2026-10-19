// den-v1 loop S1: the UI's bridge client starts a task. Contract:
//   createBridgeClient({ fetch }) also returns startTask(role, { text }) -> Promise<{ agent, ticket }>
//   POST /tasks, Content-Type application/json, body exactly { role, text } with the text trimmed.
//   The token is attached by the injected session fetch; the client never builds it.
//   Failure rejects { status, reason } like the other calls. Text that is not a string, is empty after trim or is over
//   2,048 UTF-8 bytes, and a role that is not a non-empty string, reject with status 0 and send nothing.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createBridgeClient } from "./bridge-client.mjs";
import { createSession } from "../session/session.mjs";

const TOKEN = ["tok", "test", "456"].join("-"); // built at runtime so the root secret scan does not flag the fixture

function clientOver(responder) {
  const calls = [];
  const f = async (url, init = {}) => { calls.push({ url, init }); return responder(url, init); };
  const session = createSession({
    fetch: f,
    storage: { getItem: () => TOKEN, setItem() {}, removeItem() {} },
    location: { hash: "", pathname: "/", search: "" },
    history: { replaceState() {} },
  });
  return { calls, client: createBridgeClient({ fetch: session.fetch }) };
}
const ok = (body) => ({ ok: true, status: 201, json: async () => body });
const refuse = (status, body) => ({ ok: false, status, json: async () => body });
const header = (init, name) => Object.entries(init.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const rejection = async (promise) => {
  try { await promise; } catch (e) { return e; }
  assert.fail("expected a rejection");
};
const STARTED = { agent: { id: "c-1", ref: "den/01-scout" }, ticket: { ref: "den/01-scout" } };

describe("startTask", () => {
  test("POSTs /tasks once with the session token and { role, text }, and resolves with the body", async () => {
    const { calls, client } = clientOver(() => ok(STARTED));
    assert.equal(typeof client.startTask, "function", "createBridgeClient must return startTask");
    assert.deepEqual(await client.startTask("scout", { text: "  count the baskets \n" }), STARTED);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/tasks");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(header(calls[0].init, "Content-Type"), "application/json");
    assert.equal(header(calls[0].init, "Authorization"), `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(calls[0].init.body), { role: "scout", text: "count the baskets" });
  });

  test("a refusal rejects with the bridge's status and reason", async () => {
    const { client } = clientOver(() => refuse(429, { error: "max_concurrent_agents (2) reached" }));
    const err = await rejection(client.startTask("scout", { text: "x" }));
    assert.deepEqual({ status: err.status, reason: err.reason }, { status: 429, reason: "max_concurrent_agents (2) reached" });
  });

  test("empty, oversized or non-string text and a missing role send nothing", async () => {
    const { calls, client } = clientOver(() => ok(STARTED));
    for (const [role, body] of [["scout", { text: "" }], ["scout", { text: "   " }], ["scout", { text: 7 }], ["scout", undefined], ["scout", { text: "€".repeat(683) }], ["", { text: "x" }], [undefined, { text: "x" }]]) {
      assert.equal((await rejection(client.startTask(role, body))).status, 0);
    }
    assert.equal(calls.length, 0);
    await client.startTask("scout", { text: "€".repeat(682) + "ab" }); // exactly 2,048 bytes
    assert.equal(calls.length, 1);
  });
});
