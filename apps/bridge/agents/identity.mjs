// Canonical bridge identities, independent of adapter names and native thread IDs.
export const RUNTIMES = ["claude", "codex"];
export const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const RUNTIME_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
export const runtimeId = (value) => value === undefined ? "claude" : RUNTIMES.includes(value) ? value : null;
export const validProject = (value) => typeof value === "string" && PROJECT_RE.test(value);
export const validRuntimeSession = (value) => typeof value === "string" && RUNTIME_SESSION_RE.test(value);
export function runtimeRegistry(runtime, runtimes) {
  if (runtime !== undefined && runtimes !== undefined) throw new TypeError("use runtime or runtimes, not both");
  if (runtimes !== undefined && (!runtimes || typeof runtimes !== "object" || Array.isArray(runtimes) || Reflect.ownKeys(runtimes).some((key) => !RUNTIMES.includes(key)))) throw new TypeError("unknown runtime registry key");
  return runtimes === undefined ? (runtime ? { claude: runtime } : {}) : { ...runtimes };
}
