// organism-infra/139 (ADR 0016 decision 6.1): the auth gate, table-driven from the one route registry.
//
// Seams: `ROUTES` exported by ./routes.mjs (the registry: rows of { method, path, auth, mutating } where auth is
// "none" | "origin" | "token"), and startBridge({ root, port: 0, auth: { launchCode } }) over HTTP.
// A route that is added or renamed shows up in ROUTES and is covered here by default; a mutating row with no
// entry in BODIES below fails the suite on purpose ("a mutating row missing from the auth tests fails").
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { startBridge } from "./server.mjs";
import { SHA_A, SHA_B, SHA_C, liveReleases } from "./build/release-test-helpers.mjs";
import { ROUTES } from "./routes.mjs";
import { execFileSync } from "node:child_process";
import { makeStateFixture, FEATURE } from "./bridge-fixture.mjs";
import { CODE, origin, send, login, authed } from "./bridge-auth-helpers.mjs";
// The fake runtime serves the agent routes (organism-infra/140). Until cells/runtime.mjs exists the older rows
// still run; cells/host-core.test.mjs fails on the missing module.
const { createFakeRuntime } = await import("./cells/runtime.mjs").catch(() => ({}));

const DISPATCH_REF = `${FEATURE}/02-ready-p0`; // gate "dispatch" in the fixture

// A real and a bogus body for every token-gated mutating row, keyed "METHOD path". The bogus one names an id
// that does not exist, so an unauthenticated caller must not be able to tell it apart from the real one.
const BODIES = {
  // den-mvp/11: a roll back needs two releases; `prepare` makes them in the state folder the bridge was started with.
  "POST /build/rollback": {
    real: { to: SHA_A },
    bogus: { to: SHA_C },
    prepare: async () => void (await liveReleases(denState, [SHA_A, SHA_B])),
  },
  // den-mvp/86: with no release folders the bridge has no updater, so each answers 409 to a valid caller and nothing happens.
  "POST /update/now": { real: {}, bogus: {} },
  "POST /update/restart": { real: {}, bogus: {} },
  "POST /update/auto": { real: { auto: false }, bogus: { auto: true } },
  // den-mvp/34: the checks of an open pull request (the fake git host knows #7), run by the fake checks below.
  "POST /checks": { real: { pr: 7 }, bogus: { pr: 8 } },
  // den-mvp/13: approve or decline a ticket waiting at ready-for-human (the fixture's 06-human).
  // den-mvp/45: the user's answer to Bao's release draft; with no draft both ids are a 409 and nothing is published.
  "POST /release/approve": { real: { get id() { return draftId; } }, bogus: { id: "no-draft" }, prepare: async () => void (draftId = (await bridge.releases.propose()).id) },
  "POST /release/decline": { real: { get id() { return draftId; } }, bogus: { id: "no-draft" }, prepare: async () => void (draftId = (await bridge.releases.propose()).id) },
  "POST /tickets/approve": { real: { ref: `${FEATURE}/06-human` }, bogus: { ref: `${FEATURE}/99-nope` } },
  "POST /tickets/decline": { real: { ref: `${FEATURE}/06-human`, note: "not now" }, bogus: { ref: `${FEATURE}/99-nope`, note: "no" } },
  "POST /projects/active": { real: { slug: "den" }, bogus: { slug: "nope" } },
  "POST /requests": {
    real: { kind: "dispatch-approve", ref: DISPATCH_REF },
    bogus: { kind: "dispatch-approve", ref: `${FEATURE}/99-nope` },
  },
  // organism-infra/140: the agent routes, served by a bridge started with a fake runtime (beforeEach below).
  "POST /agents": {
    real: { ref: DISPATCH_REF, role: "architect" },
    bogus: { ref: `${FEATURE}/99-nope`, role: "architect" },
  },
  // den-v1 loop S1: a task needs no ticket to exist, so "real" and "bogus" differ only in what would be written.
  "POST /tasks": {
    real: { role: "scout", text: "count the steamer baskets" },
    bogus: { role: "herald", text: "something else entirely" },
  },
  // A stop needs a live agent for the authenticated happy path; `prepare` starts one and returns its id.
  "POST /agents/:id/stop": {
    real: {},
    bogus: {},
    prepare: async () => (await bridge.host.start({ ref: `${FEATURE}/31-auth-stop`, role: "scout" })).agent.id,
  },
  // den-v1 loop S5: a message needs a live agent whose runtime takes messages (the fake is started with send on).
  "POST /agents/:id/message": {
    real: { text: "use port 5173" },
    bogus: { text: "something else entirely" },
    prepare: async () => (await bridge.host.start({ ref: `${FEATURE}/33-auth-message`, role: "scout" })).agent.id,
  },
  // organism-infra/107: a cancel needs a live agent with one message queued; `prepare` makes both, returns the agent id and
  // keeps the message id for the body. A hand-over needs only a live agent.
  "POST /agents/:id/message/cancel": {
    get real() {
      return { messageId: queuedMessageId };
    },
    bogus: { messageId: "00000000-0000-4000-8000-00000000beef" },
    prepare: async () => {
      const { agent } = await bridge.host.start({ ref: `${FEATURE}/35-auth-cancel`, role: "scout" });
      queuedMessageId = (await bridge.host.message(agent.id, { text: "cancel me" })).messageId;
      return agent.id;
    },
  },
  "POST /agents/:id/handover": {
    real: {},
    bogus: {},
    prepare: async () => (await bridge.host.start({ ref: `${FEATURE}/36-auth-handover`, role: "scout" })).agent.id,
  },
  // organism-infra/141: an approval needs a live agent holding a permission request; `prepare` makes one and returns
  // its minted id. A deny needs no prior GET, so the authenticated happy path is a plain 200.
  "POST /approvals/:id": {
    real: { decision: "deny" },
    bogus: { decision: "deny" },
    prepare: async () => {
      const { agent } = await bridge.host.start({ ref: `${FEATURE}/32-auth-approve`, role: "scout" });
      fake.spawns.at(-1).emit({ type: "permission-request", requestId: "auth-r1", tool: "Bash", input: { command: "ls" } });
      for (let i = 0; i < 100; i += 1) {
        const state = await send(bridge, { path: "/state" });
        const found = state.body?.approvals?.find((a) => a.agentId === agent.id);
        if (found) return found.id;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("the fake runtime's permission request never became an approval");
    },
  },
  // den-mvp outcome 2: a message into a role's conversation; the path names a role, and `prepare` starts its one live run.
  "POST /conversations/:role/message": {
    real: { text: "use port 5173" },
    bogus: { text: "something else entirely" },
    prepare: async () => ((await bridge.host.start({ ref: `${FEATURE}/34-auth-converse`, role: "herald" })), "herald"),
  },
  // den-mvp outcome 3: a delivery is started on a frontier ticket; the steering rows need one that is running or waiting.
  "POST /deliveries": {
    real: { ref: `${FEATURE}/08-plain` },
    bogus: { ref: `${FEATURE}/99-nope` },
  },
  "POST /deliveries/:id/stop": { real: {}, bogus: {}, prepare: () => delivery() },
  "POST /deliveries/:id/resume": { real: {}, bogus: {}, prepare: () => delivery({ stopped: true }) },
  "POST /deliveries/:id/close": { real: {}, bogus: {}, prepare: () => delivery({ stopped: true }) },
  // den-mvp/88: the router records a stop it met; a dismiss needs one waiting, which `prepare` records and returns the id of.
  "POST /router-stops": {
    real: { key: "usage-reading", kind: "usage-reading", text: "the usage reading failed" },
    bogus: { key: "order:99-nope", kind: "order", text: "something else entirely" },
  },
  "POST /router-stops/:id/dismiss": {
    real: {},
    bogus: {},
    prepare: async () => {
      const res = await send(bridge, { method: "POST", path: "/router-stops", headers: authed(bridge, token), body: { key: "bridge-down", kind: "bridge-down", text: "the bridge is down" } });
      assert.equal(res.status, 201, res.text);
      return res.body.request.id;
    },
  },
  // den-mvp outcome 4: a meeting is started on a topic; the steering rows need one that is running, waiting or briefed.
  "POST /meetings": { real: { topic: "one log or many?", roles: ["qa"] }, bogus: { topic: "something else", roles: ["scout"] } },
  "POST /meetings/:id/stop": { real: {}, bogus: {}, prepare: () => meeting() },
  "POST /meetings/:id/resume": { real: {}, bogus: {}, prepare: () => meeting({ stopped: true }) },
  "POST /meetings/:id/close": { real: {}, bogus: {}, prepare: () => meeting({ stopped: true }) },
  "POST /meetings/:id/decide": { real: { option: "A" }, bogus: { option: "B" }, prepare: () => meeting({ briefed: true }) },
  "POST /meetings/:id/ask": { real: { text: "and at restart?" }, bogus: { text: "something else" }, prepare: () => meeting({ briefed: true }) },
};
// A meeting with one seat: running (its take never ends), stopped, or taken to its brief by the fake agents. -> its id
async function meeting({ stopped = false, briefed = false } = {}) {
  const headers = authed(bridge, token);
  const started = await send(bridge, { method: "POST", path: "/meetings", headers, body: { topic: "one log or many?", roles: ["qa"] } });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const { id } = started.body.meeting;
  const spawned = async (n) => {
    for (let i = 0; i < 200 && !fake.spawns[n]; i += 1) await new Promise((r) => setTimeout(r, 10));
    return fake.spawns[n];
  };
  if (stopped) assert.equal((await send(bridge, { method: "POST", path: `/meetings/${id}/stop`, headers, body: {} })).status, 202);
  if (briefed) {
    const say = (rec, text) => (rec.emit({ type: "reply", text }), rec.emit({ type: "done", ok: true }));
    say(await spawned(0), "Claim: one log");
    say(await spawned(1), "## Option A: one\n## Option B: many\nRECOMMENDED: A");
    for (let i = 0; i < 200; i += 1) {
      if ((await send(bridge, { path: "/state" })).body?.meetings?.some((m) => m.id === id && m.state === "briefed")) break;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  return id;
}
// A delivery on its own ticket, running (its developer never ends) or stopped. -> its id
async function delivery({ stopped = false } = {}) {
  const headers = authed(bridge, token);
  const started = await send(bridge, { method: "POST", path: "/deliveries", headers, body: { ref: `${FEATURE}/07-bumpable` } });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const { id } = started.body.delivery;
  if (stopped) assert.equal((await send(bridge, { method: "POST", path: `/deliveries/${id}/stop`, headers, body: {} })).status, 202);
  return id;
}
// Path parameters: a registry path like "/cells/:id/stop" is exercised with each value.
const fill = (pattern, value) => pattern.replace(/:\w+/g, value);

const tokenRows = ROUTES.filter((r) => r.auth === "token" && r.method !== "GET");
const originRows = ROUTES.filter((r) => r.auth === "origin");
const noneRows = ROUTES.filter((r) => r.auth === "none");
const runRows = ROUTES.filter((r) => r.auth === "run");

let fx;
let denState;
let bridge;
let token;
let file;
let fake;
let queuedMessageId; // set by the cancel row's prepare (organism-infra/107)

beforeEach(async () => {
  fx = await makeStateFixture({ git: true });
  file = path.join(fx.root, ".scratch", "_requests", "requests.jsonl");
  fake = createFakeRuntime?.({ send: true, cancel: true }) ?? null;
  // The delivery rows never get past their first agent here, so the git host is only asked for the main branch's commit.
  const gitHost = {
    mainSha: async () => execFileSync("git", ["-C", fx.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    lastTag: async () => "v0.1.0", mergedSince: async () => [{ number: 3, title: "fix: x", body: "" }], publishRelease: async () => {},
    prState: async ({ number }) => (number === 7 ? { number, state: "OPEN", sha: "a".repeat(40), checks: [], mergeable: "MERGEABLE" } : Promise.reject(new Error("not found"))),
  };
  const checks = { run: async () => ({}), recent: async () => [], running: () => [] };
  denState = path.join(fx.root, ".den-state"); // empty: the bridge serves the checkout's build until a test makes releases
  bridge = await startBridge({ root: fx.root, port: 0, auth: { launchCode: CODE }, gitHost, denState, checks, ...(fake ? { runtime: fake } : {}) });
  token = await login(bridge);
});
afterEach(async () => {
  for (const r of fake?.spawns ?? []) if (!r.exited) r.exit();
  await bridge.close();
  await fx.cleanup();
});

let draftId = null;
const requestsFile = () => readFile(file, "utf8");
const bodyFor = (row, which) => {
  const entry = BODIES[`${row.method} ${row.path}`];
  assert.ok(entry, `add a real and a bogus body for ${row.method} ${row.path} to BODIES: every mutating route is auth-tested`);
  return entry[which];
};
const call = (row, { which = "real", id = "an-id", headers = {}, body, host, query = "" } = {}) =>
  send(bridge, { method: row.method, path: fill(row.path, id) + query, headers, body: body ?? bodyFor(row, which), host });

describe("the route registry", () => {
  test("every row is well formed and unique", () => {
    assert.ok(Array.isArray(ROUTES) && ROUTES.length > 0);
    const seen = new Set();
    for (const r of ROUTES) {
      assert.match(r.method, /^[A-Z]+$/);
      assert.match(r.path, /^\//);
      assert.ok(["none", "origin", "token", "run"].includes(r.auth), `auth of ${r.method} ${r.path}`);
      assert.equal(typeof r.mutating, "boolean", `mutating of ${r.method} ${r.path}`);
      const key = `${r.method} ${r.path}`;
      assert.ok(!seen.has(key), `duplicate row ${key}`);
      seen.add(key);
    }
  });

  test("it holds the known routes with the auth ADR 0016 gives each", () => {
    const row = (m, p) => ROUTES.find((r) => r.method === m && r.path === p);
    for (const p of ["/state", "/metrics", "/events"]) {
      assert.equal(row("GET", p)?.auth, "none", `GET ${p}`);
      assert.equal(row("GET", p)?.mutating, false, `GET ${p}`);
    }
    assert.equal(row("POST", "/session")?.auth, "origin");
    assert.equal(row("POST", "/requests")?.auth, "token");
    assert.equal(row("POST", "/requests")?.mutating, true);
  });

  test("an unauthenticated row is a read; every other method needs Origin or token", () => {
    for (const r of ROUTES) {
      if (r.auth === "none") {
        assert.equal(r.method, "GET", `${r.method} ${r.path} must not be unauthenticated`);
        assert.equal(r.mutating, false, `${r.path} must not be mutating`);
      }
      if (r.method !== "GET") assert.notEqual(r.auth, "none", `${r.method} ${r.path}`);
    }
  });
});

describe("unauthenticated reads stay open", () => {
  for (const r of noneRows.filter((x) => x.path !== "/events")) {
    test(`GET ${r.path} needs no Origin and no token`, async () => {
      const res = await send(bridge, { path: r.path });
      assert.equal(res.status, 200);
    });
  }
  test("GET /events opens the stream with no token", async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port: bridge.port, path: "/events" }, (r) => {
        resolve({ status: r.statusCode, type: r.headers["content-type"] });
        req.destroy();
      });
      req.on("error", reject);
    });
    assert.equal(res.status, 200);
    assert.match(res.type, /text\/event-stream/);
  });
  for (const r of noneRows) {
    test(`a foreign Host is 403 on GET ${r.path}`, async () => {
      assert.equal((await send(bridge, { path: r.path, host: "evil.example" })).status, 403);
    });
  }
  test("the snapshot, metrics and error bodies never carry the launch code or a session token", async () => {
    for (const p of ["/state", "/metrics"]) {
      const res = await send(bridge, { path: p });
      assert.ok(!res.text.includes(CODE), `${p} leaks the launch code`);
      assert.ok(!res.text.includes(token), `${p} leaks the session token`);
    }
  });
});

// den-mvp/38: a "run" row answers only the token of a live run (the den script). The user's own session token, no
// token, and a foreign Origin are all refused before the body is read.
describe("run-gated routes (table-driven from ROUTES)", () => {
  for (const r of runRows) {
    const name = `${r.method} ${r.path}`;
    test(`${name}: no token, the user's session token and a made-up token are 401; a foreign Origin is 403`, async () => {
      for (const auth of [undefined, `Bearer ${token}`, `Bearer ${"f".repeat(43)}`]) {
        const res = await send(bridge, { method: r.method, path: fill(r.path, "board_comment"), body: { ref: "x/01", text: "hi" }, headers: { Origin: origin(bridge), ...(auth ? { Authorization: auth } : {}) } });
        assert.equal(res.status, 401, `${auth ?? "no token"}: ${res.text}`);
      }
      const foreign = await send(bridge, { method: r.method, path: fill(r.path, "board_comment"), body: {}, headers: { Origin: "http://evil.example", Authorization: `Bearer ${token}` } });
      assert.equal(foreign.status, 403);
    });
  }
});

describe("token-gated mutating routes (table-driven from ROUTES)", () => {
  test("the registry has at least one token-gated mutating row, POST /requests among them", () => {
    assert.ok(tokenRows.some((r) => r.method === "POST" && r.path === "/requests"));
  });

  for (const r of tokenRows) {
    const name = `${r.method} ${r.path}`;
    describe(name, () => {
      test("valid Bearer, same-origin Origin (127.0.0.1 or localhost) and JSON succeeds", async () => {
        const prepared = BODIES[`${r.method} ${r.path}`]?.prepare;
        const id = prepared ? await prepared() : "an-id";
        const res = await call(r, { id, headers: authed(bridge, token) });
        assert.ok(res.status >= 200 && res.status < 300, `${res.status} ${res.text}`);
        // A repeat of the same request may now be refused as a duplicate (409); what matters is that the localhost
        // spelling of the same origin is not refused by the gate.
        const lh = await call(r, { which: "real", headers: { Origin: origin(bridge, "localhost"), Authorization: `Bearer ${token}` } });
        assert.notEqual(lh.status, 403, "http://localhost:<port> is an allowed Origin");
        assert.notEqual(lh.status, 401);
      });

      test("no Authorization is 401, identical for a real and a bogus id, and writes nothing", async () => {
        const before = await requestsFile();
        const real = await call(r, { which: "real", id: "real-id", headers: { Origin: origin(bridge) } });
        const bogus = await call(r, { which: "bogus", id: "bogus-id", headers: { Origin: origin(bridge) } });
        assert.equal(real.status, 401);
        assert.equal(bogus.status, 401);
        assert.deepEqual(bogus.body, real.body, "the refusal must not reveal whether the id exists");
        assert.equal(await requestsFile(), before);
      });

      test("auth runs before validation: an unauthenticated garbage body is still 401, not 400", async () => {
        const res = await call(r, { body: "{not json", headers: { Origin: origin(bridge) } });
        assert.equal(res.status, 401);
        const big = await call(r, { body: { x: "x".repeat(2000) }, headers: { Origin: origin(bridge) } });
        assert.equal(big.status, 401);
      });

      const badAuth = {
        "a wrong token": () => `Bearer ${"f".repeat(64)}`,
        "a token of the wrong length (short)": () => "Bearer abc",
        "a token of the wrong length (long)": () => `Bearer ${"a".repeat(5000)}`,
        "a missing token": () => "Bearer",
        "an empty token": () => "Bearer ",
        "the wrong scheme": () => `Basic ${token}`,
        "a bare token with no scheme": () => token,
      };
      for (const [label, header] of Object.entries(badAuth)) {
        test(`${label} is 401 (never 500), echoes nothing, writes nothing`, async () => {
          const before = await requestsFile();
          const res = await call(r, { headers: { Origin: origin(bridge), Authorization: header() } });
          assert.equal(res.status, 401, res.text);
          assert.ok(!res.text.includes(token));
          assert.equal(await requestsFile(), before);
        });
      }

      test("the token is accepted only in the Authorization header, never a query string", async () => {
        const before = await requestsFile();
        const res = await call(r, { headers: { Origin: origin(bridge) }, query: `?token=${token}&access_token=${token}` });
        assert.equal(res.status, 401);
        const viaHeader = await call(r, { headers: { Origin: origin(bridge), "X-Token": token, "X-Auth-Token": token } });
        assert.equal(viaHeader.status, 401);
        assert.equal(await requestsFile(), before);
      });

      test("a missing Origin is 403 even with a valid token (Origin is required, not optional)", async () => {
        const before = await requestsFile();
        const res = await call(r, { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(res.status, 403);
        assert.equal(await requestsFile(), before);
      });

      for (const [label, o] of [
        ["a foreign Origin", "http://evil.example"],
        ["Origin: null", "null"],
        ["the right host on another port", (p) => `http://127.0.0.1:${p + 1}`],
        ["a look-alike origin", () => "http://127.0.0.1.evil.example"],
        ["https instead of http", (p) => `https://127.0.0.1:${p}`],
      ]) {
        test(`${label} is 403`, async () => {
          const before = await requestsFile();
          const value = typeof o === "function" ? o(bridge.port) : o;
          const res = await call(r, { headers: { Origin: value, Authorization: `Bearer ${token}` } });
          assert.equal(res.status, 403);
          assert.equal(await requestsFile(), before);
        });
      }

      test("a wrong or missing Content-Type is 403", async () => {
        const before = await requestsFile();
        for (const ct of ["text/plain", "application/x-www-form-urlencoded", null]) {
          const res = await call(r, { headers: { ...authed(bridge, token), "Content-Type": ct } });
          assert.equal(res.status, 403, `Content-Type ${ct}`);
        }
        assert.equal(await requestsFile(), before);
      });

      test("a foreign Host is 403 even with a valid token", async () => {
        const res = await call(r, { headers: authed(bridge, token), host: "evil.example" });
        assert.equal(res.status, 403);
      });

      test("a body over 4 KB is 413 even with a valid token", async () => {
        const before = await requestsFile();
        const res = await call(r, { headers: authed(bridge, token), body: { pad: "x".repeat(5000) } });
        assert.equal(res.status, 413);
        assert.equal(await requestsFile(), before);
      });

      test("OPTIONS carries no Access-Control-Allow-* header", async () => {
        for (const o of ["http://evil.example", origin(bridge)]) {
          const res = await send(bridge, {
            method: "OPTIONS",
            path: fill(r.path, "an-id"),
            headers: { Origin: o, "Access-Control-Request-Method": r.method, "Access-Control-Request-Headers": "authorization, content-type" },
          });
          const allow = Object.keys(res.headers).filter((h) => h.startsWith("access-control-allow-"));
          assert.deepEqual(allow, [], `Origin ${o}`);
          assert.ok(res.status >= 400, "a preflight is never answered with success");
        }
      });
    });
  }
});

describe("origin-gated routes (POST /session): Origin, Content-Type, Host and body cap, no Bearer", () => {
  for (const r of originRows) {
    const name = `${r.method} ${r.path}`;
    const fresh = () => ({ code: "not-the-code" });
    test(`${name}: needs no Bearer`, async () => {
      const res = await send(bridge, { method: r.method, path: r.path, body: fresh(), headers: { Origin: origin(bridge) } });
      assert.notEqual(res.status, 403, "reached the handler");
      assert.ok(res.status < 500);
    });
    test(`${name}: a missing or foreign Origin is 403`, async () => {
      for (const o of [undefined, "http://evil.example", "null"]) {
        const headers = o === undefined ? {} : { Origin: o };
        const res = await send(bridge, { method: r.method, path: r.path, body: { code: CODE }, headers });
        assert.equal(res.status, 403, `Origin ${o}`);
        assert.equal(res.body?.token, undefined);
      }
    });
    test(`${name}: a wrong Content-Type is 403`, async () => {
      const res = await send(bridge, { method: r.method, path: r.path, body: { code: CODE }, headers: { Origin: origin(bridge), "Content-Type": "text/plain" } });
      assert.equal(res.status, 403);
    });
    test(`${name}: a foreign Host is 403`, async () => {
      const res = await send(bridge, { method: r.method, path: r.path, body: { code: CODE }, headers: { Origin: origin(bridge) }, host: "evil.example" });
      assert.equal(res.status, 403);
    });
    test(`${name}: a body over 4 KB is 413`, async () => {
      const res = await send(bridge, { method: r.method, path: r.path, body: { code: "x".repeat(5000) }, headers: { Origin: origin(bridge) } });
      assert.equal(res.status, 413);
    });
    test(`${name}: OPTIONS carries no Access-Control-Allow-* header`, async () => {
      const res = await send(bridge, {
        method: "OPTIONS",
        path: r.path,
        headers: { Origin: "http://evil.example", "Access-Control-Request-Method": r.method },
      });
      assert.deepEqual(Object.keys(res.headers).filter((h) => h.startsWith("access-control-allow-")), []);
    });
  }
});

describe("default deny: an unknown route is 404 with no side effect, before any lookup", () => {
  const unknown = [
    ["POST", "/nope"],
    ["POST", "/cells"],
    ["POST", "/cells/abc/stop"],
    ["POST", "/approvals"],
    ["POST", "/approvals/abc/extra"],
    ["POST", "/Requests"],
    ["POST", "/requests/"],
    ["POST", "/requests/extra"],
    ["DELETE", "/requests"],
    ["PUT", "/requests"],
    ["PATCH", "/requests"],
    ["DELETE", "/state"],
    ["POST", "/state"],
    ["POST", "/metrics"],
    ["POST", "/events"],
  ].filter(([m, p]) => !ROUTES.some((r) => r.method === m && fill(r.path, "x") === fill(p, "x")));

  for (const [method, p] of unknown) {
    test(`${method} ${p} is 404 with and without a token, and writes nothing`, async () => {
      const before = await requestsFile();
      const without = await send(bridge, { method, path: p, body: { kind: "dispatch-approve", ref: DISPATCH_REF }, headers: { Origin: origin(bridge) } });
      const withTok = await send(bridge, { method, path: p, body: { kind: "dispatch-approve", ref: DISPATCH_REF }, headers: authed(bridge, token) });
      assert.equal(without.status, 404, without.text);
      assert.equal(withTok.status, 404, withTok.text);
      assert.deepEqual(without.body, withTok.body);
      assert.equal(await requestsFile(), before);
    });
  }

  test("a registered path with a method the registry does not list is 404, for every row", async () => {
    for (const r of ROUTES) {
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        if (ROUTES.some((x) => x.method === method && x.path === r.path)) continue;
        const res = await send(bridge, { method, path: fill(r.path, "an-id"), body: {}, headers: authed(bridge, token) });
        assert.equal(res.status, 404, `${method} ${r.path}`);
      }
    }
  });

  test("no side effects at all from unknown routes: no requests file appears on an empty board", async () => {
    const empty = await makeStateFixture({ empty: true });
    const b = await startBridge({ root: empty.root, port: 0, auth: { launchCode: CODE } });
    try {
      const t = await login(b);
      await send(b, { method: "POST", path: "/nope", body: {}, headers: authed(b, t) });
      await send(b, { method: "POST", path: "/requests", body: { kind: "dispatch-approve", ref: "x/01-y" } });
      await assert.rejects(stat(path.join(empty.root, ".scratch", "_requests", "requests.jsonl")));
    } finally {
      await b.close();
      await empty.cleanup();
    }
  });
});
