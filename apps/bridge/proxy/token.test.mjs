// hardening/11 (ADR 0031 decision 5): the login lives in the proxy; the bridge keeps the refresh token and refreshes before expiry.
// qa specify. Written before apps/bridge/proxy/token.mjs exists; every test here is red until it does. Offline: no Docker, no network, no real token.
//
// The seam, in apps/bridge/proxy/token.mjs (all injected, nothing global):
//   TOKEN_FILE_NAME                     "access-token": the one file the proxy reads, inside a directory the proxy container mounts read-only.
//   fileTokenSource({ file })           proxy side. .get() reads the file on EVERY call (that is how a refresh reaches the proxy with no restart),
//                                       returns the trimmed text, and rejects when the file is missing or empty (the error never quotes the contents).
//   createTokenRefresher({ store, refresh, dir, now, skewMs })   bridge side.
//       store.load()   -> { accessToken, refreshToken, expiresAt }   (expiresAt: ms since epoch)
//       store.save(c)  -> persists rotated credentials (the refresh token rotates)
//       refresh(refreshToken) -> Promise<{ accessToken, refreshToken, expiresAt }>
//       now() -> ms; skewMs defaults to 300000 (refresh when expiresAt - now <= skewMs)
//       .tick()   -> Promise<{ refreshed: boolean, expiresAt?: number, error?: string }>. Never rejects. Always leaves <dir>/access-token holding
//                    the current access token (writes it even when no refresh was due). Concurrent ticks share one refresh() call.
//       .start({ setTimer, clearTimer }) -> Promise (the first tick). Schedules the next tick with setTimer(fn, ms); .stop() clears it.
//   credentialsFileStore({ file })      a store over ~/.claude/.credentials.json shape ({ claudeAiOauth: { accessToken, refreshToken, expiresAt, ... } }).
//   oauthRefresh({ fetch, now, url?, clientId? }) -> refresh(refreshToken) over an injected fetch.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TOKEN_FILE_NAME, fileTokenSource, createTokenRefresher, credentialsFileStore, oauthRefresh } from "./token.mjs";

const A1 = ["sk-ant", "oat01-ACCESS-ONE"].join("-"); // built at runtime so the repo secret scan stays clean
const A2 = ["sk-ant", "oat01-ACCESS-TWO"].join("-"); // built at runtime so the repo secret scan stays clean
const A3 = ["sk-ant", "oat01-ACCESS-THREE"].join("-"); // built at runtime so the repo secret scan stays clean
const R1 = ["sk-ant", "ort01-REFRESH-ONE"].join("-"); // built at runtime so the repo secret scan stays clean
const R2 = ["sk-ant", "ort01-REFRESH-TWO"].join("-"); // built at runtime so the repo secret scan stays clean
const HOUR = 3_600_000;

let tmp;
beforeEach(async () => { tmp = await mkdtemp(path.join(tmpdir(), "den-token-")); });
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe("fileTokenSource (the proxy's side)", () => {
  test("reads the file on every call, so a rewrite reaches the proxy with no restart", async () => {
    const file = path.join(tmp, TOKEN_FILE_NAME);
    await writeFile(file, `${A1}\n`);
    const src = fileTokenSource({ file });
    assert.equal(await src.get(), A1);
    await writeFile(file, `${A2}\n`);
    assert.equal(await src.get(), A2);
  });

  test("a missing or empty file rejects, and the error never quotes file contents", async () => {
    const file = path.join(tmp, TOKEN_FILE_NAME);
    const src = fileTokenSource({ file });
    await assert.rejects(src.get());
    await writeFile(file, "  \n");
    await assert.rejects(src.get());
    await writeFile(file, A1);
    assert.equal(await src.get(), A1); // recovers once the bridge writes it
  });
});

describe("createTokenRefresher (the bridge's side)", () => {
  let clock, store, saved, refreshCalls, creds, refresh;
  const make = (over = {}) => createTokenRefresher({ store, refresh, dir: tmp, now: () => clock.t, ...over });
  beforeEach(() => {
    clock = { t: 1_000_000_000 };
    saved = [];
    refreshCalls = [];
    creds = { accessToken: A1, refreshToken: R1, expiresAt: clock.t + HOUR };
    store = { load: async () => ({ ...creds }), save: async (c) => { saved.push(c); creds = { ...c }; } };
    refresh = async (rt) => { refreshCalls.push(rt); return { accessToken: A2, refreshToken: R2, expiresAt: clock.t + 8 * HOUR }; };
  });

  test("a token with time left is written to the token file and not refreshed", async () => {
    const r = await make().tick();
    assert.equal(r.refreshed, false);
    assert.deepEqual(refreshCalls, []);
    assert.equal((await readFile(path.join(tmp, TOKEN_FILE_NAME), "utf8")).trim(), A1);
  });

  test("a token inside the skew window is refreshed before it expires, the file is rewritten and the rotated credentials saved", async () => {
    creds.expiresAt = clock.t + 4 * 60_000; // inside the default 5 minute skew, not yet expired
    const r = await make().tick();
    assert.equal(r.refreshed, true);
    assert.deepEqual(refreshCalls, [R1]);
    assert.equal((await readFile(path.join(tmp, TOKEN_FILE_NAME), "utf8")).trim(), A2);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].refreshToken, R2, "the rotated refresh token is persisted, or the next refresh fails");
    assert.equal(saved[0].accessToken, A2);
  });

  test("an already expired token is refreshed too; skewMs is honoured", async () => {
    creds.expiresAt = clock.t - 1000;
    assert.equal((await make().tick()).refreshed, true);
    creds = { accessToken: A1, refreshToken: R1, expiresAt: clock.t + 4 * 60_000 };
    refreshCalls.length = 0;
    assert.equal((await make({ skewMs: 60_000 }).tick()).refreshed, false, "4 minutes left is outside a 1 minute skew");
    assert.deepEqual(refreshCalls, []);
  });

  test("the token file holds the access token alone: never the refresh token; mode 0600; no stray files in the mounted directory", async () => {
    creds.expiresAt = clock.t;
    await make().tick();
    const file = path.join(tmp, TOKEN_FILE_NAME);
    const text = await readFile(file, "utf8");
    assert.ok(!text.includes(R1) && !text.includes(R2), "the refresh token stays with the bridge");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(tmp), [TOKEN_FILE_NAME]);
  });

  test("creates the token directory when it is missing (the bridge may tick before anything made it)", async () => {
    const dir = path.join(tmp, "not", "yet");
    await createTokenRefresher({ store, refresh, dir, now: () => clock.t }).tick();
    assert.equal((await readFile(path.join(dir, TOKEN_FILE_NAME), "utf8")).trim(), A1);
  });

  test("the file is replaced atomically (a new inode), because the proxy container mounts the directory and a reader must never see a half-written token", async () => {
    await make().tick();
    const before = (await stat(path.join(tmp, TOKEN_FILE_NAME))).ino;
    creds.expiresAt = clock.t;
    await make().tick();
    assert.notEqual((await stat(path.join(tmp, TOKEN_FILE_NAME))).ino, before);
    assert.deepEqual(await readdir(tmp), [TOKEN_FILE_NAME]);
  });

  test("a failed refresh keeps the old file, reports an error that quotes no token, and does not reject", async () => {
    await make().tick(); // file holds A1
    creds.expiresAt = clock.t;
    refresh = async (rt) => { throw new Error(`upstream said 400 for ${rt} and ${A1}`); };
    const r = await make().tick();
    assert.equal(r.refreshed, false);
    assert.equal(typeof r.error, "string");
    assert.ok(!r.error.includes(R1) && !r.error.includes(A1) && !r.error.includes(R2), "no token in the reported error");
    assert.equal((await readFile(path.join(tmp, TOKEN_FILE_NAME), "utf8")).trim(), A1);
    assert.deepEqual(saved, []);
  });

  test("concurrent ticks share one refresh call (a rotated refresh token is single use)", async () => {
    creds.expiresAt = clock.t;
    let release;
    const gate = new Promise((r) => { release = r; });
    refresh = async (rt) => { refreshCalls.push(rt); await gate; return { accessToken: A2, refreshToken: R2, expiresAt: clock.t + HOUR }; };
    const t = make();
    const both = Promise.all([t.tick(), t.tick()]);
    release();
    await both;
    assert.equal(refreshCalls.length, 1);
  });

  test("start() ticks at once, schedules the next tick before the expiry window opens, and the timer firing refreshes", async () => {
    const timers = [];
    const cleared = [];
    const setTimer = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
    const clearTimer = (h) => cleared.push(h);
    const t = make();
    await t.start({ setTimer, clearTimer });
    assert.equal(timers.length, 1);
    assert.ok(timers[0].ms > 0 && timers[0].ms <= HOUR - 300_000, `next tick (${timers[0].ms} ms) is due before the window opens`);
    assert.deepEqual(refreshCalls, []);

    clock.t += HOUR - 200_000; // now inside the window
    await timers[0].fn();
    assert.deepEqual(refreshCalls, [R1]);
    assert.equal(timers.length, 2, "a new tick is scheduled after each one");
    t.stop();
    assert.ok(cleared.length >= 1);
  });

  test("after a failed refresh the retry comes within five minutes and not in a hot loop", async () => {
    creds.expiresAt = clock.t;
    refresh = async () => { throw new Error("offline"); };
    const timers = [];
    const t = make();
    await t.start({ setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
    assert.equal(timers.length, 1);
    assert.ok(timers[0].ms >= 1000 && timers[0].ms <= 300_000, `retry delay ${timers[0].ms}`);
    t.stop();
  });
});

describe("credentialsFileStore", () => {
  const original = (over = {}) => ({
    claudeAiOauth: { accessToken: A1, refreshToken: R1, expiresAt: 1234, scopes: ["user:inference"], subscriptionType: "max", ...over },
    mcpOAuth: { keep: "me" },
  });

  test("load returns the three fields; save rewrites only those and keeps scopes, subscription and every other key, mode 0600", async () => {
    const file = path.join(tmp, ".credentials.json");
    await writeFile(file, JSON.stringify(original()), { mode: 0o600 });
    const store = credentialsFileStore({ file });
    assert.deepEqual(await store.load(), { accessToken: A1, refreshToken: R1, expiresAt: 1234 });
    await store.save({ accessToken: A2, refreshToken: R2, expiresAt: 99 });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), original({ accessToken: A2, refreshToken: R2, expiresAt: 99 }));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(tmp), [".credentials.json"], "no temp file left behind");
  });

  test("a missing or invalid file rejects with an error that quotes none of it", async () => {
    const file = path.join(tmp, ".credentials.json");
    const store = credentialsFileStore({ file });
    await assert.rejects(store.load());
    await mkdir(tmp, { recursive: true });
    await writeFile(file, `{"claudeAiOauth": {"accessToken": "${A1}", `);
    await assert.rejects(store.load(), (e) => !String(e.message).includes(A1));
    await writeFile(file, JSON.stringify({ other: 1 }));
    await assert.rejects(store.load());
  });
});

describe("oauthRefresh (over an injected fetch)", () => {
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  test("posts a refresh_token grant carrying the refresh token and maps the reply to credentials", async () => {
    const seen = [];
    const fetch = async (url, init) => { seen.push({ url, init }); return reply({ access_token: A2, refresh_token: R2, expires_in: 28800 }); };
    const refresh = oauthRefresh({ fetch, now: () => 5000 });
    assert.deepEqual(await refresh(R1), { accessToken: A2, refreshToken: R2, expiresAt: 5000 + 28800 * 1000 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].init.method, "POST");
    const body = JSON.parse(seen[0].init.body);
    assert.equal(body.grant_type, "refresh_token");
    assert.equal(body.refresh_token, R1);
    assert.ok(!String(seen[0].url).includes(R1), "the refresh token is in the body, never the URL");
  });

  test("a reply with no new refresh token keeps the old one", async () => {
    const refresh = oauthRefresh({ fetch: async () => reply({ access_token: A3, expires_in: 60 }), now: () => 0 });
    assert.equal((await refresh(R1)).refreshToken, R1);
  });

  test("a non-2xx or malformed reply rejects, and the error quotes no token or reply body", async () => {
    const refresh = oauthRefresh({ fetch: async () => reply({ error: "invalid_grant", echo: R1, access_token: A3 }, 400), now: () => 0 });
    await assert.rejects(refresh(R1), (e) => ![R1, A3].some((s) => String(e.message).includes(s)));
    const bad = oauthRefresh({ fetch: async () => reply({ nothing: true }), now: () => 0 });
    await assert.rejects(bad(R1), (e) => !String(e.message).includes(R1));
  });
});
