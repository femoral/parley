# ADR-0005: Parley-owned worktrees with canonical AGENTS.md translation; parley never merges

**Status**: accepted, **amended by ADR-0018** · **Date**: 2026-07-09 · **Decided**: [#7](https://github.com/femoral/parley/issues/7), context layout [#8](https://github.com/femoral/parley/issues/8)

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

## Amendments

**ADR-0018** (workflow runs). Nothing here reverses; four clauses extend or correct:

- A workspace belongs to a **task or a run**. A run owns every checkout and branch in it, so per-task auto-remove and per-task naming do not apply inside one; a run-owned task records a working directory only, with `worktree`/`branch` null.
- A run's workspace is a checkout **or** a parley-owned scratch directory (`workspace: repo | scratch`) — a run need not be in a repo at all.
- Parley **authors checkpoint commits** (`parley: <node>.<iteration>`) at run node boundaries. It still never merges.
- `parley clean` additionally prunes provably-empty run branches (tip == base).
- **Correction:** "every generated path goes in `.git/info/exclude`" is wrong and the code deliberately does not do it — `info/exclude` resolves through the *common* gitdir, so writing there would ignore paths in the user's real checkout. The real mechanism is a worktree-private `parley-exclude` wired via `core.excludesFile --worktree`.
