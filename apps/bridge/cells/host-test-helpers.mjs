// organism-infra/140: shared helpers for the steering host-core tests (not a test file: no .test.mjs suffix).
//
// PINNED INTERFACE (the contract these tests hold the developer to; ADR 0016 as amended, names per ADR 0019
// decision 10: "agent" and "role" in code):
//
//   apps/bridge/cells/policy.mjs   MAX_CONCURRENT_AGENTS (2), SESSION_CAP (8), KILL_GRACE_MS (5000),
//                                  RELAY_HOP_ROLES (developer, qa, security)
//   apps/bridge/cells/runtime.mjs  createFakeRuntime(config) -> CellRuntime plus test controls (see host-core.test.mjs)
//   startBridge({ root, port, auth, runtime?, policy? })
//       policy: { maxConcurrent?, sessionCap?, killGraceMs? }  (test-only overrides; production passes none)
//       returns the existing fields plus  host: { start(input), shutdown() }
//   host.start({ ref, role, mode? }) -> Promise<{ ok: true, status: 201, agent } | { ok: false, status, error }>
//       the internal entry (relay runner); never reachable from HTTP; shares the reservation and the caps
//   routes: POST /agents, POST /agents/:id/stop (token-gated, mutating), snapshot key `agents`, change type `agent`
//   process: CellProcess = { handle, events, closeInput(), signal(sig), exited }; runtime.resumeCommand(sessionId) -> string
//   All of this is recorded in ADR 0016 (fourth amendment, 2026-10-05); the tests and the ADR must agree.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startBridge } from "../server.mjs";
import { makeStateFixture, FEATURE } from "../bridge-fixture.mjs";
import { CODE, login, authed, send } from "../bridge-auth-helpers.mjs";

export { FEATURE, send };
export const DISPATCH_REF = `${FEATURE}/02-ready-p0`; // the one ticket with gate "dispatch" in the fixture
export const NO_GATE_REF = `${FEATURE}/03-blocked-dep`;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AGENT_ID_RE = /^c-[0-9a-f]{16}$/; // ADR 0016 as amended: agent ids keep the c- prefix; approval ids are a-
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, { ms = 3000, every = 15, what = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) assert.fail(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(every);
  }
}

// A missing module is the feature being absent, so say that instead of a bare import error.
async function need(rel, names) {
  let mod;
  try {
    mod = await import(rel);
  } catch (err) {
    assert.fail(`apps/bridge/cells/${rel.slice(2)} does not exist yet (missing feature): ${err.message}`);
  }
  for (const n of names) assert.notEqual(mod[n], undefined, `${rel} must export ${n}`);
  return mod;
}
export const loadRuntime = () => need("./runtime.mjs", ["createFakeRuntime"]);
export const loadPolicy = () => need("./policy.mjs", ["MAX_CONCURRENT_AGENTS", "SESSION_CAP", "KILL_GRACE_MS", "SLOTS", "slotClassOf"]);

// A bridge over a disposable board, a fake runtime, a logged-in session, and shorthands.
//   preWrite(root)  runs before the bridge starts (seed .scratch files)
//   noRuntime       start with no runtime option at all
//   noGit           the root is not a git repository, so no agent worktree can be created (den-v1 loop S0)
//   gitHost, stateDir  passed to startBridge (den-mvp outcome 3: the delivery runner's git host and log directory)
//   root            an existing fixture root to start on again (a restarted bridge); the caller cleans it up
//   library         passed to startBridge (den-mvp outcome 4: the catalog of connections and its record)
//   serviceToken    den-mvp/88: the router's service token, passed to startBridge's auth
//   denState, box   passed to startBridge (den-mvp outcome 5: the release folders and the build box)
export async function makeBridge({ runtimeConfig = {}, policy, preWrite, noRuntime = false, noGit = false, gitHost, stateDir, root, library, denState, box, checks, serviceToken } = {}) {
  const { createFakeRuntime } = await loadRuntime();
  const fx = root ? { root, cleanup: async () => {} } : await makeStateFixture({ git: !noGit });
  if (preWrite) await preWrite(fx.root);
  const fake = createFakeRuntime(runtimeConfig);
  const bridge = await startBridge({
    root: fx.root,
    port: 0,
    auth: { launchCode: CODE, ...(serviceToken ? { serviceToken } : {}) },
    ...(noRuntime ? {} : { runtime: fake }),
    ...(policy ? { policy } : {}),
    ...(gitHost ? { gitHost: typeof gitHost === "function" ? gitHost(fx.root) : gitHost } : {}),
    ...(stateDir ? { stateDir } : {}),
    ...(library ? { library } : {}),
    ...(denState ? { denState } : {}),
    ...(box ? { box } : {}),
    ...(checks ? { checks } : {}),
  });
  const token = await login(bridge);
  const headers = authed(bridge, token);
  const post = (p, body = {}, h = headers) => send(bridge, { method: "POST", path: p, body, headers: h });
  const state = async () => (await send(bridge, { path: "/state" })).body;
  const agent = async (id) => (await state()).agents?.find((a) => a.id === id);
  const sessionsFile = path.join(fx.root, ".scratch", "_run", "sessions.jsonl");
  return {
    fx,
    fake,
    bridge,
    token,
    headers,
    post,
    state,
    agent,
    sessionsFile,
    dispatch: (role = "architect", ref = DISPATCH_REF, extra = {}) => post("/agents", { ref, role, ...extra }),
    async close() {
      for (const r of fake.spawns ?? []) if (!r.exited) r.exit();
      await bridge.close();
      await fx.cleanup();
    },
  };
}

export async function seedSessions(root, lines) {
  const dir = path.join(root, ".scratch", "_run");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "sessions.jsonl"), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}

// Minimal SSE client: parsed { event, data } frames, ping comments skipped.
export function openSse(bridge) {
  const frames = [];
  const waiters = [];
  let req;
  const opened = new Promise((resolve, reject) => {
    req = http.get(`${bridge.url}/events`, { headers: { Accept: "text/event-stream" } }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = "message";
          const data = [];
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
          }
          if (!data.length) continue;
          frames.push({ event, data: JSON.parse(data.join("\n")) });
          for (const w of [...waiters]) w();
        }
      });
      resolve(res);
    });
    req.on("error", reject);
  });
  function next(pred, ms = 1000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const f = frames.find(pred);
        if (f) {
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
          resolve(f);
        }
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(check), 1);
        reject(new Error(`no matching SSE frame within ${ms} ms; saw ${JSON.stringify(frames.map((f) => f.event + ":" + (f.data.type ?? "")))}`));
      }, ms);
      waiters.push(check);
      check();
    });
  }
  return { frames, opened, next, close: () => req.destroy() };
}
