# The board is local markdown in the main checkout, claimed by lock files

> Terms: written before ADR 0028, which renamed the vocabulary (cell → agent, cell type → role, genome → role definition, station → team, organism → the org, apoptosis → hand off and exit).

Work lives in `.scratch/` using the mattpocock/skills local tracker convention, not GitHub Issues. This keeps the office repo-host agnostic, offline, and fast for agents. Cells in worktrees read and write the board in the main checkout (`$ORGANISM_ROOT`), not their own copy, and claim tickets by atomically creating a `.lock` file.
