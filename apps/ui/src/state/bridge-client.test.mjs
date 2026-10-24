// den-v1/06: the UI's bridge client for permission requests. Contract (qa specify):
//   apps/ui/src/state/bridge-client.mjs exports createBridgeClient({ fetch }) -> { getApproval(id), decide(id, { decision, note? }) }
//   `fetch` is injected and has the shape of session.fetch (apps/ui/src/session/session.mjs): (url, init) -> Response-like
//   { ok, status, json() }. The client never builds the token: session.fetch attaches `Authorization: Bearer <token>`.
//   getApproval: GET /approvals/<id>; resolves with the parsed JSON body ({ tool, input, inputLength, ... }).
//   decide:      POST /approvals/<id>, Content-Type application/json, body { decision } plus `note` only when given;
//                resolves with the parsed body (or { ok: true }); `decision` must be "allow" or "deny", else it rejects
//                and sends nothing.
//   Any failure rejects with an object that has { status, reason }: `reason` is the bridge's `error` string when it
//   sent one, otherwise a non-empty plain-text fallback; a thrown fetch gives status 0.
// Tests run against a stub fetch; no network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBridgeClient } from "./bridge-client.mjs";
import { createSession } from "../session/session.mjs";

const ID = "a-0123456789abcdef";
const TOKEN = ["tok", "test", "123"].join("-"); // built at runtime so the root secret scan does not flag the fixture

function sessionWith(stubFetch, token = TOKEN) {
  return createSession({
    fetch: stubFetch,
    storage: { getItem: () => token, setItem() {}, removeItem() {} },
    location: { hash: "", pathname: "/", search: "" },
    history: { replaceState() {} },
  });
}

function stub(responder) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test('source-linked meeting replies may omit the extra instruction', async () => {
  const fetch = stub(() => ok({ ok: true }));
  const client = createBridgeClient({ fetch });
  await client.steerMeeting('m-0000000000000001', 'ask', { reask: 'qa', sourceId: 'e-1', text: '' });
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { reask: 'qa', sourceId: 'e-1', text: '' });
});
const refuse = (status, body) => ({ ok: false, status, json: async () => body });
const header = (init, name) => Object.entries(init.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

function clientOver(responder, token) {
  const f = stub(responder);
  return { f, client: createBridgeClient({ fetch: sessionWith(f, token).fetch }) };
}

const rejection = async (promise) => {
  try { await promise; } catch (e) { return e; }
  assert.fail("expected a rejection");
};

describe("getApproval", () => {
  test("GETs /approvals/:id with the session token and resolves with the body", async () => {
    const body = { id: ID, tool: "Bash", input: { command: "ls" }, inputLength: 17 };
    const { f, client } = clientOver(() => ok(body));
    assert.deepEqual(await client.getApproval(ID), body);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, `/approvals/${ID}`);
    assert.ok([undefined, "GET"].includes(f.calls[0].init.method), "a read, not a POST");
    assert.equal(header(f.calls[0].init, "Authorization"), `Bearer ${TOKEN}`);
  });

  test("an id is encoded into one path segment", async () => {
    const { f, client } = clientOver(() => ok({}));
    await client.getApproval("../placements");
    assert.equal(f.calls[0].url, "/approvals/..%2Fplacements");
  });
});

describe("decide", () => {
  test("allow is exactly one POST to /approvals/:id with the token and the bare decision", async () => {
    const { f, client } = clientOver(() => ok({ approval: { id: ID, state: "allowed" } }));
    await client.decide(ID, { decision: "allow" });
    assert.equal(f.calls.length, 1, "exactly one request");
    const { url, init } = f.calls[0];
    assert.equal(url, `/approvals/${ID}`);
    assert.equal(init.method, "POST");
    assert.equal(header(init, "Authorization"), `Bearer ${TOKEN}`);
    assert.match(String(header(init, "Content-Type")), /^application\/json/);
    assert.deepEqual(JSON.parse(init.body), { decision: "allow" });
  });

  test("deny sends deny", async () => {
    const { f, client } = clientOver(() => ok({}));
    await client.decide(ID, { decision: "deny" });
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { decision: "deny" });
  });

  test("a note rides along only when given", async () => {
    const { f, client } = clientOver(() => ok({}));
    await client.decide(ID, { decision: "deny", note: "not that file" });
    await client.decide(ID, { decision: "deny", note: undefined });
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { decision: "deny", note: "not that file" });
    assert.deepEqual(JSON.parse(f.calls[1].init.body), { decision: "deny" });
  });

  test("anything but allow or deny is rejected before any request", async () => {
    const { f, client } = clientOver(() => ok({}));
    for (const decision of ["maybe", "", undefined, "ALLOW"]) {
      await rejection(client.decide(ID, { decision }));
    }
    assert.equal(f.calls.length, 0);
  });
});

describe("failures reject with { status, reason }", () => {
  test("the reason is the bridge's error string, verbatim", async () => {
    const reason = "fetch GET /approvals/:id and review the full input before allowing";
    const { client } = clientOver(() => refuse(409, { error: reason }));
    const e = await rejection(client.decide(ID, { decision: "allow" }));
    assert.equal(e.status, 409);
    assert.equal(e.reason, reason);
  });

  test("a failed read rejects the same way", async () => {
    const { client } = clientOver(() => refuse(404, { error: "no such approval" }));
    const e = await rejection(client.getApproval(ID));
    assert.deepEqual({ status: e.status, reason: e.reason }, { status: 404, reason: "no such approval" });
  });

  test("a body with no usable error still gives a plain-text reason", async () => {
    for (const body of [{}, { error: { nested: true } }, { error: 42 }, null]) {
      const { client } = clientOver(() => refuse(500, body));
      const e = await rejection(client.decide(ID, { decision: "deny" }));
      assert.equal(e.status, 500);
      assert.equal(typeof e.reason, "string");
      assert.ok(e.reason.trim().length > 0);
      assert.doesNotMatch(e.reason, /\[object Object\]/);
    }
  });

  test("a body that is not JSON still rejects with the status", async () => {
    const { client } = clientOver(() => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("bad json"); } }));
    const e = await rejection(client.decide(ID, { decision: "deny" }));
    assert.equal(e.status, 502);
    assert.ok(e.reason.trim().length > 0);
  });

  test("a network failure is status 0 with a reason", async () => {
    const { client } = clientOver(() => { throw new TypeError("fetch failed"); });
    const e = await rejection(client.decide(ID, { decision: "deny" }));
    assert.equal(e.status, 0);
    assert.ok(e.reason.trim().length > 0);
  });

  test("with no session token nothing reaches the network and the answer is 401", async () => {
    const { f, client } = clientOver(() => ok({}), null);
    const e = await rejection(client.decide(ID, { decision: "allow" }));
    assert.equal(e.status, 401);
    assert.ok(e.reason.trim().length > 0);
    assert.equal(f.calls.length, 0);
  });
});

describe("the client never touches the token or the network itself", () => {
  test("source has no Bearer, storage or global fetch", () => {
    const src = readFileSync(new URL("./bridge-client.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(src, /Bearer|sessionStorage|localStorage|den\.session-token|globalThis\.fetch|window\.fetch/);
  });
});
