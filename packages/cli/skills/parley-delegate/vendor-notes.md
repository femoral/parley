# Vendor notes

Read this when a child fails at a vendor-specific operation — currently: codex `git commit` failures on older parley builds.

## Codex: worktree commits (fixed in #31)

Codex tasks running in a parley worktree used to be unable to `git commit` their own changes — the sandbox's writable roots covered only the per-worktree gitdir, not the shared `.git` object database, so `git add`/`git commit` failed and the child had to escalate. Fixed in [#31](https://github.com/femoral/parley/issues/31): the sandbox now grants both roots under `workspace` posture. If you hit a commit failure on an older parley build, the workaround was to instruct codex children to leave changes uncommitted and report a suggested commit message instead, with the orchestrator committing from the host.
