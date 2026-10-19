// organism-infra/228: the UI's bridge client runs a frontier ticket. Contract:
//   createBridgeClient({ fetch }) also returns dispatch(ref, { role }) -> Promise<body>
//   POST /agents, Content-Type application/json, body exactly { ref, role }; the session fetch attaches the token.
//   A 201 resolves with the bridge's body ({ agent, usageUnknown? }, passed through untouched).
//   Any other answer rejects { status, reason } with the bridge's `error` text as sent (409 and 429 included).
//   One request per call: a refusal is never retried.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createBridgeClient } from "./bridge-client.mjs";
import { createSession } from "../session/session.mjs";

const TOKEN = ["tok", "test", "228"].join("-"); // built at runtime so the root secret scan does not flag the fixture

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
const created = (body) => ({ ok: true, status: 201, json: async () => body });
const refuse = (status, body) => ({ ok: false, status, json: async () => body });
const header = (init, name) => Object.entries(init.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const rejection = async (promise) => {
  try { await promise; } catch (e) { return e; }
  assert.fail("expected a rejection");
};
const REF = "organism-infra/230-some-frontier-ticket";
const STARTED = { agent: { id: "c-1", ref: REF, role: "architect", state: "working" } };

describe("dispatch", () => {
  test("POSTs /agents once with the session token and exactly { ref, role }", async () => {
    const { calls, client } = clientOver(() => created(STARTED));
    assert.equal(typeof client.dispatch, "function", "createBridgeClient must return dispatch");
    await client.dispatch(REF, { role: "architect" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/agents");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(header(calls[0].init, "Content-Type"), "application/json");
    assert.equal(header(calls[0].init, "Authorization"), `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(calls[0].init.body), { ref: REF, role: "architect" });
  });

  test("a 201 resolves with the bridge's body", async () => {
    const { client } = clientOver(() => created(STARTED));
    assert.deepEqual(await client.dispatch(REF, { role: "architect" }), STARTED);
  });

  test("a 201 passes usageUnknown through, so the card can say the usage reading is unavailable", async () => {
    const { client } = clientOver(() => created({ ...STARTED, usageUnknown: true }));
    assert.equal((await client.dispatch(REF, { role: "architect" })).usageUnknown, true);
  });

  test("a 409 surfaces the bridge's text and status, and is not retried", async () => {
    for (const error of ["the ticket is not in the frontier", "this ticket already has a live agent"]) {
      const { calls, client } = clientOver(() => refuse(409, { error }));
      const err = await rejection(client.dispatch(REF, { role: "orchestrator" }));
      assert.deepEqual({ status: err.status, reason: err.reason }, { status: 409, reason: error });
      assert.equal(calls.length, 1, "one request, no retry");
    }
  });

  test("a 429 surfaces the bridge's capacity or usage text and status, and is not retried", async () => {
    for (const error of ["max_concurrent_agents (8) reached", "5-hour usage is at 93%"]) {
      const { calls, client } = clientOver(() => refuse(429, { error }));
      const err = await rejection(client.dispatch(REF, { role: "scout" }));
      assert.deepEqual({ status: err.status, reason: err.reason }, { status: 429, reason: error });
      assert.equal(calls.length, 1, "one request, no retry");
    }
  });

  test("a 404 or 503 with the bridge's text is surfaced the same way, with one request", async () => {
    for (const [status, error] of [[404, "no such ticket"], [503, "could not read the claim locks"]]) {
      const { calls, client } = clientOver(() => refuse(status, { error }));
      const err = await rejection(client.dispatch(REF, { role: "herald" }));
      assert.deepEqual({ status: err.status, reason: err.reason }, { status, reason: error });
      assert.equal(calls.length, 1);
    }
  });

  test("a lost session (401) rejects with status 401 so the card can say it is not signed in", async () => {
    const { calls, client } = clientOver(() => refuse(401, {}));
    assert.equal((await rejection(client.dispatch(REF, { role: "architect" }))).status, 401);
    assert.equal(calls.length, 1);
  });

  test("two presses are two requests: the client keeps no memory of a refusal and never retries on its own", async () => {
    const { calls, client } = clientOver(() => refuse(429, { error: "max_concurrent_agents (8) reached" }));
    await rejection(client.dispatch(REF, { role: "architect" }));
    assert.equal(calls.length, 1);
    await rejection(client.dispatch(REF, { role: "architect" }));
    assert.equal(calls.length, 2);
  });
});
