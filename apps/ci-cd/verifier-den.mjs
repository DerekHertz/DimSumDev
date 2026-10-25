// trust-ladder/02: the den as a verifier target, the same setup as smoke-ui.mjs: build the UI, start the bridge on a disposable
// .scratch/ fixture and open it with a launch code like a real user. A flow's `{launchCode}` is filled from `vars`.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { makeStateFixture } from "../bridge/bridge-fixture.mjs";
import { startBridge } from "../bridge/server.mjs";
import { REPO_ROOT } from "./dev-server.mjs";

// `signal` aborts the build and kills its whole process group (npm and the vite it started), so a capped run leaves no build behind.
export function runBuild({ signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "ui:build"], { cwd: REPO_ROOT, shell: process.platform === "win32", detached: process.platform !== "win32" });
    signal?.addEventListener("abort", () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, { once: true });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm run ui:build exited ${code}\n${out}`))));
  });
}

export async function startDenFixture() {
  const fx = await makeStateFixture();
  const launchCode = randomBytes(32).toString("base64url");
  const bridge = await startBridge({ root: fx.root, port: 0, auth: { launchCode } });
  return {
    base: bridge.url.replace(/\/+$/, ""),
    vars: { launchCode },
    close: async () => {
      await bridge.close();
      await fx.cleanup();
    },
  };
}
