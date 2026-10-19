// Test-only: a launcher with no resource group, for tests that drive the stub CLI on hosts with no user service manager
// (CI). Production never imports this file; createClaudeRuntime's default is the enforced launcher (resource-group.mjs).
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { cgroupOf } from "./resource-group.mjs";

export function unconfinedLauncher() {
  return {
    enforced: false,
    preflight: async () => ({ ok: true }),
    async launch({ bin, args, cwd, env }) {
      const child = spawn(bin, args, { shell: false, detached: true, cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", resolve);
      });
      return { child, group: null };
    },
  };
}

// den-mvp/35: a run lives in its own pid namespace (bwrap --unshare-pid), so a pid the command prints with $$ (or a stub reports
// with process.pid) is the namespace's number, not the host's. These read the host's /proc for the real pid: the process whose
// innermost NSpid is `nsPid` and whose control group matches `where` (a string suffix or a RegExp), so a lookalike elsewhere is ignored.
const nsPids = (host) => {
  try {
    return /^NSpid:\s+(.*)$/m.exec(readFileSync(`/proc/${host}/status`, "utf8"))?.[1].trim().split(/\s+/).map(Number) ?? [];
  } catch {
    return [];
  }
};
const inGroup = (host, where) => {
  const cg = cgroupOf(host) ?? "";
  return typeof where === "string" ? cg.endsWith(where) : where.test(cg);
};
/** The host pid of namespace pid `nsPid` in the control group `where`, or null. */
export function hostPid(nsPid, where) {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const ids = nsPids(entry);
    if (ids.length > 1 && ids.at(-1) === Number(nsPid) && inGroup(entry, where)) return Number(entry);
  }
  return null;
}
