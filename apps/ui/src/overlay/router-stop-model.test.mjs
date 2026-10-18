// den-mvp/88: a stop the router met (snapshot.requests, kind "router-stop") shows under Needs you with a Dismiss, and the
// client's dismiss posts to the bridge route. A dismissed stop is handled, so it leaves the list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsYouModel } from "./overlay-model.mjs";
import { createBridgeClient } from "../state/bridge-client.mjs";

const stop = (extra = {}) => ({ id: "r-1", ts: "2026-10-17T10:00:00Z", kind: "router-stop", ref: "den-mvp/90-x", note: "90-x needs your answer: a visual verdict", key: "pause:d-1:visual-verdict:t", stop: "visual-verdict", state: "pending", ...extra });

test("a pending router-stop is a Needs you request that names the stop and carries the id the dismiss needs", () => {
  const { count, requests } = needsYouModel({ tickets: [], requests: [stop()] }, 0);
  assert.equal(count, 1);
  const [r] = requests;
  assert.equal(r.kind, "router-stop");
  assert.equal(r.key, "router-stop:r-1");
  assert.equal(r.id, "r-1");
  assert.match(r.title, /needs your answer: a visual verdict/);
  assert.match(r.eyebrow, /90-x/);
});

test("a handled router-stop, and a gate request, are not router-stop cards", () => {
  const { requests } = needsYouModel({ tickets: [], requests: [stop({ state: "handled" }), { id: "g-1", kind: "dispatch-approve", ref: "den-mvp/02-a", state: "pending" }] }, 0);
  assert.deepEqual(requests.filter((r) => r.kind === "router-stop"), []);
});

test("a stop with no ref still shows", () => {
  const { requests } = needsYouModel({ tickets: [], requests: [stop({ ref: null, stop: "bridge-down", note: "the bridge has been down for 10 minutes" })] }, 0);
  assert.equal(requests.length, 1);
  assert.match(requests[0].title, /bridge has been down/);
});

test("dismissRouterStop posts to the dismiss route with the id", async () => {
  const calls = [];
  const fetch = async (url, init) => (calls.push([init.method, url]), new Response(JSON.stringify({ ok: true }), { status: 200 }));
  await createBridgeClient({ fetch }).dismissRouterStop("r-1");
  assert.deepEqual(calls, [["POST", "/router-stops/r-1/dismiss"]]);
});
