// A pure Codex 0.163.0 profile translator, not the shared role-policy authority.
// Input must eventually come from the one effective-role-policy compiler. This
// stage provides neither a launcher nor inherited-config/credential interposition.
import path from "node:path";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const within = (candidate, base) => candidate === base || candidate.startsWith(base === "/" ? "/" : `${base}/`);
const PATH = /^\/(?:[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*)?$/;
const FIELDS = ["version", "readRoots", "writeRoots", "readOnlyPaths", "denyPaths", "denyCommands", "hosts"];
// Exact keys from the official rust-v0.163.0 core/config.schema.json. These are
// config requests; native tool/shell enforcement still requires real conformance.
const DISABLED_FEATURES = Object.freeze([
  "multi_agent", "multi_agent_v2", "multi_agent_v2_dynamic_tools", "collab", "enable_fanout",
  "hooks", "codex_hooks", "plugin_hooks", "plugins", "remote_plugin", "apps", "connectors", "enable_mcp_apps",
  "memories", "memory_tool", "external_agent_memory_import", "external_migration", "shell_snapshot", "shell_snapshot_v2",
  "daemon_auto_start", "remote_control", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "in_app_browser",
  "computer_use", "image_generation", "js_repl", "code_mode", "code_mode_host", "tool_suggest",
  "skill_mcp_dependency_install", "skill_env_var_dependency_prompt", "auth_elicitation", "request_permissions", "request_permissions_tool",
  "request_rule", "step_model_switching",
]);
const REQUIREMENTS = Object.freeze([
  "one-shared-effective-role-policy", "private-configuration-stack", "protected-native-store", "protected-exec-policy-loading",
  "canonical-path-and-symlink-check", "enforced-resource-launcher", "role-scoped-connection-interposition", "actual-launch-conformance",
]);

function absolute(value) {
  if (typeof value !== "string" || value.length > 4096 || !PATH.test(value) || path.posix.normalize(value) !== value || value.split("/").some((part) => part === "." || part === "..")) throw new TypeError("profile paths must be exact canonical-form Linux absolute paths");
  return value;
}
function paths(value) {
  if (!Array.isArray(value) || value.length > 100 || value.some((_, index) => !Object.hasOwn(value, index))) throw new TypeError("invalid profile path list");
  return [...new Set(value.map(absolute))];
}
function freeze(value) {
  if (object(value) || Array.isArray(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

export function compileCodexPermissions(input) {
  if (!object(input) || Object.keys(input).some((key) => !["profileId", "worktree", "nativeStore", "policy"].includes(key))) throw new TypeError("invalid Codex profile input");
  const { profileId, policy } = input;
  const worktree = absolute(input.worktree);
  const nativeStore = absolute(input.nativeStore);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(profileId ?? "")) throw new TypeError("a custom profile id is required");
  if (within(nativeStore, worktree) || within(worktree, nativeStore) || nativeStore === "/") throw new TypeError("the native store must be private and separate from the worktree");
  if (!object(policy) || policy.version !== 1 || Object.keys(policy).some((key) => !FIELDS.includes(key)) || FIELDS.some((key) => !Object.hasOwn(policy, key))) throw new TypeError("unknown effective-policy requirements or version");
  if (!Array.isArray(policy.hosts) || policy.hosts.length !== 0) throw new TypeError("network hosts require separately proved proxy/connection confinement");
  const read = paths(policy.readRoots);
  const write = paths(policy.writeRoots);
  const readOnly = paths(policy.readOnlyPaths);
  const deny = [...new Set([...paths(policy.denyPaths), nativeStore])];
  if (write.includes("/")) throw new TypeError("root writes are not representable by a bounded role profile");
  if (!read.some((root) => within(worktree, root)) && !write.some((root) => within(worktree, root))) throw new TypeError("the worktree has no admitted read root");
  // Native matching is most-specific; an allow nested under a deny would reopen
  // it. Reject that input rather than relying on rule order to preserve a deny.
  for (const grant of [...read, ...write]) if (deny.some((protectedPath) => within(grant, protectedPath))) throw new TypeError("a grant reopens a protected denial");
  for (const grant of write) if (readOnly.some((protectedPath) => within(grant, protectedPath))) throw new TypeError("a grant reopens a governed read-only path");
  if (!Array.isArray(policy.denyCommands) || policy.denyCommands.length > 100 || policy.denyCommands.some((command) => !Array.isArray(command) || command.length < 1 || command.length > 16 || command.some((token) => typeof token !== "string" || !/^[A-Za-z0-9_./@+-]{1,200}$/.test(token)))) throw new TypeError("unsupported command restriction grammar");

  // A custom profile with no parent starts restricted and unmatched paths deny.
  // No root-deny carveout, glob snapshot, implicit tmp write or workspace macro is
  // needed. All roots are explicit data from the future shared effective policy.
  const filesystem = { ":minimal": "read" };
  for (const root of read) filesystem[root] = "read";
  for (const root of write) filesystem[root] = "write";
  for (const protectedPath of readOnly) filesystem[protectedPath] = "read";
  for (const protectedPath of deny) filesystem[protectedPath] = "deny";
  const config = {
    default_permissions: profileId,
    approval_policy: "never",
    approvals_reviewer: "user",
    web_search: "disabled",
    features: Object.fromEntries(DISABLED_FEATURES.map((name) => [name, false])),
    shell_environment_policy: { inherit: "none" },
    mcp_servers: {},
    permissions: { [profileId]: { filesystem, network: { enabled: false } } },
  };
  const execPolicy = policy.denyCommands.map((command) => `prefix_rule(pattern = ${JSON.stringify(command)}, decision = "forbidden", justification = "Use the bridge's approved operation instead.")`).join("\n") + (policy.denyCommands.length ? "\n" : "");
  return freeze({ profileId, config, execPolicy, launchable: false, requirements: [...REQUIREMENTS] });
}

export function renderCodexConfig(config) {
  if (!object(config)) throw new TypeError("config must be an object");
  const lines = [];
  function table(value, prefix) {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    if (prefix.length) lines.push(`[${prefix.map((part) => JSON.stringify(part)).join(".")}]`);
    for (const [name, item] of entries) {
      if (object(item)) continue;
      if (!(typeof item === "string" || typeof item === "boolean")) throw new TypeError("unsupported Codex config value");
      lines.push(`${/^[a-z_]+$/.test(name) ? name : JSON.stringify(name)} = ${JSON.stringify(item)}`);
    }
    for (const [name, item] of entries) if (object(item)) { lines.push(""); table(item, [...prefix, name]); }
  }
  table(config, []);
  return lines.join("\n") + "\n";
}
