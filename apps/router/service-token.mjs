// den-mvp/88 (ADR 0027 decision 2): the router's service token, written by `den:install` to <state>/service-token (0600).
// The bridge reads the same file; a missing or malformed file is null, so nothing is accepted.
import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const serviceTokenPath = (stateDir) => path.join(stateDir, "service-token");

export async function readServiceToken(stateDir) {
  const text = await readFile(serviceTokenPath(stateDir), "utf8").catch(() => "");
  const token = text.trim();
  return TOKEN.test(token) ? token : null;
}

/** The token, made once: an existing good file is kept. */
export async function ensureServiceToken(stateDir) {
  const kept = await readServiceToken(stateDir);
  if (kept) return kept;
  const token = randomBytes(32).toString("base64url");
  await writeFile(serviceTokenPath(stateDir), `${token}\n`, { mode: 0o600 });
  await chmod(serviceTokenPath(stateDir), 0o600); // a malformed file that was there keeps its old mode otherwise
  return token;
}
