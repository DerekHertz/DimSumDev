import { spawnSync } from "node:child_process";

export const killTree = (pid: number) => {
  if (process.platform === "win32")
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
};
