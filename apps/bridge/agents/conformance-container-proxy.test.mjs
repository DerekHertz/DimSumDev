// hardening/16 fix round: the Container spike starts its proxy with no role secrets (one fake role, no accounts).
// ensureProxy fails closed without a secretsDir, so the spike must say so; the live run cannot be tested here, its call shape can.
import { test } from "node:test";
import assert from "node:assert/strict";
import { containerProxyOptions } from "./conformance-container.mjs";
import { ensureProxy, proxyRunArgs } from "../proxy/container.mjs";

test("the spike's proxy options build run args without throwing, and mark the proxy as running without secrets", () => {
  const args = proxyRunArgs(containerProxyOptions({ image: "den-agent:abc123abc123", tokenDir: "/t" }));
  assert.ok(args.includes("DEN_PROXY_ALLOW_NO_SECRETS=1"));
  assert.ok(!args.some((a) => a.startsWith("DEN_PROXY_SECRETS_FILE=")));
});

test("ensureProxy accepts the spike's options and starts the proxy", async () => {
  const calls = [];
  const docker = async (args) => { calls.push(args[0]); return { ok: args[0] !== "inspect", out: "", err: "" }; }; // no proxy container exists yet; everything else succeeds
  const r = await ensureProxy({ docker, ...containerProxyOptions({ image: "den-agent:abc123abc123", tokenDir: "/t" }) });
  assert.equal(r.started, true);
  assert.ok(calls.includes("run"));
});
