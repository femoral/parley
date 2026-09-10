# ADR-0005: Parley-owned worktrees with canonical AGENTS.md translation; parley never merges

**Status**: accepted, **amended by ADR-0018 and #401** · **Date**: 2026-07-09 · **Decided**: [#7](https://github.com/femoral/parley/issues/7), context layout [#8](https://github.com/femoral/parley/issues/8)

## Context
Each task needs isolation. Codex reads AGENTS.md/.agents/skills; Grok reads the AGENTS.md family and Claude config natively (scanners on by default — double-loading risk).

## Decision
- Parley creates worktrees at `~/.parley/worktrees/<repo>/<task>` (outside the repo), branch `parley/<id>-<name>` from current HEAD (`--base-ref` overrides).
- Canonical config surface: symlink `CLAUDE.md → AGENTS.md`, `.claude/skills → .agents/skills`; disable grok's Claude scanners per child. Grok gets a generated `.grok/config.toml`; codex is flags-only.
- Task context materialized as `.parley/TASK.md` + `.parley/context/`; every generated path goes in `.git/info/exclude`.
- Parley never merges. Reports carry branch + worktree path; `parley clean` removes worktrees (branches kept), auto-remove only when untouched — where *untouched* means no commit past the base, nothing uncommitted or untracked, **and no child-authored ignored artifact** (see the #401 amendment).

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

**#401** (child-authored ignored artifacts). The decision does not change — auto-remove still fires only on an untouched worktree — but the definition of *untouched* was wrong:

- `git status --porcelain` never lists gitignored files, so a report-only task whose entire product was a gitignored draft read as an untouched worktree: auto-remove reclaimed it, silently, while the task's own report still pointed at the vanished paths.
- A worktree holding a **child-authored ignored artifact** is *touched*. An entry from `git status --ignored` is the child's unless it is parley plumbing, subtracted on two legs, **both required**: (1) paths parley registered in the worktree-scoped `parley-exclude`, compared at directory granularity because `--ignored` collapses to it; (2) for whatever survives, the exclude file `git check-ignore -v` attributes the match to. Leg 1 is not redundant — a path ignored by both the repo `.gitignore` and parley's `core.excludesFile` is attributed to `.gitignore`, so in any repo whose `.gitignore` covers a vendor dir (`.grok/`, `.claude/`, `.codex/`), attribution alone would read parley's own materialized config as the child's work and retain every worktree in that repo forever.
- Retention triggers on **any** such artifact, not only paths the report declared in `files_changed` — a thin envelope over an undeclared draft is exactly the case being fixed — and the retain branch writes a diag line naming the condition and the paths, so auto-remove stops being silent about its decisions.
- The same predicate gates the `parley clean` refusal (with a reason; `--force` still removes) and run-terminal checkout retention. Runs get **no exemption** for their gitignored cross-step handoff dir (`.parley/tmp/`, which lives under parley's own `.parley/` but holds the child's output): a run whose handoff channel still holds files is a run worth inspecting, and `parley clean <run>` is the explicit exit. Run-terminal reclamation therefore flips from usually-removes to usually-retains.
- Retention/gc **expiry is unaffected** — an expired worktree is purged whatever it holds (a configured deadline is not an accident), with a diag line for symmetry.
- **Consequence, accepted:** "any ignored file" includes build output. In a repo that gitignores `node_modules/` or `dist/`, a task that installs or builds leaves a child-authored ignored artifact, so its worktree is retained and `parley clean` refuses it without `--force`. Auto-remove was never the disk-reclamation mechanism — retention/gc expiry is — and a heuristic that guessed which ignored files are "only build output" would guess wrong on exactly the report-only drafts this fixes. The exits stay `clean --force`, `clean --all-terminal --force`, and expiry.
- On any git failure the predicates report modified/dirty, erring toward keeping the child's work.
