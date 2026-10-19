// den-mvp/88: the router's three adapters, each tested against a fake on the far side.
//   createBridgeClient({ url, token }) -> { state(), startDelivery(ref), resumeDelivery(id), events(onChange) -> { close() } }
//     Every POST sends Origin = the url's origin, Content-Type: application/json and Authorization: Bearer <token> (the bridge's
//     gate wants all three). state() GETs /state and returns its JSON; it rejects when the bridge does not answer or answers non-200.
//     startDelivery POSTs /deliveries { ref }; resumeDelivery POSTs /deliveries/<id>/resume {}. Both resolve { ok, status, error?,
//     draining?, delivery? } from the reply and never reject on a 4xx or 5xx. events(onChange) follows GET /events and calls onChange
//     for each event message.
//   readLiveUsage({ run }) -> the JSON `scripts/usage.mjs --live` printed, or { error } (nonzero exit, or output that is not JSON).
//     run(args) -> Promise<{ code, stdout, stderr }>; args[0] names usage.mjs and includes "--live".
//   ensureServiceToken(stateDir) / readServiceToken(stateDir): the token file `den:install` writes, `<stateDir>/service-token`, mode 0600.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBridgeClient, readLiveUsage, cachedReading, readChangedFiles } from "./client.mjs";
import { ensureServiceToken, readServiceToken, serviceTokenPath } from "./service-token.mjs";

describe("the bridge client", () => {
  let server, url, seen, reply, sse;
  before(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.url === "/events") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          sse = res;
          res.write("data: {\"seq\":1}\n\n");
          return;
        }
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => {
    sse?.end();
    server.closeAllConnections?.();
    server.close();
  });
  const fresh = (status, body) => {
    seen = [];
    reply = { status, body };
  };
  const TOKEN = "T".repeat(43);

  test("state() reads GET /state; it rejects when the bridge answers badly or not at all", async () => {
    fresh(200, { capacity: { room: 2 }, deliveries: [] });
    const c = createBridgeClient({ url, token: TOKEN });
    assert.deepEqual(await c.state(), { capacity: { room: 2 }, deliveries: [] });
    assert.deepEqual([seen[0].method, seen[0].url], ["GET", "/state"]);
    fresh(500, {});
    await assert.rejects(c.state());
    await assert.rejects(createBridgeClient({ url: "http://127.0.0.1:1", token: TOKEN }).state());
  });
  test("startDelivery POSTs { ref } with Origin, JSON and the bearer token", async () => {
    fresh(201, { delivery: { id: "d-1" } });
    const out = await createBridgeClient({ url, token: TOKEN }).startDelivery("fx/01-slug");
    const req = seen[0];
    assert.deepEqual([req.method, req.url, JSON.parse(req.body)], ["POST", "/deliveries", { ref: "fx/01-slug" }]);
    assert.equal(req.headers.origin, url);
    assert.match(req.headers["content-type"], /^application\/json/);
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual([out.ok, out.status, out.delivery?.id], [true, 201, "d-1"]);
  });
  test("resumeDelivery POSTs /deliveries/<id>/resume", async () => {
    fresh(202, { delivery: { id: "d-1" } });
    const out = await createBridgeClient({ url, token: TOKEN }).resumeDelivery("d-1");
    assert.deepEqual([seen[0].method, seen[0].url], ["POST", "/deliveries/d-1/resume"]);
    assert.equal(out.ok, true);
  });
  test("a refusal resolves with its status, error and draining flag; it does not reject", async () => {
    fresh(503, { error: "the den is updating", draining: true });
    const out = await createBridgeClient({ url, token: TOKEN }).startDelivery("fx/01-slug");
    assert.deepEqual([out.ok, out.status, out.error, out.draining], [false, 503, "the den is updating", true]);
    fresh(409, { error: "this ticket already has a delivery" });
    const other = await createBridgeClient({ url, token: TOKEN }).startDelivery("fx/01-slug");
    assert.deepEqual([other.ok, other.status, other.draining === true], [false, 409, false]);
  });
  test("events() calls onChange for an event message and can be closed", async () => {
    fresh(200, {});
    let got = 0;
    const sub = createBridgeClient({ url, token: TOKEN }).events(() => got++);
    for (let i = 0; i < 50 && !got; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(got >= 1);
    sub.close();
  });
  test("events() calls onEnd once when the server destroys the socket mid-stream, so the router can reconnect", async () => {
    fresh(200, {});
    sse = null;
    let ends = 0;
    const sub = createBridgeClient({ url, token: TOKEN }).events(() => {}, () => ends++);
    for (let i = 0; i < 50 && !sse; i++) await new Promise((r) => setTimeout(r, 20));
    sse.socket.destroy();
    for (let i = 0; i < 50 && !ends; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ends, 1);
    sub.close();
  });
  test("events() calls onEnd once when the server ends the stream cleanly", async () => {
    fresh(200, {});
    sse = null;
    let ends = 0;
    createBridgeClient({ url, token: TOKEN }).events(() => {}, () => ends++);
    for (let i = 0; i < 50 && !sse; i++) await new Promise((r) => setTimeout(r, 20));
    sse.end();
    for (let i = 0; i < 50 && !ends; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ends, 1);
  });
});

describe("cachedReading", () => {
  test("serves a reading, good or an error, for the ttl, then reads again", async () => {
    let t = 0;
    let n = 0;
    const read = cachedReading(async () => ({ n: ++n }), { ttlMs: 180_000, now: () => t });
    assert.deepEqual([await read(), await read()], [{ n: 1 }, { n: 1 }]);
    t = 179_999;
    assert.deepEqual(await read(), { n: 1 });
    t = 180_000;
    assert.deepEqual(await read(), { n: 2 });
    const failing = cachedReading(async () => (n++, { error: "HTTP 429" }), { ttlMs: 180_000, now: () => t });
    n = 0;
    await failing();
    await failing();
    assert.equal(n, 1);
  });
});

describe("the live usage read", () => {
  const ok = (json) => ({ run: async (args) => ((ok.args = args), { code: 0, stdout: JSON.stringify(json), stderr: "" }) });
  test("runs usage.mjs with --live and returns what it printed", async () => {
    const json = { "5-hour": { percent: 42 }, source: "live", age_s: 0 };
    assert.deepEqual(await readLiveUsage(ok(json)), json);
    assert.ok(ok.args.some((a) => /usage\.mjs$/.test(a)) && ok.args.includes("--live"), JSON.stringify(ok.args));
  });
  test("a nonzero exit is { error } carrying the diagnostic, never a number", async () => {
    const out = await readLiveUsage({ run: async () => ({ code: 1, stdout: "", stderr: "usage: HTTP 429\n" }) });
    assert.match(out.error, /429/);
    assert.equal("5-hour" in out, false);
  });
  test("output that is not JSON is { error }", async () => {
    assert.ok((await readLiveUsage({ run: async () => ({ code: 0, stdout: "oops", stderr: "" }) })).error);
  });
});

describe("the service token file", () => {
  let dir;
  before(async () => void (dir = await mkdtemp(path.join(tmpdir(), "router-token-"))));
  after(() => rm(dir, { recursive: true, force: true }));
  test("ensureServiceToken writes 32 random bytes as base64url, mode 0600, and keeps it on the next call", async () => {
    const a = await ensureServiceToken(dir);
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(serviceTokenPath(dir), path.join(dir, "service-token"));
    assert.equal(((await stat(serviceTokenPath(dir))).mode & 0o777), 0o600);
    assert.equal((await readFile(serviceTokenPath(dir), "utf8")).trim(), a);
    assert.equal(await ensureServiceToken(dir), a);
    assert.equal(await readServiceToken(dir), a);
  });
  test("readServiceToken is null for a missing or malformed file, so nothing is accepted", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "router-token-"));
    try {
      assert.equal(await readServiceToken(empty), null);
      await writeFile(serviceTokenPath(empty), "short\n");
      assert.equal(await readServiceToken(empty), null);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe("readChangedFiles", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  test("diffs each open delivery's base against its candidate, else its branch; skips finished or unreadable ones", async () => {
    const calls = [];
    const git = async (cwd, args) => {
      calls.push(args);
      if (args.includes("den/bad")) throw new Error("unknown revision");
      return "apps/x.mjs\napps/y.mjs\n";
    };
    const out = await readChangedFiles("/root", [
      { id: "d-1", state: "paused", base: A, candidate: { sha: B }, branch: "den/one" },
      { id: "d-2", state: "running", base: A, branch: "den/two" },
      { id: "d-3", state: "merged", base: A, branch: "den/three" },
      { id: "d-4", state: "paused", base: A, branch: "den/bad" },
      { id: "d-5", state: "paused", base: "main", branch: "den/five" },
      { id: "d-6", state: "paused", base: A, branch: "--output=x" },
    ], { git });
    assert.deepEqual([...out.keys()], ["d-1", "d-2"]);
    assert.deepEqual(out.get("d-1"), ["apps/x.mjs", "apps/y.mjs"]);
    assert.deepEqual(calls.map((a) => a.slice(2, 4)), [[A, B], [A, "den/two"], [A, "den/bad"]]);
  });
});
