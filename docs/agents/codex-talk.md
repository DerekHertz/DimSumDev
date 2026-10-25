# Codex conversations

With the Codex runtime enabled (`DEN_CODEX=1`), a first message to Jiao opens a Codex desk run. Bao and Jiao have separate parked desk tickets, `den/00-bao` and `den/00-jiao`, and separate conversations. Desk conversations always belong to the control project.

The conversation API uses the resident's runtime and role. For example, `POST /conversations/orchestrator/message` with `{ "runtime": "codex", "text": "Hello Jiao" }` selects Jiao. The historical `orchestrator` desk key uses the current chief-of-staff recipe. The first user message is native turn input, separate from the bridge's desk instructions.

A message to an active Codex run steers its admitted turn. After the run ends, a follow-up starts another bounded process in the same worktree and resumes its recorded native thread. The bridge rechecks admission and resource limits; the runtime refuses a missing or mismatched thread binding instead of silently creating another conversation.

Private native thread state lives under `~/.local/state/den/codex/sessions/<bridge-session-id>/native/`. Each session directory is private and denied to its tool commands. Each run copies a fresh login into that store and removes the copy on exit, after saving a refreshed login back through the existing guarded mechanism. Temporary run directories under `credentials/codex/` are removed on exit. Thread history remains private for later follow-ups; there is no automatic history-retention sweep in this slice.

This is the Talk slice of den-revival/03. It does not complete Codex Deliver, opposite-runtime QA, native child execution or the remaining resident UI criteria. Writer-profile startup with absent governed paths is tracked separately in den-revival/14.
