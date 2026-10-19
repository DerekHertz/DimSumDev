#!/usr/bin/env node
// organism-infra/49: redo a lost kind:"resolved" row in .scratch/usage.jsonl (ADR 0008).
// Usage: node scripts/log-resolved.mjs --ticket <feature>/<NN-slug> [--pr <n>]
// Root is $DEN_ROOT, else the current directory. Refuses (exit 1, nothing written) when the
// ticket is not resolved or a resolved row for it already exists.
import path from "node:path";
import { logResolved } from "../apps/board/board-service.mjs";

const args = process.argv.slice(2);
const f = {};
for (let i = 0; i < args.length; i += 2) {
  const name = args[i];
  if (name !== "--ticket" && name !== "--pr") {
    console.error(`log-resolved: unrecognized argument: ${name}`);
    process.exit(1);
  }
  if (args[i + 1] === undefined) {
    console.error(`log-resolved: ${name} requires a value`);
    process.exit(1);
  }
  f[name.slice(2)] = args[i + 1];
}
try {
  await logResolved(path.resolve(process.env.DEN_ROOT || process.env.ORGANISM_ROOT || process.cwd()), f.ticket ?? "", f.pr);
} catch (err) {
  console.error(`log-resolved: ${err.message}`);
  process.exit(1);
}
