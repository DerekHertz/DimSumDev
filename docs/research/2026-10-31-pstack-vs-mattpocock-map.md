# pstack vs Matt Pocock skills: mapping for review

Date: 2026-10-31. Inputs: `.claude/skills/VENDORED.md`, role frontmatter in `.claude/agents/*.md`, every `SKILL.md` in pstack 0.15.36 (`~/.claude/plugins/cache/cursor-plugins/pstack/0.15.36/skills/`), and the poteto-mode playbooks (`skills/poteto-mode/playbooks/*.md`), which hold much of pstack's process.

## Read this first

- **pstack has no planning chain.** It has no grilling, spec, ticket-breakdown, glossary/ADR or handoff skill (`poteto-help`: "pstack has no planning skill"). Its process lives in `poteto-mode` playbooks (Feature, Bug fix, Prototype, Multi-phase plan, Pause safely), which assume one agent that owns the work and opens the PR. The den's relay splits that work across roles, so it can't run those playbooks as they are.
- **Where pstack is stronger:** design and investigation fan-out (`architect`, `arena`, `swarm`, `how`, `why`), formal state checking (`statechart`), and 25 one-screen principles.
- **Port cost:** every pstack skill is `disable-model-invocation: true` and written for Cursor: `pstack-models.mdc`, Grok defaults, cloud subagents and `~/.cursor` paths. A Claude Code adapter (`docs/harness/claude-code.md`) maps those names. As with the 10 skills already adopted, a den copy has to drop the flag, swap the paths and fit the Codex 16 KB preload budget.
- **Concurrency clash:** `swarm`, `arena`, `architect`, `how` and `why` fan out to 2-4+ subagents, while the den caps `max_concurrent_agents: 2` on a Pro plan. Count each one's cost before preloading it.

## 1. Matt Pocock skills

Preloads come from role frontmatter. Body mentions are in brackets.

| MP skill | What it does | Preloaded by | Den adaptations | Best pstack counterpart | Closeness | Lost by switching | Call |
|---|---|---|---|---|---|---|---|
| grilling | Interviews the user in rounds over a design tree, one recommendation per question, until the frontier is empty | chief-of-staff, product | Counts open questions per round; hands off to wayfinder when the frontier grows | none. Nearest: `sharpen` (deepen the ask), `in-your-own-words` (restate the goal), `principle-never-block-on-the-human` (decide reversible calls yourself) | none | The whole interview method. pstack avoids questions where MP's grilling asks them | **Keep MP** (redesign under way). Borrow `in-your-own-words` as the opening move and `never-block-on-the-human` as the facts-vs-decisions filter |
| domain-modeling | Keeps CONTEXT.md and ADRs current during a session; challenges fuzzy terms | chief-of-staff, product [architect] | none | `principle-model-the-domain` | different angle (data structures in code, not a glossary or ADRs) | CONTEXT.md and ADR upkeep, which the den depends on | **Keep MP**; add `principle-model-the-domain` to developer |
| codebase-design | Vocabulary for deep modules, seams and adapters; deletion test; design-it-twice | none [architect, tdd] | Shorter description | `architect` (sketch types, arena design-twice, scrap rules) + `principle-minimize-reader-load`, `-foundational-thinking` | overlapping | The shared vocabulary that tdd and code-review cite ("seam", "depth") | **Merge**: architect role runs pstack `architect` as its process and keeps codebase-design as reference |
| prototype | Throwaway code for one design question: a logic HTML demo or switchable UI variants | none [architect, wayfinder] | none | poteto-mode Prototype playbook + `principle-exhaust-the-design-space` | same | MP's LOGIC.md and UI.md recipes; the "capture on a throwaway branch" rule | **Merge**: take pstack's steps (scope the decision, verify each variant on its surface, recommend) and keep MP's two recipe files |
| research | Background agent reads primary sources and writes a cited Markdown note | none | none | `why` (repo, PR and chat history) | different angle (external docs vs internal history) | External primary-source research | **Keep MP**; add `why` for internal history |
| tdd | Red-green loop: good tests, agreed seams, anti-patterns, vertical slices | developer, qa | Seam note: what each seam catches and misses | `tdd` (bug-fix regression test only, "use only when explicitly asked") + `principle-test-behavior-not-implementation` | overlapping, narrower | pstack's version would break the den rule that every code ticket writes failing tests first | **Keep MP**. Fold pstack's "prefer no new test over a bad test" and its failing-before/passing-after report into MP |
| diagnosing-bugs | Feedback loop first (10 ways to build one), then reproduce, hypothesise, instrument, fix | none [developer on bug tickets] | Asks where else the cause exists and fixes at the cause's layer; forced-mutation check | Bug fix playbook + `principle-fix-root-causes`, `-attack-the-premise` | overlapping | MP's catalogue of feedback loops and the HITL script | **Merge**: keep the MP loop; add the playbook's binary search plus `why` for regression history, and `attack-the-premise` after two failed fixes |
| wayfinder | Maps more than a session's work as decision tickets on the board, resolved one at a time | none | Starts from a grilling hand-off note; board paths; label rules | `figure-it-out` + Multi-phase plan playbook | overlapping (pstack plans and runs; wayfinder only decides) | Board-native decision tickets and the "fog" handling | **Switch to `figure-it-out`** for big runs; retire wayfinder once the grilling redesign settles the hand-off |
| resolving-merge-conflicts | Resolve each hunk from its primary sources; never abort | none | none | Babysit playbook (conflicts are one step) | overlapping, thinner | Nothing much | **Keep MP** (14 lines) |
| writing-for-agents | Context pointers, the two loads, information hierarchy, when to split a skill | technical-writer | none | Authoring-a-skill playbook + `principle-encode-lessons-in-structure`, `-guard-the-context-window` | overlapping, thinner | The deeper model (context vs cognitive load, pruning) | **Keep MP**; add encode-lessons-in-structure |
| handoff | Compacts work into a board handoff with fixed sections | none (every role calls `/handoff` via team-protocol) | Writes to `.scratch/<feature>/handoffs/`; 60-line cap; model-invocable | Pause safely + Session pickup playbooks | overlapping | Board integration and the den's fixed sections | **Keep (den form)**; borrow Pause safely's "what's on disk vs in your head" line |
| implement | Claim, state the outcome, tdd, verify, code-review, commit, never merge, hand off | developer | Claims through team-protocol; output to `runner`; never merges; ends with /handoff | Feature playbook (`how`, `architect`, throughput checkpoint, delegate code, verify) | different angle (pstack's lead delegates the code; the den's developer writes it) | Fit with the relay roles | **Keep MP-adapted**; add `principle-prove-it-works` and the Feature playbook's "verify on the real surface; inconclusive is not a pass" |
| to-tickets | Splits a spec into vertical-slice tickets with blocking edges and token estimates | none [chief-of-staff] | Pass gate; type, Why, Cause, estimate, done-when checks, paths | Multi-phase plan playbook (one checklist file, not tickets) | different angle | Board tickets and blocking edges | **Keep MP**; add `principle-sequence-verifiable-units` |
| to-spec | Turns a settled conversation into a spec on the board | product | Model-invocable; board path | none | none | everything | **Keep MP** |
| code-review | Standards and Spec axes in parallel, plus a smell baseline | code-reviewer | Pro budget note; board path | `interrogate` (adversarial, already adopted for security), `principle-minimize-reader-load` | different angle | The two-axis Standards/Spec verdict the relay depends on | **Keep MP**; add `minimize-reader-load` to code-reviewer |
| grill-me, grill-with-docs (`.agents/` only, untracked) | Upstream wrappers that call grilling, or grilling plus domain-modeling | none | none (not in VENDORED.md) | none | none | nothing | **Drop**, or decide during the grilling redesign |

## 2. pstack skills with no MP counterpart

Already in the den (adopted 2026-10-22): automate-me, blast-radius, correct, show-me-your-work, reflect, interrogate, no-comments, unslop, principle-laziness-protocol, principle-subtract-before-you-add.

| pstack skill | What it adds | Roles it suits | Note |
|---|---|---|---|
| architect | Ground with `how`, sketch types in an arena, keep a scrap rule | architect | Its runner models are already set in `pstack-models.md`. Costs 2+ runners |
| arena | N candidates, a cross-judge, pick a base, graft the best of the losers | architect (through `architect`), designer for UI variants | Costly; keep for one-way doors |
| swarm | N parallel workers on slices or races, one report | chief-of-staff, qa coverage sweeps | Conflicts with the 2-agent cap; use for read-only sweeps only |
| how | Fan-out explorers plus one explainer for "how does X work" | architect, developer before a non-trivial change, chief-of-staff | Overlaps `jevgrep` for finding code |
| why | Parallel investigators across git, PRs, the board and docs for design rationale | architect, release-manager (regressions), developer on bug tickets | Replaces the git-history substitute in the den's blast-radius and correct |
| teach | `how` + `why` woven into one plain explanation | the user, on request | none |
| statechart | TLA+ model checked by TLC, drawn as a Mermaid statechart, with the shortest path to each broken rule | architect, for the delivery relay, ticket lifecycle and claim locks | Strong fit: the relay is a state machine. Needs Java/TLC through mise |
| create- / maintain-formal-verification-skill | Builds and maintains formal checks where tests reach least | architect, security | Pair with statechart for claim and merge races |
| create- / maintain-verification-skill | Generates and audits a skill that drives the app like a user | qa | `browser-verify` already exists; use the *maintain* skill to audit it |
| figure-it-out | Designs a playbook with rigor levels, a hypothesis loop and a decision log | chief-of-staff, for L tickets and migrations | Replaces wayfinder (section 1) |
| sharpen | "Deeper, not bigger" rewrite of an ask | product, chief-of-staff before ticketing | 16 lines; cheap to preload |
| in-your-own-words, bro | Restate the goal; restate the last message in plain words | chief-of-staff (Bao in chat) | `bro` overlaps `caveman` |
| recall | Rebuilds recent context from transcripts, the shared record and live git/gh | chief-of-staff at session start | Overlaps `rundown` (section 3) |
| ketchup, ketchup-video | Catch-up on this chat plus every call waiting on the user | chief-of-staff | Overlaps `rundown`; the video variant fits the "den should be fun" note |
| poteto-mode | Style + router: principles, playbooks, subagent rules | none as a mode | Its playbooks assume one owner who opens the PR, which fights the relay. Mine the principles and playbooks; don't preload it |
| technical-writing | Diátaxis, Google style, STE, Global English | technical-writer, release-manager (PR and release text) | Merge into `pr-writing` |
| benchmark-checklist | Vets a perf measurement before you report it | developer on perf tickets, Jev evals, sre | Pair with `principle-explain-the-number` |
| typescript-best-practices | TS rules | low fit; the repo is `.mjs` and JS React | skip |
| make-bot-ui | Webhook UI for a Grok Bot over Tailscale | none | skip |
| setup-pstack, poteto-help | Model config and a help desk | the user | `pstack-models.md` already exists |

### Principles not yet adopted (each 10-25 lines; cheap preloads)

| Principle | Roles it suits |
|---|---|
| attack-the-premise, fix-root-causes | developer (bug tickets), qa |
| boundary-discipline, type-system-discipline | developer, code-reviewer |
| build-the-lever, encode-lessons-in-structure | chief-of-staff (`pipeline-retro`), developer |
| exhaust-the-design-space, foundational-thinking, redesign-from-first-principles | architect |
| experience-first | product, designer |
| explain-the-number | sre, developer on perf tickets |
| guard-the-context-window | all roles (matches CLAUDE.md token hygiene); fold into team-protocol |
| make-operations-idempotent, separate-before-serializing-shared-state | architect, developer on bridge and board code |
| migrate-callers-then-delete-legacy-apis, outcome-oriented-execution | architect, developer on refactors |
| minimize-reader-load | code-reviewer |
| model-the-domain | developer |
| never-block-on-the-human | chief-of-staff (relay autonomy) |
| prove-it-works | developer, qa, chief-of-staff (last review) |
| sequence-verifiable-units | chief-of-staff (`to-tickets`), developer (commit stacking) |
| test-behavior-not-implementation | qa; mostly repeats MP tdd's "good test" section |

## 3. Den-original skills (keep; flags where pstack overlaps)

| Skill | pstack overlap | Flag |
|---|---|---|
| team-protocol | `principle-make-operations-idempotent`, `guard-the-context-window` already folded in | none |
| handoff (MP-derived, now den-shaped) | Pause safely playbook | Minor; see section 1 |
| browser-verify | `create-verification-skill` generates exactly this kind of skill | Already covered; run `maintain-verification-skill` against it now and then |
| asset-critique | none | none |
| jevgrep | `how` (locates and explains code) | Different cost: jg is one cheap query, `how` fans out agents |
| pipeline-retro | `correct` + `reflect` (both adopted) | Already composes them |
| rundown | `recall`, `ketchup` | **Covered in part**: ketchup's "every call waiting on the user, with your pick" is a stronger shape for the waiting-on-you section |
| usage-watch | none | none |
| pr-writing | Opening a PR playbook + `technical-writing` | Fold technical-writing's rules into pr-writing |
| caveman (vendored, not MP) | `bro`, poteto-mode's reply rules | none |
| security-audit (Cloudflare) | `interrogate` | Different scope; keep both |
| source-command-queue (`.agents/` only) | none | none |
