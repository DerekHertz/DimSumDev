# Meetings

Open **Meetings** to start a discussion or search existing records. History lists open meetings before ended ones. Search by topic, summary or task, and filter by project, participant or status. Opening a record does not resume it.

Expand **Recent activity** in the den to see recent meeting, agent and work updates. Select an entry to open its linked record or view; collapse the feed when you want more room for the scene.

## Set up a discussion

Choose the project, enter a topic, and optionally link a task. Task-linked meetings default to the task's owner; standalone meetings default to Bao. You can choose **Bao · Claude** or **Jiao · Codex** before starting.

Select up to six specialists. **Suggest who** asks the moderator for specialists and reasons; review and edit the selection yourself. The suggestion consultation is a separate run with its own approved budget and private record.

- **Quick takes** asks for concise independent views and focused follow-ups, with code reading when needed.
- **Dig in** asks specialists to investigate relevant code and documents and bring evidence into the discussion.

Review the estimated cost range and editable budget, then choose **Approve setup & start meeting**. The initial range covers opening takes and one moderation pass; further discussion adds work. Specialists start at Medium effort. The moderator may request High effort with a recorded reason.

## Discuss and decide

Conversation appears beside questions and decisions. On narrow screens, use the **Conversation** and **Questions & decisions** tabs. Expand a contribution for its explanation, sources, confidence and recorded tool activity. Unavailable confidence or billing is labeled explicitly.

Use **Ask someone to respond** to send a participant a source message. Extra instructions are optional: choose the participant and send, or add a focused question first. Send a redirect through the composer at any time: it is recorded as **Applies next**. Current responses finish before redirects or participant changes take effect. New participants receive the discussion context.

A decision presents a question, recommendation, alternatives, tradeoffs and source links. Choose an option or write your answer to record it and resume within budget. **Discuss more** sends the question back to the relevant specialists. Answering a decision creates no ticket. Missing contributions remain visible with **Retry**, and decisions requiring that input wait.

## Budget and meeting controls

The status strip separates reported actual cost from estimates used when billing is unavailable, and shows work underway. Before another run would exceed the remaining planning allowance, the meeting waits for explicit approval of a larger total budget. This includes retries and effort increases; estimates are not an exact billing cutoff.

Closing the panel hides it while preserving the meeting. **Pause** shows **Pausing…** until current responses finish and their cost is counted, then **Paused**. No further work starts until **Resume**.

A task-linked meeting holds its task through current responses, including cancellation. Once no work remains underway, it releases the hold while paused, waiting for a decision or budget, ready for review, or ended. Before starting more work, it must reacquire the task; if another run holds it, the meeting waits.

**Ready for review** means the moderator has settled the discussion and stopped starting work. **End meeting…** saves the summary, agreed decisions and unanswered questions without creating tickets. Ended meetings stay ended. **Continue this discussion** offers setup for a linked new meeting, carrying the earlier summary, decisions and questions.

## Private records and follow-ups

Meeting records have no automatic expiry. The bridge keeps their chronology, attribution, source links, decisions and costs in private state, outside public git. After a bridge restart, interrupted work waits for explicit Resume. Authenticated meeting reads provide the discussion; the scene feed carries meeting metadata.

At final review, select proposed follow-ups, edit their titles and write the exact ticket text. Private discussion is not copied into that text automatically. You can include or remove the private-record link before previewing it. The link opens the record in your local den without resuming the meeting.

Choose **Preview exact public tickets**, inspect the text, then **Approve & create selected tickets**. This creates local board tickets at `ready-for-human`; it does not post to GitHub or start execution.

Implementation sources: [workspace controls](../apps/ui/src/overlay/Meetings.jsx), [meeting lifecycle and budgets](../apps/bridge/meetings/runner.mjs), [private record storage](../apps/bridge/meetings/log.mjs), [authenticated routes and ticket creation](../apps/bridge/server.mjs), and [opening a record](../apps/ui/src/App.jsx).
