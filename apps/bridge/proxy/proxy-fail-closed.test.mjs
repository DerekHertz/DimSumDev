// hardening/16 (security, hardening/11 delta review): the proxy fails closed, and the secrets file survives concurrent writes. qa specify.
// Red until:
//   den-proxy.mjs refuses to start without DEN_PROXY_SECRETS_FILE (exit non-zero, the variable named on stderr, nothing listening).
//   proxyRunArgs / ensureProxy refuse without secretsDir (reject or throw naming "secretsDir"; ensureProxy then runs and removes no container).
//   writeSecrets calls on one directory are serialized or use unique temp names: concurrent calls all resolve, the file is one input whole.
// A test-only escape hatch for a proxy without role secrets is allowed (its name is the developer's); the older proxy tests that start one
// without secrets (den-proxy.test.mjs, container.test.mjs, proxy-secrets.test.mjs) pass it. Adding it to them is not weakening them.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureProxy, proxyRunArgs } from "./container.mjs";
import { SECRETS_FILE_NAME, writeSecrets } from "./secrets.mjs";

const ENTRY = new URL("./den-proxy.mjs", import.meta.url).pathname;

function runEntry(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const kill = setTimeout(() => child.kill("SIGKILL"), 5000); // a proxy that did start would listen for ever
    child.on("exit", (code, signal) => { clearTimeout(kill); resolve({ code, signal, out, err }); });
  });
}

describe("den-proxy.mjs without a secrets file", () => {
  test("refuses to start: non-zero exit, DEN_PROXY_SECRETS_FILE named, nothing listening", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "den-proxy-closed-"));
    try {
      const r = await runEntry({
        DEN_PROXY_TOKEN_FILE: path.join(tmp, "access-token"),
        DEN_PROXY_ROLES: JSON.stringify({ developer: ["granted.test"] }),
        DEN_PROXY_BASE_PORT: "0",
        DEN_PROXY_LISTEN_HOST: "127.0.0.1",
      });
      assert.equal(r.signal, null, `it ran until it was killed: ${r.out}`);
      assert.notEqual(r.code, 0);
      assert.match(r.err, /DEN_PROXY_SECRETS_FILE/);
      assert.ok(!r.out.includes("listening"), `it announced a port: ${r.out}`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("an empty DEN_PROXY_SECRETS_FILE is the same as an unset one", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "den-proxy-closed-"));
    try {
      const r = await runEntry({
        DEN_PROXY_TOKEN_FILE: path.join(tmp, "access-token"),
        DEN_PROXY_ROLES: JSON.stringify({ developer: [] }),
        DEN_PROXY_BASE_PORT: "0",
        DEN_PROXY_LISTEN_HOST: "127.0.0.1",
        DEN_PROXY_SECRETS_FILE: "",
      });
      assert.equal(r.signal, null, `it ran until it was killed: ${r.out}`);
      assert.notEqual(r.code, 0);
      assert.match(r.err, /DEN_PROXY_SECRETS_FILE/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("proxyRunArgs and ensureProxy require secretsDir", () => {
  const base = { image: "den-agent:test", tokenDir: "/s/token", proxyDir: "/r/apps/bridge/proxy", roles: { developer: ["granted.test"] } };

  test("proxyRunArgs throws without it, and with it still names the secrets file", () => {
    assert.throws(() => proxyRunArgs(base), /secretsDir/);
    const args = proxyRunArgs({ ...base, secretsDir: "/s/secrets" });
    assert.ok(args.some((a) => a.startsWith("DEN_PROXY_SECRETS_FILE=")), args.join(" "));
  });

  test("ensureProxy rejects without it and starts and removes no container", async () => {
    const calls = [];
    const docker = async (args) => { calls.push(args); return { ok: args[0] !== "inspect", out: "", err: "" }; }; // the network exists; no container does
    await assert.rejects(ensureProxy({ docker, ...base }), /secretsDir/);
    assert.deepEqual(calls.filter((a) => a[0] === "run" || a[0] === "rm"), [], "a proxy without role secrets must not be started");
  });
});

describe("writeSecrets under concurrent calls", () => {
  test("30 calls at once all resolve, leave one whole input at mode 0600 and no temp file behind", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "den-secrets-race-"));
    try {
      const inputs = Array.from({ length: 30 }, (_, i) => ({ [`secret-${i}`]: i % 2 ? "developer" : "qa" }));
      const results = await Promise.allSettled(inputs.map((secrets) => writeSecrets({ dir, secrets })));
      assert.deepEqual(results.filter((r) => r.status === "rejected").map((r) => String(r.reason)), []);
      const text = await readFile(path.join(dir, SECRETS_FILE_NAME), "utf8");
      assert.ok(inputs.some((i) => JSON.stringify(i) === text), `the file is not one of the inputs: ${text}`);
      assert.equal((await stat(path.join(dir, SECRETS_FILE_NAME))).mode & 0o777, 0o600);
      assert.deepEqual(await readdir(dir), [SECRETS_FILE_NAME]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
