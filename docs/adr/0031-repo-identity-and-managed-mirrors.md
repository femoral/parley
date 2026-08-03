# ADR-0031: Repo identity and runner-managed mirrors

**Status**: accepted · **Date**: 2026-08-03 · **Decided**: [#316](https://github.com/femoral/parley/issues/316) (identity [#305](https://github.com/femoral/parley/issues/305) / [#313](https://github.com/femoral/parley/issues/313), credentials [#306](https://github.com/femoral/parley/issues/306), parent [#311](https://github.com/femoral/parley/issues/311))

## Context

Remote runners (ADR-0012) required operators to pre-clone every repo and maintain
a mandatory `runner.repos` path map from the orchestrator's absolute path to a
local checkout. That blocked zero-config fleets: a runner with no prior repo
setup could not execute, and path-based identity broke whenever the
orchestrator and executor lived on different hosts.

Repo identity on the wire landed in #313: each task records a normalized
**repo key** (`host/path`), a credential-stripped **fetch URL**, and the
delegate-time **local path**. Credentials stay ambient on the executor host
(#306) — parley never ships tokens. This ADR records how executors use that
identity to obtain code at claim time.

## Decision

### Identity (from #305 / #313)

- Canonical handle: **repo key** derived from `origin` by folding SSH/HTTPS,
  stripping trailing `.git`, and case-folding into `host/path`
  (`packages/core/src/repo-key.ts`).
- Task / lease fields: `repo_key`, `repo_fetch_url` (userinfo stripped, never
  reconstructed), `repo` (delegate-time local path for the no-origin fast path).
- `origin` is the sole remote used for identity and push-back; per-delegate
  remote overrides are out of scope.

### Managed bare mirrors

Each executor keeps a **parley-managed bare mirror per identity** under its
parley home:

```text
$PARLEY_HOME/clones/<encoded-repo-key>/
```

- Encoding: replace `/` with `--`, scrub other path-hostile characters
  (`encodeRepoKeyForFs`). Example: `github.com/femoral/parley` →
  `github.com--femoral--parley`.
- When `repo_key` is null but `repo_fetch_url` is set (bare path / `file://`
  origins that do not normalize), the directory is `url-<sha256-16>` of the
  fetch URL so warm reuse still works.
- First claim: `git clone --mirror <repo_fetch_url> <mirror>`.
- Later claims: `git fetch --prune origin '+refs/*:refs/*'` (no re-clone).
- No shallow mirrors — every ref must be available so arbitrary `base_sha`
  values resolve.
- Task worktrees are cut from the mirror with the existing worktree module
  (`createWorktree`); branches remain `parley/<id>[-<slug>]`.

### Claim-time git sequence (before vendor spawn)

On lease, before any adapter prepare / child spawn:

1. Resolve source: optional `runner.repos` override → else managed mirror from
   `repo_fetch_url` → else local path when it exists and there is no origin
   (no-origin fast path; no push).
2. Update: mirror fetch with prune, or best-effort `fetch --prune` on an
   operator clone.
3. Verify `base_sha` is a local commit; if missing, `git fetch origin <sha>`;
   if still missing → **fail the task** with
   `base_sha not resolvable from origin: <sha>`.
4. Push pre-flight:
   `git push origin <base_sha>:refs/heads/<task-branch>`.
   Permission / hook denials → **fail** with `push denied at claim time…`.
   (A real push, not `--dry-run`: git dry-run does not run remote hooks, so
   denials would only surface after the vendor. The branch tip starts at
   `base_sha`; the post-task push advances it.)
5. Cut worktree from the prepared repo at the verified sha.
6. Stream the vendor; on exit push `git push -u origin <branch>` (mirror and
   override paths only) and record the branch via `POST /runner/tasks/:id/branch`.

Any failure in steps 1–5 fails the task at claim time with a precise diagnosis;
the vendor **never** spawns.

### Optional `runner.repos` override

`runner.repos` is **optional** and maps a **repo key** (or path id) to an
operator-managed existing clone. It is no longer required for a runner to
function. When present, claim-time still fetches/verifies/dry-run-pushes against
that clone and pushes the result branch to its `origin`. Greenfield: the old
"must configure runner.repos" hard requirement is removed with no compat shim.

### Credentials

Executor hosts use **ambient git credentials** only (SSH agent, credential
helper, deploy keys). No credential material in parley config, leases, or the
db. Unreachable origin / auth failures surface as claim-time diagnoses
(`mirror_clone_failed`, `mirror_fetch_failed`, `push_denied`, …).

### Local / no-origin path

Repos without a network origin remain supported only when the executing host
has the delegate-time `repo` path: worktree is cut there, branch is recorded,
**no** origin push. Routing a no-origin repo to a remote runner that lacks that
path fails at claim with `no_repo_source`.

## Consequences

- Zero-config runners execute end-to-end against any origin the host can fetch
  and push, with warm mirrors across tasks on the same key.
- Operators can still pin a hand-managed clone via `repos` when they need a
  special layout or offline cache.
- Claim-time dry-run push catches permission problems before spending a vendor
  turn.
- Mirror disk growth and prune policy ride with later runner lifecycle / status
  work; this ADR does not auto-gc clones.
- Local daemon executor adopting the same mirror layout is follow-on (routing /
  unified executor tickets); this ticket wires the **runner** path and the
  shared `homePaths.clones` layout.
