# Claude-specific features live behind a runtime adapter

The office must be OS- and model-agnostic. The daemon talks to every runtime through one adapter interface (spawn, stream events, send message, approve/deny, stop). Claude Code hooks, agent view, and subagents are optimizations inside the Claude adapter, never core dependencies. Other runtimes get a lowest-common-denominator event stream.

## Amendment: shared host and canonical runtime identity

Approved by the user in the Codex residents plan (codex-residents/01). One bridge host owns admission, state and approvals for all runtimes. A validated canonical runtime (`claude` or `codex`) selects a `CellRuntime` adapter within that host. Separate hosts per runtime are rejected because they split ticket exclusion and capacity authority. Runtime protocol translation remains inside its adapter. Adapter names do not determine persisted runtime identity; an omitted selector retains Claude behavior.
