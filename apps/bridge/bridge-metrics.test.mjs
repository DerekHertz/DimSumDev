// dimsumden-ui-v0/11 scope add: GET /metrics through startBridge (ADR 0011 decision 4).
// Expected values come from the CLI (`metrics.mjs --json`, a separate process) and fixture literals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { startBridge } from "./server.mjs";
import { makeStateFixture } from "./bridge-fixture.mjs";

const statusWithHost = (port, host) =>
  new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/metrics", headers: { Host: host } }, (r) => {
      r.resume();
      resolve(r.statusCode);
    }).on("error", reject);
  });

const METRICS_CLI = fileURLToPath(new URL("../../scripts/metrics.mjs", import.meta.url));

test("GET /metrics is 200 JSON, exactly what metrics.mjs --json prints for the same root", async () => {
  const fx = await makeStateFixture();
  const bridge = await startBridge({ root: fx.root, port: 0 });
  try {
    const res = await fetch(`${bridge.url}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    const cli = JSON.parse(execFileSync(process.execPath, [METRICS_CLI, "--json"], { env: { ...process.env, DEN_ROOT: fx.root }, encoding: "utf8" }));
    assert.deepEqual(body, cli);
    assert.equal(body.schema, 1);
    assert.equal(body.usage.sampledAt, "2026-09-29T05:00:00.000Z"); // latest usage row by ts
  } finally {
    await bridge.close();
    await fx.cleanup();
  }
});

test("GET /metrics on an empty board is 200 with no usage sample", async () => {
  const fx = await makeStateFixture({ empty: true });
  const bridge = await startBridge({ root: fx.root, port: 0 });
  try {
    const res = await fetch(`${bridge.url}/metrics`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.usage, null);
    assert.equal(body.resolvedTickets, 0);
  } finally {
    await bridge.close();
    await fx.cleanup();
  }
});

test("GET /metrics rejects a foreign Host header", async () => {
  const fx = await makeStateFixture({ empty: true });
  const bridge = await startBridge({ root: fx.root, port: 0 });
  try {
    assert.equal(await statusWithHost(bridge.port, "evil.example"), 403);
    assert.equal(await statusWithHost(bridge.port, `127.0.0.1:${bridge.port}`), 200);
  } finally {
    await bridge.close();
    await fx.cleanup();
  }
});
