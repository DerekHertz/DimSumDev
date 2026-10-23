// hardening/16 (ADR 0031 decisions 4 and 5): the den's side of the credential proxy. It keeps one refresher per account (each refresh token is
// single use, so an account that is not active still needs its refresher), serves the active account's access token to the proxy, and mints
// the per-run secrets. The active account changes only when the user says so (switchAccount); no usage limit or failed refresh moves it.
// Never reads or writes the interactive CLI's credentials: every path is under stateDir.
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { activeAccount, accountsDir, listAccounts, setActiveAccount } from "./accounts.mjs";
import { ensureProxy } from "./container.mjs";
import { roleHosts } from "./proxy.mjs";
import { mintSecret, writeSecrets } from "./secrets.mjs";
import { TOKEN_FILE_NAME, createTokenRefresher, credentialsFileStore, oauthRefresh, writeAtomic } from "./token.mjs";

const LOOK_MS = 60_000; // how often every account is looked at: a rotation or a switch reaches the proxy within a minute

export function createProxyService({ stateDir, releaseDir, ceilings, docker, image, fetch, now = Date.now, log = console.error }) {
  const roles = roleHosts(ceilings);
  const served = path.join(stateDir, "proxy", "token"); // mounted into the proxy: holds the active account's access token only
  const secretsDir = path.join(stateDir, "proxy", "secrets");
  const refreshers = new Map(); // account -> refresher; each writes its access token to <stateDir>/proxy/accounts/<name>, which no container mounts
  const privateToken = (name) => path.join(stateDir, "proxy", "accounts", name, TOKEN_FILE_NAME);
  let timer = null;
  const lastError = new Map(); // account -> the last refresh error logged, so a login that stays broken is said once, not every minute
  const note = (name, r) => {
    if (r.error === lastError.get(name)) return;
    lastError.set(name, r.error);
    if (r.error) log(`proxy: account ${name}: ${r.error}`);
  };

  async function sync() {
    for (const name of await listAccounts({ stateDir })) {
      if (refreshers.has(name)) continue;
      const store = credentialsFileStore({ file: path.join(accountsDir(stateDir), name, ".credentials.json") });
      refreshers.set(name, createTokenRefresher({ store, refresh: oauthRefresh({ fetch, now, scope: store.scope }), dir: path.dirname(privateToken(name)), now }));
    }
  }

  // Copies the active account's latest access token to the one place the proxy reads. A refresh of another account never reaches it.
  async function publish() {
    const name = await activeAccount({ stateDir });
    const token = name && (await readFile(privateToken(name), "utf8").catch(() => null));
    if (token) await writeAtomic(path.join(served, TOKEN_FILE_NAME), token);
  }

  async function tick() {
    await sync();
    await Promise.all([...refreshers].map(async ([name, r]) => note(name, await r.tick())));
    await publish();
  }

  // Run secrets stay in memory and are written one after another, each write the whole map: a mint is in the file when its promise resolves.
  const secrets = {};
  let writes = Promise.resolve();

  return {
    async start() {
      for (const dir of [path.join(stateDir, "proxy"), path.join(stateDir, "proxy", "accounts")]) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await chmod(dir, 0o700);
      }
      await tick();
      await mkdir(secretsDir, { recursive: true });
      await writeSecrets({ dir: secretsDir, secrets });
      await ensureProxy({ docker, image, tokenDir: served, proxyDir: path.join(releaseDir, "apps", "bridge", "proxy"), secretsDir, roles });
      timer = setInterval(() => tick().catch((e) => log(`proxy: refresh round failed: ${e.message}`)), LOOK_MS);
      timer.unref();
    },
    stop() { clearInterval(timer); },
    tick,
    async status() { return { active: await activeAccount({ stateDir }), accounts: await listAccounts({ stateDir }) }; },
    async switchAccount(name) {
      await sync();
      const refresher = refreshers.get(name);
      if (!refresher) throw new Error(`no such account: ${JSON.stringify(name)}`);
      const r = await refresher.tick();
      note(name, r);
      if (r.error && !(r.expiresAt > now())) throw new Error(`account ${name} could not refresh and its token has expired: run den:account again`);
      if (!(await readFile(privateToken(name), "utf8").catch(() => null))) throw new Error(`account ${name} has no usable login: run den:account again`);
      await setActiveAccount({ stateDir, name });
      await publish();
    },
    async mintRunSecret({ role }) {
      if (!Object.hasOwn(roles, role)) throw new Error(`no such role: ${JSON.stringify(role)}`);
      const secret = mintSecret();
      secrets[secret] = role;
      const write = writes.then(() => writeSecrets({ dir: secretsDir, secrets: { ...secrets } }));
      writes = write.catch(() => {});
      await write;
      return { secret };
    },
  };
}
