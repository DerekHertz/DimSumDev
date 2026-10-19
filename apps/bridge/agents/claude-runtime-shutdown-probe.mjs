// organism-infra/143: test-only probe for claude-runtime-shutdown.test.mjs (not a test file: no .test.mjs suffix).
//
// Like host-shutdown-probe.mjs, but the runtime is the REAL createClaudeRuntime over the stub binary (which ignores stdin
// EOF and SIGTERM and has a SIGTERM-ignoring grandchild). Starts one agent through host.start(), prints one JSON line
// { ready, pid, grandchild }, then does what `mode` says: hold (wait to be signalled), exit (process.exit(0)), throw.
// Usage: node claude-runtime-shutdown-probe.mjs <root> <stubBin> <stubDir> <mode>
import { writeSync } from "node:fs";
import { startBridge } from "../server.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { unconfinedLauncher } from "./launcher-test-helpers.mjs";

const [, , root, stubBin, stubDir, mode] = process.argv;
const runtime = createClaudeRuntime({ launcher: unconfinedLauncher(), env: { PATH: process.env.PATH, HOME: process.env.HOME, DEN_CLAUDE_BIN: stubBin } });
const bridge = await startBridge({ root, port: 0, auth: { launchCode: "c0de".repeat(16) }, runtime, policy: { killGraceMs: 100 } });
const r = await bridge.host.start({ ref: "fx/21-one", role: "architect" });
if (!r.ok) {
  writeSync(1, JSON.stringify({ error: `start refused: ${r.status} ${r.error}` }) + "\n");
  process.exit(2);
}
const read = (f) => {
  try {
    return readFileSync(path.join(stubDir, f), "utf8");
  } catch {
    return "";
  }
};
for (let i = 0; i < 100 && !(read("grandchild.pid") && read("log.jsonl")); i += 1) await new Promise((res) => setTimeout(res, 50));
const start = read("log.jsonl").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.kind === "start");
writeSync(1, JSON.stringify({ ready: true, pid: start?.pid, grandchild: Number(read("grandchild.pid")) }) + "\n");
if (mode === "exit") setTimeout(() => process.exit(0), 300);
if (mode === "throw") setTimeout(() => { throw new Error("probe boom"); }, 300);
