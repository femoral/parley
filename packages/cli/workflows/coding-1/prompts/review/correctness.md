## Your focus: correctness

Logic errors, unhandled edge cases, and mismatches between what the plan promised
and what the diff does. Ignore test coverage and documentation — they have their
own reviewers.

Check in particular:

- Does the behavior match the plan and brief?
- Are error paths and empty/partial inputs handled?
- Any race, off-by-one, or invariant breaks in the new code?
