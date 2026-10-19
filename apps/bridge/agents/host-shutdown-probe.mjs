// organism-infra/140: test-only probe for host-shutdown.test.mjs (not a test file: no .test.mjs suffix).
//
// Starts a bridge whose runtime wraps REAL operating-system processes (node children that ignore SIGTERM and stdin
// close, so only SIGKILL ends them), starts two agents through the internal host.start(), prints one JSON line with
// the child pids, then does what `mode` says:
//   hold   wait to be signalled from outside (the test sends SIGTERM, SIGINT or SIGHUP)
//   exit   call process.exit(0): only the synchronous 'exit' handler can still kill the children
//   throw  throw an uncaught exception
// Usage: node host-shutdown-probe.mjs <root> <mode>
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { startBridge } from "../server.mjs";

const [, , root, mode] = process.argv;
const pids = [];

const runtime = {
  id: "probe",
  capabilities: { spawn: true, stop: true, approve: false, send: false, handover: true },
  async spawn() {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: ["pipe", "ignore", "ignore"] });
    pids.push(child.pid);
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    return {
      handle: String(child.pid),
      events: { async *[Symbol.asyncIterator]() { await exited; } },
      closeInput: () => child.stdin.end(),
      signal: (sig) => child.kill(sig),
      exited,
    };
  },
};

const bridge = await startBridge({ root, port: 0, auth: { launchCode: "c0de".repeat(16) }, runtime, policy: { killGraceMs: 100 } });
for (const ref of ["fx/21-one", "fx/22-two"]) {
  const r = await bridge.host.start({ ref, role: "architect" });
  if (!r.ok) {
    writeSync(1, JSON.stringify({ error: `start refused: ${r.status} ${r.error}` }) + "\n");
    process.exit(2);
  }
}
writeSync(1, JSON.stringify({ ready: true, pids }) + "\n");
if (mode === "exit") setTimeout(() => process.exit(0), 300);
if (mode === "throw") setTimeout(() => { throw new Error("probe boom"); }, 300);
