# Default to one active cell, with relay handoffs

> Terms: written before ADR 0028, which renamed the vocabulary (cell → agent, cell type → role, genome → role definition, station → team, organism → the org, apoptosis → hand off and exit).

On the Pro plan, the default endocrine limit (`max_concurrent_cells`) is eight active cells at a time (configurable, and never above the 8-session cap), plus cheap `scout` subagents. *(Amended 2026-10-12, organism-infra/226: the default was one, then two. The bridge counts live agents plus claim locks against it, ADR 0016 amendment 14.)* Cells hand off through files on the board. This replaces the more obvious parallel swarm because every active cell re-sends its whole context each request, and agent teams cost about 7x the tokens. New spawns auto-pause at 90% of the usage window.
