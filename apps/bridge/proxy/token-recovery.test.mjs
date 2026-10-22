// hardening/11 fix round: the refresher must never lose a rotated login, and a refresh must not narrow the token's scopes.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TOKEN_FILE_NAME, createTokenRefresher, credentialsFileStore, oauthRefresh } from "./token.mjs";

const A1 = ["sk-ant", "oat01-RECOVERY-ONE"].join("-"); // built at runtime so the repo secret scan stays clean
const A2 = ["sk-ant", "oat01-RECOVERY-TWO"].join("-"); // built at runtime so the repo secret scan stays clean
const R1 = ["sk-ant", "ort01-RECOVERY-ONE"].join("-"); // built at runtime so the repo secret scan stays clean
const R2 = ["sk-ant", "ort01-RECOVERY-TWO"].join("-"); // built at runtime so the repo secret scan stays clean
const HOUR = 3_600_000;

let tmp;
beforeEach(async () => { tmp = await mkdtemp(path.join(tmpdir(), "den-token-rec-")); });
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });
const fileText = async () => (await readFile(path.join(tmp, TOKEN_FILE_NAME), "utf8")).trim();

describe("a rotated login survives a failed save", () => {
  let clock, creds, saveFails, saves, refreshCalls, refresh, store;
  beforeEach(() => {
    clock = { t: 1_000_000_000 };
    creds = { accessToken: A1, refreshToken: R1, expiresAt: clock.t }; // due now
    saveFails = true;
    saves = [];
    refreshCalls = [];
    refresh = async (rt) => { refreshCalls.push(rt); return { accessToken: A2, refreshToken: R2, expiresAt: clock.t + 8 * HOUR }; };
    store = { load: async () => ({ ...creds }), save: async (c) => { if (saveFails) throw new Error(`disk full for ${R2}`); saves.push(c); creds = { ...c }; } };
  });
  const make = () => createTokenRefresher({ store, refresh: (rt) => refresh(rt), dir: tmp, now: () => clock.t });

  test("save throws then recovers: the next tick saves the held login and does not refresh again", async () => {
    const t = make();
    const first = await t.tick();
    assert.equal(typeof first.error, "string");
    assert.ok(!first.error.includes(R2));
    assert.equal(await fileText(), A2, "the new access token is already usable");
    saveFails = false;
    const second = await t.tick();
    assert.equal(second.error, undefined);
    assert.deepEqual(refreshCalls, [R1], "the already-rotated refresh token is never spent twice");
    assert.deepEqual(saves.map((s) => s.refreshToken), [R2]);
    assert.equal(await fileText(), A2);
  });

  test("while the save keeps failing the held login is retried, not refreshed over, and the file keeps the new token", async () => {
    const t = make();
    await t.tick();
    await t.tick();
    await t.tick();
    assert.deepEqual(refreshCalls, [R1]);
    assert.equal(await fileText(), A2);
  });

  test("a refresh that fails after a rotation never writes an older access token over the newer one", async () => {
    saveFails = false;
    const t = make();
    await t.tick(); // rotates to A2, saved
    assert.equal(await fileText(), A2);
    creds = { accessToken: A1, refreshToken: R1, expiresAt: clock.t }; // the store hands back stale credentials
    refresh = async () => { throw new Error("invalid_grant"); };
    const r = await t.tick();
    assert.equal(typeof r.error, "string");
    assert.equal(await fileText(), A2, "A1 expires earlier than A2 and must not replace it");
  });
});

describe("a refresh carries the stored scopes", () => {
  const reply = () => new Response(JSON.stringify({ access_token: A2, refresh_token: R2, expires_in: 60 }), { status: 200, headers: { "content-type": "application/json" } });

  test("credentialsFileStore.scope() returns the stored scopes space-joined, and undefined when there are none", async () => {
    const file = path.join(tmp, ".credentials.json");
    await writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: A1, refreshToken: R1, expiresAt: 1, scopes: ["user:inference", "user:profile"] } }));
    assert.equal(await credentialsFileStore({ file }).scope(), "user:inference user:profile");
    await writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: A1, refreshToken: R1, expiresAt: 1 } }));
    assert.equal(await credentialsFileStore({ file }).scope(), undefined);
  });

  test("oauthRefresh sends scope from a string or a function, and sends none when absent", async () => {
    const bodies = [];
    const fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return reply(); };
    await oauthRefresh({ fetch, scope: "a b" })(R1);
    await oauthRefresh({ fetch, scope: async () => "c d" })(R1);
    await oauthRefresh({ fetch, scope: () => undefined })(R1);
    await oauthRefresh({ fetch })(R1);
    assert.deepEqual(bodies.map((b) => b.scope), ["a b", "c d", undefined, undefined]);
  });
});
