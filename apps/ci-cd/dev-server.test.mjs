// ci-cd/02: the committed dev server. `npm run dev` serves the repo so agents and
// the smoke check share one server that gets MIME types and caching right --
// ticket 07's designer hit Python's http.server serving .mjs as text/plain on
// Windows, and a reused port serving a stale module graph.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

// ci-cd/08 (organism-infra/221): a port from listen(0) is in the kernel's ephemeral range, which every outgoing connection and
// every other listen(0) in a parallel run also draws from, and `npm run dev` takes seconds to start; in 64 runs at 24 at once one
// child died with "EADDRINUSE" (exit code 1). Probe a random port below that range (32768+) instead.
async function findFreePort() {
  for (;;) {
    const port = 20000 + Math.floor(Math.random() * 12000);
    const free = await new Promise((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
    if (free) return port;
  }
}

function startDevServer(port) {
  return spawn("npm", ["run", "dev", "--", String(port)], {
    cwd: REPO_ROOT,
    shell: true,
    // POSIX only: makes this child the leader of its own process group, so
    // stopServer can signal the whole tree (sh -> npm -> node) at once. See
    // stopServer for why the plain, non-detached child.kill() below isn't enough.
    detached: process.platform !== "win32",
  });
}

async function waitForServer(url, child, timeoutMs = 30000 /* ci-cd/08: startup time, measured: 24 parallel `npm run dev` starts on 8 cores took more than 10 s (4 of 64 runs) */) {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  let exitInfo = null;
  let stderr = ""; // ci-cd/08: say why it exited (organism-infra/221 had only the exit code)
  child.stderr?.on("data", (c) => (stderr += c));
  child.once("exit", (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });

  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `dev server exited before it answered ${url} (code=${exitInfo.code}, signal=${exitInfo.signal}). stderr: ${stderr.slice(0, 1500)}`
      );
    }
    try {
      return await fetch(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`dev server never answered ${url} within ${timeoutMs}ms`);
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    if (process.platform === "win32") {
      // `npm run dev` on Windows re-spawns the actual `node dev-server.mjs` process
      // through its own shell layer, and Windows has no POSIX-style process-group
      // signal propagation -- child.kill() here would only kill the outer cmd.exe
      // wrapper and orphan the real server. Kill the whole tree by pid instead.
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      // child.kill() alone only signals the immediate shell (`sh -c "npm run dev
      // ..."`), not npm's own child node process -- that node process (the real
      // server) is left running, still holding the piped stdout/stderr open, which
      // hangs `node --test` forever waiting for those pipes to close. Confirmed in
      // CI run 36376905451 (test job stuck 36+ min; GitHub's own cleanup found the
      // orphaned "npm run dev" process still alive at cancellation). startDevServer
      // spawns this child detached (its own process group), so signal the whole
      // group via the negative pid instead of just the immediate child.
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill();
      }
    }
  });
}

test("npm run dev serves a .mjs file as text/javascript with Cache-Control: no-store", async () => {
  const port = await findFreePort();
  const child = startDevServer(port);
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += chunk));

  try {
    const res = await waitForServer(
      `http://localhost:${port}/apps/ui/src/scene/scene-from-state.mjs`,
      child
    );
    assert.equal(res.status, 200, `expected 200 for scene-from-state.mjs, got ${res.status}. stderr: ${stderr}`);

    const contentType = res.headers.get("content-type") || "";
    assert.ok(
      contentType.includes("text/javascript"),
      `.mjs must be served as text/javascript so browsers accept the module; got "${contentType}"`
    );

    assert.equal(
      res.headers.get("cache-control"),
      "no-store",
      "dev server must send Cache-Control: no-store so a reused port never serves a stale module graph"
    );
  } finally {
    await stopServer(child);
  }
});

test("npm run dev takes a port argument and listens on the requested port", async () => {
  const port = await findFreePort();
  const child = startDevServer(port);

  try {
    const res = await waitForServer(
      `http://localhost:${port}/apps/ui/index.html`,
      child
    );
    assert.equal(
      res.status,
      200,
      `dev server did not serve index.html on the requested port ${port}`
    );
  } finally {
    await stopServer(child);
  }
});
