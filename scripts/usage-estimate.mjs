#!/usr/bin/env node
// Estimates cloud usage from session transcripts (organism-infra/32), for sessions
// with no OAuth credentials. Sums price-weighted tokens (input 1, cache write 1.25,
// cache read 0.1, output 5) over every *.jsonl under
// $HOME/.claude/projects/<cwd slug>/ (subagent transcripts included). Credit
// calibration is optional: it needs two cloud_credits readings in the usage log
// ($USAGE_LOG, default <DEN_ROOT or cwd>/.scratch/usage.jsonl).
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEIGHTS = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };

function* jsonlFiles(dir) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p);
    else if (e.isFile() && e.name.endsWith(".jsonl")) yield p;
  }
}

function messages(dir) {
  const out = [];
  for (const file of jsonlFiles(dir)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const u = rec?.type === "assistant" ? rec.message?.usage : null;
      if (!u) continue;
      const w =
        (u.input_tokens || 0) * WEIGHTS.input +
        (u.cache_creation_input_tokens || 0) * WEIGHTS.cacheWrite +
        (u.cache_read_input_tokens || 0) * WEIGHTS.cacheRead +
        (u.output_tokens || 0) * WEIGHTS.output;
      out.push({ t: Date.parse(rec.timestamp), w });
    }
  }
  return out;
}

function readReadings(log) {
  let text = "";
  try {
    text = readFileSync(log, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r?.cloud_credits === "number" && Number.isFinite(Date.parse(r.ts))) {
        rows.push({ ts: r.ts, t: Date.parse(r.ts), cloud_credits: r.cloud_credits });
      }
    } catch {
      // skip malformed rows
    }
  }
  return rows.sort((a, b) => a.t - b.t);
}

export function estimate({ home = process.env.HOME || os.homedir(), cwd = process.cwd(), log } = {}) {
  const dir = path.join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  log ??= process.env.USAGE_LOG || path.join(process.env.DEN_ROOT || process.env.ORGANISM_ROOT || cwd, ".scratch", "usage.jsonl");
  const msgs = messages(dir);
  const sum = (f) => msgs.filter(f).reduce((a, m) => a + m.w, 0);
  const weighted = sum(() => true);
  const rs = readReadings(log);
  const out = {
    source: "estimate",
    weighted_tokens: weighted,
    tokens_per_credit: null,
    credits_used_est: null,
    credits_left_est: null,
    last_reading: null,
  };
  if (!rs.length) return out;
  const first = rs[0];
  const last = rs[rs.length - 1];
  out.last_reading = { ts: last.ts, cloud_credits: last.cloud_credits };
  const drop = first.cloud_credits - last.cloud_credits;
  if (rs.length < 2 || !(drop > 0)) return out;
  const tpc = sum((m) => m.t >= first.t && m.t <= last.t) / drop;
  if (!(tpc > 0)) return out;
  const used = sum((m) => m.t > last.t) / tpc;
  out.tokens_per_credit = tpc;
  out.credits_used_est = used;
  out.credits_left_est = last.cloud_credits - used;
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(estimate()));
}
