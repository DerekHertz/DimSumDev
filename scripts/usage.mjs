#!/usr/bin/env node
// Provider routing happens before either adapter reads credentials or starts I/O.
// --live (claude only; usage-claude.mjs reads it) skips the cache. It is not part of the provider shape.
const live = process.argv.includes("--live");
const args = process.argv.slice(2).filter((a) => a !== "--live");
const provider = args.length === 0 ? "claude" : args.length === 2 && args[0] === "--provider" ? args[1] : null;
if (!["claude", "codex"].includes(provider) || (live && provider !== "claude")) {
  console.error("usage: expected [--live] [--provider claude|codex] (--live is claude only)");
  process.exit(1);
}
if (provider === "claude") await import("./usage-claude.mjs");
else {
  try {
    const { readCodexUsage } = await import("./usage-codex.mjs");
    console.log(JSON.stringify(await readCodexUsage()));
  } catch (error) {
    console.error(`usage: codex ${error.message}`);
    process.exitCode = 1;
  }
}
