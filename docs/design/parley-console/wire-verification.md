# Wire verification — mock-invented elements vs the daemon on develop

Asset for the wayfinder ticket "Wire verification: can the daemon already feed the
mock's invented elements?" (femoral/parley#343, map #337). Verdicts for each
invented feature in `coverage-audit.md` §2B, plus the §2C checks. Evidence lives in
`packages/daemon/src` (server.ts, metrics.ts, engine.ts, run-query.ts, info.ts) and
`packages/core/src` (contract.ts, sdk.ts, states.ts, classification.ts, usage.ts).

## §2B verdicts

| Mock element | Verdict | Basis |
| --- | --- | --- |
| Token-burn 24h histogram | **wire-supported (client-side bucketing)** | Every `/tasks` list envelope carries raw `usage` + `cached_input_tokens` and `created_at/started_at/completed_at`; a client buckets by hour itself. No time-bucketed endpoint and no time filter exist — the histogram only sees tasks still in retention, which the spec must state. |
| Fleet-table tokens + duration columns | **wire-supported** | The list envelope is the full envelope — `usage`, `duration_ms` (server-computed, null while live), `error`, `report`, run address, `queue_position`/`blocking_cap` are all on `GET /tasks`, not detail-only. |
| Run-tasks panel | **wire-supported (two routes)** | Task ids per node come only from `GET /runs/:ref/nodes/:node?iteration=&slot=` (`NodeTaskRow`: task_id, state, usage, duration, summary, gist). A whole-run task list is client-side: filter `/tasks` by envelope `run_id` (no `?run=` param exists). |
| Firehose | **partial — task side rich, run side thin** | Task SSE events (`task.started/question/completed/failed/cancelled/stalled/pending/queued`) carry the full envelope — enough for any feed line. Run events (`run.started/blocked/node_entered/running/completed/failed/cancelled`) carry only `{run_id, state, current_node, iteration, seq}` — no workflow name (client joins against its `/runs` cache), and the gate verb taken is never evented. Rich gate lines = daemon work. |
| Metrics `group_by=workflow` | **wire-supported via `/run-metrics`** | Not a `/metrics` group_by. `GET /run-metrics` (unused by Cove) groups by `workflow` (its default) with tokens, duration percentiles, evals, success and `cost_per_completed_run` — the console's workflow tab should consume this endpoint. |
| Metrics `group_by=session` | **needs daemon work (or reframe)** | `session` is a filter on `/metrics`/`/tasks`, never a group_by. Options: add the group_by server-side, or reframe the mock's "session" tab as the existing session *scope* filter (Cove's pattern). |
| Concurrency cap (`cap 16`) | **needs daemon work** | The cap value (`vendors.*.maxConcurrent` / `profiles.*.maxConcurrent`) is config-only; `/health` and `/info` don't expose it and preflight's cap struct isn't routed. The wire gives cap *identity* + queue position per task (`blocking_cap`, `queue_position`) but no denominator. |
| Report file churn (+/−) | **needs daemon work** | `Report` is `{summary, outcome, files_changed: string[]}` — paths only; no churn identifier exists anywhere in core/daemon. |
| Global header `tail` status | **reframe** | No global tail exists; logs are per-task cursor polls (`/tasks/:ref/logs?since=`). The header slot should reflect the selected task's tail (or the SSE stream's health), not a daemon fact. |

## §2C answers

1. **`/tasks` list envelope** — full `TaskEnvelope` per task: usage, duration_ms,
   error + error_category, report, timestamps, run address (`run_id/node/iteration/slot`),
   queue observability. No note-like field (task prose lives in `report.summary`).
   Query params are exactly the metrics filter set (`session, type, vendor, model,
   profile, size, difficulty, orch_*, eval_*, rubric, rubric_version,
   first_attempt, below_baseline`) — **no `run=`, `state=`, or `limit=`**.
2. **SSE vocabulary** — task events with full envelopes; run lifecycle events with
   a 5-field payload; gate visibility is `run.node_entered` + `run.blocked` only.
   No deliverable/runner/eval events. Resume via `Last-Event-ID` or `?since=`.
3. **`/metrics` group_by allowlist** — `vendor, model, profile, size, difficulty,
   type, orch_harness, orch_model, orch_effort, eval_harness, eval_model,
   eval_effort, rubric` (400 otherwise). `workflow` lives on `/run-metrics`'s
   separate allowlist; `session` is filter-only on both.
4. **Run-scoped tasks** — see §2B verdicts (node detail endpoint + client-side
   run_id filter).
5. **Adoptable unused endpoints** — `/run-metrics` (run-level metrics incl.
   workflow grouping and cost-per-completed-run), `/runs/:ref/nodes/:node`
   (per-node task rows + deliverable refs), `/info?project=` (vendors, models,
   enforcement matrix, profiles, executors, defaults — requires a `project` query
   param, so it's a per-project surface, not a daemon-global one).

## Consequences for the console spec

- Nothing blocks the fleet board's density: tokens/duration/error columns and the
  burn sparkline are buildable today from `GET /tasks` + SSE alone.
- The metrics screen's four mock tabs map to: `/metrics` (task dims),
  `/run-metrics` (workflow dim), session as a scope filter — one tab reframed, no
  daemon work.
- Three genuinely need daemon additions if kept: file churn, cap denominator,
  rich gate-verb firehose lines. These go to the build/cut/defer decision.
