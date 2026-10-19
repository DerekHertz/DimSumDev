# 02: `board` CLI with a direct-file backend

**What to build:** A `board` command that every cell calls through the shell for all board changes: claim, release, status, comment and list, with the command set from 01's ADR. Until the daemon exists, it writes the markdown board in the main checkout directly. It finds the checkout via `$ORGANISM_ROOT` or `git worktree list`, and claims with atomic lock files. Its interface must match 01's ADR, so ticket 03 can swap the transport without changing the calls.

**Blocked by:** 01

**Status:** resolved

- [x] `board claim|release|status|comment|list` work from any worktree and write only to the main checkout's board
- [x] Two concurrent claims of the same ticket: exactly one wins (tested)
- [x] Comments are appended with the cell type and date; statuses are validated against `docs/agents/issue-tracker.md`
- [x] `organism-protocol` and the genomes tell cells to use `board` rather than editing board files (brain gate: genome change)
- [x] Runs the full code relay: qa specify, developer, qa verify, security review

## Comments

- **QA specify (qa, 2026-09-27):** Branch `qa/organism-infra-02-board-cli`, tests at `apps/organism-infra/board-cli.test.mjs` (+ helper `apps/organism-infra/board-fixture.mjs`). 19 `node --test` cases, all real child-process runs of `apps/organism-infra/board.mjs` against disposable git fixtures (no repo `.scratch/` touched). All fail now on the missing CLI module, confirmed by running the suite.
  Criterion map:
  - Main-checkout writes (worktree + `$ORGANISM_ROOT` resolution): tests 1-2
  - Two concurrent claims, exactly one wins: test 3
  - Locking (live lock never stolen, stale reclaim past age floor, fresh-lock/different-host not reclaimed, claim lock never auto-expires): tests 4-8. Pinned a write-lock file convention (`<ticket>.write-lock.json`, JSON `{pid,host,createdAt}`) since the ADR fixes the content schema but not a path — flagged for the developer/verify stage in case a different convention is chosen.
  - Atomic writes + events.jsonl schema, no temp-file leftovers, release as one atomic call: tests 9-12
  - Comment stamped with cell type + date: test 13
  - Validation (path traversal in ticket id/feature, oversized args, symlink escape): tests 14-17 (symlink test self-skips if the sandbox can't create symlinks)
  - status/list output: tests 18-19
  - `human-verified`: "`organism-protocol` and the genomes tell cells to use `board`" (genome/skill wording change, not test-observable) and "runs the full code relay" (process criterion, verified by this relay itself running).
- **Developer (developer, 2026-09-27):** Branch `claude/organism-infra-02-board-cli` off qa's `fdd4d01`, commit `2850cdd`. Implemented `apps/organism-infra/board.mjs` (thin CLI) over `apps/organism-infra/board-service.mjs` (claim/release/status/comment/list, write-lock + claim-lock per ADR 0008, atomic writes, events.jsonl). Used qa's pinned write-lock path convention (`<ticket>.write-lock.json`) as-is, no change needed. All 19 tests in `board-cli.test.mjs` pass unmodified; full `npm test` is 81/81, exit 0. No new dependencies; added npm `board` script and a `bin` entry. Status left at `in-review` for qa verify. Full report in `.scratch/organism-infra/handoffs/02-developer.md`, including proposed `organism-protocol`/genome wording (not applied, brain gate).
- **QA verify pass (qa, 2026-09-27):** Light verify (qa wrote the tests in specify at fdd4d01). Detached checkout of developer commit 2850cdd in a scratch worktree. npm install (node_modules absent), npm test: 81/81 pass, exit 0, including all 19 board-cli.test.mjs cases. Diff of fdd4d01 vs 2850cdd for board-cli.test.mjs and board-fixture.mjs is empty, no weakening. Manual spot-check against a disposable temp fixture (never the real board, deleted after): board claim demo-feature/01-thing qa succeeded exit 0; board status returned claimed; board list returned the ref and status tab-separated. All criteria have passing tests except the two marked human-verified in the specify comment (genome/protocol wording, and running the full relay). No processes left running. Handing off to security review.
- **Security review (security, 2026-09-27):** Pass. Diffed 2850cdd vs origin/main. Path/symlink validation, execFileSync arg-array usage, events.jsonl JSON escaping, write-lock reclaim (same-host+dead-pid+age-floor+tombstone+exclusive recreate), and atomic tmp+rename all check out; no new dependency (bin/script entries only, no lockfile change needed); no secrets in the diff; no CI/workflow files touched. Two non-blocking findings for the backlog: (1) Medium, board-service.mjs comment() (~L343-370) does not escape embedded newlines in free-text comments, so a caller can inject a fake attributed line forging another cell's sign-off in the visible comment trail (readStatus/replaceStatus first-match regex protects the real Status: line from override, but forged comment stamps are indistinguishable from real ones) -- worth a follow-up ticket. (2) Low, assertWithinRoot's realpath containment check (~L102-116) runs once per operation on issuesDir in prepare(), not re-verified at each subsequent write/open, a TOCTOU window under a racing symlink swap (low likelihood, local single-user tool, no network exposure yet). (3) Low, reclaim tombstone files are never cleaned up (hygiene only). Full report: `.scratch/organism-infra/handoffs/02-security.md`
- **Developer (developer, 2026-09-27):** Attempted the approved narrowed-exception docs commit on `claude/organism-infra-02-board-cli` (commit `71321cd`, on top of `2850cdd`). The harness's self-modification guard blocked editing `.claude/skills/organism-protocol/SKILL.md` and would block any `.claude/agents/*` genome edit in this session; only `docs/agents/issue-tracker.md` (board claim as claim-lock creator) landed. `risk-check` clean on `2850cdd..HEAD`, `npm test` 81/81. The `organism-protocol` wording (narrowed handoff-only exception, future `board handoff` note) still needs a session that can write those files.
- **orchestrator, 2026-09-27:** PR #15 merged (main 256159f); organism-protocol now points cells at board (70276d0, user-applied).
