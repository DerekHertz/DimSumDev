// hardening/16 fix round: a failing login is said once in the log, and the user cannot switch to an account whose token is dead.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProxyService } from "./proxy-service.mjs";

const NOW = Date.now();
const CEILINGS = { developer: { write: "worktree", hosts: ["granted.test"] } };

describe("proxy-service refresh errors", () => {
  let tmp, stateDir, logs, service;
  const seed = async (name, expiresAt) => {
    const dir = path.join(stateDir, "accounts", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: `AT-${name}`, refreshToken: `RT-${name}`, expiresAt, scopes: ["user:inference"] } }));
  };
  const make = (status) => createProxyService({
    stateDir, releaseDir: path.join(tmp, "release"), ceilings: CEILINGS, image: "den-agent:test", now: () => NOW, log: (m) => logs.push(m),
    docker: async (args) => ({ ok: args[0] !== "inspect", out: "", err: "" }),
    fetch: async () => ({ ok: false, status, json: async () => ({}) }),
  });

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "den-svc-err-"));
    stateDir = path.join(tmp, "state");
    logs = [];
  });
  afterEach(() => rm(tmp, { recursive: true, force: true }));

  test("a refresh that fails is logged once, not every look", async () => {
    await seed("a", NOW - 60_000);
    service = make(400);
    await service.tick();
    await service.tick();
    assert.equal(logs.length, 1);
    assert.match(logs[0], /account a/);
  });

  test("switching to an account whose refresh failed and whose token has expired is refused; the active account stays", async () => {
    await seed("a", NOW + 3_600_000);
    await seed("dead", NOW - 60_000);
    service = make(400);
    await service.switchAccount("a");
    await assert.rejects(service.switchAccount("dead"), /dead/);
    assert.equal((await service.status()).active, "a");
  });

  test("a failed refresh does not block a switch while the token is still good", async () => {
    await seed("a", NOW + 3_600_000);
    await seed("b", NOW + 3_600_000);
    service = make(400);
    await service.switchAccount("b");
    assert.equal((await service.status()).active, "b");
  });
});
