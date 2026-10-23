// hardening/16: the den shows the active account and the user switches it by hand. qa specify.
// Red until startBridge takes a `proxy` (the proxy-service.mjs object: start, stop, status, switchAccount) and the routes exist.
// The contract:
//   startBridge({ proxy }) awaits proxy.start() before it answers, and close() calls proxy.stop(). With none, GET /state has accounts: null.
//   GET /state carries accounts: await proxy.status()  ({ active, accounts: [names] }) -- this is what the den shows.
//   POST /accounts/active { name } (session token, same-origin, like every steering route) calls proxy.switchAccount(name) and answers 200 { accounts }.
//     No name or a non-string: 400. An account the proxy refuses: a 4xx, and the active account is what it was. No proxy: 409. No token: 401.
//   No code path switches by itself: a full five-hour usage reading, a shut-down, a start leave switchAccount uncalled.
//   apps/bridge/server.mjs's production entry builds the service with createProxyService (the den start brings up the proxy).
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ROUTES } from "./routes.mjs";
import { startBridge } from "./server.mjs";
import { createFakeRuntime } from "./agents/runtime.mjs";
import { makeStateFixture } from "./bridge-fixture.mjs";
import { CODE, origin, send, login, authed } from "./bridge-auth-helpers.mjs";

function fakeProxy(names = ["a", "b"]) {
  const log = [];
  let active = names[0];
  return {
    log,
    start: async () => { log.push("start"); },
    stop: async () => { log.push("stop"); },
    status: async () => ({ active, accounts: names }),
    switchAccount: async (name) => {
      log.push(`switch ${name}`);
      if (!names.includes(name)) throw new Error("no such account");
      active = name;
    },
  };
}

describe("accounts over HTTP", () => {
  let fx, bridge, session, proxy;
  const open = async (extra = {}) => {
    const gitHost = { mainSha: async () => execFileSync("git", ["-C", fx.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
    bridge = await startBridge({ root: fx.root, port: 0, auth: { launchCode: CODE }, gitHost, denState: path.join(fx.root, ".den-state"), checks: { run: async () => ({}), recent: async () => [], running: () => [] }, runtime: createFakeRuntime({ send: true, cancel: true }), ...extra });
    session = await login(bridge);
  };
  const state = async () => (await send(bridge, { path: "/state" })).body;
  const switchTo = (name, headers) => send(bridge, { method: "POST", path: "/accounts/active", headers: headers ?? authed(bridge, session), body: name === undefined ? {} : { name } });

  beforeEach(async () => { fx = await makeStateFixture({ git: true }); proxy = fakeProxy(); });
  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
    await fx.cleanup();
  });

  test("the route is registered: a session-token steering row, not open to the service token", () => {
    const row = ROUTES.find((r) => r.method === "POST" && r.path === "/accounts/active");
    assert.ok(row, "no POST /accounts/active row");
    assert.equal(row.auth, "token");
    assert.equal(row.mutating, true);
    assert.ok(!row.service);
  });

  test("the den start brings the proxy up before it answers, and close stops it", async () => {
    await open({ proxy });
    assert.deepEqual(proxy.log, ["start"]);
    await bridge.close();
    bridge = undefined;
    assert.deepEqual(proxy.log, ["start", "stop"]);
  });

  test("the den shows the active account in its state; with no proxy it shows none", async () => {
    await open({ proxy });
    assert.deepEqual((await state()).accounts, { active: "a", accounts: ["a", "b"] });
    await bridge.close();
    await open();
    assert.equal((await state()).accounts, null);
  });

  test("the user switches by hand: the state then shows the new account, and the answer carries it", async () => {
    await open({ proxy });
    const res = await switchTo("b");
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.accounts, { active: "b", accounts: ["a", "b"] });
    assert.equal((await state()).accounts.active, "b");
  });

  test("a bad request changes nothing: no name, a non-string, an unknown account, no token, no proxy", async () => {
    await open({ proxy });
    assert.equal((await switchTo(undefined)).status, 400);
    assert.equal((await switchTo(7)).status, 400);
    const unknown = await switchTo("nobody");
    assert.ok(unknown.status >= 400 && unknown.status < 500, `${unknown.status}`);
    assert.equal((await switchTo("b", { Origin: origin(bridge) })).status, 401);
    assert.equal((await state()).accounts.active, "a");
    await bridge.close();
    await open();
    assert.equal((await switchTo("b")).status, 409);
  });

  test("nothing switches by itself: a full five-hour reading and a state read leave switchAccount uncalled", async () => {
    await open({ proxy, usage: () => ({ fiveHour: 100, weekly: 100, sampledAt: new Date().toISOString() }) });
    assert.equal((await state()).usage.fiveHour, 100);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(proxy.log.filter((l) => l.startsWith("switch")), []);
    assert.equal((await state()).accounts.active, "a");
  });
});

describe("the production entry", () => {
  test("builds the proxy service, so the den start brings the proxy up", async () => {
    const src = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
    assert.match(src, /createProxyService/);
  });
});
