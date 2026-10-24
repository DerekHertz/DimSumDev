// hardening/16: the den starts the credential proxy with one refresher per account, and the user switches accounts by hand. qa specify.
// Red until apps/bridge/proxy/proxy-service.mjs exists. Offline: a fake docker, a fake token endpoint (fetch), a temp state folder.
//
// The contract, createProxyService({ stateDir, releaseDir, ceilings, docker, image, fetch?, now? }) (apps/bridge/proxy/proxy-service.mjs):
//   stateDir     the den's state folder; the accounts are <stateDir>/accounts/<name>/.credentials.json (accounts.mjs)
//   releaseDir   the running release; the proxy code mounted is <releaseDir>/apps/bridge/proxy
//   ceilings     the shape of apps/bridge/agents/ceilings.json; the proxy's roles are roleHosts(ceilings)
//   docker       docker(args) -> { ok, out, err }, handed to ensureProxy;  fetch / now  handed to oauthRefresh and the refreshers
//   start()      -> a refresher per listed account (createTokenRefresher, each with its own credentialsFileStore and
//                   oauthRefresh({ scope: store.scope })), the first tick of each awaited; the secrets file written (an empty map) BEFORE
//                   ensureProxy runs; then ensureProxy with secretsDir. It never reads or writes ~/.claude/.credentials.json.
//   stop()       stops the refreshers
//   tick()       one refresh look at every account now (the test's stand-in for the timers)
//   status()     -> { active, accounts: [names] }   (may be async)
//   switchAccount(name)  the user's manual switch: the proxy's token file (in the directory ensureProxy mounts at /run/den-token) holds the active
//                   account's access token and no other's; a refresh of an account that is not active never writes it. Refuses an unknown account.
//   mintRunSecret({ role }) -> { secret }: a fresh random secret for this run, mapped to its role in the secrets file the proxy reads, and the
//                   file holds it by the time the promise resolves (the agent starts after). Concurrent calls lose no entry. An unknown role rejects.
// Nothing here switches accounts by itself: a usage limit (HTTP 429) or a failed refresh leaves the active account as it is.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { roleHosts } from "./proxy.mjs";
import { createProxyService } from "./proxy-service.mjs";

const NOW = Date.now();
const SCOPES = ["user:inference", "user:profile"];
const CEILINGS = { developer: { write: "worktree", hosts: ["granted.test"] }, qa: { write: "none", hosts: [] } };
const TOKEN_MOUNT = "/run/den-token";
const SECRETS_MOUNT = "/run/den-secrets";
const CLI_REFRESH = ["sk-ant", "ort01-SENTINEL-INTERACTIVE-CLI"].join("-"); // built at runtime so the repo secret scan stays clean

// A fake token endpoint that knows each account's refresh-token lineage. A refresh token it has never issued is a "stranger" (401).
function fakeEndpoint({ failing = {} } = {}) {
  const lineage = new Map(); // refresh token -> account
  const count = {};
  const calls = []; // { account, body }
  const strangers = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const account = lineage.get(body.refresh_token);
    if (!account) { strangers.push(body); return { ok: false, status: 401, json: async () => ({}) }; }
    calls.push({ account, body });
    if (failing[account]) return { ok: false, status: failing[account], json: async () => ({}) };
    count[account] = (count[account] ?? 0) + 1;
    const next = `RT-${account}-${count[account]}`;
    lineage.set(next, account);
    return { ok: true, status: 200, json: async () => ({ access_token: `AT-${account}-${count[account]}`, refresh_token: next, expires_in: 3600 }) };
  };
  return { fetch, calls, strangers, know: (refresh, account) => lineage.set(refresh, account) };
}

function fakeDocker({ onRun } = {}) {
  const calls = [];
  const docker = async (args) => {
    calls.push(args);
    if (args[0] === "run") await onRun?.(args);
    return { ok: args[0] !== "inspect", out: "", err: "" }; // the network exists, no proxy container does
  };
  return { docker, calls, runs: () => calls.filter((a) => a[0] === "run") };
}
const flag = (args, name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const mountOf = (args, target) => flag(args, "-v").map((m) => m.split(":")).find((p) => p[1] === target)?.[0];

describe("createProxyService", () => {
  let tmp, stateDir, releaseDir, endpoint, dk, service;
  const accountDir = (name) => path.join(stateDir, "accounts", name);
  const seed = async (name, { expiresAt = NOW - 60_000 } = {}) => {
    await mkdir(accountDir(name), { recursive: true });
    await writeFile(path.join(accountDir(name), ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: `AT-${name}-0`, refreshToken: `RT-${name}-0`, expiresAt, scopes: SCOPES } }));
    endpoint.know(`RT-${name}-0`, name);
  };
  const make = (extra = {}) => (service = createProxyService({ stateDir, releaseDir, ceilings: CEILINGS, docker: dk.docker, image: "den-agent:test", fetch: endpoint.fetch, now: () => NOW, ...extra }));
  const tokenFile = () => path.join(mountOf(dk.runs()[0], TOKEN_MOUNT), "access-token");
  const served = async () => (await readFile(tokenFile(), "utf8")).trim();
  const secretsFile = () => path.join(mountOf(dk.runs()[0], SECRETS_MOUNT), "secrets.json");

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "den-proxy-service-"));
    stateDir = path.join(tmp, "state");
    releaseDir = path.join(tmp, "release");
    endpoint = fakeEndpoint();
    dk = fakeDocker();
  });
  afterEach(async () => {
    await service?.stop?.();
    service = undefined;
    await rm(tmp, { recursive: true, force: true });
  });

  describe("start", () => {
    test("brings up the proxy container: the release's proxy code, the roles from the ceilings, a secrets dir, the token dir", async () => {
      await seed("a");
      await make().start();
      assert.equal(dk.runs().length, 1);
      const args = dk.runs()[0];
      assert.equal(mountOf(args, "/den-proxy"), path.join(releaseDir, "apps", "bridge", "proxy"));
      assert.ok(mountOf(args, TOKEN_MOUNT), "no token directory is mounted");
      assert.ok(mountOf(args, SECRETS_MOUNT), "no secrets directory is mounted");
      const env = flag(args, "-e");
      assert.ok(env.includes(`DEN_PROXY_ROLES=${JSON.stringify(roleHosts(CEILINGS))}`), env.join(" "));
      assert.ok(env.some((e) => e.startsWith("DEN_PROXY_SECRETS_FILE=")), env.join(" "));
      assert.equal(args.at(-3), "den-agent:test"); // image, then `node /den-proxy/den-proxy.mjs`
    });

    // hardening/16 security F3: nobody else on the box needs to list the proxy's folders.
    test("the proxy folder and its private accounts folder are mode 0700, even when they already existed at 0755", async () => {
      await seed("a");
      await mkdir(path.join(stateDir, "proxy", "accounts"), { recursive: true, mode: 0o755 });
      await chmod(path.join(stateDir, "proxy"), 0o755);
      await make().start();
      for (const dir of [path.join(stateDir, "proxy"), path.join(stateDir, "proxy", "accounts")]) assert.equal((await stat(dir)).mode & 0o777, 0o700, dir);
    });

    test("the secrets file exists, as an empty map, before the proxy container is run", async () => {
      await seed("a");
      let atRun;
      dk = fakeDocker({ onRun: async (args) => { atRun = await readFile(path.join(mountOf(args, SECRETS_MOUNT), "secrets.json"), "utf8").catch((e) => `missing: ${e.code}`); } });
      await make().start();
      assert.deepEqual(JSON.parse(atRun), {});
    });

    test("one refresher per account, each refreshing its own login with its own scopes, each saved back to its own dir", async () => {
      await seed("a");
      await seed("b");
      await make().start();
      assert.deepEqual(endpoint.calls.map((c) => c.account).sort(), ["a", "b"]);
      assert.deepEqual(endpoint.calls.map((c) => [c.account, c.body.refresh_token]).sort(), [["a", "RT-a-0"], ["b", "RT-b-0"]]);
      for (const c of endpoint.calls) assert.equal(c.body.scope, SCOPES.join(" "), "oauthRefresh({ scope: store.scope })");
      assert.deepEqual(endpoint.strangers, []);
      for (const name of ["a", "b"]) {
        const saved = JSON.parse(await readFile(path.join(accountDir(name), ".credentials.json"), "utf8")).claudeAiOauth;
        assert.equal(saved.refreshToken, `RT-${name}-1`, `${name}'s rotated login is saved in its own dir`);
        assert.equal(saved.accessToken, `AT-${name}-1`);
      }
    });

    test("a login dir whose /login is not finished is left alone: start still works for the others", async () => {
      await seed("a");
      await mkdir(accountDir("half"), { recursive: true });
      await make().start();
      assert.deepEqual(endpoint.calls.map((c) => c.account), ["a"]);
      assert.deepEqual((await service.status()).accounts, ["a"]);
    });

    test("the proxy serves the active account's access token, the first listed one by default", async () => {
      await seed("b");
      await seed("a");
      await make().start();
      assert.equal(await served(), "AT-a-1");
      assert.deepEqual(await service.status(), { active: "a", accounts: ["a", "b"] });
    });

    test("never touches the interactive CLI's credentials: the file is byte-identical, unmodified, and its login is never sent", async () => {
      const home = path.join(tmp, "home");
      const cliFile = path.join(home, ".claude", ".credentials.json");
      await mkdir(path.dirname(cliFile), { recursive: true });
      const cliText = JSON.stringify({ claudeAiOauth: { accessToken: "AT-cli", refreshToken: CLI_REFRESH, expiresAt: NOW - 60_000, scopes: SCOPES } });
      await writeFile(cliFile, cliText);
      const before = await stat(cliFile);
      const homeBefore = await readdir(home, { recursive: true });
      const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      try {
        await seed("a");
        await seed("b");
        await make().start();
        await service.switchAccount("b");
        await service.tick();
        await service.mintRunSecret({ role: "developer" });
        service.stop();
      } finally {
        for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
      }
      assert.equal(await readFile(cliFile, "utf8"), cliText);
      assert.equal((await stat(cliFile)).mtimeMs, before.mtimeMs);
      assert.deepEqual(await readdir(home, { recursive: true }), homeBefore);
      assert.ok(!JSON.stringify(endpoint.calls).includes(CLI_REFRESH) && endpoint.strangers.length === 0, "the CLI's refresh token reached the token endpoint");
    });
  });

  describe("switching by hand", () => {
    test("status shows the active account; switchAccount changes it, keeps it across a new service, and the proxy then serves the other token", async () => {
      await seed("a");
      await seed("b");
      await make().start();
      assert.equal(await served(), "AT-a-1");
      await service.switchAccount("b");
      assert.deepEqual(await service.status(), { active: "b", accounts: ["a", "b"] });
      assert.equal(await served(), "AT-b-1");
      service.stop();
      make();
      assert.equal((await service.status()).active, "b", "the choice survives a restart");
    });

    test("an unknown account is refused and the active account, and the token served, stay as they were", async () => {
      await seed("a");
      await seed("b");
      await make().start();
      for (const bad of ["nobody", "../a", "", undefined]) await assert.rejects(service.switchAccount(bad), undefined, String(bad));
      assert.equal((await service.status()).active, "a");
      assert.equal(await served(), "AT-a-1");
    });

    test("a refresh of the account that is not active never replaces the token being served; the next switch finds the fresh one", async () => {
      await seed("a");
      await seed("b");
      await make().start();
      await service.switchAccount("b");
      // a's access token runs out: its stored login says so, and the next look refreshes it
      const aFile = path.join(accountDir("a"), ".credentials.json");
      const a = JSON.parse(await readFile(aFile, "utf8"));
      a.claudeAiOauth.expiresAt = NOW - 1000;
      await writeFile(aFile, JSON.stringify(a));
      const before = endpoint.calls.length;
      await service.tick();
      assert.deepEqual(endpoint.calls.slice(before).map((c) => c.account), ["a"], "the refresher of the inactive account still runs, or its single-use login dies");
      assert.equal(await served(), "AT-b-1");
      await service.switchAccount("a");
      assert.equal(await served(), "AT-a-2");
    });

    test("a refresh of the active account does replace the token being served", async () => {
      await seed("a");
      await make().start();
      const aFile = path.join(accountDir("a"), ".credentials.json");
      const a = JSON.parse(await readFile(aFile, "utf8"));
      a.claudeAiOauth.expiresAt = NOW - 1000;
      await writeFile(aFile, JSON.stringify(a));
      await service.tick();
      assert.equal(await served(), "AT-a-2");
    });
  });

  describe("no automatic switch", () => {
    test("a usage limit (HTTP 429) on the active account's refresh leaves it active and never serves the other account's token", async () => {
      endpoint = fakeEndpoint({ failing: { a: 429 } });
      await seed("a");
      await seed("b");
      await make().start();
      await service.tick();
      assert.equal((await service.status()).active, "a");
      const file = await readFile(tokenFile(), "utf8").catch(() => "");
      assert.ok(!file.includes("AT-b"), "b's token is being served though the user never switched");
    });

    test("an account whose login is revoked (HTTP 401) is reported, not swapped for another", async () => {
      endpoint = fakeEndpoint({ failing: { a: 401 } });
      await seed("a");
      await seed("b");
      await make().start();
      await service.tick();
      assert.equal((await service.status()).active, "a");
      assert.deepEqual(dk.runs().length, 1, "the proxy was not restarted for another account");
    });
  });

  describe("run secrets", () => {
    test("a secret is minted per run: long, distinct, and written under its role before the promise resolves", async () => {
      await seed("a");
      await make().start();
      const one = await service.mintRunSecret({ role: "developer" });
      const map1 = JSON.parse(await readFile(secretsFile(), "utf8"));
      const two = await service.mintRunSecret({ role: "developer" });
      const map2 = JSON.parse(await readFile(secretsFile(), "utf8"));
      assert.match(one.secret, /^[A-Za-z0-9_-]{32,}$/);
      assert.notEqual(one.secret, two.secret);
      assert.equal(map1[one.secret], "developer");
      assert.deepEqual(map2, { [one.secret]: "developer", [two.secret]: "developer" }, "a second run adds its secret and keeps the first run's");
      assert.equal((await stat(secretsFile())).mode & 0o777, 0o600);
    });

    test("20 runs started at once: each finds its own secret in the file when its call returns, and none is lost", async () => {
      await seed("a");
      await make().start();
      const roles = ["developer", "qa"];
      const seen = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
        const role = roles[i % 2];
        const { secret } = await service.mintRunSecret({ role });
        const map = JSON.parse(await readFile(secretsFile(), "utf8"));
        return { secret, role, mapped: map[secret] };
      }));
      for (const s of seen) assert.equal(s.mapped, s.role, "the secret was not in the file when the run was told it");
      assert.equal(new Set(seen.map((s) => s.secret)).size, 20);
      const final = JSON.parse(await readFile(secretsFile(), "utf8"));
      assert.deepEqual(Object.entries(final).sort(), seen.map((s) => [s.secret, s.role]).sort());
    });

    test("retireRunSecret drops one run's secret from the file and keeps the others (hardening/16 F4)", async () => {
      await seed("a");
      await make().start();
      const one = await service.mintRunSecret({ role: "developer" });
      const two = await service.mintRunSecret({ role: "qa" });
      await service.retireRunSecret(one.secret);
      assert.deepEqual(JSON.parse(await readFile(secretsFile(), "utf8")), { [two.secret]: "qa" });
      await service.retireRunSecret(one.secret);
      await service.retireRunSecret("not-a-secret");
      assert.deepEqual(JSON.parse(await readFile(secretsFile(), "utf8")), { [two.secret]: "qa" }, "retiring an unknown secret changes nothing");
    });

    test("a role the ceilings do not know is refused and the file is unchanged", async () => {
      await seed("a");
      await make().start();
      await service.mintRunSecret({ role: "qa" });
      const before = await readFile(secretsFile(), "utf8");
      await assert.rejects(service.mintRunSecret({ role: "wizard" }));
      assert.equal(await readFile(secretsFile(), "utf8"), before);
    });
  });
});
