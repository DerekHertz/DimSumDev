#!/usr/bin/env node
// ADR 0028: renamed to scripts/agent-start.mjs. This shim stays for one release so old instructions still work.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.stderr.write("cell-start: renamed; use node scripts/agent-start.mjs (ADR 0028)\n");
const target = fileURLToPath(new URL("./agent-start.mjs", import.meta.url));
const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
