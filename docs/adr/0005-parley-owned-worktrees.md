# ADR-0005: Parley-owned worktrees with canonical AGENTS.md translation; parley never merges

**Status**: accepted · **Date**: 2026-07-09 · **Decided**: [#7](https://github.com/femoral/parley/issues/7), context layout [#8](https://github.com/femoral/parley/issues/8)

## Context
Each task needs isolation. Codex reads AGENTS.md/.agents/skills; Grok reads the AGENTS.md family and Claude config natively (scanners on by default — double-loading risk).

## Decision
- Parley creates worktrees at `~/.parley/worktrees/<repo>/<task>` (outside the repo), branch `parley/<id>-<name>` from current HEAD (`--base-ref` overrides).
- Canonical config surface: symlink `CLAUDE.md → AGENTS.md`, `.claude/skills → .agents/skills`; disable grok's Claude scanners per child. Grok gets a generated `.grok/config.toml`; codex is flags-only.
- Task context materialized as `.parley/TASK.md` + `.parley/context/`; every generated path goes in `.git/info/exclude`.
- Parley never merges. Reports carry branch + worktree path; `parley clean` removes worktrees (branches kept), auto-remove only when untouched.

## Consequences
- Both vendors see one config surface; no plumbing can be committed by the child.
- On-disk context survives stall→resume respawns.
- Merge-back judgment stays with the orchestrator, which reviews diffs — this also justifies the permissive sandbox default (ADR-0006).
