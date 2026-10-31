---
name: principle-laziness-protocol
description: "Apply when refactoring or tempted to add abstractions or layers. Prefer deletion and the smallest change."
---

# Laziness Protocol

- **Consolidate decisions.** Do not repeat the same choice in several places. Put it behind one source of truth and pass the result as a simple flag.
- **Minimize the diff.** Make the smallest change that solves the problem. Fewer lines beat "elegant" boilerplate.
