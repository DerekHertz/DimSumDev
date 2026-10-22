// hardening/11 (security fix): a port is not an identity. The bridge mints a random secret per role (or per agent run); the proxy reads the
// secret-to-role map from a read-only mounted DIRECTORY on every request, so a new run's secret needs no proxy restart.
// Imports only node: built-ins and siblings.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./token.mjs";

export const SECRETS_FILE_NAME = "secrets.json";

export const mintSecret = () => randomBytes(32).toString("base64url");

// Proxy side. get() -> { [secret]: role }. The error never quotes the file.
export function fileSecretSource({ file }) {
  return {
    async get() {
      let map;
      try { map = JSON.parse(await readFile(file, "utf8")); } catch { throw new Error("secrets file is missing or not valid JSON"); }
      if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("secrets file is not a secret-to-role map");
      return map;
    },
  };
}

// Bridge side. Atomic, mode 0600, in a directory the proxy container mounts read-only.
export function writeSecrets({ dir, secrets }) {
  return writeAtomic(path.join(dir, SECRETS_FILE_NAME), JSON.stringify(secrets));
}
