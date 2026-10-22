// ADR 0030: the launch plan for a Codex run under the den's resource group. Codex's own sandbox (`codex sandbox`, a named
// permission profile) is the isolation layer: it reads Node, Codex's native helper and the platform default read set
// (`:minimal`: /etc, /usr, /bin, /proc), writes only the worktree, denies the native store and has the tool network off. This builds the plan only; the caller hands it to createResourceLauncher().launch()
// and writes configToml into nativeStore. It starts no process and makes no model or account call.
import path from "node:path";
import { compileCodexPermissions, renderCodexConfig } from "./codex-permissions.mjs";

export function codexSandboxPlan({ worktree, nativeStore, home, xdg, tmp, codexBin, nativeHelper, nodeBin, command }) {
  if (!Array.isArray(command) || !command.length) throw new TypeError("a command to run under the sandbox is required");
  const compiled = compileCodexPermissions({
    profileId: "den-codex", worktree, nativeStore,
    policy: { version: 1, readRoots: [nodeBin, nativeHelper], writeRoots: [worktree], readOnlyPaths: [], denyPaths: [], denyCommands: [], hosts: [] },
  });
  return {
    // "ephemeral": Codex keeps no credential file of its own in the native store.
    configToml: renderCodexConfig({ ...compiled.config, cli_auth_credentials_store: "ephemeral" }),
    bin: codexBin,
    args: ["sandbox", "--permission-profile", compiled.profileId, "--cd", worktree, "--", ...command],
    cwd: worktree,
    env: { PATH: `${path.dirname(nodeBin)}:/usr/bin:/bin`, LANG: "C.UTF-8", HOME: home, CODEX_HOME: nativeStore, XDG_CONFIG_HOME: xdg, TMPDIR: tmp },
  };
}
