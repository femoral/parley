## Your focus: fast sweep

Do a quick pass for obvious defects a careful first read should catch.

Prioritize:

- Clear bugs, typos in public surface, broken imports/exports
- Missing null/empty checks at boundaries
- Tests that cannot pass as written, or no tests for non-trivial new paths
- Mismatches between summary claims and the actual diff

Do not deep-dive architecture or style. If the change looks basically sound for
a fast gate, approve with empty notes.
