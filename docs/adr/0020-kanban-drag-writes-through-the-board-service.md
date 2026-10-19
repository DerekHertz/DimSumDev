# Kanban drag writes through the board service

> Terms: written before ADR 0028, which renamed the vocabulary (cell → agent, cell type → role, genome → role definition, station → team, organism → the org, apoptosis → hand off and exit).

**Status:** proposed (product, 2026-10-08, from the user's answers in the kanban spec session; the architect cell must accept it before any drag code)

The kanban lets the user drag a card across their own gates (approve, park, waiting on you). The bridge handles the drop by calling the board service (ADR 0008) in-process, so claim rules, locks and `events.jsonl` stay identical to the `board` CLI. The UI never edits ticket files, and a card with a live claim lock is pinned and refuses the move.

**Considered options:** the UI editing ticket files directly (simpler, but skips the event log and claim checks); read-only kanban only (safe, but the user asked for drag).

**Consequences:** the bridge gains its first board write, so it crosses the bridge and board-service packages and needs an architect gate. It also touches the steering channel boundary (ADR 0016): a drop is a board command, not a message to an agent. Allowed moves: proposed or parked to ready (approve), ready to parked, and any user-owned card to or from waiting on you. In-flight and resolved are never drop targets.
