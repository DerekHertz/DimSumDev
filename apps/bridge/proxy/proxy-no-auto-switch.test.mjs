// hardening/16 (user, 2026-10-22): no code path switches accounts on a 429 or a usage reading. qa specify.
// Red until the account code exists (the allowlist is of files that may name the switch); then it stays as a tripwire: a new caller must be
// added here on purpose, with a reason a reviewer reads. The switch is the user's: a route, and the den:account script if it offers one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = new URL("../../../", import.meta.url).pathname;
const CALLERS = new Set([
  "apps/bridge/proxy/accounts.mjs", // setActiveAccount, the definition
  "apps/bridge/proxy/proxy-service.mjs", // switchAccount, the definition
  "apps/bridge/server.mjs", // POST /accounts/active, the user's click
  "scripts/den-account.mjs", // the user's own command
]);

async function sources(dir, out = []) {
  for (const e of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "dist" && !e.name.startsWith(".")) await sources(rel, out); }
    else if (/\.(mjs|js|jsx|ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(rel);
  }
  return out;
}

test("only the account code, the route and the user's command name the switch", async () => {
  const named = [];
  for (const file of [...(await sources("apps")), ...(await sources("scripts"))]) {
    if (/\bswitchAccount\b|\bsetActiveAccount\b/.test(await readFile(path.join(ROOT, file), "utf8"))) named.push(file);
  }
  assert.ok(named.includes("apps/bridge/proxy/proxy-service.mjs"), "the account switch does not exist yet");
  const strangers = named.filter((f) => !CALLERS.has(f) && !f.startsWith("apps/ui/"));
  assert.deepEqual(strangers, [], "these files name the switch; only a user action may call it");
});

test("the proxy side that runs in the container knows nothing of accounts", async () => {
  for (const f of ["proxy.mjs", "den-proxy.mjs", "token.mjs", "secrets.mjs", "container.mjs"]) {
    const src = await readFile(new URL(`./${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\baccounts?\b.*\b(switch|active)\b|\b(switch|active)\w*Account/i, f);
  }
  assert.ok(await readFile(new URL("./proxy-service.mjs", import.meta.url), "utf8"), "proxy-service.mjs does not exist yet");
});

test("server.mjs calls the switch from one place", async () => {
  const src = await readFile(path.join(ROOT, "apps/bridge/server.mjs"), "utf8");
  assert.ok(/switchAccount/.test(src), "the route does not call the switch yet");
  assert.ok((src.match(/\.switchAccount\(/g) ?? []).length <= 1);
});
