# Cells get codebase context from jevgrep as a file path at dispatch, tried on a bounded trial first

> Terms: written before ADR 0028, which renamed the vocabulary (cell → agent, cell type → role, genome → role definition, station → team, organism → the org, apoptosis → hand off and exit).

**Status:** accepted for a trial (2026-09-29, architect, ticket organism-infra/57). Adoption waits on the user's go/no-go after the trial (decision 8). Building `scripts/dispatch-context.mjs`, editing genomes, and installing and authenticating `jg` each need the user's explicit yes.

**Context.** Cells start cold and spend tokens finding code. Jevgrep (`jg`, MIT, npm `@dzhng/jevgrep`, primary docs read 2026-09-29) takes a natural-language repository question and prints ranked files, reading leads and verbatim excerpts, ending in `End context.`. It calls Jev through a provider the user chose at `jg auth`. It ignores environment keys, and it sends eligible source (ignore-file filtered, no hidden, dependency or obvious credential files) to that provider. The user said (2026-09-29) that Jev would also be good for handing agents codebase information fast, and wants jg in use.

Evidence on hand (`usage.jsonl`, handoffs of 26, 28, 34, 53): qa specify reached for `jg` on 3 of 3 tickets and called it useful; developer used it on 1 of 3 (tickets named the files); qa verify and security used it 0 of 6 times. Cell tokens have a large fixed floor (no logged cell run under about 25k, except stubs) and huge spread (developer 4.8k to 229k, median 51k; qa specify 28k to 106k, median 49k). Only the part above the floor can be saved, and three tickets cannot resolve a difference of that size against that spread. The design has to say so.

**Conflicts checked.**
- *ADR 0010 decision 1* lists "dispatch routing" and "scout filtering" as not Jev's. Context supply is neither: it chooses no cell, model or depth, and it trims no output. It is a different capability from 0010's two decision points, so 0010 is followed, not amended.
- *ADR 0010 decision 9* says source files never leave the machine. That sentence scopes `scripts/jev.mjs`, which reads the ticket and a test-output file only. `jg` is a different program with different exposure, and the user allowed source excerpts to go to TypeSafe on 2026-09-28 (ticket 04 comments), with `.env` and secrets excluded. This ADR records that exposure for jg. **Proposed, not made:** a one-line pointer in 0010 decision 9 to this ADR (an ADR edit is a pass gate).
- *ADR 0001* (no Claude API from the office) and *0004* (OS-agnostic) hold: jg is not the Claude API, and the wrapper is plain Node.
- *ADR 0010 decision 2's reasoning* (skills and MCP servers cost context in every session) applies here too, and drives decision 2.

**Decision.**

1. **In scope, as its own capability.** Supplying codebase context to a cold cell at dispatch is in scope for the organism, through `jg`. Jev's decision points stay as 0010 has them. `jg` is a user-installed system tool (`npm install -g`), not a repo dependency, so `package.json` does not change.

2. **Push a path, never content, and the orchestrator never reads it.** Copying excerpts into a dispatch prompt would spend the orchestrator's Opus context on text meant for Sonnet cells, and it would bake in whatever jg returned. Instead the orchestrator runs a script once per ticket and adds one line to the dispatch prompt: `Start-here context: <path> (jg output; read before searching; may be incomplete or stale)`. The cell decides whether it needs more. Rejected: pasting the top N paths and excerpts into the prompt (the ticket's first idea), for the reason above.

3. **Interface** (deep module: one script, one call per ticket).
   ```
   node scripts/dispatch-context.mjs --ticket <feature>/<NN-slug> [--root <dir>] [--refresh]
   ```
   - *Input:* the ticket's `What to build` text only. The script builds the question ("Where would this change be made, and which tests cover it?" plus that text, cut to 1,500 characters). It reads nothing else.
   - *Output:* writes `$ORGANISM_ROOT/.scratch/_context/<feature>/<NN-slug>.md`, prints one JSON line `{"path","bytes","skipped","fallback"}`, and appends a `kind:"jg"` row to `.scratch/usage.jsonl`: `ts, ticket, bytes, files, ms, skipped, fallback`. Exit 0 always, except exit 2 for bad arguments. The file is reused by every hop of the relay (qa specify, developer, fix rounds) unless `--refresh`.
   - *Root:* the main checkout by default. Search runs with `--exclude '.scratch/'` so the board's plans and old handoffs do not answer code questions. `.claude/worktrees/` and `.env*` are already gitignored, and jg honors ignore files. Because the developer's worktree contains the qa tests that main lacks, the qa handoff, not this file, names those tests.
   - *Skip (no jg call):* the ticket type is not a code type; or the `What to build` text names two or more existing tracked paths (already located; this is the case where the trial data shows jg going unused); or `jg files` reports the root over 5 MB eligible.
   - *Fallback (writes no file, run continues cold, exactly today's behavior):* `jg` missing, not authenticated, non-zero exit, a 90 s timeout, output lacking the `End context.` marker (incomplete), or a match of a `scripts/risk-check.mjs` secret pattern in the output. The row records the reason. Output is capped at 24 KB (`--max-source-bytes`).
   - *Which cells:* architect, qa `specify` and developer, the stages that start cold. Not qa `verify` or security (both work from a diff and the handoffs; 0 of 6 jg uses), not the orchestrator.

4. **Scout: pull, not push.** Scout's job is verbose codebase surveys, where jg is documented to help. The proposed change is one line in `.claude/agents/scout.md`: for behavioral questions, run `command -v jg` and start with `jg "<question>" .` when present, else grep as today. This is `.claude/` work; only the orchestrator applies it, with the user's permission.

5. **Data exposure** (for `security`). *Leaves the machine, to the provider chosen at `jg auth` only:* eligible source of the search root and the question text. *Never sent by the wrapper:* anything outside the root, the board (`--exclude '.scratch/'`), transcripts, locks. Jg's own filter is documented as not a guarantee that all sensitive information is removed, so the script also refuses to run when the root contains a file matching a `risk-check` secret pattern outside gitignored paths (fallback `secret-in-root`, checked with `git ls-files`), and `security` should review that check. *Key:* the user runs `jg auth` themselves (interactive, or `--stdin` from their secret manager); jg stores it in `~/.config/jevgrep/credentials.json`. No cell enters, reads, prints or passes a key, in line with 0010. In cloud sessions jg ignores `TYPESAFE_API_KEY`, so the user must run `jg auth` there once. jg's Node process may also need `NODE_USE_ENV_PROXY=1` to leave the sandbox; the script sets it for its child.

6. **Cost.** Jg's Jev spend goes to the user's provider account, outside 0010's $0.50 cap, and jg prints no cost. Bounds: one search per ticket (reused), the 5 MB skip, the 24 KB output cap, and a 90 s timeout. The trial reads real spend from the provider dashboard (the user reports it) and adds it to the token comparison.

7. **Test seam.** The exported `buildContext({ticketText, root, run, exists, now})` returns `{file?, row}`. The one seam is `run` (real `spawn` of `jg` in production, a fake in tests: two adapters). Skip rules, question building, caps, each fallback, secret handling and row shape are tested through it. `jg` itself is never mocked deeper.

8. **Trial, then the user's go/no-go.** Thresholds are fixed here, before any result exists.
   - *Phase 1, retrieval replay (no cells, cheap, controlled).* For at least 10 resolved code tickets, run the script on the ticket text and compare the listed paths with the files the merged PR touched (non-test, non-doc). Report recall, count of listed paths, bytes and ms. Continue only if median recall is at least 0.6 and median output is at most 24 KB. This measures context quality with no cell-token noise.
   - *Phase 2, live relay on 3 or more consecutive code tickets*, both cold stages given the path. Baseline is the `cell` rows already in `usage.jsonl` (qa specify median 49.5k, developer median 50.9k), plus each handoff's `jg vs grep` line. Tag the tickets' cell rows with `ctx:jg` in `--outcome`. Report per stage: tokens, exploration calls (Read, Grep, Glob, jg) before the first edit, whether the context file was read, bounces, and provider spend.
   - *Go* needs all of: no more bounces than baseline; specify plus developer tokens per ticket below the baseline sum (about 100k) on at least 2 of 3 tickets, none above 1.25 times it; provider spend for the trial under 1% of the plan usage those tickets consumed. State plainly that 3 tickets cannot establish significance given the spread above; a go is a judgment call the user makes with the numbers and the spread, and a borderline result extends the trial by 3 tickets rather than deciding.
   - *No-go* stops the script (delete it) and leaves jg as an optional tool for cells that reach for it.

**Considered options.**
- *Design A, push content into the dispatch prompt* (the ticket's idea). Rejected: costs orchestrator Opus tokens on every dispatch, and inserts unverified excerpts into the prompt whether or not the cell needs them.
- *Design B, pull only: tell every genome to start with jg.* Rejected as the main path: cells already use it on 3 of 3 qa specify tickets and 1 of 3 developer tickets without a rule, each cell searching again for the same ticket; installing the skill in every session costs description tokens (0010's reason). Kept for scout, where surveys are the job.
- *Design C, script writes a file and the prompt carries the path (chosen).* One search per ticket serves every hop; caps, skip rules, secret handling and logging live once (deletion test: they would be copied into every genome or dispatch otherwise).
- *Jev picks the relevant files via `jev.mjs`.* Rejected: `jev.mjs` sees only the ticket and test output (0010), and jg is the purpose-built tool for repository text.
- *Judge the trial on cell tokens alone at n=3.* Rejected: spread is 50x, so it would decide on noise; phase 1 and the exploration-call counts carry the signal.

**Consequences.**
- Nothing is built yet. Follow-ups, unpublished: (A) build and test `scripts/dispatch-context.mjs` (developer, needs the user's yes and a working `jg auth`); (B) `.claude/` edits by the orchestrator: orchestrator relay step to run the script and add the prompt line to cold-cell dispatches, and the scout line (user permission); (C) phase 1 replay script and report (developer or scout); (D) user runs `jg auth` and `jg doctor` in the target environment.
- The `usage.jsonl` kinds list in the orchestrator genome gains `kind:"jg"`; that line changes only with the user's permission.
- `CONTEXT.md` gets no new terms yet. If adopted, **start-here context** may be worth defining.
- Open: whether jg's index cache under local state persists across cloud sessions; whether the relay should refresh the file when the developer's base moves off main.

**Amendment 1 (2026-10-07, organism-infra/136, the user's go-live terms):** decision 3's "Which cells" bullet is replaced. The start-here context file goes to every hop that starts cold: architect, qa `specify`, developer, and also full qa `verify`, `security` and `scout`. The evidence behind the old exclusion (0 of 6 `jg` uses at verify and security) predates the trial. Decision 4 hardens from "may" to a rule: `scout` calls `jg` before grepping, and falls back to `rg` as today. The orchestrator role file's step 0 and `scripts/dispatch-prompt.mjs` change with it; the role-file text is gated `.claude/` work, written as exact text in ticket 136. See ADR 0015 Amendment 2.
