// hardening/11 (ADR 0031 decision 5): the login lives in the proxy; the bridge keeps the refresh token and refreshes before expiry.
// Imports only node: built-ins and siblings: the proxy side (fileTokenSource) runs inside the container.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const TOKEN_FILE_NAME = "access-token";

// Verified against Claude Code 2.1.293's own refresh (its oauth config object, a.TOKEN_URL and a.CLIENT_ID, and its refresh function):
// POST TOKEN_URL, Content-Type application/json, body { grant_type: "refresh_token", refresh_token, client_id, scope }.
// A change of either is a config change: both are options of oauthRefresh.
export const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// Write by atomic rename: the proxy container mounts the directory, so a reader sees the old or the new file, never half of one.
export async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

const redact = (message, secrets) => [...secrets, ...(message.match(/sk-ant-[\w-]+/g) ?? [])].filter(Boolean).reduce((m, s) => m.split(s).join("[redacted]"), message);

export function fileTokenSource({ file }) {
  return {
    async get() {
      let text;
      try { text = await readFile(file, "utf8"); } catch { throw new Error("access token file is missing or unreadable"); }
      const token = text.trim();
      if (!token) throw new Error("access token file is empty");
      return token;
    },
  };
}

export function createTokenRefresher({ store, refresh, dir, now = Date.now, skewMs = 300_000 }) {
  const file = path.join(dir, TOKEN_FILE_NAME);
  let inflight = null;
  let timer = null;
  let stopped = true;
  let clear = clearTimeout;

  // Rotated credentials not yet persisted: the old refresh token is spent, so these are the only working login. Saved before any new refresh.
  let held = null;
  // Expiry of the newest access token written: an older one is never written over it.
  let newest = -Infinity;

  async function run() {
    let creds = held;
    if (!creds) {
      try { creds = await store.load(); } catch (e) { return { refreshed: false, error: `could not load credentials: ${e.message}` }; }
    }
    let refreshed = false;
    let error;
    if (!held && creds.expiresAt - now() <= skewMs) {
      const spent = [creds.refreshToken, creds.accessToken];
      try {
        creds = await refresh(creds.refreshToken);
        held = creds;
        refreshed = true;
      } catch (e) {
        error = redact(`refresh failed: ${e.message}`, spent);
      }
    }
    if (held) {
      try { await store.save(held); held = null; } catch (e) { error = `could not save the rotated credentials: ${e.code ?? "error"}`; }
    }
    if (creds.expiresAt >= newest) {
      try { await writeAtomic(file, `${creds.accessToken}\n`); newest = creds.expiresAt; } catch (e) { return { refreshed, error: `could not write the token file: ${e.code ?? "error"}` }; }
    }
    return error ? { refreshed, expiresAt: creds.expiresAt, error } : { refreshed, expiresAt: creds.expiresAt };
  }

  // Concurrent ticks share one run: a rotated refresh token is single use.
  const tick = () => (inflight ??= run().finally(() => { inflight = null; }));

  // Due before the skew window opens, never later than five minutes (a sleeping host skips timers); a failure retries in a minute.
  const nextDelay = (r) => (r.error ? 60_000 : Math.min(Math.max(r.expiresAt - skewMs - now(), 1000), 300_000));

  async function loop({ setTimer, clearTimer }) {
    const r = await tick();
    if (!stopped) {
      timer = setTimer(() => loop({ setTimer, clearTimer }), nextDelay(r));
      timer?.unref?.();
    }
    return r;
  }

  return {
    tick,
    start({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
      stopped = false;
      clear = clearTimer;
      return loop({ setTimer, clearTimer });
    },
    stop() { stopped = true; if (timer !== null) clear(timer); },
  };
}

// ~/.claude/.credentials.json: { claudeAiOauth: { accessToken, refreshToken, expiresAt, ...other }, ...other }. Save keeps every other field.
export function credentialsFileStore({ file }) {
  async function read() {
    let doc;
    try { doc = JSON.parse(await readFile(file, "utf8")); } catch { throw new Error("credentials file is missing or not valid JSON"); } // the parse error would quote the file
    const o = doc?.claudeAiOauth;
    if (typeof o?.accessToken !== "string" || typeof o.refreshToken !== "string" || typeof o.expiresAt !== "number") throw new Error("credentials file has no claudeAiOauth login");
    return doc;
  }
  return {
    async load() {
      const { accessToken, refreshToken, expiresAt } = (await read()).claudeAiOauth;
      return { accessToken, refreshToken, expiresAt };
    },
    // The stored scopes, space-joined, so a refresh can't narrow the token.
    async scope() {
      const { scopes } = (await read()).claudeAiOauth;
      return Array.isArray(scopes) && scopes.length ? scopes.join(" ") : undefined;
    },
    async save({ accessToken, refreshToken, expiresAt }) {
      const doc = await read();
      Object.assign(doc.claudeAiOauth, { accessToken, refreshToken, expiresAt });
      await writeAtomic(file, JSON.stringify(doc));
    },
  };
}

// scope: a string, or a (maybe async) function read at each refresh (credentialsFileStore.scope). Claude Code sends its scopes; absent, the server's default applies.
export function oauthRefresh({ fetch = globalThis.fetch, now = Date.now, url = OAUTH_TOKEN_URL, clientId = OAUTH_CLIENT_ID, scope } = {}) {
  return async function refresh(refreshToken) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, scope: typeof scope === "function" ? await scope() : scope }),
    });
    if (!res.ok) throw new Error(`token endpoint answered HTTP ${res.status}`);
    let body;
    try { body = await res.json(); } catch { body = null; }
    if (typeof body?.access_token !== "string" || !(body.expires_in > 0)) throw new Error("token endpoint reply was malformed");
    return { accessToken: body.access_token, refreshToken: body.refresh_token ?? refreshToken, expiresAt: now() + body.expires_in * 1000 };
  };
}
