#!/usr/bin/env node
// organism-infra/211: report billed-token spend per ticket and per role from kind:"spend" rows.
// Usage: node scripts/spend.mjs [--json]     (npm run spend)
// Agent rows carry the same totals but are never summed here, so nothing is counted twice.
import path from "node:path";
import { resolveRoot } from "../apps/board/board-service.mjs";
import { FOUR, readRows } from "./spend-lib.mjs";

const args = process.argv.slice(2);
if (args.some((a) => a !== "--json")) {
  console.error("spend: usage: spend.mjs [--json]");
  process.exit(1);
}

let root;
try {
  root = path.resolve(resolveRoot(process.cwd(), process.env));
} catch {
  root = process.cwd();
}

const bucket = () => ({ ...Object.fromEntries(FOUR.map((k) => [k, 0])), total: 0 });
const by_ticket = {};
const by_role = {};
for (const r of readRows(root)) {
  if (r?.kind !== "spend") continue;
  const t = (by_ticket[typeof r.ticket === "string" && r.ticket ? r.ticket : "(none)"] ??= bucket());
  const o = (by_role[typeof r.role === "string" && r.role ? r.role : "(none)"] ??= bucket());
  for (const k of FOUR) {
    const v = Number.isFinite(r[k]) ? r[k] : 0;
    t[k] += v;
    t.total += v;
    o[k] += v;
    o.total += v;
  }
}

if (args.includes("--json")) {
  console.log(JSON.stringify({ by_ticket, by_role }));
} else {
  const section = (title, map) => {
    console.log(title);
    const keys = Object.keys(map);
    if (!keys.length) console.log("  (no spend rows)");
    for (const key of keys.sort((a, b) => map[b].total - map[a].total)) {
      const v = map[key];
      console.log(`  ${key}  total ${v.total}  in ${v.input_tokens}  cache_create ${v.cache_creation_input_tokens}  cache_read ${v.cache_read_input_tokens}  out ${v.output_tokens}`);
    }
  };
  section("Spend per ticket", by_ticket);
  section("Spend per role", by_role);
}
