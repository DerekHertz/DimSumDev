---
name: interrogate
description: "Adversarial two-model review of a change, sorted into act on, consider, noted, dismissed. Use for 'interrogate'. Applies nothing."
---

# Interrogate

Two reviewers on different models review the same change. The adversarial signal comes from model diversity, not assigned personas. The deliverable is a synthesized verdict. Do not apply changes.

## 1. Scope and intent

Take the files or diff the user names. On a feature branch use `git diff main...HEAD`. State the intent in one paragraph from the request, the commit messages, the ticket and the code. If you cannot, ask the user before going on.

## 2. Reviewers

Start both in one message, read-only, each with the intent, the diff, and the rubric in `references/rubric.md`:

- **Reviewer A:** `code-reviewer` on its own model.
- **Reviewer B:** a different model. Use Codex when the den's Codex adapter is enabled (`.codex/config.toml`); otherwise a general-purpose agent on a different Claude tier from A.

Reviewers return findings as `file:line`, a failure scenario and a severity. They write no code. A reviewer that reaches a different model through the bridge counts toward `max_concurrent_agents`.

## 3. Synthesize

Merge findings that describe the same issue and note who raised each. Two reviewers raising the same issue independently is the strongest signal; a lone finding gets read but weighted less. Record disagreements.

## 4. Lead judgment

You are a pragmatic senior engineer, not a neutral aggregator. Use `references/lead-judgment.md`. Sort every finding into one bucket with who raised it and a one-line reason:

- **Act on.** Real correctness, security or maintainability issues that would block a PR.
- **Consider.** Legitimate, but unclear whether the cost is worth it now.
- **Noted.** Valid but not actionable.
- **Dismissed.** Wrong, nitpicky or missing context, with the reason.

## Output

Intent (quoted), Reviewers (label, model, finding count), Act on, Consider, Noted, Dismissed, and an agreement map: where the models agreed or split and what that pattern says.

<!-- Adapted from pstack interrogate (MIT, Lauren Tan). See .claude/skills/VENDORED.md. -->
