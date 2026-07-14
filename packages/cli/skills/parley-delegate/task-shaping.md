# Shaping a non-default task

Read this when a task needs more than `-v <vendor> -m <model> -n <name> --session <id>` — structured results, a custom fork point, tighter sandboxing, or several context files.

## Structured reports

`--report-schema <file>` (JSON Schema) makes the child's report conform to your shape — e.g. a findings list from a review task. Validation failures bounce back to the child to retry, so the envelope you receive always conforms. Without it you get the default schema: `summary`, `outcome: success|partial|blocked`, `files_changed`.

## Worktree base

Tasks branch from HEAD by default; `--base-ref <ref>` overrides — use it in dependency waves so a follow-up task forks from its actual prerequisite instead of a stale shared HEAD. `--cwd <path>` skips worktree creation entirely and runs in that directory — escape hatch only, forfeits isolation.

```
parley delegate -v codex -m <model> -n task-b --session <id> --base-ref task-a-merged "<brief>"
```

## Sandbox

Default posture is workspace-write + network, approvals off. Tighten or loosen per task:

- `--sandbox read-only` for review/analysis tasks that shouldn't write.
- `--no-network` to cut egress.
- `--sandbox full` only when the task genuinely needs to escape the workspace.

## Task state vocabulary

The exact strings `status --json` reports in `state`: `pending`, `running`, `awaiting_answer`, `stalled`, `completed`, `failed`, `cancelled`. If you ever grep states by hand, match on `awaiting_answer` — the word "question" never appears in the field, and a filter for it silently misses a parked child.
