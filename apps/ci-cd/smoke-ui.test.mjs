// dimsumden-ui-v0/13: end-to-end smoke of bridge + UI on a fixture board.
// Public interfaces under test (ADR 0011 decision 8):
//   1. `npm run smoke -- --url <url> [--url <url> ...]` : smoke.mjs "load this URL" mode. Loads
//      the given absolute URL(s) in a headless browser instead of serving repo dev pages, and
//      exits non-zero on a console error, failed import, or failed asset load.
//   2. `npm run smoke:ui` : builds the UI, starts the bridge on a fixture .scratch/ tree, loads
//      it, checks scene count, queue order, a chart, and one Approve round trip. Each check
//      prints a line starting with PASS (or FAIL) that names it (scene, queue, chart, approve).
//      den-iso-v1/02 adds the orthographic camera: "camera fit" at 1440x900 and 375x667 (every kiosk sign and
//      the Tally inside the scene), "camera zoom" (wheel scales sign spacing by 1/d, clamped) and "camera pan" (drag shifts the scene rigidly).
// Needs Playwright plus an installed browser, like smoke.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDevServer } from "./dev-server.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

function run(args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", ...args], {
      cwd: REPO_ROOT,
      shell: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill();
      }
      reject(new Error(`npm run ${args.join(" ")} did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (c) => (stdout += c));
    child.stderr?.on("data", (c) => (stderr += c));
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function withFixtureServer(fn) {
  const server = createDevServer(REPO_ROOT);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("smoke --url passes a healthy page at the given URL", async () => {
  await withFixtureServer(async (base) => {
    const { code, stdout, stderr } = await run(
      ["smoke", "--", "--url", `${base}/apps/ci-cd/fixtures/ok-page.html`],
      { timeoutMs: 45000 }
    );
    assert.equal(code, 0, `stdout: ${stdout}\nstderr: ${stderr}`);
    assert.match(stdout, /PASS/);
  });
});

test("smoke --url exits non-zero when the page at the URL has a failed module import", async () => {
  await withFixtureServer(async (base) => {
    const { code, stdout, stderr } = await run(
      ["smoke", "--", "--url", `${base}/apps/ci-cd/fixtures/node-import.html`],
      { timeoutMs: 45000 }
    );
    assert.notEqual(code, 0, `stdout: ${stdout}\nstderr: ${stderr}`);
    assert.match(`${stdout}${stderr}`, /FAIL/);
    assert.match(`${stdout}${stderr}`, /node:|import|module/i, `must fail for the import, not for a mangled URL.\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.ok(!/127\.0\.0\.1:\d+\/http/.test(`${stdout}${stderr}`), "the URL must be loaded as given, not appended to the repo server");
  });
});

test("smoke --url exits non-zero when the URL is unreachable", async () => {
  // Port 9 (discard) on loopback: nothing listens, so navigation fails.
  const { code, stdout, stderr } = await run(["smoke", "--", "--url", "http://127.0.0.1:9/"], {
    timeoutMs: 45000,
  });
  assert.notEqual(code, 0, `stdout: ${stdout}\nstderr: ${stderr}`);
  assert.match(`${stdout}${stderr}`, /ERR_CONNECTION_REFUSED|navigation/i, `must fail on navigation.\nstderr: ${stderr}`);
  assert.ok(!/127\.0\.0\.1:\d+\/http/.test(`${stdout}${stderr}`), "URL must be loaded as given");
});

test("npm run smoke:ui passes on main: scene count, queue order, chart and one Approve round trip", async () => {
  const { code, stdout, stderr } = await run(["smoke:ui"], { timeoutMs: 170000 });
  assert.equal(code, 0, `smoke:ui must exit 0.\nstdout: ${stdout}\nstderr: ${stderr}`);
  for (const check of ["scene", "queue", "chart", "approve", "camera fit.*1440x900", "camera fit.*375x667", "camera zoom", "camera controls: Shift-drag pans, primary drag orbits both axes, and Den resets the framing"]) {
    assert.match(
      stdout,
      new RegExp(`^PASS.*${check}`, "im"),
      `expected a PASS line naming the ${check} check.\nstdout: ${stdout}`
    );
  }
  assert.ok(!/^FAIL/m.test(stdout + stderr), `no FAIL lines expected.\n${stdout}\n${stderr}`);
});
