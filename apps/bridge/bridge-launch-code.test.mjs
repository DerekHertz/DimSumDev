// organism-infra/139 (ADR 0016 decision 6.2): the one-time launch code and the session token.
//
// Seam: startBridge({ root, port: 0, auth: { launchCode, ttlMs?, now? } }) over HTTP, plus the production
// entry point (`node apps/bridge/server.mjs`) as a child process for what it prints.
//   POST /session { code }  ->  200 { token }  (token: a string of at least 43 URL-safe characters)
//                               401 for a wrong, used, expired or burned code
//                               429 when four session tokens are already live (the cap; refused, not evicted)
//   bridge.newLaunchCode()  ->  a fresh code string; the one in-process way to mint another (the only thing the
//                               tests can use to reach the four-session cap, since each code redeems once)
// `now` is a function returning epoch milliseconds, so TTL tests never sleep. The default TTL is 5 minutes.
import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startBridge } from "./server.mjs";
import { makeStateFixture, FEATURE } from "./bridge-fixture.mjs";
import { CODE, origin, send, redeem, login, authed } from "./bridge-auth-helpers.mjs";

const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url));
const DISPATCH_REF = `${FEATURE}/02-ready-p0`;
const TTL = 5 * 60_000;
// Built at run time so no secret-looking literal sits in the tracked source (organism-infra/166 root scan).
const PRESET_TOKEN = "preset" + "-token";

let fx;
let bridge;
let clock;

const startAt = async (auth = {}) => startBridge({ root: fx.root, port: 0, auth: { launchCode: CODE, now: () => clock, ...auth } });
const placeRequest = (b, token) => send(b, { method: "POST", path: "/requests", body: { kind: "dispatch-approve", ref: DISPATCH_REF }, headers: authed(b, token) });

beforeEach(async () => {
  fx = await makeStateFixture();
  clock = 1_000_000;
  bridge = await startAt();
});
afterEach(async () => {
  await bridge.close();
  await fx.cleanup();
});

describe("redeeming the launch code", () => {
  test("the right code returns 200 and a session token, and the code is not echoed", async () => {
    const res = await redeem(bridge, CODE);
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.token, "string");
    assert.ok(res.body.token.length >= 43, "at least 32 random bytes encoded");
    assert.match(res.body.token, /^[A-Za-z0-9_-]+$/);
    assert.ok(!res.text.includes(CODE), "the response must not echo the launch code");
    assert.equal(res.headers["set-cookie"], undefined, "the token is in the body only, never a cookie");
  });

  test("the token authorises a mutating route", async () => {
    const token = await login(bridge);
    assert.equal((await placeRequest(bridge, token)).status, 201);
  });

  test("a wrong code is 401 and hands out no token", async () => {
    const res = await redeem(bridge, "nope");
    assert.equal(res.status, 401);
    assert.equal(res.body?.token, undefined);
  });

  test("a code of the wrong length or shape is 401, never 500", async () => {
    for (const code of ["", "a", "x".repeat(63), `${CODE}0`, "x".repeat(3000), CODE.toUpperCase()]) {
      const res = await redeem(bridge, code);
      assert.equal(res.status, 401, `code of length ${code.length}`);
    }
  });

  test("a body that is not { code: <string> } is a 4xx, never a 5xx, and hands out no token", async () => {
    for (const body of [{}, { code: 5 }, { code: null }, { code: [CODE] }, [CODE], "{not json", ""]) {
      const res = await send(bridge, { method: "POST", path: "/session", body, headers: { Origin: origin(bridge) } });
      assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(body)} gave ${res.status}`);
      assert.equal(res.body?.token, undefined);
    }
  });

  test("two sessions get two different tokens", async () => {
    const a = await login(bridge);
    const b = await login(bridge, bridge.newLaunchCode());
    assert.notEqual(a, b);
  });
});

describe("single use", () => {
  test("the code works once; the same code a second time is 401", async () => {
    assert.equal((await redeem(bridge, CODE)).status, 200);
    const again = await redeem(bridge, CODE);
    assert.equal(again.status, 401);
    assert.equal(again.body?.token, undefined);
  });

  test("burning the code does not end the session it made", async () => {
    const token = await login(bridge);
    assert.equal((await redeem(bridge, CODE)).status, 401);
    assert.equal((await placeRequest(bridge, token)).status, 201);
  });

  test("two redemptions racing for one code give exactly one token", async () => {
    const results = await Promise.all([redeem(bridge, CODE), redeem(bridge, CODE), redeem(bridge, CODE)]);
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 401).length, 2);
  });
});

describe("TTL (5 minutes by default, one constant)", () => {
  test("a code is good just inside five minutes", async () => {
    clock += TTL - 1;
    assert.equal((await redeem(bridge, CODE)).status, 200);
  });

  test("a code is dead just past five minutes", async () => {
    clock += TTL + 1;
    const res = await redeem(bridge, CODE);
    assert.equal(res.status, 401);
    assert.equal(res.body?.token, undefined);
  });

  test("ttlMs overrides the default", async () => {
    await bridge.close();
    bridge = await startAt({ ttlMs: 1000 });
    clock += 1001;
    assert.equal((await redeem(bridge, CODE)).status, 401);
    await bridge.close();
    bridge = await startAt({ ttlMs: 1000 });
    clock += 999;
    assert.equal((await redeem(bridge, CODE)).status, 200);
  });

  test("an expired code stays dead, and a session made before expiry outlives it", async () => {
    const token = await login(bridge);
    clock += TTL * 10;
    assert.equal((await redeem(bridge, CODE)).status, 401);
    assert.equal((await placeRequest(bridge, token)).status, 201, "the session token has no five-minute limit");
  });

  test("a code minted later has its own five minutes", async () => {
    clock += TTL - 10;
    const fresh = bridge.newLaunchCode();
    clock += TTL - 10;
    assert.equal((await redeem(bridge, fresh)).status, 200);
  });
});

describe("burn after five failures", () => {
  const wrong = ["a", "b".repeat(64), "", "c".repeat(63), "d".repeat(65)];

  test("five wrong codes burn it: the right code is then 401", async () => {
    for (const code of wrong) assert.equal((await redeem(bridge, code)).status, 401);
    const res = await redeem(bridge, CODE);
    assert.equal(res.status, 401);
    assert.equal(res.body?.token, undefined);
  });

  test("four wrong codes do not: the right one still works", async () => {
    for (const code of wrong.slice(0, 4)) assert.equal((await redeem(bridge, code)).status, 401);
    assert.equal((await redeem(bridge, CODE)).status, 200);
  });

  test("failures racing in parallel still burn it", async () => {
    await Promise.all(wrong.concat(wrong).map((code) => redeem(bridge, code)));
    assert.equal((await redeem(bridge, CODE)).status, 401);
  });

  test("a refused request (foreign Origin, wrong Content-Type, foreign Host) is not a failed redemption", async () => {
    for (let i = 0; i < 6; i++) {
      assert.equal((await send(bridge, { method: "POST", path: "/session", body: { code: "wrong" }, headers: { Origin: "http://evil.example" } })).status, 403);
      assert.equal((await send(bridge, { method: "POST", path: "/session", body: { code: "wrong" }, headers: { Origin: origin(bridge), "Content-Type": "text/plain" } })).status, 403);
      assert.equal((await send(bridge, { method: "POST", path: "/session", body: { code: "wrong" }, headers: { Origin: origin(bridge) }, host: "evil.example" })).status, 403);
    }
    assert.equal((await redeem(bridge, CODE)).status, 200, "a cross-site page must not be able to burn the user's code");
  });

  test("a foreign Origin with the right code gets no token", async () => {
    const res = await send(bridge, { method: "POST", path: "/session", body: { code: CODE }, headers: { Origin: "http://evil.example" } });
    assert.equal(res.status, 403);
    assert.equal((await redeem(bridge, CODE)).status, 200, "and the code is still good for the real UI");
  });
});

describe("four-session cap", () => {
  test("four sessions are allowed, each token works, and the fifth redemption is refused with 429", async () => {
    const tokens = [await login(bridge)];
    for (let i = 0; i < 3; i++) tokens.push(await login(bridge, bridge.newLaunchCode()));
    assert.equal(new Set(tokens).size, 4);

    const fifth = await redeem(bridge, bridge.newLaunchCode());
    assert.equal(fifth.status, 429);
    assert.equal(fifth.body?.token, undefined);

    // Refusing the fifth takes nothing away from the four that are live.
    for (const [i, t] of tokens.entries()) {
      const res = await send(bridge, { method: "POST", path: "/requests", body: { kind: "dispatch-reject", ref: DISPATCH_REF }, headers: authed(bridge, t) });
      assert.notEqual(res.status, 401, `session ${i} was dropped`);
      assert.notEqual(res.status, 403, `session ${i} was dropped`);
    }
  });
});

describe("newLaunchCode", () => {
  test("returns a fresh code of at least 43 URL-safe characters that redeems once", async () => {
    const code = bridge.newLaunchCode();
    assert.notEqual(code, CODE);
    assert.match(code, /^[A-Za-z0-9_-]{43,}$/);
    assert.equal((await redeem(bridge, code)).status, 200);
    assert.equal((await redeem(bridge, code)).status, 401);
  });
});

describe("the launch code and token never appear in logs", () => {
  test("nothing the bridge sends to the console during its life contains the code or a token (stdio is checked on the real entry point below)", async () => {
    const seen = [];
    const spies = ["log", "info", "warn", "error", "debug"].map((m) => mock.method(console, m, (...a) => seen.push(a.map(String).join(" "))));
    let token;
    try {
      const b = await startAt();
      try {
        await redeem(b, "wrong-guess");
        token = await login(b);
        await redeem(b, CODE); // reuse
        await placeRequest(b, token);
        await send(b, { method: "POST", path: "/requests", body: { kind: "dispatch-approve", ref: DISPATCH_REF }, headers: { Origin: origin(b), Authorization: "Bearer not-it" } });
        await send(b, { method: "POST", path: "/requests", body: "{broken", headers: authed(b, token) });
      } finally {
        await b.close();
      }
    } finally {
      for (const s of spies) s.mock.restore();
    }
    const all = seen.join("\n");
    assert.ok(!all.includes(CODE), "the launch code was logged");
    assert.ok(!all.includes(token), "a session token was logged");
  });
});

// ---- the production entry point -------------------------------------------------------------------------------
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function startChild({ env = {}, args = [] } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, ...args], {
    // Its own state folder: with the caller's, the child bridge's delivery runner sweeps the live den's previews (F31).
    env: { ...process.env, DEN_ROOT: fx.root, PORT: String(port), DEN_STATE_DIR: path.join(fx.root, ".den-state"), XDG_STATE_HOME: path.join(fx.root, ".state"), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  child.stdout.on("data", (c) => (text += c));
  child.stderr.on("data", (c) => (text += c));
  const deadline = Date.now() + 20_000;
  while (!/#code=/.test(text)) {
    if (child.exitCode !== null) throw new Error(`bridge exited early: ${text}`);
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`no launch URL printed in 20s: ${text}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const m = text.match(/http:\/\/127\.0\.0\.1:(\d+)\/#code=([A-Za-z0-9_-]+)/);
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    });
  return { port, url: m?.[0], code: m?.[2], logs: () => text, stop, bridge: { port }, child };
}

describe("the production entry point (node apps/bridge/server.mjs)", () => {
  test("prints one launch URL with a fresh code in the fragment, and that code redeems", async () => {
    const c = await startChild();
    try {
      assert.ok(c.url, `no launch URL in: ${c.logs()}`);
      assert.equal(c.url, `http://127.0.0.1:${c.port}/#code=${c.code}`);
      assert.ok(c.code.length >= 43, "32 random bytes");
      const res = await redeem(c.bridge, c.code);
      assert.equal(res.status, 200);
      assert.equal((await redeem(c.bridge, c.code)).status, 401, "burned on first use");
    } finally {
      await c.stop();
    }
  });

  test("two starts print two different codes", async () => {
    const a = await startChild();
    const b = await startChild();
    try {
      assert.notEqual(a.code, b.code);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  // F39 (npm run den:link): a fresh link without a restart. Only the user's own account can signal the process (a run's
  // agent is in a pid namespace of its own), and the link goes to the same console the first one did.
  test("SIGUSR2 prints one more launch URL with a new code, which redeems once", async () => {
    const c = await startChild();
    try {
      const before = c.logs();
      process.kill(c.child.pid, "SIGUSR2");
      const deadline = Date.now() + 10_000;
      while ((c.logs().match(/#code=/g) ?? []).length < 2) {
        if (Date.now() > deadline) throw new Error(`no second launch URL: ${c.logs()}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      const fresh = c.logs().slice(before.length).match(/http:\/\/127\.0\.0\.1:(\d+)\/#code=([A-Za-z0-9_-]+)/);
      assert.ok(fresh, "the new line has the launch URL's shape");
      assert.notEqual(fresh[2], c.code);
      assert.equal((await redeem(c.bridge, fresh[2])).status, 200);
      assert.equal((await redeem(c.bridge, fresh[2])).status, 401, "burned on first use");
    } finally {
      await c.stop();
    }
  });

  test("the code is printed exactly once, and neither it nor a token is logged afterwards", async () => {
    const c = await startChild();
    try {
      await redeem(c.bridge, "wrong-guess");
      const token = await login(c.bridge, c.code);
      await send(c.bridge, { method: "POST", path: "/requests", body: "{broken", headers: authed(c.bridge, token) });
      await send(c.bridge, { method: "POST", path: "/requests", body: {}, headers: { Origin: origin(c.bridge), Authorization: "Bearer not-it" } });
      await new Promise((r) => setTimeout(r, 200));
      const logs = c.logs();
      assert.equal(logs.split(c.code).length - 1, 1, "the launch code appears once (the launch URL) and nowhere else");
      assert.ok(!logs.includes(token), "a session token was logged");
    } finally {
      await c.stop();
    }
  });

  test("nothing disables or presets the gate: no env var, flag or field supplies a token or code or turns auth off", async () => {
    const c = await startChild({
      env: {
        DEN_AUTH: "off", DEN_NO_AUTH: "1", NO_AUTH: "1", AUTH_DISABLED: "1", BRIDGE_AUTH: "off", DISABLE_AUTH: "true",
        DEN_TOKEN: PRESET_TOKEN, BRIDGE_TOKEN: PRESET_TOKEN, TOKEN: PRESET_TOKEN, SESSION_TOKEN: PRESET_TOKEN,
        DEN_LAUNCH_CODE: "preset-code", LAUNCH_CODE: "preset-code", BRIDGE_LAUNCH_CODE: "preset-code",
      },
      args: ["--no-auth", `--token=${PRESET_TOKEN}`, "--launch-code=preset-code", "--auth=off"],
    });
    try {
      assert.notEqual(c.code, "preset-code", "the launch code is never supplied from outside");
      const body = { kind: "dispatch-approve", ref: DISPATCH_REF };
      assert.equal((await send(c.bridge, { method: "POST", path: "/requests", body, headers: { Origin: origin(c.bridge) } })).status, 401);
      assert.equal((await send(c.bridge, { method: "POST", path: "/requests", body, headers: { Origin: origin(c.bridge), Authorization: `Bearer ${PRESET_TOKEN}` } })).status, 401);
      assert.equal((await redeem(c.bridge, "preset-code")).status, 401);
      assert.equal((await redeem(c.bridge, c.code)).status, 200, "the printed code still works");
    } finally {
      await c.stop();
    }
  });

  test("startBridge ignores an auth option carrying a flag that would disable the gate or preset a token", async () => {
    const b = await startAt({ disabled: true, enabled: false, token: PRESET_TOKEN, sessionToken: PRESET_TOKEN, disable: true });
    try {
      const body = { kind: "dispatch-approve", ref: DISPATCH_REF };
      assert.equal((await send(b, { method: "POST", path: "/requests", body, headers: { Origin: origin(b) } })).status, 401);
      assert.equal((await send(b, { method: "POST", path: "/requests", body, headers: { Origin: origin(b), Authorization: `Bearer ${PRESET_TOKEN}` } })).status, 401);
    } finally {
      await b.close();
    }
  });
});
