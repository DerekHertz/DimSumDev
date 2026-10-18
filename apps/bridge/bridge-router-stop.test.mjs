// den-mvp/88 (user decision 2026-10-17): the router's stops reach Needs you as a `router-stop` request in requests.jsonl.
//   POST /router-stops { key, kind, ref?, text } takes the router's service token (or a session); the same key twice is one row.
//   The snapshot lists it with its key and stop kind; it never holds a ticket's gate. POST /router-stops/:id/dismiss (a session
//   only) marks it handled, so it leaves Needs you; the router's known keys still hold a dismissed pause stop.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { startBridge } from "./server.mjs";
import { makeStateFixture, FEATURE } from "./bridge-fixture.mjs";
import { CODE, origin, send, login, authed } from "./bridge-auth-helpers.mjs";
import { readRequestRows } from "./requests-log.mjs";
import { knownStopKeys } from "../router/client.mjs";

const SERVICE = "R".repeat(43);

describe("router stops", () => {
  let fx, bridge, session;
  beforeEach(async () => {
    fx = await makeStateFixture({ git: true });
    const gitHost = { mainSha: async () => execFileSync("git", ["-C", fx.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
    bridge = await startBridge({ root: fx.root, port: 0, auth: { launchCode: CODE, serviceToken: SERVICE }, gitHost, denState: path.join(fx.root, ".den-state"), checks: { run: async () => ({}), recent: async () => [], running: () => [] } });
    session = await login(bridge);
  });
  afterEach(async () => {
    await bridge.close();
    await fx.cleanup();
  });
  const asService = { Origin: () => origin(bridge), Authorization: `Bearer ${SERVICE}` };
  const post = (body, headers = { Origin: origin(bridge), Authorization: asService.Authorization }) => send(bridge, { method: "POST", path: "/router-stops", headers, body });
  const stop = { key: "pause:d-1:visual-verdict:t1", kind: "visual-verdict", ref: `${FEATURE}/08-plain`, text: "waits for you" };
  const listed = async () => (await send(bridge, { method: "GET", path: "/state" })).body.requests.filter((r) => r.kind === "router-stop");

  test("the service token records a stop once; the snapshot shows it pending with its key and kind, outside the ticket's gate", async () => {
    const first = await post(stop);
    assert.equal(first.status, 201, first.text);
    assert.equal((await post(stop)).status, 200);
    const rows = await listed();
    assert.deepEqual(rows.map((r) => [r.key, r.stop, r.ref, r.note, r.state]), [[stop.key, "visual-verdict", stop.ref, "waits for you", "pending"]]);
    const ticket = (await send(bridge, { method: "GET", path: "/state" })).body.tickets.find((t) => t.ref === stop.ref);
    assert.equal(ticket?.request ?? null, null);
  });
  test("a stop with no ref (the bridge was down, a bad reading) is kept too; a malformed one is a 400", async () => {
    assert.equal((await post({ key: "usage-reading", kind: "usage-reading", text: "no reading" })).status, 201);
    for (const bad of [{}, { ...stop, key: "" }, { ...stop, kind: "Not A Kind" }, { ...stop, text: "x".repeat(501) }, { ...stop, ref: 5 }]) assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  });
  test("no token or a wrong one is a 401", async () => {
    assert.equal((await post(stop, { Origin: origin(bridge) })).status, 401);
    assert.equal((await post(stop, { Origin: origin(bridge), Authorization: `Bearer ${"x".repeat(43)}` })).status, 401);
  });
  test("the user dismisses it with a session; the service token cannot; a dismissed pause key stays known to the router", async () => {
    const { id } = (await post(stop)).body.request;
    const dismiss = (headers) => send(bridge, { method: "POST", path: `/router-stops/${id}/dismiss`, headers, body: {} });
    assert.equal((await dismiss({ Origin: origin(bridge), Authorization: asService.Authorization })).status, 401);
    assert.equal((await dismiss(authed(bridge, session))).status, 200);
    assert.equal((await dismiss(authed(bridge, session))).status, 404, "only a waiting stop is dismissed");
    assert.equal((await listed()).find((r) => r.id === id)?.state, "handled");
    assert.deepEqual(knownStopKeys(await readRequestRows(fx.root)), [stop.key]);
  });
  test("a dismissed stop that names no occurrence is forgotten by the router, so it comes back if still true", async () => {
    const { id } = (await post({ key: "usage-reading", kind: "usage-reading", text: "no reading" })).body.request;
    assert.deepEqual(knownStopKeys(await readRequestRows(fx.root)), ["usage-reading"]);
    await send(bridge, { method: "POST", path: `/router-stops/${id}/dismiss`, headers: authed(bridge, session), body: {} });
    assert.deepEqual(knownStopKeys(await readRequestRows(fx.root)), []);
  });
});
