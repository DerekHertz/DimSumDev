// den-v1 loop S4 (ADR 0016 amendment 11, ADR 0008 decision 12): the run ledger. Every agent the bridge ran leaves
// one kind:"agent" row in .scratch/usage.jsonl, in the shape scripts/log-agent.mjs writes, through the same
// symlink-refusing append. Every field comes from the host's own record of the run; no agent text reaches a row.
import { appendUsageRows, agentRow } from "../../../scripts/spend-lib.mjs";

const NONE = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, final: false };

/**
 * run = { agentId, ref, role, mode, state, reason, model, usage, costUsd, durationMs, cliMs, turns } -> the row.
 * `tokens` is the four tiers summed. `tokens_partial` marks counts that are the host's running total, because the
 * run ended without reporting its own; `cost_usd` is null when the run reported no cost.
 */
export function runRow(run, ts = new Date().toISOString()) {
  const u = run.usage ?? NONE;
  return agentRow({
    ts, ticket: run.ref, role: run.role, mode: run.mode ?? undefined, model: run.model ?? undefined,
    tokens: u.input + u.cacheWrite + u.cacheRead + u.output, ms: run.durationMs ?? 0,
    outcome: run.reason ? `${run.state}: ${run.reason}` : run.state,
    billed: { input_tokens: u.input, cache_creation_input_tokens: u.cacheWrite, cache_read_input_tokens: u.cacheRead, output_tokens: u.output },
    extra: {
      cost_usd: run.costUsd ?? null,
      ...(run.cliMs == null ? {} : { cli_ms: run.cliMs }),
      ...(run.turns == null ? {} : { turns: run.turns }),
      source: "bridge", agent: run.agentId,
      ...(run.runtime === undefined ? {} : { runtime: run.runtime }),
      ...(run.project === undefined ? {} : { project: run.project }),
      ...(run.runtimeSessionId === undefined ? {} : { runtime_session_id: run.runtimeSessionId }),
      ...(u.final ? {} : { tokens_partial: true }),
    },
  });
}

export function createLedger(root) {
  return { record: async (run) => appendUsageRows(root, [runRow(run)]) };
}
