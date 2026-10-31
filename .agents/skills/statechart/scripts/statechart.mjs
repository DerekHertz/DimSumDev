#!/usr/bin/env node
const [major, minor] = process.versions.node.split(".").map(Number);
if (!(major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18))) {
  console.error("statechart needs Node 22.18 to 22.x, or Node 23.6 or later.");
  process.exit(127);
}
process.removeAllListeners("warning");
await import("./statechart.ts");
