# Cells are unmodified `claude` CLI processes on the owner's subscription

> Terms: written before ADR 0028, which renamed the vocabulary (cell → agent, cell type → role, genome → role definition, station → team, organism → the org, apoptosis → hand off and exit).

Agent Office is for the owner's personal use only (the front end may be demoed to others). Every Claude cell therefore runs the official `claude` CLI under the owner's Pro login. The office observes cells through hooks, `claude agents --json`, and transcripts, and never calls the model API directly or uses the Agent SDK.

Using the Agent SDK on a subscription login is contradicted by Anthropic's Feb 2026 statements. Moving to the SDK with an API key becomes necessary if the tool is shared, runs unattended at scale, or needs in-process control.
