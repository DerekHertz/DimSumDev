// hardening/16: the den's own Claude logins ("accounts"). Each lives in <state>/accounts/<name>, made by one `/login` with CLAUDE_CONFIG_DIR set there.
// Every path comes from stateDir: the den never reads or writes the interactive CLI's credentials. Switching is the user's, by hand.
import { chmod, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./token.mjs";

const CREDENTIALS = ".credentials.json";
const ACTIVE_FILE = "active-account";
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const accountsDir = (stateDir) => path.join(stateDir, "accounts");

const exists = (file) => stat(file).then(() => true, () => false);

// An account is a folder with a finished login; a half-made login folder is not one yet.
export async function listAccounts({ stateDir }) {
  let entries;
  try { entries = await readdir(accountsDir(stateDir), { withFileTypes: true }); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const names = entries.filter((e) => e.isDirectory() && NAME.test(e.name)).map((e) => e.name);
  const finished = await Promise.all(names.map((n) => exists(path.join(accountsDir(stateDir), n, CREDENTIALS))));
  return names.filter((_, i) => finished[i]).sort();
}

export async function activeAccount({ stateDir }) {
  const names = await listAccounts({ stateDir });
  const chosen = await readFile(path.join(stateDir, ACTIVE_FILE), "utf8").then((t) => t.trim(), () => null);
  return names.includes(chosen) ? chosen : names[0] ?? null;
}

export async function setActiveAccount({ stateDir, name }) {
  if (!(await listAccounts({ stateDir })).includes(name)) throw new Error(`no such account: ${JSON.stringify(name)}`);
  await writeAtomic(path.join(stateDir, ACTIVE_FILE), `${name}\n`);
  return name;
}

// login({ dir, env }) is the interactive `claude` where the user types /login.
export async function addAccount({ stateDir, name, login }) {
  if (typeof name !== "string" || !NAME.test(name)) throw new Error("an account name is 1-32 characters of a-z, 0-9, _ and -, not starting with _ or -");
  if ((await listAccounts({ stateDir })).includes(name)) throw new Error(`account ${name} already exists`);
  const dir = path.join(accountsDir(stateDir), name);
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700);
  await login({ dir, env: { CLAUDE_CONFIG_DIR: dir } });
  if (!(await exists(path.join(dir, CREDENTIALS)))) throw new Error(`the login ended without credentials in ${dir}: run /login in the claude that opened`);
  return { name, dir };
}
