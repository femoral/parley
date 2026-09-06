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
