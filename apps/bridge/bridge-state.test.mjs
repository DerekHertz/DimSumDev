// dimsumden-ui-v0/04: GET /state through startBridge (ADR 0011 decisions 2 and 3).
// The seam is startBridge({root, port: 0}) plus HTTP. Nothing internal is imported.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { startBridge } from "./server.mjs";
import { makeStateFixture, FEATURE, GOAL_KEY, BIG_HANDOFF, SMALL_HANDOFF, PENDING_ID, HANDLED_ID, LOCK_TS } from "./bridge-fixture.mjs";

const ref = (n) => `${FEATURE}/${n}`;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

async function withBridge(fxOpts, fn) {
  const fx = await makeStateFixture(fxOpts);
  const bridge = await startBridge({ root: fx.root, port: 0 });
  try {
    return await fn(bridge, fx);
  } finally {
    await bridge.close();
    await fx.cleanup();
  }
}

async function getState(bridge) {
  const res = await fetch(`${bridge.url}/state`);
  assert.equal(res.status, 200);
  return { res, snap: await res.json() };
}

describe("GET /state on a fixture tree (no claim lock)", () => {
  let bridge, fx, snap, res, byRef;
  before(async () => {
    fx = await makeStateFixture();
    bridge = await startBridge({ root: fx.root, port: 0 });
    ({ res, snap } = await getState(bridge));
    byRef = Object.fromEntries(snap.tickets.map((t) => [t.ref, t]));
  });
  after(async () => {
    await bridge.close();
    await fx.cleanup();
  });

  test("envelope: schema, seq, generatedAt, JSON, no-store", () => {
    assert.equal(snap.schema, 1);
    assert.ok(Number.isInteger(snap.seq) && snap.seq >= 0);
    assert.match(snap.generatedAt, ISO);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  test("tickets are non-resolved only and sorted by ref", () => {
    const refs = snap.tickets.map((t) => t.ref);
    assert.deepEqual(refs, [
      ref("02-ready-p0"),
      ref("03-blocked-dep"),
      ref("04-review"),
      ref("05-blocked"),
      ref("06-human"),
      ref("07-bumpable"),
      ref("08-plain"),
    ]);
  });

  test("ticket identity fields: feature, title keeps NN:, type lower-cased first word", () => {
    const t = byRef[ref("03-blocked-dep")];
    assert.equal(t.feature, FEATURE);
    assert.equal(t.title, "03: Blocked dep");
    assert.equal(t.type, "design");
    assert.equal(byRef[ref("04-review")].type, "bug");
    assert.equal(byRef[ref("02-ready-p0")].type, "feature");
  });

  test("den-mvp/61: the goals file and each ticket's goal ride the snapshot", () => {
    assert.deepEqual(snap.goals, [{ key: GOAL_KEY, name: "The fixture goal", why: "To test goals.", doneWhen: "Never." }]);
    assert.deepEqual(snap.goalErrors, []);
    assert.equal(byRef[ref("02-ready-p0")].goal, GOAL_KEY);
    assert.equal(byRef[ref("04-review")].goal, null);
  });

  test("status is copied verbatim", () => {
    assert.equal(byRef[ref("02-ready-p0")].status, "ready-for-agent");
    assert.equal(byRef[ref("04-review")].status, "in-review");
    assert.equal(byRef[ref("05-blocked")].status, "blocked");
    assert.equal(byRef[ref("06-human")].status, "ready-for-human");
  });

  test("ready and blockedBy: only unresolved blockers, unknown for a missing file", () => {
    assert.equal(byRef[ref("02-ready-p0")].ready, true);
    assert.deepEqual(byRef[ref("02-ready-p0")].blockedBy, []);
    const t = byRef[ref("03-blocked-dep")];
    assert.equal(t.ready, false);
    assert.deepEqual(t.blockedBy, [
      { ref: ref("02-ready-p0"), status: "ready-for-agent" },
      { ref: ref("99"), status: "unknown" },
    ]);
    // non-ready statuses are never ready
    assert.equal(byRef[ref("04-review")].ready, false);
    assert.equal(byRef[ref("06-human")].ready, false);
  });

  test("blocker 'None' yields no blockers", () => {
    assert.deepEqual(byRef[ref("07-bumpable")].blockedBy, []);
    assert.equal(byRef[ref("07-bumpable")].ready, true);
  });

  test("priority: parsed, missing is P2; readySince only for ready tickets", () => {
    assert.equal(byRef[ref("02-ready-p0")].priority, "P0");
    assert.equal(byRef[ref("07-bumpable")].priority, "P1");
    assert.equal(byRef[ref("08-plain")].priority, "P2");
    assert.match(byRef[ref("02-ready-p0")].readySince, ISO);
    assert.equal(byRef[ref("04-review")].readySince, null);
    assert.equal(byRef[ref("03-blocked-dep")].readySince, null);
  });

  test("sessions counts only orchestrator handoff files", () => {
    assert.equal(snap.sessions, 3);
  });

  test("no aging (queue/06): 3 later orchestrator handoffs leave P1 at P1; the bump fields stay and say not bumped", () => {
    const aged = byRef[ref("07-bumpable")];
    assert.equal(aged.priority, "P1");
    assert.equal(aged.effectivePriority, "P1");
    assert.equal(aged.bumps, 0);
    assert.equal(aged.bumped, false);
    const p0 = byRef[ref("02-ready-p0")];
    assert.equal(p0.effectivePriority, "P0");
    assert.equal(p0.bumps, 0);
    assert.equal(p0.bumped, false);
    const fresh = byRef[ref("08-plain")];
    assert.equal(fresh.effectivePriority, "P2");
    assert.equal(fresh.bumped, false);
  });

  test("frontier: ready tickets without a lock, in priority-then-age order", () => {
    assert.deepEqual(snap.frontier, [ref("02-ready-p0"), ref("07-bumpable"), ref("08-plain")]);
  });

  test("holder is null and lastRole comes from the newest events row", () => {
    assert.equal(byRef[ref("04-review")].holder, null);
    assert.equal(byRef[ref("04-review")].lastRole, "security");
    assert.equal(byRef[ref("05-blocked")].lastRole, "qa");
    assert.equal(byRef[ref("02-ready-p0")].lastRole, null);
  });

  test("blockedReason is the last Comments bullet when blocked, else null", () => {
    assert.equal(byRef[ref("05-blocked")].blockedReason, "Waiting on the user for the API key");
    assert.equal(byRef[ref("04-review")].blockedReason, null);
    assert.equal(byRef[ref("02-ready-p0")].blockedReason, null);
  });

  test("gate: merge for in-review + no lock + newest verdict is a security pass; dispatch for frontier[0]", () => {
    assert.equal(byRef[ref("04-review")].gate, "merge");
    assert.equal(byRef[ref("02-ready-p0")].gate, "dispatch");
    assert.equal(byRef[ref("07-bumpable")].gate, null);
    assert.equal(byRef[ref("08-plain")].gate, null);
    assert.equal(byRef[ref("05-blocked")].gate, null);
  });

  test("request: the ticket's pending Gate request as {id, kind, ts}; handled ones do not attach", () => {
    assert.deepEqual(byRef[ref("04-review")].request, {
      id: PENDING_ID,
      kind: "merge-approve",
      ts: "2026-09-29T05:58:00.000Z",
    });
    assert.equal(byRef[ref("08-plain")].request, null);
    assert.equal(byRef[ref("02-ready-p0")].request, null);
  });

  test("handoff: newest by mtime whose name starts with the ticket's NN-", () => {
    const h = byRef[ref("04-review")].handoff;
    assert.equal(h.path, `${FEATURE}/handoffs/04-new.md`);
    assert.equal(new Date(h.mtime).toISOString(), "2026-09-25T10:00:00.000Z");
    assert.equal(h.truncated, false);
    assert.equal(h.text, SMALL_HANDOFF);
    assert.equal(byRef[ref("02-ready-p0")].handoff, null);
  });

  test("handoff text is capped at 8 KB with truncated: true", () => {
    const h = byRef[ref("06-human")].handoff;
    assert.equal(h.truncated, true);
    assert.ok(Buffer.byteLength(h.text) <= 8192);
    assert.ok(h.text.length > 4000, "cap keeps most of 8 KB, not a stub");
    assert.ok(BIG_HANDOFF.startsWith(h.text));
  });

  test("usage is the newest kind:usage row with a numeric five_hour", () => {
    assert.deepEqual(snap.usage, { fiveHour: 74, weekly: 72, sampledAt: "2026-09-29T04:36:50.650Z" });
  });

  test("requests: pending plus handled, oldest first, handled carry outcome and handledAt", () => {
    assert.deepEqual(snap.requests, [
      {
        id: HANDLED_ID,
        ts: "2026-09-29T05:00:00.000Z",
        kind: "dispatch-approve",
        ref: ref("08-plain"),
        note: "go",
        state: "handled",
        outcome: "dispatched",
        handledAt: "2026-09-29T05:05:00.000Z",
      },
      {
        id: PENDING_ID,
        ts: "2026-09-29T05:58:00.000Z",
        kind: "merge-approve",
        ref: ref("04-review"),
        note: "ship it",
        state: "pending",
      },
    ]);
  });
});

describe("GET /state with a claim lock", () => {
  test("holder parsed from the lock; locked ticket leaves the frontier; frontier[0] keeps the dispatch gate (organism-infra/227)", () =>
    withBridge({ lock: true }, async (bridge) => {
      const { snap } = await getState(bridge);
      const t = snap.tickets.find((x) => x.ref === ref("09-claimed"));
      assert.deepEqual(t.holder, { role: "developer", since: LOCK_TS });
      assert.ok(!snap.frontier.includes(ref("09-claimed")));
      assert.deepEqual(snap.frontier, [ref("02-ready-p0"), ref("07-bumpable"), ref("08-plain")]);
      assert.deepEqual(snap.tickets.filter((x) => x.gate === "dispatch").map((x) => x.ref), [ref("02-ready-p0")], "only frontier[0], and it has the gate despite the lock");
      // a merge gate needs no lock on the ticket itself
      assert.equal(snap.tickets.find((x) => x.ref === ref("04-review")).gate, "merge");
    }));
});

describe("GET /state on an empty .scratch/", () => {
  test("empty collections and null usage, never an error", () =>
    withBridge({ empty: true }, async (bridge) => {
      const { snap } = await getState(bridge);
      assert.equal(snap.schema, 1);
      assert.deepEqual(snap.tickets, []);
      assert.deepEqual(snap.frontier, []);
      assert.equal(snap.sessions, 0);
      assert.equal(snap.usage, null);
      assert.deepEqual(snap.requests, []);
    }));
});

describe("network binding", () => {
  test("binds 127.0.0.1 only: url uses it and a non-loopback address refuses connections", () =>
    withBridge({ empty: true }, async (bridge) => {
      assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(new URL(bridge.url).port, String(bridge.port));
      const external = Object.values(os.networkInterfaces())
        .flat()
        .find((i) => i && i.family === "IPv4" && !i.internal);
      if (!external) return; // no non-loopback interface to probe on this host
      const outcome = await new Promise((resolve) => {
        const s = net.connect({ host: external.address, port: bridge.port });
        s.once("connect", () => {
          s.destroy();
          resolve("connected");
        });
        s.once("error", (e) => resolve(e.code));
        setTimeout(() => {
          s.destroy();
          resolve("timeout");
        }, 3000);
      });
      assert.notEqual(outcome, "connected", `bridge reachable on ${external.address}`);
    }));

  test("a request whose Host header is not loopback is a 403 (DNS rebinding)", () =>
    withBridge({ empty: true }, async (bridge) => {
      const status = await new Promise((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: bridge.port, path: "/state", headers: { Host: "evil.example.com" } },
          (r) => {
            r.resume();
            resolve(r.statusCode);
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(status, 403);
    }));
});
