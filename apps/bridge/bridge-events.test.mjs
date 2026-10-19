// dimsumden-ui-v0/05: GET /events (SSE) through startBridge (ADR 0011 decisions 2 and 5).
// The seam is startBridge({root, port: 0}) plus HTTP. Nothing internal is imported.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { startBridge } from "./server.mjs";
import { makeStateFixture, FEATURE } from "./bridge-fixture.mjs";

const REF = `${FEATURE}/08-plain`;
const WITHIN_MS = 2500; // ADR: the 2 s safety net, plus 500 ms of scheduling slack

// Minimal SSE client: collects parsed {event, data} frames, skips ": ping" comments.
function openSse(bridge) {
  const frames = [];
  const waiters = [];
  let req;
  const opened = new Promise((resolve, reject) => {
    req = http.get(`${bridge.url}/events`, { headers: { Accept: "text/event-stream" } }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = "message";
          const data = [];
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
          }
          if (!data.length) continue;
          const frame = { event, data: JSON.parse(data.join("\n")) };
          frames.push(frame);
          for (const w of [...waiters]) w();
        }
      });
      resolve(res);
    });
    req.on("error", reject);
  });
  function next(pred, ms = WITHIN_MS) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const check = () => {
        const f = frames.find(pred);
        if (f) {
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
          resolve(f);
        }
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(check), 1);
        reject(new Error(`no matching SSE frame within ${ms} ms (${Date.now() - t0} elapsed); saw ${JSON.stringify(frames.map((f) => f.event + ":" + (f.data.type ?? "")))}`));
      }, ms);
      waiters.push(check);
      check();
    });
  }
  return { opened, frames, next, close: () => req.destroy() };
}

async function withBridge(fn) {
  const fx = await makeStateFixture();
  const bridge = await startBridge({ root: fx.root, port: 0 });
  const clients = [];
  const connect = async () => {
    const c = openSse(bridge);
    clients.push(c);
    const res = await c.opened;
    return { c, res };
  };
  try {
    return await fn({ bridge, fx, connect });
  } finally {
    clients.forEach((c) => c.close());
    await bridge.close();
    await fx.cleanup();
  }
}

async function setStatus(fx, name, from, to) {
  const file = path.join(fx.root, ".scratch", FEATURE, "issues", `${name}.md`);
  const text = await readFile(file, "utf8");
  assert.ok(text.includes(`**Status:** ${from}`), "fixture precondition");
  await writeFile(file, text.replace(`**Status:** ${from}`, `**Status:** ${to}`));
}

describe("GET /events", () => {
  test("responds text/event-stream, no-store, and the first message is a full snapshot", async () => {
    await withBridge(async ({ connect, bridge }) => {
      const { c, res } = await connect();
      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"], /text\/event-stream/);
      assert.equal(res.headers["cache-control"], "no-store");
      const first = await c.next(() => true);
      assert.equal(first.event, "snapshot");
      assert.equal(first, c.frames[0]);
      assert.equal(first.data.schema, 1);
      const state = await (await fetch(`${bridge.url}/state`)).json();
      assert.deepEqual(first.data.tickets.map((t) => t.ref), state.tickets.map((t) => t.ref));
    });
  });

  test("touching a fixture ticket emits a ticket change event within 2s, seq continuing from the snapshot", async () => {
    await withBridge(async ({ connect, fx }) => {
      const { c } = await connect();
      const snap = await c.next((f) => f.event === "snapshot");
      const t0 = Date.now();
      await setStatus(fx, "08-plain", "ready-for-agent", "blocked");
      const ev = await c.next((f) => f.event === "change" && f.data.type === "ticket" && f.data.ref === REF);
      assert.ok(Date.now() - t0 <= WITHIN_MS, `took ${Date.now() - t0} ms`);
      assert.equal(ev.data.ticket.ref, REF);
      assert.equal(ev.data.ticket.status, "blocked");
      assert.equal(ev.data.ticket.ready, false);
      assert.ok(Number.isInteger(ev.data.seq) && ev.data.seq > snap.data.seq);
      // seq increments by one per event, continuing from the snapshot
      const changes = c.frames.filter((f) => f.event === "change");
      let prev = snap.data.seq;
      for (const f of changes) {
        assert.equal(f.data.seq, prev + 1);
        prev = f.data.seq;
      }
    });
  });

  test("resolving a ticket emits a ticket event with ticket: null", async () => {
    await withBridge(async ({ connect, fx }) => {
      const { c } = await connect();
      await c.next((f) => f.event === "snapshot");
      await setStatus(fx, "08-plain", "ready-for-agent", "resolved");
      const ev = await c.next((f) => f.event === "change" && f.data.type === "ticket" && f.data.ref === REF);
      assert.equal(ev.data.ticket, null);
    });
  });

  test("appending to usage.jsonl emits usage and metrics-changed within 2s", async () => {
    await withBridge(async ({ connect, fx }) => {
      const { c } = await connect();
      await c.next((f) => f.event === "snapshot");
      const row = { kind: "usage", ts: "2026-09-29T07:00:00.000Z", five_hour: 88, weekly: 77 };
      await appendFile(path.join(fx.root, ".scratch", "usage.jsonl"), JSON.stringify(row) + "\n");
      const usage = await c.next((f) => f.event === "change" && f.data.type === "usage");
      assert.equal(usage.data.usage.fiveHour, 88);
      assert.equal(usage.data.usage.weekly, 77);
      await c.next((f) => f.event === "change" && f.data.type === "metrics-changed");
    });
  });

  test("appending to events.jsonl emits metrics-changed within 2s", async () => {
    await withBridge(async ({ connect, fx }) => {
      const { c } = await connect();
      await c.next((f) => f.event === "snapshot");
      const row = { seq: 4, ts: "2026-09-29T07:00:00.000Z", feature: FEATURE, ticket: "05-blocked", role: "qa", op: "comment", text: "hi" };
      await appendFile(path.join(fx.root, ".scratch", "events.jsonl"), JSON.stringify(row) + "\n");
      await c.next((f) => f.event === "change" && f.data.type === "metrics-changed");
    });
  });

  test("a new handoff for a ticket emits a ticket change carrying that handoff", async () => {
    await withBridge(async ({ connect, fx }) => {
      const { c } = await connect();
      await c.next((f) => f.event === "snapshot");
      await writeFile(path.join(fx.root, ".scratch", FEATURE, "handoffs", "08-dev.md"), "fresh handoff text\n");
      const ev = await c.next((f) => f.event === "change" && f.data.type === "ticket" && f.data.ref === REF);
      assert.match(ev.data.ticket.handoff.text, /fresh handoff text/);
    });
  });

  test("a client that reconnects gets a fresh snapshot reflecting changes it missed", async () => {
    await withBridge(async ({ connect, fx }) => {
      const first = await connect();
      const snap1 = await first.c.next((f) => f.event === "snapshot");
      first.c.close();

      await setStatus(fx, "08-plain", "ready-for-agent", "blocked");
      // Let the bridge observe the change while no client is connected.
      await new Promise((r) => setTimeout(r, 2300));

      const second = await connect();
      assert.equal(second.res.statusCode, 200);
      const snap2 = await second.c.next(() => true);
      assert.equal(snap2.event, "snapshot", "first message on a reconnect is a snapshot");
      const t = snap2.data.tickets.find((x) => x.ref === REF);
      assert.equal(t.status, "blocked");
      assert.ok(snap2.data.seq >= snap1.data.seq);
    });
  });
});
