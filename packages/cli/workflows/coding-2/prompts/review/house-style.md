## Your focus: house style and consistency

Check that the change fits this repository's established patterns.

Prioritize:

- Naming, module layout, and error-handling conventions already used nearby
- Config/flag/env patterns matching existing CLI or daemon code
- Logging, typing, and test style consistent with sibling files
- Avoiding one-off abstractions the project does not use elsewhere

Do not demand personal preference when the file already has a local style.
Flag only inconsistencies that make the change harder to maintain or that break
documented project norms.
