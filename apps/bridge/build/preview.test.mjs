// den-mvp/09 (ADR 0026 decision 5): the preview listener, over real HTTP beside a real bridge.
//   table     every row of routes.mjs that is not a listed read is a 403 on the preview, with and without the den's token
//   reads     the listed reads need no token, and leave out what agents said and asked
//   listener  Host, Origin, the built files, the policy, closing
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startBridge } from "../server.mjs";
import { makeStateFixture } from "../bridge-fixture.mjs";
import { CODE, authed, login, origin, send } from "../bridge-auth-helpers.mjs";
import { PREVIEW_READS, ROUTES } from "../routes.mjs";
import { PREVIEW_CSP, openPreview, redactChange, redactSnapshot } from "./preview.mjs";
import { makeBridge, until } from "../agents/host-test-helpers.mjs";

const concrete = (route) => route.replace(/:\w+/g, "x1");
const directive = (csp, name) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(name + " ")) ?? null;

describe("the preview listener", () => {
  let fx, tmp, dir, bridge, preview, target, denToken, outsideFile;
  // What a page of the preview itself would send: its own Origin, JSON, and (when given) a token.
  const own = (token) => ({ Origin: origin(target), ...(token ? { Authorization: `Bearer ${token}` } : {}) });
  const tokens = () => [["no token", undefined], ["the den's token", denToken]];

  before(async () => {
    fx = await makeStateFixture();
    tmp = await mkdtemp(path.join(tmpdir(), "den-preview-"));
    dir = path.join(tmp, "job-1");
    const dist = path.join(dir, "apps/ui/dist");
    await mkdir(path.join(dist, "assets"), { recursive: true });
    await writeFile(path.join(dist, "index.html"), "<!doctype html><title>preview</title>");
    await writeFile(path.join(dist, "assets", "app.js"), "export const x = 1;");
    outsideFile = path.join(tmp, "outside.txt");
    await writeFile(outsideFile, "not part of the build");
    await writeFile(path.join(dir, "package.json"), "{}"); // in the preview's folder, not in its built files
    await symlink(outsideFile, path.join(dist, "assets", "link.txt"));
    bridge = await startBridge({ root: fx.root, port: 0, uiDir: dist, auth: { launchCode: CODE } });
    preview = await openPreview({ id: "job-1", dir, reads: bridge.previewReads });
    const url = new URL(preview.url);
    target = { port: Number(url.port) };
    denToken = await login(bridge);
  });
  after(async () => {
    await preview.close();
    await bridge.close();
    await fx.cleanup();
    await rm(tmp, { recursive: true, force: true });
  });

  test("the url is on 127.0.0.1, on a port of its own, and carries no token", () => {
    const url = new URL(preview.url);
    assert.equal(url.hostname, "127.0.0.1");
    assert.notEqual(target.port, bridge.port);
    assert.equal(url.pathname + url.search + url.hash, "/");
  });

  test("the list of reads is written out: each is a GET row that changes nothing and needs no token, and the bridge hands over exactly those", () => {
    for (const route of PREVIEW_READS) {
      const row = ROUTES.find((r) => r.method === "GET" && r.path === route);
      assert.ok(row, `${route} is a GET row`);
      assert.equal(row.mutating, false, route);
      assert.equal(row.auth, "none", `${route}: a preview has no token, so a read that needs one is not offered`);
    }
    assert.deepEqual(PREVIEW_READS, ["/state", "/events", "/library"]);
    assert.deepEqual(Object.keys(bridge.previewReads), PREVIEW_READS);
  });

  describe("every row of routes.mjs that is not a listed read is a 403", () => {
    // Read from ROUTES itself: a mutating route added there is in this table without anyone remembering to add it.
    const refused = ROUTES.filter((row) => !(row.method === "GET" && PREVIEW_READS.includes(row.path)));
    test("the table holds every mutating row and every read that is not on the list", () => {
      assert.deepEqual(ROUTES.filter((row) => row.mutating && !refused.includes(row)), []);
      assert.ok(refused.some((row) => row.method === "GET"), "a read that is not on the list is in the table");
      assert.ok(refused.length >= 18);
    });
    for (const row of refused) {
      test(`${row.method} ${row.path}`, async () => {
        for (const [name, token] of tokens()) {
          const res = await send(target, { method: row.method, path: concrete(row.path), headers: own(token), ...(row.method === "GET" ? {} : { body: {} }) });
          assert.equal(res.status, 403, `${row.method} ${row.path} with ${name}`);
        }
      });
    }
    test("a refused POST /session did not reach the den's handler: a launch code sent to the preview is still good on the den", async () => {
      const code = bridge.newLaunchCode();
      const res = await send(target, { method: "POST", path: "/session", headers: own(), body: { code } });
      assert.equal(res.status, 403);
      assert.equal(res.body?.token, undefined);
      assert.equal(typeof (await login(bridge, code)), "string");
    });
    test("any other method is a 403, on a read, a file and a path that is nothing", async () => {
      for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS", "POST"]) {
        for (const p of ["/state", "/", "/assets/app.js", "/nothing"]) {
          const res = await send(target, { method, path: p, headers: own(denToken), ...(method === "OPTIONS" ? {} : { body: {} }) });
          assert.equal(res.status, 403, `${method} ${p}`);
        }
      }
    });
    test("HEAD of a read is a 403; a GET of a path that is a route only for POST is a 403, not the page", async () => {
      assert.equal((await send(target, { method: "HEAD", path: "/state" })).status, 403);
      for (const p of ["/session", "/agents", "/deliveries/x1/close"]) assert.equal((await send(target, { path: p })).status, 403, p);
    });
  });

  describe("the listed reads", () => {
    test("they answer with no token, with the den's own data", async () => {
      const [here, there] = await Promise.all([send(target, { path: "/state" }), send(bridge, { path: "/state" })]);
      assert.equal(here.status, 200);
      assert.deepEqual(here.body.tickets, there.body.tickets);
      assert.equal((await send(target, { path: "/library" })).status, 200);
    });
    test("a meeting and a conversation are not read from a preview, with the den's token or without", async () => {
      for (const p of ["/meetings/x1", "/conversations/developer"]) {
        assert.equal((await send(target, { path: p })).status, 403, p);
        assert.equal((await send(target, { path: p, headers: own(denToken) })).status, 403, `${p} with the den's token`);
        assert.notEqual((await send(bridge, { path: p, headers: authed(bridge, denToken) })).status, 401, `${p} on the den`);
      }
    });
    test("a handler for a read that needs a token is not answered even when it is handed over", async () => {
      // The list is the gate, and so is the row: a listed read must be one the den answers without a token.
      assert.equal(ROUTES.filter((r) => PREVIEW_READS.includes(r.path) && r.method === "GET" && r.auth !== "none").length, 0);
    });
    test("the event stream is served, and carries the policy", async () => {
      const first = await new Promise((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port: target.port, path: "/events" }, (res) => {
          res.once("data", (chunk) => {
            resolve({ status: res.statusCode, type: res.headers["content-type"], csp: res.headers["content-security-policy"], text: String(chunk) });
            req.destroy();
          });
        });
        req.on("error", reject);
      });
      assert.equal(first.status, 200);
      assert.match(first.type, /text\/event-stream/);
      assert.match(first.text, /^event: snapshot/);
      assert.equal(first.csp, PREVIEW_CSP);
    });
  });

  describe("Host and Origin", () => {
    test("a request with another Host is refused", async () => {
      for (const host of ["evil.example", `evil.example:${target.port}`, `127.0.0.1:${bridge.port}`, "127.0.0.1", `[::1]:${target.port}`]) {
        assert.equal((await send(target, { path: "/state", host })).status, 403, host);
        assert.equal((await send(target, { path: "/", host })).status, 403, host);
      }
      assert.equal((await send(target, { path: "/state", host: `localhost:${target.port}` })).status, 200);
    });
    test("a request with another Origin is refused, the den's included", async () => {
      for (const from of [origin(bridge), "http://evil.example", "null", `https://127.0.0.1:${target.port}`]) {
        assert.equal((await send(target, { path: "/state", headers: { Origin: from } })).status, 403, from);
        assert.equal((await send(target, { path: "/assets/app.js", headers: { Origin: from } })).status, 403, from);
      }
    });
  });

  describe("the built files", () => {
    test("index.html and a built file are served with the policy: connect-src is this listener and nothing on the network", async () => {
      for (const p of ["/", "/assets/app.js", "/some/page"]) {
        const res = await send(target, { path: p });
        assert.equal(res.status, 200, p);
        assert.equal(res.headers["content-security-policy"], PREVIEW_CSP);
        assert.equal(res.headers["x-content-type-options"], "nosniff");
      }
      assert.equal(directive(PREVIEW_CSP, "connect-src"), "connect-src 'self' blob:");
      assert.equal(directive(PREVIEW_CSP, "default-src"), "default-src 'self'");
      assert.equal(directive(PREVIEW_CSP, "script-src"), "script-src 'self'");
      assert.equal(directive(PREVIEW_CSP, "form-action"), "form-action 'none'");
      assert.doesNotMatch(PREVIEW_CSP, /https?:|\*|unsafe-eval/);
      assert.match((await send(target, { path: "/some/page" })).text, /<title>preview<\/title>/);
      assert.match((await send(target, { path: "/assets/app.js" })).headers["content-type"], /javascript/);
    });
    test("HEAD of a file has no body; a missing file with an extension is a 404", async () => {
      const head = await send(target, { method: "HEAD", path: "/assets/app.js" });
      assert.equal(head.status, 200);
      assert.equal(head.text, "");
      assert.equal((await send(target, { path: "/assets/gone.js" })).status, 404);
    });
    test("nothing outside the built files is served: not the preview's own folder, not by a link, not by a path that climbs", async () => {
      assert.equal((await send(target, { path: "/assets/link.txt" })).status, 403);
      assert.equal((await send(target, { path: "/package.json" })).status, 404);
      for (const p of ["/../package.json", "/..%2f..%2fpackage.json", "/assets/%2e%2e/%2e%2e/%2e%2e/package.json", "/assets/..%5c..%5cpackage.json", "/%00", "/%E0%A4%A"]) {
        const res = await send(target, { path: p });
        assert.equal(res.status, 403, p);
        assert.doesNotMatch(res.text, /\{\}|not part of the build/);
      }
    });
  });

  describe("opening and closing", () => {
    test("reads that are not exactly the listed handlers are not taken", async () => {
      const reads = bridge.previewReads;
      await assert.rejects(openPreview({ id: "job-3", dir, reads: { ...reads, "/agents": () => {} } }), TypeError);
      await assert.rejects(openPreview({ id: "job-3", dir, reads: { "/state": reads["/state"] } }), TypeError);
      await assert.rejects(openPreview({ id: "job-3", dir }), TypeError);
      await assert.rejects(openPreview({ id: "../job", dir, reads }), TypeError);
      await assert.rejects(openPreview({ id: "job-3", dir: "relative", reads }), TypeError);
      await assert.rejects(openPreview({ id: "job-3", dir: path.join(tmp, "no-such-preview"), reads }), { code: "ENOENT" });
    });
    test("closing the preview closes the port and ends an open event stream", async () => {
      const mine = await openPreview({ id: "job-4", dir, reads: bridge.previewReads });
      const port = Number(new URL(mine.url).port);
      const ended = new Promise((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/events" }, (res) => {
          res.once("data", () => mine.close());
          res.on("data", () => {});
          res.on("close", resolve);
        });
        req.on("error", (err) => (err.code === "ECONNRESET" ? resolve() : reject(err)));
      });
      await ended;
      await mine.close(); // a second call is the same close
      // Asked by content: the system may give the freed port to another test's listener at once.
      const answer = await send({ port }, { path: "/assets/app.js" }).catch((err) => err.code);
      assert.ok(answer === "ECONNREFUSED" || answer.text !== "export const x = 1;", "nothing serves this preview's files there any more");
      assert.equal((await send(bridge, { path: "/state" })).status, 200); // the den is untouched
    });
  });
});

describe("what a preview is told", () => {
  const agent = { id: "c-1", ref: "fx/01", role: "developer", state: "running", tokens: 12, branch: "fx/01-a", tool: { name: "Bash", summary: "cat notes.txt" }, reason: "the run said why", reply: "what the agent wrote last" };
  const shown = { id: "c-1", ref: "fx/01", role: "developer", state: "running", tokens: 12, branch: "fx/01-a", tool: null, reason: null, reply: null };
  test("the snapshot is the listed keys: no transcript, no permission request, and no agent's reply, tool call or reason", () => {
    const snap = { schema: 1, seq: 4, tickets: [{ ref: "fx/01" }], agents: [agent], transcripts: { "c-1": { entries: [{ text: "said" }] } }, approvals: [{ id: "a-1", summary: "rm -rf" }], deliveries: [], meetings: [], build: null };
    assert.deepEqual(redactSnapshot(snap), { ...snap, agents: [shown], transcripts: {}, approvals: [] });
    assert.equal(snap.approvals.length, 1, "the den's own snapshot is not changed");
    assert.equal(snap.agents[0].reply, "what the agent wrote last");
  });
  test("a snapshot key or an agent field nobody listed does not reach a preview", () => {
    const out = redactSnapshot({ seq: 4, agents: [{ id: "c-1", prompt: "added later" }], notes: "added later" });
    assert.deepEqual(out, { seq: 4, agents: [{ id: "c-1", tool: null, reason: null, reply: null }], transcripts: {}, approvals: [] });
  });
  test("a change of a kind that is not listed keeps its seq and carries nothing else", () => {
    assert.deepEqual(redactChange({ seq: 7, type: "transcript", agentId: "c-1", entry: { text: "said" } }), { seq: 7, type: "hidden" });
    assert.deepEqual(redactChange({ seq: 8, type: "approval", approval: { id: "a-1", summary: "rm -rf" } }), { seq: 8, type: "hidden" });
    assert.deepEqual(redactChange({ seq: 9, type: "added-later", text: "anything" }), { seq: 9, type: "hidden" });
  });
  test("a listed change passes as it is; an agent change loses what the agent said", () => {
    for (const type of ["ticket", "frontier", "usage", "sessions", "requests", "metrics-changed", "delivery", "meeting", "build", "library"]) {
      const change = { seq: 9, type, delivery: { id: "d-1" } };
      assert.equal(redactChange(change), change, type);
    }
    assert.deepEqual(redactChange({ seq: 10, type: "agent", agent }), { seq: 10, type: "agent", agent: shown });
    assert.deepEqual(redactChange({ seq: 11, type: "agent", agent: null }), { seq: 11, type: "agent", agent: null });
  });
  test("over the wire: a permission request reaches the den's stream and state, and a preview gets a hidden frame and an empty list", async () => {
    const t = await makeBridge();
    const tmp = await mkdtemp(path.join(tmpdir(), "den-preview-told-"));
    let preview;
    const streams = [];
    try {
      await mkdir(path.join(tmp, "apps/ui/dist"), { recursive: true });
      await writeFile(path.join(tmp, "apps/ui/dist/index.html"), "<!doctype html><title>preview</title>");
      preview = await openPreview({ id: "job-9", dir: tmp, reads: t.bridge.previewReads });
      const port = Number(new URL(preview.url).port);
      // The change frames of one event stream, from its snapshot on.
      const listen = (to) => new Promise((resolve, reject) => {
        const seen = [];
        const req = http.get({ host: "127.0.0.1", port: to, path: "/events" }, (res) => {
          let text = "";
          res.on("data", (chunk) => {
            text += chunk;
            for (let at; (at = text.indexOf("\n\n")) >= 0; text = text.slice(at + 2)) {
              const [event, data] = text.slice(0, at).split("\n");
              if (event === "event: snapshot") resolve({ seen, first: JSON.parse(data.slice(6)) });
              if (event === "event: change") seen.push(JSON.parse(data.slice(6)));
            }
          });
        });
        streams.push(req);
        req.on("error", reject);
      });
      const [den, shown] = await Promise.all([listen(t.bridge.port), listen(port)]);
      await t.bridge.host.start({ ref: "fx/31-told", role: "scout" });
      t.fake.spawns.at(-1).emit({ type: "permission-request", requestId: "told-r1", tool: "Bash", input: { command: "ls" } });
      await until(() => den.seen.some((f) => f.type === "approval"), { what: "the approval frame on the den's stream" });
      await until(() => shown.seen.length >= den.seen.length, { what: "the preview's stream to catch up" });

      assert.ok(shown.seen.some((f) => f.type === "hidden"));
      assert.deepEqual(shown.seen.filter((f) => ["approval", "transcript"].includes(f.type)), [], "no hidden kind of frame reaches a preview");
      assert.deepEqual(shown.seen.map((f) => f.seq), den.seen.map((f) => f.seq), "the preview's sequence has no gap");
      assert.doesNotMatch(JSON.stringify(shown.seen), /told-r1|permission/);
      const [denState, previewState] = await Promise.all([send(t.bridge, { path: "/state" }), send({ port }, { path: "/state" })]);
      assert.equal(denState.body.approvals.length, 1);
      assert.deepEqual([previewState.body.approvals, previewState.body.transcripts], [[], {}]);
      assert.deepEqual([shown.first.approvals, shown.first.transcripts], [[], {}]);
      assert.equal(previewState.body.agents.length, denState.body.agents.length, "who is at work is still shown");
    } finally {
      for (const req of streams) req.destroy();
      await preview?.close();
      await t.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
