# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`. In Agent Office this is the **board**.

## Org additions

- **Its own repo.** `.scratch/` is git-ignored here: it is a separate private git repo cloned into the main checkout (`git clone <board repo> .scratch` on a new machine). Commit and push board changes from inside `.scratch/`; pull there before starting on another device. Never stage board files in this repo.
- **One board.** The board is `.scratch/` in the **main checkout**. `board` finds it from any worktree through `git worktree list` (the main checkout is listed first), so agents need no setup; `$DEN_ROOT` is an optional override, e.g. outside a git checkout. Never use a worktree's copy.
- **Status values:** `ready-for-agent` → `claimed` → `in-review` → `resolved`. `in-review` means a developer finished a code ticket and it is going through the qa and security review stages; only the chief of staff moves it to `resolved`, after the merge. A `security` or `qa --mode verify` claim on an `in-review` ticket keeps it `in-review` (ADR 0008 decision 10); check the `.lock` to see if a review is running. `blocked` and `ready-for-human` can come from any state. Always add a reason in `## Comments`. A ticket the user asked for files at `ready-for-agent`: asking is approval, and an agent confirms at pickup. `ready-for-human` needs a `**Question:**` line naming what the user must decide; without one the ticket isn't ready-for-human, and `npm run queue` flags it `[no Question]`.
- **Claim lock:** `.scratch/<feature>/issues/<NN>-<slug>.lock`, created atomically by `board claim` (see the `team-protocol` skill). The lock holder owns the ticket. Lock files are ignored by the board repo (`.scratch/.gitignore`).
- **Claim modes:** `board claim <ref> <role> --mode <m>`. `qa` must pass `--mode specify` or `--mode verify`. `designer` may pass `--mode review`, `spec`, `critique` or `direction` (a designer verdict needs `review`). Other agents may pass `specify` or `verify` but need no mode. Any other value is refused.
- **Handoffs:** `.scratch/<feature>/handoffs/<NN>-<role>.md` (see the `handoff` skill). The State block names its author: `role` (`cell` before ADR 0028) and `mode` for moded agents such as qa). `board release --status in-review|resolved` accepts only a handoff whose `role`/`mode` match the claim and whose mtime is not older than the claim lock, so an earlier hop's handoff never satisfies it (ADR 0008 decision 11). Write your handoff after claiming and before releasing. `board handoff <ref> --template` prints a State block that already passes validation, with the ticket, agent and mode filled in; draft the handoff under `/tmp`, because `board handoff --from` refuses a file inside a worktree.
- **Resolve:** `board resolve <ref>... --pr <n> [--note "<text>"]` is the chief of staff's one-step resolve after a merge. It claims each ticket as `chief-of-staff`, publishes a minimal chief-of-staff handoff (`<NN>-chief-of-staff-resolve.md`, `current_step: resolved`, the PR in `artifacts`), and releases with `--status resolved --pr <n>`, which writes the usage.jsonl resolved row. Several refs share one `--pr` (a batch). Every ref is checked before the first write: a missing or invalid `--pr`, a missing ticket, an already-resolved ticket, or a lock held by another agent refuses the whole command and changes nothing. A ticket discovered from the ref (see Discovered work) that is still untriaged refuses it too. A failure after writes began names the refs already resolved and the ref it stopped on. The `claim` / `handoff` / `release` path still works.
- **Park and close:** `board park <ref>... --reason "<text>"` sets `parked` (off the relay until there is a reason to bring it back); `board close <ref>... --reason "<text>"` sets `closed` (will not be done); `board unpark <ref>... --reason "<text>"` returns a parked ticket to `ready-for-agent`, and `board reopen <ref>... --reason "<text>"` does the same for a closed one. Each appends a chief-of-staff comment with the reason and one event per ref. Every ref is checked first: a missing, claimed or resolved ticket, or one already at the target status, refuses the whole command and changes nothing. No agent can release into `parked` or `closed`; the frontier and the idle audit skip them. Park anything that cannot name the v1 step or testbed friction it serves (refocus, `docs/refocus/triage-2026-10-02.md`).
- **Board audit:** `board audit [--stale-days N] [--feature F] [--json]` lists board inconsistencies: a claimed or in-review ticket with no lock, a lock with no matching branch or worktree (a branch named in the ticket or its handoffs counts), a `blocked` ticket whose blockers are all resolved, a `Blocked by` ref that does not exist, a handoff `pending` item naming another ticket that is missing or resolved with no comment recording it, and open tickets idle for N days (default 7). It never writes. Exit 0 clean, 1 findings, 2 bad arguments.
- **Discovered work (portable-den/11):** fix forward by default. A small fix found mid-work, in the ticket's own files, off the risk path and under about 30 lines, goes in the same commit with a one-line `Scope added:` comment on the ticket (`board comment`), never a new ticket. Anything larger, outside the ticket's files or on the risk path becomes a ticket, filed and started at once, never queued: `board file <feature> <slug> --discovered-from <ref> --title "<t>" (--text "<request>" | --ticket-file <file with ## Acceptance criteria>) [--priority P2] [--class product|pipeline] [--serves "<form>"] [--status ready-for-agent|ready-for-human] [--type <t>]`. It writes a `**Discovered from:** <ref>` header line (a missing parent is refused). A ticket is *untriaged* while its status is `ready-for-agent` or `ready-for-human`, no claim lock exists and its `## Comments` hold no chief-of-staff comment. `board resolve` and `board release --status resolved` refuse the parent while any ticket discovered from it, in any feature, is untriaged; `--force` does not bypass it. The chief of staff triages by claiming the ticket, parking or closing it (`board park`/`close` leave a chief-of-staff comment), or `board comment <ref> --as chief-of-staff "triaged: <decision>"`. The admission gate has no cap on `Origin: added` tickets any more (ADR 0015 Amendment 4); its class, Serves and incident checks still apply.
- **Release events** carry `force: true|false`; `--force` shows in the audit trail.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- State is recorded as a `Status:` line near the top of each issue file (values above)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## Ticket format

The `to-tickets` template. Each field is a `**Name:**` line near the top of the file:

- `**Type:** feature | bug | spike | chore`. (A wayfinder child ticket uses its own `Type:` values, `research | prototype | grilling | task`; see Wayfinding operations.)
- `**Why:**` the problem and for whom, in a line or two.
- `**What to build:**` the behaviour, not the layers.
- `**Out of scope:**` what an agent must not do.
- `**Cause:**` stays empty. On a `bug` the developer posts the cause note in `## Comments` (symptom, repro, hypotheses, chosen cause, where else, target layer).
- `**Estimate:** ~Nk tokens`. Above 150k, split the ticket; below 30k, merge it into a sibling with the same touch set.
- `Paths (advisory):` the touch set in backticks. It guides; the work may touch other files.
- `**Question:**` (only on a `ready-for-human` ticket) what the user must decide; `npm run queue` shows it under WAITING ON YOU.
- `**Discovered from:** <ref>` (only on a ticket filed from other work; `board file` writes it).
- `**Blocked by:**`, `**Status:**` and optionally `**Priority:**`, then the done-when checks: about 5, with milestones only when the work has more than one.

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Priority**: a `**Priority:** P0|P1|P2|P3` line near the top (P0 urgent, P1 next, P2 normal, P3 someday). No line means P2. Set it when filing a ticket.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed. The Queue puts them in order (`board queue`, `npm run queue`; ADR 0015 Amendment 3): a P0 with a reason first, then tickets in the active feature, then the rest; inside each tier, the ticket that would unblock the most others first (unblock count), then the lower P-level, then the lower ticket number. There is no aging bump: a ticket does not move up by waiting.- **Claim**: set `Status: claimed` (or keep `in-review` for a review claim) and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
