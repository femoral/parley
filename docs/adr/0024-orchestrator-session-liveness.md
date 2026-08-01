# ADR-0024: Orchestrator session liveness — dead-anchor filter, TTL backstop, gc sweep

**Status**: accepted · **Date**: 2026-07-29 · **Decided**: [#280](https://github.com/femoral/parley/issues/280)

## Context
Registered orchestrator sessions (ADR-0013) accumulate without bound: nothing ends, expires, or reaps them, and workspace-fallback binding counts every stored row. After one conformance round a workspace held 35 "live" sessions, making every un-flagged `delegate`/`fix`/`eval` fail ambiguous. Session rows are not load-bearing for history — tasks and runs snapshot `orch_*`/`eval_*` provenance onto their own rows at spawn/eval time.

## Decision
- **Liveness = anchor alive, with a TTL backstop.** A session is live while its anchor process (`machine_id` + `pid` + `start_time`) is verifiably alive on the daemon's machine. Anchors the daemon cannot verify — foreign `machine_id` (remote runners, ADR-0012) or the degraded `start_time: "0"` re-anchor form — are live until an idle TTL lapses (default 7 days since `updated_at`).
- **Successful binding refreshes `updated_at`**, so an active session never TTL-expires mid-use.
- **Filter at resolve.** Binding's workspace fallback and ambiguity count consider only live sessions. Explicit `--session`/`PARLEY_SESSION_ID` to a still-stored row keeps working regardless of liveness. Ancestry matching is unaffected (a dead anchor can never appear in a live caller's chain).
- **`parley gc` deletes dead/expired rows** (reported in the gc result like tasks/runs). No reap-on-start; the long-running daemon is the normal case.
- **Genuine ambiguity still errors.** When multiple *live* sessions share a workspace and ancestry is silent, the ambiguous error stays — two concurrent orchestrators are real, and silently binding to the most-recent would cross-attribute provenance.

## Consequences
- The ambiguous error becomes rare and meaningful: it fires only while multiple orchestrators are actually alive in one workspace.
- Sessions on remote machines degrade to TTL-only liveness until some future heartbeat exists; accepted.
- Deleting session rows loses nothing historical (provenance is snapshotted), but a purged id can no longer be re-anchored by `parley session --session <id>` — re-registering fresh is the path.
