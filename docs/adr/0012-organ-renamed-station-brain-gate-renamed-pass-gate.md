# 0012: Organ is renamed station; Brain gate is renamed Pass gate

> Terms: written before ADR 0028, which renamed the vocabulary (cell → agent, cell type → role, genome → role definition, station → team, organism → the org, apoptosis → hand off and exit).

Status: accepted (2026-09-29, user decision; carried out in organism-infra/53)

**Context.** The organism metaphor's "organ" grouping was replaced by a kitchen-floor layout drawn on Bao. The user renamed the grouping to **station** (see CONTEXT.md and `design-brief.md` section 4.2).

**Decision.**

- "Organ" is renamed **station** everywhere current: genome frontmatter `organism.station:` (values `pass`, `steamers`, `tea-pantry`, `front-of-house`), skills, `docs/agents/`, code and `CLAUDE.md`.
- Cell prose uses the station name: Pass (orchestrator, product, architect), Steamers (developer, scout, debugger), Tea & Pantry (qa, security), Front of House (designer).
- "Brain gate" is renamed **Pass gate**, because the Brain organ no longer exists. Its meaning is unchanged.
- Earlier ADRs and frozen fixtures keep the old words. They are history and are not rewritten.
