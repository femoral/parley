# Task listing and watch bootstrap

`GET /tasks` returns at most 100 newest task envelopes by default. `limit=1..100`
chooses a smaller bound; `has_more` says whether more matching records exist.
`all=true` explicitly requests the expensive, complete retained history for
administration and legacy snapshot consumers. The CLI status/list surface and
SDK `listTasks()` preserve their full-list behavior by sending that opt-in.

`GET /tasks/scope?session=<id>` is the lightweight watch bootstrap. It returns
the current sequence, resolved session, task identities/states, task/run counts,
terminal count, and excluded NULL-session task count. `session=latest` is
resolved by the daemon. Optional `ids` resolve explicit references; `follow=true`
selects the firehose's active-task bootstrap. It never builds report envelopes
or resolves per-task project settings. Unknown references/sessions are errors.

Task-list envelope construction resolves effective settings once per repository
per request. The next request reads fresh configuration, so no stale cross-request
cache or invalidation timer is needed.

## Console fleet pages (#400)

`GET /fleet/tasks` and `/fleet/runs` return `{items,total,next_cursor,seq}`.
Default `limit=50`, maximum 100. `session`, exact `state`, and task-only `run`
filters apply in SQL before projection. `gate` means blocked runs with a persisted
gate block reason (no matching tasks). `attention=true` restricts to asks, stalls,
failures or held gates and orders by priority/oldest age; ordinary pages order by
`created_at DESC, id DESC`. Cursors are opaque, validated, scope-bound keysets.
Send the returned cursor unchanged; changing filters or page size starts a new
sequence. New inserts do not shift an older chronological page. Live changes may
remove records from a filtered page; Newest returns to the current first page.

`GET /fleet/summary?session=...` computes retained-session state totals and 24h
settled/usage aggregates independently of roster pages. It reads slim usage
columns, never historical prompts/reports or envelopes. Like existing metrics,
aggregates necessarily inspect their matching population; response size is fixed.
The Console uses bounded pages at startup, reconnect, and regular refresh. Its
recent discovery cache is capped at 500 tasks; attention, selected detail and run
tasks have independent server reads. CLI/legacy SDK complete-list behavior is
unchanged.

The firehose labels its observation scope: live task stream plus the newest 50
polled runs. It is not an all-history run event audit; the independent attention
query still reaches older held gates, and direct run detail reads remain complete.

Reproducible performance fixture: `pnpm exec vitest run packages/daemon/tests/fleet-query.test.ts`.
On this development machine, 1,000 tasks/runs: full lists 52/74ms and
1,955,037/580,019 bytes; pages 6/6ms and 97,909/29,158 bytes. At 10,000:
441/1,004ms and 19,550,038/5,820,020 bytes versus 7/6ms and 97,911/29,260
bytes. Projections drop from N to 50; scoped tuple cursors use covering
`*_session_state_created` indexes without a temporary sort. Summary payloads
were ~2.2KB (2ms / 14ms at the two fixture sizes). These are local observations,
not latency guarantees; expensive individual run definitions/children can still
affect the cost of a run summary.
Repeat page refreshes measured 5/6ms at 1,000 tasks/runs and 5/5ms at 10,000,
with the same payload sizes and 50 projections per request.

Browser proof: `node --import tsx packages/dashboard/verify/demos/fleet-pagination.mjs`.
It starts an isolated daemon, exercises every state chip, combined session scope,
independent page controls, a live membership change and off-page detail links;
it checks pagination with axe and records screenshots at 1280/1460/1920 under
the printed temporary directory. No full task/run list request is permitted
during startup or the regular refresh cadence.
