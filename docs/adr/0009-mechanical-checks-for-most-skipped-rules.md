# Encode the five most-skipped organism rules as mechanical checks, and add a Contract/State/Receipt schema

> Terms: written before ADR 0028, which renamed the vocabulary (cell → agent, cell type → role, genome → role definition, station → team, organism → the org, apoptosis → hand off and exit).

**Status:** accepted (2026-09-28: user chose all 5 rules, and a hard block with a logged --force on release without a handoff).

**Context.** Every organism rule today is prose that a cell enforces on itself: brain gates, usage-% reporting, timeouts, scope-in-Comments, the relay order, one handoff per ending. `.scratch/usage.jsonl`'s `incident` lines show these being skipped in practice, and each skip already produced a *second* piece of prose ("rule_change") rather than a check — the usage-% incident (line 20) was already patched once in the orchestrator genome and nothing stops it recurring silently. "Encode the rule twice" (guide text + a check the agent can't bypass) means picking a seam per rule where a program, not the model's own memory, refuses the bad action.

**Decision.**

1. **Ranking, by incident count and cost** (evidence: `.scratch/usage.jsonl`, all `organism-infra/12`, `ci-cd/03`, `ci-cd/04`, `organism-infra/05` unless noted):

   | # | Rule | Incidents | Cost |
   |---|------|-----------|------|
   | 1 | Board CLI accepts bad mutations | 3: unknown `--as` flag stored as comment text; `qa` set `in-review` during `specify`; `developer` ended twice without pushing or writing a handoff | one hand-fixed comment, one wrong ticket status, two resume round-trips |
   | 2 | Handback omits tool refusals | 2: a refused compound `cd`+heredoc command went unreported ("no environment issues" anyway); a refused main-checkout write was worked around without being logged as a refusal | retries inside a 14-minute cell; the orchestrator has no record to fix the underlying refusal |
   | 3 | Usage % goes unchecked | 1, but the highest per-incident cost: a session ran 30%→82% of the 5-hour window with no check in between | near-exhausted plan window, discovered too late to steer |
   | 4 | Scope in ticket Comments isn't tested | 1: `qa`/`developer` covered only the checkbox criteria; three named scope items (deadline after self-reclaim, EPERM/EBUSY retry, `NODE_ENV` gate) got no tests and no code | a missed scope that `security` had to catch, one bounce |
   | 5 | `.claude/` changes aren't gated in CI | 0 logged, included on cost alone | the existing brain gate ("only the orchestrator edits `.claude/`, with permission") has no mechanical backstop; a silent bad edit changes every cell's behavior and is the hardest of the five to notice or reverse |

   Two more usage.jsonl incidents are real but out of scope here: the `.some()` worktree-guard bug and the designer-in-a-worktree write failure are worktree-lifecycle problems, folded into `organism-infra/16` instead of duplicated (see decision 5).

2. **Per-rule check.**

   - **Board CLI hardening.** *Blocks:* any subcommand flag not in that subcommand's declared set; `board release --status in-review` when the calling cell's last claim was `qa --mode specify` (`qa` only sets `in-review` implicitly via `developer`'s later release — `qa specify` never sets ticket status itself); `board release --status in-review|resolved` when no handoff file for that ticket has a valid State block (decision 4). *Override:* `board release --force --reason "<text>"`, which still writes the release but appends a `kind:"override"` line to `events.jsonl` the orchestrator surfaces in its own report.
   - **Handback tool-refusal reporting.** *Blocks nothing directly* — it's a required section, not a gate on an action. The `handoff` skill's template gets a mandatory `## Tool refusals` heading (`none` is a valid, explicit entry). *Check:* the orchestrator's handback-processing step greps the handoff for that heading before filing the cell's Receipt (decision 4); a missing heading is itself logged as a `kind:"incident"` line, the same way a missing usage sample would be. *Override:* none needed — writing "none" always satisfies it.
   - **Usage-% freshness gate.** *Blocks:* a `PreToolUse` hook on `Agent` (dispatch) and on `gh pr merge`/`git push` to `main`, refusing unless `.scratch/usage.jsonl` has a `kind:"usage"` line timestamped within the last 30 minutes. *Override:* an env var (`ORGANISM_USAGE_GATE_OVERRIDE=1`) set by the human for one call; the hook logs the override to `usage.jsonl` as `kind:"incident"` with `rule_change:null` so overrides themselves stay visible.
   - **Scope-in-Comments to test mapping.** *Blocks:* `qa`'s own `specify` step from reporting "done" — a small check script reads every "Scope added" bullet under a ticket's `## Comments` and requires each to appear (by close paraphrase or an explicit `// scope: <ticket>#<n>` test comment) in the test file `qa` just wrote; unmatched bullets fail the script. *Override:* a human edits the ticket Comments to mark a bullet `(descoped)`, which the script skips.
   - **`.claude/` CI approval gate.** *Blocks:* a PR whose diff touches `.claude/**` from passing CI, unless the PR carries a required label (e.g. `human-approved-claude-dir`) that only a human (not a cell's `gh` token scope) can apply. *Override:* the human applies the label after reviewing the diff — the same approval organism-protocol already requires in prose, now enforced at the PR gate instead of trusted to memory.

3. **`Contract` — written into the ticket on claim**, derived from the checkbox criteria plus every Comments scope item, so the task can't be silently redefined mid-flight:
   ```json
   {"goal": "string", "inputs": ["string"], "output": "string",
    "constraints": ["string"], "done_when": ["string"]}
   ```
   `board claim` writes this as a fenced block under a new `## Contract` heading in the same atomic call that sets `Status: claimed`.

4. **`State` — the first block of every handoff**, so the next session inherits state, not a retelling:
   ```json
   {"ticket": "feature/NN-slug", "current_step": "string",
    "artifacts": ["path"], "decisions": ["string"], "failures": ["string"], "pending": ["string"]}
   ```
   `board release --status in-review|resolved` parses the ticket's newest handoff file and refuses (decision 2) unless this block parses and `pending` is either empty or every remaining item is explicitly handed to a named next cell. This is the mechanical form of two `usage.jsonl` incidents: "board release refuses to proceed without a handoff" and "cells must not hand back an interim status and end" (a cell can't end on an interim status *and* satisfy a non-empty `pending` with no owner).

5. **`Receipt` — the last block of every cell's final report**, which the orchestrator appends to `usage.jsonl` verbatim (as `kind:"cell"` today, extended):
   ```json
   {"context_sources": ["string"], "policy_version": "<git SHA>", "tools_used": ["string"],
    "tool_refusals": [{"tool": "string", "what": "string"}],
    "tests": {"passed": 0, "failed": 0}, "retries": 0, "human_corrections": 0,
    "tokens": 0, "artifact": "path", "rollback_point": "<base commit SHA>",
    "worktree": {"path": "string", "clean": true}}
   ```
   `policy_version` is `git rev-parse HEAD:.claude` (verified working: `9feb2a5c27f33a03139a84ce8b7f3fea69f997d0` at this commit) — cheap, no new dependency. **`worktree` is shape-only here**: `organism-infra/16` owns computing `clean`/dirty and the per-file dirty list (its own acceptance criterion 5); this ADR only fixes the field name and nesting so one Receipt object satisfies both tickets. `tool_refusals` is the mechanical partner to decision 2's handoff section — the orchestrator reads it, not the prose.

**Considered options.**
- *A PreToolUse hook for every rule, uniformly.* Rejected for rules 1, 2 and 4: a hook can only see the tool call about to run, not a ticket's Comments or a handoff's content, so the board CLI, the orchestrator's handback step and a `qa`-owned script are each a better-fitted seam than forcing everything through `settings.json`.
- *One giant `validate-organism` script run at every gate.* Rejected: it would own five unrelated pieces of behavior behind one interface — a shallow module by `codebase-design`'s test. Each check stays where its data already lives (board CLI owns board mutations, the hook owns tool-call interception, qa owns its own test file, CI owns the PR diff).
- *Add the worktree clean/dirty check here too, since it's also a "final report" field.* Rejected per the ticket's own instruction: `organism-infra/16` already carries this as acceptance criterion 5 with more context (byte-identical-to-main detection, dirty-file listing). Duplicating it here would give two tickets authority over the same behavior.

**Consequences.**
- Six follow-up tickets carry the implementation; nothing is built in this ticket (`organism-infra/15`'s own acceptance criterion 4). See `.scratch/organism-infra/issues/17` through `22`.
- `CONTEXT.md` gains no terms yet: **Contract**, **State block**, and **Receipt** are proposed vocabulary, not added — changing `CONTEXT.md` is a brain gate, and this architect subagent had no live user to ask (see Comments). Whoever applies ticket 17 should raise this addition to the user directly.
- The orchestrator genome changes needed to apply the Receipt schema and the two board-CLI/hook checks are gated by the user's yes (ticket 15's own acceptance criterion 3); `organism-infra/23` tracks that application separately from this design.
- Two specific choices in this ADR are recommendations pending explicit user confirmation, not yet decided: (a) whether all five rules ship together or the scope trims to the top three, and (b) whether the State-block handoff check in decision 2/4 is a hard block (recommended above, with a logged `--force`) or a warn-and-log. Both are listed as open questions in the ticket.

## Comments

- **Created (architect, 2026-09-28):** Resolves the design half of `organism-infra/15`. Ranking and evidence drawn from `.scratch/usage.jsonl` (50 lines, session of 2026-09-27/28) and the ticket's own Comments (structured Contract/State/Receipt scope, AgentSystemLabs ideas). Coordinated with `organism-infra/16` (worktree lifecycle) rather than duplicating its Receipt worktree field — see decision 5 and Considered Options. This subagent's `AskUserQuestion` tool was refused by the harness ("not available inside subagents"); the two brain-gate questions below are therefore relayed to the orchestrator/user instead of asked live, per organism-protocol's instruction not to treat a missing tool as license to proceed as if approved:
  1. Ship all 5 ranked rules, or trim to the top 3 (board CLI hardening, tool-refusal reporting, usage-% gate) and defer the qa scope-mapping gate and the `.claude/` CI gate?
  2. Should the State-block handoff check (decision 2/4) hard-block `board release`, or warn-and-log without blocking any cell?
