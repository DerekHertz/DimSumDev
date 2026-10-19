// den-mvp outcome 5 (ADR 0026 decisions 1 and 8): the bridge serves the UI from ui/current when the links name a complete
// release, resolved per request, and from the checkout's build (uiDir) when they do not. bridge-static.test.mjs covers the latter.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { startBridge } from "./server.mjs";
import { makeStateFixture } from "./bridge-fixture.mjs";
import { createReleases } from "./build/releases.mjs";

const sha = (n) => String(n).repeat(40);
const raw = (port, target) => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path: target }, (res) => {
    res.resume();
    res.on("end", () => resolve(res.statusCode));
  }).on("error", reject);
});

describe("bridge serves the UI from release folders", () => {
  let fx, tmp, state, uiDir, bridge, releases;
  // A complete release: build.json and the built UI, whose index names the build and whose one hashed file carries its name.
  const release = async (n) => {
    const dir = path.join(state, "releases", sha(n).slice(0, 12));
    await mkdir(path.join(dir, "apps/ui/dist/assets"), { recursive: true });
    await writeFile(path.join(dir, "apps/ui/dist/index.html"), `<title>build ${n}</title>`);
    await writeFile(path.join(dir, "apps/ui/dist/assets", `app-${n}.js`), `export const build = ${n};`);
    await writeFile(path.join(dir, "build.json"), JSON.stringify({ sha: sha(n), builtAt: "2026-10-13T00:00:00Z", lock: "x" }));
  };
  const get = async (p) => {
    const res = await fetch(`${bridge.url}${p}`);
    return [res.status, await res.text()];
  };

  before(async () => {
    fx = await makeStateFixture();
    tmp = await mkdtemp(path.join(tmpdir(), "den-state-"));
    state = path.join(tmp, "den");
    uiDir = path.join(tmp, "checkout-dist");
    await mkdir(path.join(uiDir, "assets"), { recursive: true });
    await writeFile(path.join(uiDir, "index.html"), "<title>checkout</title>");
    await writeFile(path.join(uiDir, "assets", "checkout.js"), "export const x = 0;");
    releases = createReleases({ stateDir: state });
    bridge = await startBridge({ root: fx.root, port: 0, uiDir, denState: state });
  });
  after(async () => {
    await bridge.close();
    await fx.cleanup();
    await rm(tmp, { recursive: true, force: true });
  });

  test("with no links, the checkout's build is served as before", async () => {
    assert.deepEqual(await get("/"), [200, "<title>checkout</title>"]);
    assert.equal((await get("/assets/checkout.js"))[0], 200);
  });

  test("a link to a folder without build.json is not served", async () => {
    await mkdir(path.join(state, "releases", sha(9).slice(0, 12), "apps/ui/dist"), { recursive: true });
    await writeFile(path.join(state, "releases", sha(9).slice(0, 12), "apps/ui/dist/index.html"), "half");
    await mkdir(path.join(state, "ui"), { recursive: true });
    execFileSync("ln", ["-s", `../releases/${sha(9).slice(0, 12)}`, path.join(state, "ui", "current")]);
    assert.deepEqual(await get("/"), [200, "<title>checkout</title>"]);
    await rm(path.join(state, "ui"), { recursive: true });
  });

  test("after a switch the old build's hashed file is still answered and index.html is the new one", async () => {
    await release(1); // each release is made just before its switch: a switch deletes a release no link points to
    await releases.switchUi(sha(1));
    assert.deepEqual(await get("/"), [200, "<title>build 1</title>"]);
    assert.equal((await get("/assets/app-1.js"))[0], 200);
    assert.equal((await get("/assets/checkout.js"))[0], 404);
    await release(2);
    await releases.switchUi(sha(2));
    assert.deepEqual(await get("/"), [200, "<title>build 2</title>"]);
    assert.deepEqual(await get("/some/route"), [200, "<title>build 2</title>"]);
    assert.deepEqual(await get("/assets/app-1.js"), [200, "export const build = 1;"]); // the previous release
    assert.deepEqual(await get("/assets/app-2.js"), [200, "export const build = 2;"]);
    assert.equal((await get("/assets/app-3.js"))[0], 404);
  });

  test("index.html is never taken from the previous release", async () => {
    await rm(path.join(state, "releases", sha(2).slice(0, 12), "apps/ui/dist/index.html"));
    assert.equal((await get("/index.html"))[0], 404);
    await writeFile(path.join(state, "releases", sha(2).slice(0, 12), "apps/ui/dist/index.html"), "<title>build 2</title>");
  });

  test("traversal is still a 403 and API routes still win", async () => {
    assert.equal(await raw(bridge.port, "/../releases/x"), 403);
    assert.equal(await raw(bridge.port, "/assets/%2e%2e/%2e%2e/build.json"), 403);
    assert.equal((await fetch(`${bridge.url}/state`)).headers.get("content-type"), "application/json");
  });

  test("a roll back is seen by the next request", async () => {
    await releases.rollbackUi(sha(1));
    assert.deepEqual(await get("/"), [200, "<title>build 1</title>"]);
  });

  test("starting a bridge removes a half-made release folder", async () => {
    const half = path.join(state, "releases", sha(8).slice(0, 12));
    await mkdir(half, { recursive: true });
    const other = await startBridge({ root: fx.root, port: 0, uiDir, denState: state });
    await other.close();
    await assert.rejects(rm(half, { recursive: false }), { code: "ENOENT" });
  });

  test("the bridge starts when launched through a link to server.mjs, as the service does through bridge/current", async () => {
    const free = await new Promise((resolve) => net.createServer().listen(0, "127.0.0.1", function () { const { port } = this.address(); this.close(() => resolve(port)); }));
    const link = path.join(tmp, "server-link.mjs");
    await symlink(fileURLToPath(new URL("./server.mjs", import.meta.url)), link);
    const child = spawn(process.execPath, [link], { cwd: fx.root, env: { PATH: process.env.PATH, HOME: tmp, XDG_STATE_HOME: path.join(tmp, "xdg"), DEN_ROOT: fx.root, PORT: String(free) }, stdio: ["ignore", "pipe", "ignore"] });
    try {
      const line = await new Promise((resolve, reject) => {
        child.stdout.once("data", (chunk) => resolve(String(chunk)));
        child.once("exit", (code) => reject(new Error(`the bridge exited with ${code} and printed nothing`)));
      });
      assert.match(line, new RegExp(`bridge listening on http://127.0.0.1:${free}`));
    } finally {
      child.kill();
    }
  });
});
