# UI v1 scope & game-viz mapping

Decided on wayfinder map #47 (ticket #52). Companion to
`docs/design/design-manifest.md` (tokens/chrome) and
`docs/spec/ui-interface-contract.md` (data contract). Scopes the first-party
`@useparley/ui` v1 — fills panels only from data parley exposes today; design
feature parity is explicitly not a goal.

## Scene grammar (the living view)

- **Island = task.** The worktree made literal — isolation felt. An island
  rises from the water when a task is created and remains as a terminal-state
  marker until the task is cleaned (island sinks).
- **Small ship = the vendor agent** working a task, flying its faction color +
  emblem (extensible per the brief: faction = color + emblem, never hardcode
  vendors).
- **Big ship = an orchestrator session.** One per orchestrator session with
  live tasks, anchored in its own water region, its task-islands clustered
  around it.
- **Camera shows one session at a time.** The roster/session selector switches
  sessions: the target session's region spawns offscreen and the camera
  travels there (sail-over movement) — parallel sessions exist in one
  continuous sea, not separate screens. Sessions whose tasks are all terminal
  quietly age out of the scene.

## State → visual mapping

Attention hierarchy (from the brief, enforced structurally in the design):
`awaiting_answer` > `stalled` > `running` > terminal.

| State | Scene read |
|---|---|
| `pending` | Island rising from the water, no ship yet. Transient. |
| `running` | Ship circles the island, wake trail. The alive state. |
| `awaiting_answer` | **Ship drops anchor; signal flare/beacon fires over the island; PARLEY! ribbon.** Unmissable from any zoom. |
| `stalled` | Fog bank rolls over the island; ship adrift. |
| `completed` | Flag planted on the island; ship docks. Quiet. |
| `failed` | Shipwreck on the rocks. Quiet but legible. |
| `cancelled` | Ship sails away; island sinks. |

HUD chrome (badges, colors, glyphs) follows the design manifest's state
language; the scene and the panels must always agree on state.

## v1 panels (around the scene)

Four cockpit panels, per the design's layout regions:

1. **Roster** — all tasks grouped by state (attention order), session
   grouping, faction color/emblem, name, state badge. Doubles as the session
   selector driving the camera.
2. **Inbox** — `awaiting_answer` tasks with question text and **inline answer**
   (`POST /tasks/:ref/answer`) — the one write in v1.
3. **Inspector** (selected task) — prompt/brief, branch + worktree, model /
   effort / sandbox / network posture, token usage + duration, raw log tail
   (`GET /tasks/:ref/logs`), structured report, question/answer history, eval
   score when present.
4. **Daemon health** — status, pid, version (contract's `/health`), task counts
   by state, uptime.

## v1 writes

- **Answer only.** Cancel, eval, clean, and a delegate form are all deferred —
  delegation is the orchestrator's job; the human's v1 job is unblocking and
  reviewing.

## Data sources

Everything above rides the existing contract: `GET /tasks` snapshot + SSE
stream for live state, task envelope for inspector fields, logs endpoint for
the tail. No daemon additions beyond the contract spec.

## Out of scope for v1

- Delegate/cancel/eval/clean from the UI.
- Rendering technology & asset production for the scene — separate map ticket.
- Component system structure — ticket #53.
- Historical analytics (usage over time, eval trends).
