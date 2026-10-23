// den-mvp/88 (ADR 0027 decision 2): the router's service token, a second credential for the bridge.
// Pinned interface:
//   createAuth({ ..., serviceToken }) and startBridge({ auth: { ..., serviceToken } }): a string of 32 to 512 characters from
//   [A-Za-z0-9_-]; anything shorter or malformed is ignored (no service access, never a throw that stops the bridge).
//   auth.verifyService(header) -> true only for "Bearer <the service token>". auth.verify(header) (a session) is false for it.
//   routes.mjs: a row may carry `service: true`. Exactly POST /deliveries and POST /deliveries/:id/resume do; no other row.
//   The token is outside SESSION_CAP: it takes no session slot, and four live sessions leave it working.
//   apps/bridge/server.mjs's production entry reads <DEN_STATE_DIR>/service-token (apps/router/service-token.mjs) and passes it.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createAuth, SESSION_CAP } from "./auth.mjs";
import { ROUTES } from "./routes.mjs";
import { startBridge } from "./server.mjs";
import { createFakeRuntime } from "./agents/runtime.mjs";
import { makeStateFixture, FEATURE } from "./bridge-fixture.mjs";
import { CODE, origin, send, login, authed } from "./bridge-auth-helpers.mjs";

const SERVICE = "S".repeat(10) + "e".repeat(33); // 43 characters, base64url

describe("createAuth", () => {
  test("the service token verifies as a service, never as a session", () => {
    const auth = createAuth({ launchCode: CODE, serviceToken: SERVICE });
    assert.equal(auth.verifyService(`Bearer ${SERVICE}`), true);
    assert.equal(auth.verify(`Bearer ${SERVICE}`), false);
  });
  test("a session token is not a service token, and a wrong, missing or malformed header is not either", () => {
    const auth = createAuth({ launchCode: CODE, serviceToken: SERVICE });
    const session = auth.redeem(CODE).token;
    assert.equal(auth.verifyService(`Bearer ${session}`), false);
    for (const h of [undefined, "", "Bearer", `Bearer ${SERVICE}x`, `Bearer ${SERVICE.slice(1)}`, `bearer ${SERVICE}`, SERVICE]) assert.equal(auth.verifyService(h), false, String(h));
  });
  test("with no token configured, or a short or malformed one, no header opens the service gate", () => {
    for (const serviceToken of [undefined, "", "short", "has space ".repeat(5), null, 12345]) {
      const auth = createAuth({ launchCode: CODE, serviceToken });
      for (const h of ["Bearer undefined", "Bearer ", "Bearer short", `Bearer ${String(serviceToken)}`, undefined]) assert.equal(auth.verifyService(h), false, `${serviceToken} / ${h}`);
    }
  });
  test("the service token takes no session slot: four sessions are still redeemable and the fifth is still refused", () => {
    const auth = createAuth({ launchCode: CODE, serviceToken: SERVICE });
    for (let i = 0; i < SESSION_CAP; i++) assert.equal(auth.redeem(auth.newLaunchCode()).status, 200, `session ${i + 1}`);
    assert.equal(auth.redeem(auth.newLaunchCode()).status, 429);
    assert.equal(auth.verifyService(`Bearer ${SERVICE}`), true);
  });
});

describe("the route registry", () => {
  // den-mvp/88 user decision (2026-10-17): the router also posts its router-stop requests with the token.
  test("exactly the start, resume and sweep delivery routes, and the router-stop post, accept the service token", () => {
    assert.deepEqual(ROUTES.filter((r) => r.service).map((r) => `${r.method} ${r.path}`).sort(), ["POST /deliveries", "POST /deliveries/:id/resume", "POST /deliveries/sweep", "POST /router-stops"]);
  });
});

describe("over HTTP", () => {
  let fx, bridge, session;
  beforeEach(async () => {
    fx = await makeStateFixture({ git: true });
    const gitHost = { mainSha: async () => execFileSync("git", ["-C", fx.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
    bridge = await startBridge({ root: fx.root, port: 0, auth: { launchCode: CODE, serviceToken: SERVICE }, gitHost, denState: path.join(fx.root, ".den-state"), checks: { run: async () => ({}), recent: async () => [], running: () => [] }, runtime: createFakeRuntime({ send: true, cancel: true }) });
    session = await login(bridge);
  });
  afterEach(async () => {
    await bridge.close();
    await fx.cleanup();
  });
  const asService = (extra = {}) => ({ Origin: origin(bridge), Authorization: `Bearer ${SERVICE}`, ...extra });

  test("the service token starts a delivery and resumes one", async () => {
    const started = await send(bridge, { method: "POST", path: "/deliveries", headers: asService(), body: { ref: `${FEATURE}/08-plain` } });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const { id } = started.body.delivery;
    assert.equal((await send(bridge, { method: "POST", path: `/deliveries/${id}/stop`, headers: authed(bridge, session), body: {} })).status, 202);
    // A stop is the user's pause (ADR 0027 decision 8): the router's token does not resume it; the session token does.
    const refused = await send(bridge, { method: "POST", path: `/deliveries/${id}/resume`, headers: asService(), body: {} });
    assert.equal(refused.status, 403, `${refused.status} ${refused.text}`);
    const resumed = await send(bridge, { method: "POST", path: `/deliveries/${id}/resume`, headers: authed(bridge, session), body: {} });
    assert.ok([200, 202].includes(resumed.status), `${resumed.status} ${resumed.text}`);
  });
  test("the service token is refused with a 401 on every other mutating route, stop and close included", async () => {
    const others = ROUTES.filter((r) => r.method === "POST" && r.auth === "token" && !r.service);
    assert.ok(others.length > 10);
    for (const r of others) {
      const res = await send(bridge, { method: "POST", path: r.path.replace(/:\w+/g, "an-id"), headers: asService(), body: {} });
      assert.equal(res.status, 401, `${r.method} ${r.path}`);
    }
  });
  test("a wrong token, or none, is a 401 on the delivery routes; the Origin check still applies to the service token", async () => {
    const body = { ref: `${FEATURE}/08-plain` };
    assert.equal((await send(bridge, { method: "POST", path: "/deliveries", headers: asService({ Authorization: `Bearer ${"x".repeat(43)}` }), body })).status, 401);
    assert.equal((await send(bridge, { method: "POST", path: "/deliveries", headers: { Origin: origin(bridge) }, body })).status, 401);
    assert.equal((await send(bridge, { method: "POST", path: "/deliveries", headers: asService({ Origin: "http://evil.example" }), body })).status, 403);
  });
  test("the service token never opens a session: POST /session does not take it", async () => {
    const res = await send(bridge, { method: "POST", path: "/session", headers: { Origin: origin(bridge) }, body: { code: SERVICE } });
    assert.equal(res.status, 401);
  });
});
