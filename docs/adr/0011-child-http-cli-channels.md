# 11. Child→daemon channels: plain HTTP and a CLI, beside MCP

Date: 2026-07-16

## Status

Accepted

## Context

Children reach the daemon only via MCP (ADR-0003): a streamable-HTTP endpoint
with per-task `x-parley-task` header correlation, exposing `submit_report` and
`ask_orchestrator`. That assumes the harness has a configurable MCP client with
custom-header support. The harness research (#96) shows the assumption fails in
practice: some CLIs have no MCP client, some can't set headers, and remote
runners (#111) plus plain shell scripts need a way to report that doesn't
require an MCP SDK. A `curl`-able surface is the lowest common denominator.

## Decision

The engine's task operations (`submitReport`, `askOrchestrator`) get a second,
thin front-end: a child REST surface on the same daemon HTTP server, correlated
by the same `x-parley-task` header MCP uses — one correlation mechanism, three
transports (MCP, HTTP, CLI):

- `POST /child/report` — body is the report object; `200` on acceptance,
  `400` with the schema violation list otherwise (same validation path as MCP).
- `POST /child/ask` — body `{ "question": string }`; long-polls until the
  orchestrator answers (`200 { "answer": string }`) or the task stalls on
  answer-timeout (`504`, child may exit; the task is resumable).
- `GET /child/task` — the child's own task envelope, for self-inspection.

The engine injects `PARLEY_HUB_URL` and `PARLEY_TASK_ID` into every
`SpawnPlan.env` (engine-level, not per adapter) and materializes
`.parley/child.json` (`{ url, task_id }`) into the workspace, so subprocesses
that lose env can still find the hub.

The CLI grows a child-side namespace wrapping the REST surface:
`parley child report` / `parley child ask` / `parley child task`, resolving
hub + task id from env first, then `.parley/child.json` found upward from cwd.

MCP remains the canonical channel adapters inject; HTTP/CLI are the fallback
and script surface. All three converge on the same engine methods, so state
semantics (report validation, question stall/collapse) cannot drift.

## Consequences

- Any harness that can run `curl` or the parley binary can complete the task
  contract — adapter authors are no longer blocked on MCP client quality.
- Trust model is unchanged (localhost, header correlation, no secret): a local
  process that knows a task id can act as that child. This matches the MCP
  status quo. Remote runners (#111) must add real authentication (per-runner
  bearer tokens) because they leave localhost; that ADR owns it.
- The long-poll on `/child/ask` follows the answer-timeout semantics already
  owned by the engine; the HTTP layer adds no timer of its own.
