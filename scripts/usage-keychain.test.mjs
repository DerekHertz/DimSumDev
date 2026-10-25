// organism-infra/134: usage-watch reads live Claude usage on macOS as well as WSL.
// Public interface under test: `node scripts/usage.mjs` (the status line no longer starts it, hardening/17).
// No real Keychain, credential file or network is touched: HOME points at an
// empty temp dir, PATH holds no `security`, fetch is replaced through a --import preload.
//
// Env seams this file pins (names are the contract the developer implements, like NOTIFY_POWERSHELL):
//   USAGE_PLATFORM            overrides process.platform for token-source selection (darwin|linux|win32)
//   USAGE_SECURITY_BIN        the `security` binary (default "security"); tests point it at a fake
//   USAGE_SECURITY_TIMEOUT_MS bound on the Keychain read (default is the developer's choice, under 10 s)
//
// Keychain payload shape (confirmed on the user's Mac, 2026-10-04; structure only, no values):
//   {"claudeAiOauth":{"accessToken":str,"refreshToken":str,"expiresAt":num,"refreshTokenExpiresAt":num,
//    "scopes":[...],"subscriptionType":str,"rateLimitTier":str},"mcpOAuth":{"<server>":{"accessToken":str,...}}}
// i.e. the same claudeAiOauth.accessToken as ~/.claude/.credentials.json, plus other tokens that must
// never be sent or printed.
//
// Criterion -> test map: see the "AC" tags in each test name.
//   AC1 file unchanged        -> existing usage-401 / usage-provider tests, plus "AC1" below
//   AC2 darwin Keychain       -> "AC2" tests
//   AC3 injectable fake       -> every test here (HOME/PATH isolation; the fake records its calls)
//   AC4 failure paths         -> "AC4" tests
//   AC5 token never leaks     -> "AC5" tests, and the leak assertions inside every AC4 test
//   AC6 native Windows        -> "AC6" test (pins: fails with the same clear message; supporting it
//                                means changing this test deliberately)
//   AC8 gated-file wording    -> human-verified (developer writes the edit into its handoff)
//   "reports which source answered" -> human-verified (no output-contract change; internal to the lookup)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const USAGE = path.join(ROOT, "scripts", "usage.mjs");

// Synthetic values, built so the literals never look like real credentials.
const TOKEN = ["keychain", "access", "token", "synthetic"].join("-");
const REFRESH = ["keychain", "refresh", "token", "synthetic"].join("-");
const MCP = ["keychain", "mcp", "token", "synthetic"].join("-");
const FILE_TOKEN = ["file", "access", "token", "synthetic"].join("-");
const SECRETS = [TOKEN, REFRESH, MCP];
const SERVICE = "Claude Code-credentials";

const API = {
  five_hour: { utilization: 53.4, resets_at: "2026-09-30T20:26:40.000Z" },
  seven_day: { utilization: 21.7, resets_at: "2026-10-05T11:33:20.000Z" },
};
const EXPECTED = {
  // organism-infra/167 (ticket criterion 3): a live reading also carries source and age_s.
  source: "live",
  age_s: 0,
  "5-hour": { percent: 53, resets_at: "2026-09-30T20:26:40.000Z", resets_local: "2026-09-30 13:26 PDT" },
  weekly: { percent: 22, resets_at: "2026-10-05T11:33:20.000Z", resets_local: "2026-10-05 04:33 PDT" },
};

const PAYLOAD = JSON.stringify({
  claudeAiOauth: { accessToken: TOKEN, refreshToken: REFRESH, expiresAt: 1790000000000, refreshTokenExpiresAt: 1799999999999, scopes: ["user:inference"], subscriptionType: "max", rateLimitTier: "default" },
  mcpOAuth: { "plugin:design:figma|0000": { serverName: "figma", serverUrl: "https://example.invalid/mcp", accessToken: MCP } },
});

// Stands in for macOS `security`. Modes: ok | missing | denied | non-json | no-token | hang.
// Every mode that prints puts the secrets on stdout/stderr, so a leak by the adapter is detectable.
const FAKE_SECURITY = `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
writeFileSync(process.env.FAKE_PID, String(process.pid));
appendFileSync(process.env.FAKE_TRACE, JSON.stringify(process.argv.slice(2)) + '\\n');
const mode = process.env.FAKE_MODE;
const payload = process.env.FAKE_PAYLOAD;
if (mode === 'ok') { process.stdout.write(payload + '\\n'); process.exit(0); }
if (mode === 'missing') { process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n'); process.exit(44); }
if (mode === 'denied') { process.stderr.write('security: SecKeychainItemCopyContent: User interaction is not allowed. ' + payload + '\\n'); process.exit(36); }
if (mode === 'non-json') { process.stdout.write('{"claudeAiOauth":{"accessToken":"' + process.env.FAKE_LEAK + '" -- truncated, not json\\n'); process.exit(0); }
if (mode === 'no-token') { process.stdout.write(JSON.stringify({ claudeAiOauth: { refreshToken: process.env.FAKE_LEAK }, mcpOAuth: {} }) + '\\n'); process.exit(0); }
if (mode === 'hang') { setTimeout(() => {}, 60000); }
`;

function run({
  platform = "darwin",
  mode = "ok",
  file = null, // token to put in ~/.claude/.credentials.json, or null for no file
  fetchStatus = 200,
  args = [],
  timeoutMs = "1000",
  noOverride = false,
} = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "usage-keychain-")));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const fake = path.join(bin, "fake-security");
  const trace = path.join(root, "trace.jsonl");
  const pidfile = path.join(root, "pid");
  const fetched = path.join(root, "fetches.jsonl");
  const preload = path.join(root, "preload.mjs");
  writeFileSync(fake, FAKE_SECURITY, { mode: 0o755 });
  if (file) {
    mkdirSync(path.join(root, ".claude"));
    writeFileSync(path.join(root, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: file } }));
  }
  writeFileSync(
    preload,
    `import {appendFileSync} from 'node:fs';
globalThis.fetch = async (url, init) => {
  appendFileSync(${JSON.stringify(fetched)}, JSON.stringify({ url: String(url), headers: init?.headers ?? {}, body: init?.body ?? null }) + '\\n');
  return new Response(${JSON.stringify(JSON.stringify(API))}, { status: ${fetchStatus} });
};`,
  );
  // PATH holds an empty dir: the real `security` can never be found, so only the override can answer.
  const empty = path.join(root, "empty");
  mkdirSync(empty);
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    PATH: empty,
    TZ: "America/Los_Angeles", // resets_local is pinned to a fixed zone (ticket 157)
    USAGE_PLATFORM: platform,
    FAKE_TRACE: trace,
    FAKE_PID: pidfile,
    FAKE_MODE: mode,
    FAKE_PAYLOAD: PAYLOAD,
    FAKE_LEAK: TOKEN,
    USAGE_SECURITY_TIMEOUT_MS: timeoutMs,
  };
  if (!noOverride) env.USAGE_SECURITY_BIN = fake;
  delete env.CLAUDE_CODE_REMOTE;
  try {
    const started = Date.now();
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, USAGE, ...args], { env, encoding: "utf8", timeout: 20000 });
    const elapsed = Date.now() - started;
    const calls = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    const fetches = existsSync(fetched) ? readFileSync(fetched, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    let childAlive = false;
    if (existsSync(pidfile)) {
      try { process.kill(Number(readFileSync(pidfile, "utf8")), 0); childAlive = true; } catch (e) { if (e.code !== "ESRCH") throw e; }
    }
    return { ...r, elapsed, calls, fetches, childAlive };
  } finally {
    if (existsSync(pidfile)) {
      try { process.kill(Number(readFileSync(pidfile, "utf8")), "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const noLeak = (r, secrets = SECRETS) => {
  for (const s of secrets) {
    assert.ok(!(r.stdout ?? "").includes(s), "a secret reached stdout");
    assert.ok(!(r.stderr ?? "").includes(s), "a secret reached stderr");
  }
};

function assertFailsWithDiagnostic(r, platform) {
  assert.equal(r.error, undefined, "CLI must finish inside the test deadline");
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout.trim(), "", "failure must not print usage");
  assert.match(r.stderr, /^usage: /m, "diagnostic must use the `usage:` prefix");
  assert.ok(r.stderr.includes(platform), `diagnostic must name the platform (${platform}): ${r.stderr}`);
  assert.equal(r.fetches.length, 0, "no request may be sent when no token was read");
  noLeak(r);
}

test("AC1: on darwin with the credentials file present, the file token is used and the Keychain is never asked", () => {
  const r = run({ platform: "darwin", file: FILE_TOKEN });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), EXPECTED);
  assert.deepEqual(r.calls, [], "the Keychain must not be read when the file answered");
  assert.equal(r.fetches.length, 1);
  assert.equal(r.fetches[0].headers.Authorization, `Bearer ${FILE_TOKEN}`);
});

test("AC1: on linux with the credentials file present, output is unchanged and the Keychain is never asked", () => {
  const r = run({ platform: "linux", file: FILE_TOKEN });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), EXPECTED);
  assert.deepEqual(r.calls, []);
});

test("AC2: on darwin with no credentials file, the Keychain token is used and the canonical JSON is printed", () => {
  const r = run({ platform: "darwin" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), EXPECTED);
  assert.equal(r.calls.length, 1, "the Keychain is read exactly once");
  assert.ok(r.calls[0].includes(SERVICE), `the read must name the service ${SERVICE}: ${JSON.stringify(r.calls[0])}`);
  assert.ok(r.calls[0].includes("find-generic-password"), "reads with `security find-generic-password`");
});

test("AC2: the legacy and explicit --provider claude invocations both read the Keychain on darwin", () => {
  assert.deepEqual(JSON.parse(run({ args: ["--provider", "claude"] }).stdout), EXPECTED);
});

test("AC5: the token is sent only to api.anthropic.com, as the bearer for the usage call; other Keychain tokens are never sent", () => {
  const r = run({ platform: "darwin" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.fetches.length, 1, "exactly one request");
  assert.equal(new URL(r.fetches[0].url).hostname, "api.anthropic.com");
  assert.equal(r.fetches[0].headers.Authorization, `Bearer ${TOKEN}`);
  const sent = JSON.stringify(r.fetches[0]);
  assert.ok(!sent.includes(REFRESH), "the refresh token must never be sent");
  assert.ok(!sent.includes(MCP), "MCP server tokens must never be sent");
  assert.equal(r.fetches[0].body, null, "no token in a request body");
  noLeak(r);
});

test("AC5: the token is never passed on a command line (Keychain read and the usage process)", () => {
  const r = run({ platform: "darwin" });
  assert.equal(r.status, 0, r.stderr);
  for (const argv of r.calls) for (const s of SECRETS) assert.ok(!argv.join(" ").includes(s), "a secret is on the security command line");
  noLeak(r);
});

test("AC5: after a Keychain success followed by an HTTP failure, no secret reaches stdout or stderr", () => {
  for (const status of [401, 500]) {
    const r = run({ platform: "darwin", fetchStatus: status });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^usage: /m);
    noLeak(r);
  }
  assert.match(run({ platform: "darwin", fetchStatus: 401 }).stderr, /claude \/login/, "the 401 hint still works on the Keychain path");
});

for (const mode of ["missing", "denied", "non-json", "no-token"]) {
  test(`AC4: a Keychain read that ends as '${mode}' exits 1 with a darwin diagnostic, no request and no secret in the output`, () => {
    const r = run({ platform: "darwin", mode });
    assert.equal(r.calls.length, 1, "the fake Keychain must actually have been asked");
    assertFailsWithDiagnostic(r, "darwin");
  });
}

test("AC4: a hanging Keychain prompt times out, exits 1 with a darwin diagnostic, and the child is reaped", () => {
  const r = run({ platform: "darwin", mode: "hang", timeoutMs: "1000" });
  assert.equal(r.calls.length, 1, "the fake Keychain must actually have been asked");
  assertFailsWithDiagnostic(r, "darwin");
  assert.ok(r.elapsed < 8000, `the Keychain deadline was not honored (${r.elapsed}ms)`);
  assert.match(r.stderr, /timeout|timed out|deadline/i);
  assert.equal(r.childAlive, false, "the hung `security` child must be killed");
});

test("AC4: a missing `security` binary (override points at nothing) exits 1 with a darwin diagnostic", () => {
  const r = run({ platform: "darwin" });
  // Re-run with the override pointing at a path that does not exist.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "usage-keychain-missing-")));
  try {
    const empty = path.join(root, "empty");
    mkdirSync(empty);
    const env = { ...process.env, HOME: root, USERPROFILE: root, PATH: empty, USAGE_PLATFORM: "darwin", USAGE_SECURITY_BIN: path.join(root, "no-such-security"), USAGE_SECURITY_TIMEOUT_MS: "1000" };
    delete env.CLAUDE_CODE_REMOTE;
    const missing = spawnSync(process.execPath, [USAGE], { env, encoding: "utf8", timeout: 20000 });
    assert.equal(missing.status, 1, missing.stderr);
    assert.equal(missing.stdout.trim(), "");
    assert.match(missing.stderr, /^usage: /m);
    assert.ok(missing.stderr.includes("darwin"), missing.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(r.status, 0, "control run with the fake present still succeeds");
});

test("AC4: the darwin diagnostic names both sources tried (credentials file and Keychain)", () => {
  const r = run({ platform: "darwin", mode: "missing" });
  assert.match(r.stderr, /credentials\.json/);
  assert.match(r.stderr, /keychain/i);
});

test("AC4: on linux with no credentials file the failure names the platform and the file tried, and never calls the Keychain", () => {
  const r = run({ platform: "linux" });
  assertFailsWithDiagnostic(r, "linux");
  assert.match(r.stderr, /credentials\.json/);
  assert.deepEqual(r.calls, [], "the Keychain is a darwin-only source");
});

test("AC6: native Windows with no credentials file fails with the same clear message and never calls the Keychain (Windows is not supported by this ticket)", () => {
  const r = run({ platform: "win32" });
  assertFailsWithDiagnostic(r, "win32");
  assert.match(r.stderr, /credentials\.json/);
  assert.deepEqual(r.calls, []);
});

test("AC3: with the real platform and no override of the binary, a darwin run still never finds a real `security` (PATH is empty)", () => {
  // If the implementation ignored the override and spawned `security` by PATH, it would fail here
  // instead of reading the fake. This guards the isolation the other tests rely on.
  const r = run({ platform: "darwin", noOverride: true });
  assertFailsWithDiagnostic(r, "darwin");
  assert.deepEqual(r.calls, []);
});
