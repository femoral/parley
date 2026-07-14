# Parley v1 — Specification

Parley lets an orchestrating agent (Claude Code) delegate tasks to other agent CLIs — **Codex** and **Grok Build** in v1 — with per-task model selection, context passing, parley-managed git worktrees, and bidirectional Q&A between the spawned agent and the orchestrator.

This spec is the destination artifact of the [wayfinder map](https://github.com/femoral/parley/issues/1). Every design decision links its resolving ticket; ADRs in `docs/adr/` record the load-bearing choices. Research grounding: [Codex CLI](../research/codex-cli-automation.md), [Grok Build CLI](../research/grok-build-cli-automation.md).

## 1. Architecture

```
Claude Code (orchestrator)
   │  parley CLI  — HTTP long-poll (transport adapter)
   ▼
parley daemon (TypeScript/Node, one per user)
   ├─ HTTP server: CLI plane (REST) + MCP endpoint (streamable HTTP)
   ├─ task engine: state machine + SQLite persistence
   ├─ worktree manager: create/translate/clean
   └─ vendor adapters: codex, grok  → spawn child processes
        │
        ▼
child agent (codex exec / grok -p) in its worktree
   └─ MCP over HTTP back to daemon: ask_orchestrator, submit_report
```

- **Stack**: TypeScript/Node ([ADR-0001](../adr/0001-typescript-node.md)).
- **Form factor**: CLI + single global background daemon ([ADR-0002](../adr/0002-cli-daemon-http-longpoll.md)); daemon auto-spawns on first `delegate`.
- **Child channel**: daemon-served streamable-HTTP MCP ([ADR-0003](../adr/0003-mcp-child-channel.md)).
- **Adapters**: spawn-per-turn child processes ([ADR-0004](../adr/0004-spawn-per-turn-adapters.md)).
- **Worktrees**: parley-owned, canonical AGENTS.md translation ([ADR-0005](../adr/0005-parley-owned-worktrees.md)).
- **Sandbox**: workspace + network default, approvals off ([ADR-0006](../adr/0006-sandbox-workspace-network.md)).

## 2. Task lifecycle

Decided in [wire protocol and task lifecycle](https://github.com/femoral/parley/issues/5).

```
pending ─→ running ─┬─→ completed   (submit_report received)
                    ├─→ failed      (child exit w/o report, fatal error)
                    ├─→ cancelled   (parley cancel)
                    ├─→ awaiting_answer ─┬─→ running (answered)
                    │                    └─→ stalled (answer timeout → question recorded, child stopped)
                    └─(daemon/child crash)─→ stalled

stalled ─→ running   (late `parley answer` → vendor session resume)
```

- `completed` strictly requires `submit_report`; exit without it = `failed` with vendor output attached as diagnostics.
- One outstanding question per task (child blocks while asking — holds by construction). Questions carry `question_id`; answers correlate by it.
- Unanswered question at `--answer-timeout` (default 30m): question durably recorded (task record; linked tracker ticket when that future feature exists), child stopped, task `stalled`.
- Resume from `stalled`: respawn via persisted vendor session id (`codex exec resume <id>` / `grok -p -s <id>`), protocol preamble re-prepended.

## 3. Daemon

Decided in [daemon lifecycle and state management](https://github.com/femoral/parley/issues/9).

- **One global daemon per user**; tasks tagged with repo.
- **Discovery**: binds `127.0.0.1:0`; writes `{port, pid, started_at}` to `~/.parley/daemon.json` under a lockfile (also guards auto-spawn races). Staleness = pid liveness check.
- **Persistence**: SQLite (`node:sqlite` / `DatabaseSync`) at `~/.parley/parley.db` — tasks, questions, report envelopes, vendor session ids. Vendor event streams as per-task JSONL logs (raw, untouched).
- **Crash story**: children run in the daemon's process group and die with it. On start, tasks recorded `running`/`awaiting_answer` → `stalled`.

### `~/.parley/` layout

```
~/.parley/
├── daemon.json                    # {port, pid, started_at} + lock
├── parley.db                      # SQLite state
├── tasks/<id>/vendor.jsonl        # raw vendor event stream
└── worktrees/<repo>/<task>/       # parley-created worktrees
```

### CLI plane (REST, transport-adapted)

| endpoint | purpose |
|---|---|
| `POST /tasks` | delegate |
| `GET /tasks/:id/events?wait=true` | long-poll: blocks until question / terminal state |
| `GET /tasks/inbox?ids=…&ack=<seq>&wait=true` | acked attention inbox: next pending actionable event, or all-done ([#91](https://github.com/femoral/parley/issues/91), ADR-0007) |
| `GET /tasks/events?ids=…&since=<seq>&wait=true` | multi-task transition firehose (`watch --follow`) ([#34](https://github.com/femoral/parley/issues/34)) |
| `POST /tasks/:id/answer` | answer a question (or resume a stalled task) |
| `POST /tasks/:id/cancel` | cancel |
| `GET /tasks[/:id]` | status/list |

Messages are transport-agnostic JSON behind a transport adapter — long-poll HTTP first, websocket can slot in later. Event vocabulary (daemon → CLI): `task.started`, `task.question`, `task.completed`, `task.failed`, `task.cancelled`, `task.stalled`. Vendor-stream items are logs, never CLI events.

### Transition sequencing (`seq`)

Decided in [`parley watch`](https://github.com/femoral/parley/issues/34), refined by [ADR-0007](../adr/0007-watch-attention-inbox.md) / [#91](https://github.com/femoral/parley/issues/91). The daemon assigns every task-state transition a global monotonically increasing `seq`. Every task envelope carries the `seq` of the task's most recent state change. For the attention inbox, that `seq` is the **event id** passed to `watch --ack`. The transition firehose (`GET /tasks/events?...&since=<seq>`, used by `watch --follow`) still replays transitions after `<seq>`; omitting `since` starts from "now".

## 4. Child channel (MCP)

Decided in [child-to-hub channel](https://github.com/femoral/parley/issues/4).

- Daemon serves **streamable-HTTP MCP** on its localhost port. Correlation: per-task header set at injection time (grok additionally interpolates `{{session_id}}`).
- **Tools** (the only two — `report_progress` deliberately dropped, [#5](https://github.com/femoral/parley/issues/5)):
  - `ask_orchestrator(question) → answer` — **blocks** until the orchestrator answers or timeout stalls the task (returned as tool error).
  - `submit_report(report)` — validated against the task's report schema; validation errors bounce back as tool errors so the child retries.
- Injection per vendor:
  - Codex: `-c 'mcp_servers.parley.url=…'` + `http_headers`, and **`tool_timeout_sec` raised** past the answer timeout (default 60s would kill blocking Q&A).
  - Grok: `[mcp_servers.parley]` in the worktree's generated `.grok/config.toml` (default `tool_timeout_sec` 6000s suffices).

### Report

Decided in [#5](https://github.com/femoral/parley/issues/5): caller-supplied JSON Schema (`--report-schema`); parley's default when omitted:

```json
{ "summary": "markdown", "outcome": "success | partial | blocked", "files_changed": ["…"] }
```

Daemon wraps the validated body in its envelope: task id, name, repo, worktree path, branch, vendor, model, vendor session id, token usage, duration, final state.

## 5. CLI

Decided in [CLI surface prototype](https://github.com/femoral/parley/issues/6) — full reference: [docs/design/cli-surface.md](../design/cli-surface.md). Additions since: `parley clean` ([#7](https://github.com/femoral/parley/issues/7)), sandbox flags finalized ([#12](https://github.com/femoral/parley/issues/12)).

```
parley delegate [flags] "<prompt>"   # '-' = stdin
  -v --vendor codex|grok   -m --model <id>   -n --name <label>
  --effort <level>         (opaque; codex: model_reasoning_effort, grok: --reasoning-effort)
  -w --worktree <name>     --cwd <path>      --base-ref <ref>
  --context <file>…        --report-schema <file>
  --wait                   --answer-timeout <dur=30m>
  --sandbox read-only|workspace|full   --no-network
parley answer <task> "<text>" [--wait]
parley status [task] [--json]        parley list
parley logs <task> [--follow]
parley cancel <task>
parley clean <task> | --all-terminal
parley watch [task…] [--ack <event-id>] [--session <id>] [--follow] [--json]
parley daemon start|stop|status
```

**Blocking contract** (`delegate --wait` / `answer --wait`): JSON on stdout + typed exit code — `0` completed · `1` failed · `2` usage · `3` question (`{task_id, name, question_id, question}`) · `4` stalled · `5` cancelled. The orchestrator branches on `$?` without parsing.

**`parley watch`** ([#91](https://github.com/femoral/parley/issues/91), [ADR-0007](../adr/0007-watch-attention-inbox.md)): delivers pending events from a per-orchestrator-session **attention inbox**, instead of edge-triggered transition watching.
- Each task contributes at most its *current* actionable state (`awaiting_answer` > `stalled` > `failed` > `completed`) if un-acked — level-triggered by construction.
- `--ack <event-id>` records handling of a prior event (id = transition `seq`), then returns the next pending one (blocking if none). Un-acked events redeliver (at-least-once). Ack of a superseded event is a no-op; `parley answer` implicitly consumes a question event.
- Scope like `status`: `--session`, else `PARLEY_SESSION_ID`, else latest session. Positional task refs filter the inbox.
- Exit codes: `0` all-done (all watched tasks terminal **and** all events acked) · `3` awaiting_answer · `4` stalled · `5` failed · `6` completed · `2` usage.
- `--follow`: no-ack JSONL firehose of every transition until all watched tasks are terminal; for UIs/debugging, not orchestration.

**Task identity**: daemon-assigned short ids (`t7`) + optional `--name`; commands accept either; branch/worktree `parley/t7-fix-auth`.

## 6. Worktrees & config translation

Decided in [worktree lifecycle and vendor config translation](https://github.com/femoral/parley/issues/7).

- Created from the repo's **current HEAD** (`--base-ref` overrides) at `~/.parley/worktrees/<repo>/<task>`, branch `parley/<id>-<name>`.
- **Canonical AGENTS.md**: symlink `CLAUDE.md → AGENTS.md` and `.claude/skills → .agents/skills` (skipped when the repo tracks AGENTS.md / `.agents`). Grok's Claude scanners disabled per child (`GROK_CLAUDE_*_ENABLED=0`) — one config surface, no double-loading. Codex AGENTS.md cap: 32 KiB combined.
- Grok additionally gets generated `.grok/config.toml` (MCP endpoint, `new_session_worktree_mode = "never"`, permission posture). Codex needs no files — all flags.
- **Hygiene**: every generated path appended to the worktree's `.git/info/exclude`.
- **Cleanup**: parley never merges. Report envelope carries branch + path; orchestrator reviews/merges. `parley clean` removes worktrees (branches kept); auto-remove only when untouched.

## 7. Context passing

Decided in [context passing](https://github.com/femoral/parley/issues/8).

- `.parley/TASK.md` (task brief) + `--context` files copied to `.parley/context/` — on disk, git-excluded, survive resume.
- Vendor prompt = **protocol preamble** + caller prompt + pointer to the files. Preamble (re-prepended on resume): `ask_orchestrator` when blocked; must finish with `submit_report`; report-schema summary; worktree/branch facts; answer-timeout.
- Auto-context minimal: mechanics only. Domain context is the orchestrator's job.

## 8. Sandbox & approvals

Decided in [sandbox and approval posture](https://github.com/femoral/parley/issues/12). Default **workspace + network**; vendor approvals disabled — the sandbox is the guardrail; escalation is social via `ask_orchestrator`.

| posture | codex | grok |
|---|---|---|
| read-only | `--sandbox read-only` | `GROK_SANDBOX=read-only`, `GROK_WRITE_FILE=0` |
| workspace (default) | `--sandbox workspace-write` + `-c sandbox_workspace_write.network_access=true` | `GROK_SANDBOX=workspace` (no `restrict_network`), `GROK_SANDBOX_AUTO_ALLOW_BASH=1` |
| workspace `--no-network` | omit network override | workspace profile + `restrict_network` |
| full | `--sandbox danger-full-access` | `GROK_SANDBOX=off --always-approve` |

Approvals: codex `-a never`; grok `--always-approve` (+ permission rules as belt-and-braces).

## 9. Vendor adapters

Decided in [vendor adapter abstraction](https://github.com/femoral/parley/issues/11).

```ts
interface VendorAdapter {
  id: 'codex' | 'grok' | string
  prepare(task: TaskSpec, hub: HubInfo): Promise<SpawnPlan>   // fresh run
  resume(task: TaskSpec, hub: HubInfo): Promise<SpawnPlan>    // stalled → running
  parseEvent(line: string): VendorEvent[]
  sessionId(events: VendorEvent[]): string | undefined
}
interface SpawnPlan {
  argv: string[]
  env: Record<string, string>
  files: MaterializedFile[]   // vendor-specific, written pre-spawn
  cwd: string
}
```

- `SpawnPlan.files` absorbs the flags-vs-files asymmetry (codex: flags only; grok: `.grok/config.toml`). Worktree/symlink/context materialization is core, not adapter.
- Event normalization is thin: `message | command | file_change | error | session_meta`, used only for `status`/`logs` display and session-id extraction; raw JSONL is the record. Unknown lines pass through opaque.
- New vendor (pi, opencode) = one `VendorAdapter` module + a research doc. No core changes.

### Vendor invocation summary

| | codex | grok |
|---|---|---|
| spawn | `codex exec --json --cd <wt> -m <model> --sandbox … -a never -c mcp_servers…` | `grok -p --cwd <wt> -m <model> --output-format streaming-json --always-approve --no-auto-update` |
| resume | `codex exec resume <session-id>` | `grok -p -s <session-id> …` |
| auth | `CODEX_API_KEY` (exec-only) | `XAI_API_KEY` |
| gotchas | exit codes 0/1 only; read-only default; 60s MCP tool timeout must be raised | undocumented event schema & exit codes — pin version; headless stalls without approval posture; `MCP_TIMEOUT` env leaks from Claude setups |

## 10. Testing strategy (prescription for implementation)

- Unit: state machine transitions; report-schema validation; adapter `SpawnPlan` construction (golden argv/env/files per posture matrix).
- Contract: a **fake vendor CLI** (small script speaking each vendor's stream format) drives end-to-end daemon tests — delegate → question → answer → report — without paid API calls.
- Adapter smoke tests against real CLIs behind an opt-in flag (versions pinned; grok `--no-auto-update`).
- Golden JSONL fixtures per pinned vendor version to catch stream-schema drift.

## 11. Future work (non-blocking)

- Task ↔ issue-tracker linkage (`--ticket <url>`; stalled questions commented onto the ticket).
- Milestone-only `report_progress` tool, if logs prove insufficient.
- Websocket transport implementation of the CLI-plane adapter; live TUI.
- Persistent-protocol adapters (grok ACP, codex app-server) enabling mechanical approval-routing and mid-turn steering.
- pi / opencode adapters.
- OSS packaging (npm), docs, versioning.
