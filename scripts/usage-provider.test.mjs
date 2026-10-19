// Ticket 81: exercise the public CLI against a real, local app-server substitute.
// No installed Codex session, credential file or external network is consulted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const USAGE = fileURLToPath(new URL("./usage.mjs", import.meta.url));
const SECRET = ["synthetic", "secret", "must", "not", "escape"].join("-");
const five = { usedPercent: 53.4, windowDurationMins: 300, resetsAt: 1790800000 };
const week = { usedPercent: 21.7, windowDurationMins: 10080, resetsAt: 1791200000 };
const codex = (primary = five, secondary = week) => ({ limitId: "codex", limitName: "Codex", primary, secondary });
const EXPECTED = {
  "5-hour": { percent: 53, resets_at: "2026-09-30T20:26:40.000Z", resets_local: "2026-09-30 13:26 PDT" },
  weekly: { percent: 22, resets_at: "2026-10-05T11:33:20.000Z", resets_local: "2026-10-05 04:33 PDT" },
};

const FAKE_CLI = `#!${process.execPath}
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
writeFileSync(process.env.FAKE_PID, String(process.pid));
appendFileSync(process.env.FAKE_TRACE, JSON.stringify({argv:process.argv.slice(2), tmpdir:process.env.TMPDIR})+'\\n');
const fixture=JSON.parse(process.env.FAKE_RESPONSE);
const mode=process.env.FAKE_MODE;
const send=(obj)=>process.stdout.write(JSON.stringify(obj)+'\\n');
let initialized=false, greeted=false;
if (!process.argv.includes('app-server')) process.exit(9);
// Simulate runtime SQLite state using the supported sqlite_home config override.
// A dedicated child TMPDIR is also a valid isolation choice.
const sqliteArg=process.argv.find(arg=>arg.startsWith('sqlite_home='));
const stateDir=sqliteArg ? sqliteArg.slice('sqlite_home='.length).replace(/^"|"$/g,'') : process.env.TMPDIR;
mkdirSync(stateDir,{recursive:true});
writeFileSync(path.join(stateDir,'fixture.sqlite'),'synthetic runtime state');
if(mode==='exit') { process.stderr.write('${SECRET} https://private.example/credential\\n'); process.exit(7); }
const input=createInterface({input:process.stdin});
input.on('line',line=>{
  const req=JSON.parse(line);
  appendFileSync(process.env.FAKE_TRACE, JSON.stringify(req)+'\\n');
  if(req.method==='initialize') {
    if(!req.params?.clientInfo?.name) { send({id:req.id,error:{code:-32602,message:'clientInfo required'}}); return; }
    if(mode==='hang-initialize') return;
    greeted=true; send({id:req.id,result:{userAgent:'fake-codex/1'}}); return;
  }
  if(req.method==='initialized') { initialized=greeted; return; }
  if(req.method==='account/rateLimits/read') {
    if(!initialized) { send({id:req.id,error:{code:-32000,message:'not initialized'}}); return; }
    if(mode==='hang-read') return;
    if(mode==='rpc-error') { send({id:req.id,error:{code:-32001,message:'${SECRET} https://private.example/credential',data:{token:'${SECRET}'}}}); return; }
    if(mode==='malformed-json') { process.stdout.write('{untrusted ${SECRET}\\n'); return; }
    // Noise and a mismatched response must never be mistaken for this result.
    send({method:'account/rateLimits/updated',params:{rateLimits:{primary:{usedPercent:99}}}});
    send({id:'unrelated-id',result:{rateLimits: {primary:{usedPercent:99}}}});
    send({id:req.id,result:fixture}); return;
  }
  send({id:req.id,error:{code:-32601,message:'unexpected method'}});
});
`;

function fixtureRun(args, { response = { rateLimits: codex() }, mode = "ok", claude = false, remote = false, selfCheck = false, timeout } = {}) {
  // organism-infra/104: the adapter deadline starts when the app-server spawns, so 1 s made every success test flake
  // when the machine was busy. Only the hang modes need a short deadline (they assert the deadline is honored).
  timeout ??= mode.startsWith("hang") ? "1000" : "20000";
  const root = mkdtempSync(path.join(tmpdir(), "usage-provider-"));
  const bin = path.join(root, "bin");
  const runtime = path.join(root, "runtime");
  mkdirSync(bin); mkdirSync(runtime);
  const trace = path.join(root, "trace.jsonl");
  const pidfile = path.join(root, "pid");
  const fetched = path.join(root, "fetches");
  const preload = path.join(root, "preload.mjs");
  writeFileSync(path.join(bin, "codex"), FAKE_CLI, { mode: 0o755 });
  if (mode === "missing-cli") rmSync(path.join(bin, "codex"));
  if (claude) {
    mkdirSync(path.join(root, ".claude"));
    writeFileSync(path.join(root, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }));
  }
  writeFileSync(preload, `import {appendFileSync} from 'node:fs';
globalThis.fetch=async(url)=>{appendFileSync(${JSON.stringify(fetched)},String(url)+'\\n');
if(!${JSON.stringify(claude)}) throw new Error('network forbidden in Codex fixture');
return new Response(JSON.stringify({five_hour:{utilization:53.4,resets_at:'2026-09-30T20:26:40.000Z'},seven_day:{utilization:21.7,resets_at:'2026-10-05T11:33:20.000Z'}}));};`);
  // Only the fixture bin is searched: a missing CLI must never find the real Codex.
  const env = { ...process.env, TZ: "America/Los_Angeles", HOME: root, USERPROFILE: root, PATH: bin, TMPDIR: runtime,
    FAKE_TRACE: trace, FAKE_PID: pidfile, FAKE_RESPONSE: JSON.stringify(response), FAKE_MODE: mode, USAGE_CODEX_TIMEOUT_MS: timeout };
  delete env.CLAUDE_CODE_REMOTE;
  delete env.CODEX_HOME;
  if (remote) env.CLAUDE_CODE_REMOTE = "1";
  try {
    const started = Date.now();
    const selfInput = [
      { id: 1, method: "initialize", params: { clientInfo: { name: "fixture-validation", version: "1" } } },
      { method: "initialized" },
      { id: 2, method: "account/rateLimits/read" },
    ].map(JSON.stringify).join("\n") + "\n";
    const r = spawnSync(process.execPath, selfCheck ? [path.join(bin, "codex"), "app-server"] : ["--import", pathToFileURL(preload).href, USAGE, ...args], {
      env, encoding: "utf8", timeout: 20000, ...(selfCheck ? { input: selfInput } : {}),
    });
    const elapsed = Date.now() - started;
    const exchanges = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse) : [];
    let childAlive = false;
    if (existsSync(pidfile)) {
      try { process.kill(Number(readFileSync(pidfile, "utf8")), 0); childAlive = true; } catch (e) { if (e.code !== "ESRCH") throw e; }
    }
    return { ...r, elapsed, exchanges, childAlive, leftovers: readdirSync(runtime), fetched: existsSync(fetched) };
  } finally {
    // A broken adapter must fail cleanup assertions without leaking test children.
    if (existsSync(pidfile)) {
      try { process.kill(Number(readFileSync(pidfile, "utf8")), "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function assertUsage(r) {
  assert.equal(r.error, undefined, "CLI must finish inside the test deadline");
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.deepEqual(body["5-hour"], EXPECTED["5-hour"]);
  assert.deepEqual(body.weekly, EXPECTED.weekly);
}
function assertClean(r) {
  assert.equal(r.childAlive, false, "app-server child must be reaped before CLI returns");
  assert.deepEqual(r.leftovers, [], "temporary app-server state must be removed");
  assert.equal(r.fetched, false, "Codex must not call the Claude endpoint");
}
function assertUnavailable(r) {
  assert.equal(r.error, undefined, "adapter must enforce its own deadline");
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout.trim(), "", "failure must not publish usage, estimates or stale data");
  assert.match(r.stderr, /codex/i, "diagnostic must identify the failing provider");
  assert.doesNotMatch(r.stderr, /synthetic-secret|private\.example/);
  assertClean(r);
}

test("local app-server fixture completes a valid initialization and quota exchange", () => {
  const r = fixtureRun([], { selfCheck: true });
  assert.equal(r.status, 0, r.stderr);
  const messages = r.stdout.trim().split("\n").map(JSON.parse);
  assert.deepEqual(messages.find(x => x.id === 2).result, { rateLimits: codex() });
  assert.equal(r.childAlive, false);
  assert.deepEqual(r.leftovers, ["fixture.sqlite"], "fixture actually creates temporary runtime state");
  assert.equal(r.fetched, false);
});

test("legacy and explicit Claude invocations preserve canonical usage output", () => {
  assertUsage(fixtureRun([], { claude: true }));
  assertUsage(fixtureRun(["--provider", "claude"], { claude: true }));
});

for (const args of [["--provider", "gemini"], ["--provider"], ["--provider", "codex", "--unexpected"]]) {
  test(`invalid provider arguments (${args.join(" ")}) fail before contacting an adapter`, () => {
    const r = fixtureRun(args, { claude: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /provider|argument|option|usage/i);
    assert.equal(r.fetched, false);
    assert.deepEqual(r.exchanges, []);
    assert.equal(r.stdout.trim(), "");
  });
}

test("Codex initializes its app-server and reads live rate limits without Claude credentials", () => {
  const r = fixtureRun(["--provider", "codex"]);
  assertUsage(r);
  assert.deepEqual(r.exchanges.filter(x => x.method).map(x => x.method), ["initialize", "initialized", "account/rateLimits/read"]);
  assertClean(r);
});

test("Codex chooses windows by duration when primary and secondary are swapped", () => {
  const r = fixtureRun(["--provider", "codex"], { response: { rateLimits: codex(week, five) } });
  assertUsage(r); assertClean(r);
});

test("Codex map selection ignores default and unrelated product limits", () => {
  const other = { limitId: "other-product", limitName: "Other", primary: { ...five, usedPercent: 99 }, secondary: { ...week, usedPercent: 99 } };
  const r = fixtureRun(["--provider", "codex"], { response: { rateLimits: other, rateLimitsByLimitId: { "other-product": other, codex: codex() } } });
  assertUsage(r); assertClean(r);
});

const UNKNOWN_WINDOW = { percent: null, resets_at: null, resets_local: null };
const singleWindows = [
  ["weekly primary with null secondary", { primary: week, secondary: null }, "weekly"],
  ["weekly secondary with null primary", { primary: null, secondary: week }, "weekly"],
  ["weekly primary with omitted secondary", { primary: week }, "weekly"],
  ["five-hour primary with null secondary", { primary: five, secondary: null }, "5-hour"],
  ["five-hour secondary with null primary", { primary: null, secondary: five }, "5-hour"],
  ["five-hour primary with omitted secondary", { primary: five }, "5-hour"],
];
for (const [name, windows, present] of singleWindows) {
  test(`Codex accepts ${name} and reports the absent window as unknown`, () => {
    // Match the Pro account's named-limit map, and prove duration, not slot, selects the window.
    const response = { rateLimitsByLimitId: { codex: { limitId: "codex", planType: "pro", ...windows } } };
    const r = fixtureRun(["--provider", "codex"], { response, remote: true });
    assert.equal(r.error, undefined, "CLI must finish inside the test deadline");
    assert.equal(r.status, 0, r.stderr);
    const absent = present === "weekly" ? "5-hour" : "weekly";
    assert.deepEqual(JSON.parse(r.stdout), {
      provider: "codex", source: "account/rateLimits/read",
      [present]: EXPECTED[present], [absent]: UNKNOWN_WINDOW,
    });
    assert.deepEqual(r.exchanges.filter(x => x.method).map(x => x.method), ["initialize", "initialized", "account/rateLimits/read"]);
    assertClean(r);
  });
}

test("Codex two-window canonical JSON stays byte-compatible", () => {
  const r = fixtureRun(["--provider", "codex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, JSON.stringify({ provider: "codex", source: "account/rateLimits/read", ...EXPECTED }) + "\n");
  assertClean(r);
});

const invalid = {
  "both null windows": { rateLimits: codex(null, null) },
  "both omitted windows": { rateLimits: { limitId: "codex" } },
  "empty window beside a valid weekly window": { rateLimits: codex({}, week) },
  "false window beside a valid weekly window": { rateLimits: codex(false, week) },
  "array window beside a valid weekly window": { rateLimits: codex([], week) },
  "string window beside a valid weekly window": { rateLimits: codex(SECRET, week) },
  "unsupported duration": { rateLimits: codex({ ...five, windowDurationMins: 60 }) },
  "unsupported single window": { rateLimits: codex({ ...five, windowDurationMins: 60 }, null) },
  "string duration": { rateLimits: codex({ ...five, windowDurationMins: "300" }) },
  "duplicate five-hour windows": { rateLimits: codex(five, five) },
  "duplicate weekly windows": { rateLimits: codex(week, week) },
  "string percent": { rateLimits: codex({ ...five, usedPercent: "53" }) },
  "null percent in a single window": { rateLimits: codex({ ...five, usedPercent: null }, null) },
  "out-of-range percent": { rateLimits: codex({ ...five, usedPercent: 101 }) },
  "negative percent": { rateLimits: codex({ ...five, usedPercent: -1 }) },
  "invalid reset": { rateLimits: codex({ ...five, resetsAt: "tomorrow" }) },
  "zero reset in a single window": { rateLimits: codex({ ...five, resetsAt: 0 }, null) },
  "out-of-range reset": { rateLimits: codex({ ...five, resetsAt: Number.MAX_VALUE }) },
  "missing reset": { rateLimits: codex({ usedPercent: 53, windowDurationMins: 300 }) },
  "only unrelated limit": { rateLimits: { ...codex(), limitId: "other-product", limitName: "Other" } },
  "empty result": {},
};
for (const [name, response] of Object.entries(invalid)) {
  test(`Codex rejects ${name} instead of publishing misleading usage`, () => {
    const r = fixtureRun(["--provider", "codex"], { response, remote: true });
    assert.ok(r.exchanges.some(x => x.method === "account/rateLimits/read"), "failure must follow a real protocol exchange");
    assertUnavailable(r);
  });
}

for (const mode of ["rpc-error", "exit", "malformed-json", "hang-initialize", "hang-read"]) {
  test(`Codex ${mode} is bounded, sanitized and cleans up its subprocess`, () => {
    const r = fixtureRun(["--provider", "codex"], { mode, remote: true });
    assert.ok(r.exchanges.length > 0, "fake app-server must actually launch");
    assertUnavailable(r);
    if (mode.startsWith("hang")) {
      // 8 s, not 3.5 s: process startup under load adds to the 1 s deadline, but still sits well under the 10 s
      // adapter default, so a deadline that ignored USAGE_CODEX_TIMEOUT_MS would still fail here.
      assert.ok(r.elapsed < 8000, `adapter deadline was not honored (${r.elapsed}ms)`);
      assert.match(r.stderr, /timeout|timed out|deadline/i);
    }
  });
}

test("missing Codex executable is unavailable without any Claude estimate fallback", () => {
  assertUnavailable(fixtureRun(["--provider", "codex"], { mode: "missing-cli", remote: true }));
});

for (const timeout of ["-1", "0", "forever", "1000000000"]) {
  test(`Codex refuses unbounded or invalid timeout ${timeout}`, () => {
    const r = fixtureRun(["--provider", "codex"], { timeout });
    assertUnavailable(r);
    assert.match(r.stderr, /timeout|deadline/i);
    assert.deepEqual(r.exchanges, [], "invalid deadline must fail before starting Codex");
  });
}
