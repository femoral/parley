# Hermes CLI — automation surface for Parley

Research asset for writing a Parley vendor adapter for the Hermes agent CLI.
Verified against a live install on 2026-07-16; Hermes Agent **v0.17.0
(2026.6.19) · upstream `efd87a15`**. Upstream latest tagged release at research
time: **v0.18.2 (2026.7.7.2)** ([GitHub releases](https://github.com/NousResearch/hermes-agent/releases)).
Re-verify flags against the install you ship with before implementing.

## Identity choice (prominent)

**This document targets [Nous Research Hermes Agent](https://github.com/NousResearch/hermes-agent)**
— product name **Hermes Agent**, CLI binary **`hermes`**, docs at
[hermes-agent.nousresearch.com](https://hermes-agent.nousresearch.com/).

Not to be confused with:

- Hermes *models* from Nous (e.g. Hermes 3/4 model weights) — those are LLMs,
  not this CLI.
- Unofficial npm bridge package [`hermes-agent`](https://www.npmjs.com/package/hermes-agent)
  (maintainer `wyrtensi`) — a third-party wrapper around the same project;
  **do not** treat it as the official install path.
- Other unrelated "Hermes" tooling.

Choice criterion: most prominent, actively maintained coding/agent CLI named
Hermes under `github.com/NousResearch`.

## LOUD CAVEAT — no streaming JSON event surface

**Hermes cannot do Codex/Grok-style headless JSONL event streaming.** There is
no `--json`, `--output-format streaming-json`, or equivalent flag on
`hermes chat` / `hermes -z` in v0.17.0 (VERIFIED: `hermes chat --help` shows
none). Quiet mode emits:

| Stream | Content |
|--------|---------|
| **stdout** | Final assistant text only (or error text on some failure paths) |
| **stderr** | Machine line `session_id: <id>` on successful quiet runs; error detail for `-z` |

Tool calls, file edits, intermediate messages, and token usage are **not**
streamed as structured events to the parent. Parley's durable raw JSONL log
will therefore contain plain text (plus the stderr session line if captured),
not a rich event timeline.

**Adapter note (#107):** the engine dual-feeds stderr into `parseEvent`, so the
`session_id: …` quiet-mode line is load-bearing for multi-turn resume. Quiet
mode remains intentionally opaque for tool/usage progress (capability limit;
ACP / post-exit DB scrape would be a redesign).

**Closest viable Parley integration shapes** (in preference order for an
adapter):

1. **Spawn-per-turn `hermes chat --quiet -q …`** — matches Codex/Grok
   spawn-per-turn architecture. Synthesize thin `VendorEvent`s from stdout /
   stderr / exit code / optional post-run `hermes sessions export`. Live
   tool progress is opaque.
2. **`hermes acp`** (Agent Client Protocol over stdio) — richer streaming
   (`session/update` tool start/complete, message/thought chunks, usage). A
   different process model (long-lived ACP server per task) than the current
   codex/grok adapters. Not fully exercised in this research pass.
3. **`hermes -z`** — final answer only; **no session id**; unsuitable when
   resume matters.

Paperclip's open-source [hermes-paperclip-adapter](https://github.com/NousResearch/hermes-paperclip-adapter)
already integrates Hermes by parsing **raw stdout** into typed transcript
entries (not JSONL) and tagging sessions `--source tool` — independent
confirmation that the ecosystem treats Hermes as a text-I/O agent, not a
JSONL stream.

---

## TL;DR for Parley

| Need | Hermes answer | Quality |
|------|---------------|---------|
| One-shot headless | `hermes chat --quiet -q "<prompt>" --yolo --source tool` | Strong |
| Streaming JSON events | **None** (synthesize from stdout/stderr/exit) | Weak |
| MCP HTTP + custom headers | `mcp_servers.<name>.url` + `.headers` in `config.yaml` under isolated `HERMES_HOME` | Strong |
| Session resume | stderr `session_id: …`; `--resume <id>` | Strong |
| Sandbox / approvals | `--yolo` / `HERMES_YOLO_MODE`; `approvals.mode: off`; `terminal.backend` + `HERMES_WRITE_SAFE_ROOT` + docker network | Partial (not codex-shaped) |
| Model | `-m` / `--provider` / `HERMES_INFERENCE_MODEL` | Strong |
| Effort | `agent.reasoning_effort` in config only (no CLI flag in 0.17.0) | Partial |
| Auth via env | Many provider keys (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, …) + `HERMES_HOME/.env` | Strong |
| Token usage in stream | **Not in quiet stream**; SQLite session + `hermes insights` / export | Weak for live capture |

Recommended default: **files-heavy adapter** like Grok — materialize a private
`HERMES_HOME` (config.yaml + .env) per task, spawn `hermes chat --quiet`, parse
stderr for session id, map exit code to success/failure.

---

## 1. Identity & install

| Field | Value | Evidence |
|-------|-------|----------|
| Product | Hermes Agent (Nous Research) | [GitHub](https://github.com/NousResearch/hermes-agent), [docs](https://hermes-agent.nousresearch.com/docs/) |
| Binary | `hermes` | VERIFIED (`which hermes` → `~/.local/bin/hermes`) |
| Language / packaging | Python 3.11 agent; managed install under `$HERMES_HOME/hermes-agent` | VERIFIED (`hermes version`) |
| Verified version | **v0.17.0 (2026.6.19) · upstream `efd87a15`** | VERIFIED `hermes --version` |
| Upstream latest (docs) | v0.18.2 (2026.7.7.2), 2026-07-08 | DOCS [release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.7.2) |
| Official install (Linux/macOS) | `curl -fsSL https://hermes-agent.nousresearch.com/install.sh \| bash` | DOCS [install](https://hermes-agent.nousresearch.com/docs/getting-started/installation) |
| Alternate | `pip install hermes-agent` / `pip install -U hermes-agent` | DOCS release notes |
| Config home | `$HERMES_HOME` (default `~/.hermes`) | DOCS + VERIFIED (`hermes config show`) |
| Config files | `config.yaml` (settings), `.env` (secrets), `auth.json` (OAuth), `state.db` (sessions) | DOCS [configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration) |

Pin the version your adapter was written against; `hermes update` pulls latest
git/code and can change quiet-mode I/O.

---

## 2. Headless invocation

### Preferred Parley argv (quiet single-query)

```bash
hermes chat \
  --quiet \
  -q "<prompt>" \
  --yolo \
  --accept-hooks \
  --source tool \
  -m <model> \
  --provider <provider>   # optional
```

| Flag | Role | Evidence |
|------|------|----------|
| `chat -q/--query` | One-shot non-interactive prompt | VERIFIED help; DOCS [CLI](https://hermes-agent.nousresearch.com/docs/user-guide/cli) |
| `-Q/--quiet` | Suppress banner/spinner/tool previews; final response + session info only | VERIFIED help + source `cli.py` quiet path |
| `--yolo` | Bypass dangerous-command approval prompts | VERIFIED help; DOCS [security](https://hermes-agent.nousresearch.com/docs/user-guide/security) |
| `--accept-hooks` | Auto-approve shell hooks without TTY | VERIFIED help |
| `--source tool` | Tag session so it is filtered out of interactive session lists | VERIFIED help; Paperclip docs use this |
| `-m/--model` | Per-run model override | VERIFIED help |
| `--provider` | Force provider (`openrouter`, `nous`, `anthropic`, …) | VERIFIED help |

Working directory = **process cwd** (spawn with `cwd: task.worktree`). There is
no `--cd` equivalent on `hermes chat` (VERIFIED help). CLI always uses the
launch directory for tools; gateway/cron use `terminal.cwd` in config (DOCS).

### Output contract (`--quiet -q`) — VERIFIED from source + failed auth run

Successful quiet path (from `cli.py` ~15553–15690, v0.17.0):

1. **stdout**: final assistant message text (plain), one print of
   `result["final_response"]`.
2. **stderr**: a trailing line:
   ```text
   session_id: 20260716_081234_a1b2c3
   ```
   (leading newline before `session_id:`).
3. **exit code**: `0` on success; `1` if `result.failed`; `130` on
   KeyboardInterrupt (still prints `session_id` to stderr).

Auth / provider-missing failure (VERIFIED live run, v0.17.0):

```text
# stdout
No inference provider configured. Run 'hermes model' to choose a provider and
model, or set an API key (OPENROUTER_API_KEY, OPENAI_API_KEY, etc.) in
~/.hermes/.env.

# stderr
(empty)

# exit code
1
```

(The error text always says `~/.hermes/.env` even when `HERMES_HOME` is
overridden — cosmetic; secrets still load from `$HERMES_HOME/.env`.)

### Alternative: pure oneshot (`hermes -z`)

```bash
hermes -z "<prompt>" [-m <model>] [--provider <provider>]
```

| Behavior | Detail | Evidence |
|----------|--------|----------|
| stdout | Final response text only | VERIFIED source `hermes_cli/oneshot.py` |
| stderr | Error lines only (`hermes -z: agent failed: …`) | VERIFIED live run |
| session_id | **Not emitted** | VERIFIED source docstring |
| Approvals | Auto `HERMES_YOLO_MODE=1` + `HERMES_ACCEPT_HOOKS=1` | VERIFIED source |
| Exit | `0` success, `1` agent failure, `2` usage error | VERIFIED source |

**Do not use `-z` if Parley needs resume or session correlation.**

### Streaming JSON — absent

- No `--json` / streaming-json flag (VERIFIED help).
- Interactive streaming is terminal UI only (`display.streaming` in config).
- Trajectory / session **export** is post-hoc JSONL via
  `hermes sessions export <file> [--session-id ID]` (VERIFIED help) — not a
  live stream.

### Example lines a Parley adapter would see (synthesized / source-backed)

There is no live JSONL stream. The adapter's raw log for a quiet child would
look like:

```text
# --- stdout ---
Implemented the fix and ran the tests.

# --- stderr ---

session_id: 20260716_143052_a1b2c3
```

Failed auth (VERIFIED):

```text
# --- stdout ---
No inference provider configured. Run 'hermes model' to choose a provider and
model, or set an API key (OPENROUTER_API_KEY, OPENAI_API_KEY, etc.) in
~/.hermes/.env.
```

### Human single-query (not quiet)

`hermes chat -q "…"` without `--quiet` prints a Query label, full tool
progress UI, then `_print_exit_summary()` with human resume hints. **Not** for
Parley.

---

## 3. MCP injection

### Capabilities (DOCS + VERIFIED config path)

Hermes is an MCP **client**. Config key: `mcp_servers` in
`$HERMES_HOME/config.yaml` (default `~/.hermes/config.yaml`).

| Transport | Keys | Notes |
|-----------|------|-------|
| stdio | `command`, `args`, `env` | Env filtered to safe baseline + explicit `env` |
| HTTP (streamable) | `url`, `headers` | DOCS [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) |
| SSE | `url`, `transport: sse`, `headers` | Source comment in `tools/mcp_tool.py` |

**Custom headers: yes** (DOCS + source example):

```yaml
mcp_servers:
  parley:
    url: "http://127.0.0.1:PORT/mcp"
    headers:
      X-Parley-Task: "<task-id>"
      Authorization: "Bearer ***"   # if needed
    timeout: 3600          # per-tool-call seconds (default 300)
    connect_timeout: 10    # handshake (default 60)
    enabled: true
    tools:
      include: [ask_orchestrator, submit_report]  # optional whitelist
```

**Default tool timeout is 300s** (VERIFIED `_DEFAULT_TOOL_TIMEOUT = 300` in
`tools/mcp_tool.py`). Raise above Parley's `answerTimeoutMs` for blocking
`ask_orchestrator` — same load-bearing concern as Codex's 60s default.

### Flags vs config vs env

| Mechanism | Works for Parley? | Notes |
|-----------|-------------------|-------|
| CLI flag for MCP URL/headers | **No** | No per-invocation MCP inject flag (VERIFIED help) |
| `$HERMES_HOME/config.yaml` | **Yes** | Full isolation if Parley sets `HERMES_HOME` |
| `hermes mcp add --url …` | Writes user config | Interactive/discovery-oriented; not ideal mid-spawn |
| Project-scoped MCP path | **No first-class project `mcp_servers`** | MCP lives under HERMES_HOME config, not worktree `.hermes/` (DOCS + config loader) |
| `--ignore-user-config` | Loads built-in defaults; **drops** user MCP | Do **not** combine with needing hub injection unless MCP is in the isolated home that still loads |
| `--safe-mode` | Disables MCP entirely | Avoid for Parley children |

### Recommended Parley injection

1. Create a task-private directory, e.g. `<worktree>/.parley/hermes-home/`
   (git-exclude it).
2. Set `HERMES_HOME=<that dir>` in `SpawnPlan.env`.
3. Materialize `config.yaml` with `mcp_servers.parley` (url + headers + high
   `timeout`) and posture keys (approvals, terminal, reasoning).
4. Materialize `.env` with provider API keys (or rely on process env if keys
   are already exported — Hermes also reads process environment; DOCS).
5. Do **not** use `--ignore-user-config` if the MCP block lives only in that
   home's `config.yaml` (it *is* the user config for that home — loading it is
   correct). Use `--ignore-user-config` only when you want built-in defaults
   *and* inject MCP another way (you currently cannot).

**VERIFIED**: with `HERMES_HOME=/tmp/…` and a `config.yaml` containing
`mcp_servers.parley`, `hermes mcp list` shows the server as enabled HTTP.

### Tool naming

MCP tools register as `mcp_<server>_<tool>` (DOCS). Parley tools would appear
as e.g. `mcp_parley_ask_orchestrator`, `mcp_parley_submit_report` unless the
agent discovers them generically (it usually does).

---

## 4. Session resume

### Session id emission

| Mode | Where session id appears | Format |
|------|--------------------------|--------|
| `chat --quiet -q` | **stderr** line `session_id: <id>` | VERIFIED source |
| `chat -q` (not quiet) | Human exit summary: `Session: <id>` + resume hint | DOCS CLI |
| `hermes -z` | **Not emitted** | VERIFIED source |

Session id shape (VERIFIED `cli.py`):

```text
YYYYMMDD_HHMMSS_<6 hex chars>
# e.g. 20260225_143052_a1b2c3
```

Stored in `$HERMES_HOME/state.db` (SQLite). DOCS: [sessions](https://hermes-agent.nousresearch.com/docs/user-guide/cli).

### Resume argv

```bash
# Preferred for Parley (quiet + follow-up prompt)
hermes chat --quiet -q "<follow-up prompt>" --resume <SESSION_ID> --yolo --source tool -m <model>

# Also accepted globally
hermes --resume <SESSION_ID>
hermes -r <SESSION_ID>
hermes --continue            # most recent CLI session
hermes -c "title substring"  # by title
```

Resume also works on `hermes chat --resume` / `--continue` (VERIFIED help).

**Caveat**: sessions are scoped to `HERMES_HOME` / profile. Resuming requires
the **same** `HERMES_HOME` (and profile) that created the session. Parley must
persist the private hermes home across prepare→resume.

**Caveat**: mid-run context compression can rotate to a continuation session
id; quiet mode syncs `cli.session_id` from the agent before printing stderr
(VERIFIED source comment). Always trust the **last** `session_id:` line.

---

## 5. Sandbox & approvals

Hermes does **not** expose Codex-style `--sandbox read-only|workspace-write|danger-full-access`.
Security is layered differently (DOCS [security](https://hermes-agent.nousresearch.com/docs/user-guide/security)).

### Approvals (headless must disable)

| Mechanism | Effect | Evidence |
|-----------|--------|----------|
| `--yolo` | Bypass dangerous-command approval prompts for the process | VERIFIED help |
| `HERMES_YOLO_MODE=1` | Same, env form | DOCS security |
| `approvals.mode: off` in config.yaml | Permanent off for that home | DOCS |
| `approvals.mode: smart\|manual` | Default smart uses aux LLM / prompts | DOCS |
| Hardline blocklist | Always on (`rm -rf /`, fork bombs, …) even under yolo | DOCS |
| `approvals.deny` | User globs blocked even under yolo | DOCS |
| Default approval timeout | 60s then **deny** (fail-closed) | DOCS |

**Parley children must always pass `--yolo` (and/or set `approvals.mode: off`
in the private home).** Without it, a dangerous-pattern match will hang or
deny in headless mode.

Also set `--accept-hooks` / `HERMES_ACCEPT_HOOKS=1` so shell hooks never TTY
prompt.

### Mapping Parley posture → Hermes

| Parley `sandbox` + `network` | Hermes mapping (proposed) | Fidelity |
|------------------------------|---------------------------|----------|
| `read-only` | `HERMES_WRITE_SAFE_ROOT` empty + deny writes via approvals? **Weak.** Better: `terminal.backend: docker` with read-only mounts, or accept host read-only is not first-class. `write_file`/`patch` blocked outside `HERMES_WRITE_SAFE_ROOT` but **terminal can still write**. | Poor without docker |
| `workspace` + network on | `terminal.backend: local`, process `cwd` = worktree, `HERMES_WRITE_SAFE_ROOT=<worktree>:<gitDir>:<gitCommonDir>:<HERMES_HOME>` so agent may write workspace + git metadata + hermes state | Partial |
| `workspace` + network off | Docker backend with `terminal.docker_network: false` (`--network=none`) **or** host network left open (local backend has no egress filter) | Docker only for real isolation |
| `full` | `terminal.backend: local`, unset `HERMES_WRITE_SAFE_ROOT`, `--yolo` | Good |

**Git worktree note**: like Codex workspace-write, if you use
`HERMES_WRITE_SAFE_ROOT`, include both the worktree private gitdir and the
common gitdir or `git commit` fails. Also include `HERMES_HOME` itself so
session DB / memory writes are not blocked.

**Container bypass**: with `docker`/`modal`/`daytona` backends, dangerous-
command approval is **skipped** (container is the boundary) — DOCS.

### Network

| Lever | Scope |
|-------|-------|
| `terminal.docker_network: false` | Docker sandbox air-gap only |
| `security.website_blocklist` | Web/browser tools domain denylist |
| Local backend | No OS-level network sandbox |

There is **no** single flag equivalent to Codex
`sandbox_workspace_write.network_access`.

---

## 6. Model & effort flags; auth env vars

### Model selection

| Lever | Notes | Evidence |
|-------|-------|----------|
| `-m` / `--model <id>` | Per invocation on `chat` and `-z` | VERIFIED help |
| `--provider <name>` | `auto`, `openrouter`, `nous`, `anthropic`, `openai-api`, `xai`, … | VERIFIED help |
| `HERMES_INFERENCE_MODEL` | Env override for model (esp. `-z`) | VERIFIED oneshot source / help |
| `HERMES_INFERENCE_PROVIDER` | Env override (seen in CLI) | VERIFIED env references in source |
| `config.yaml` `model` / `model.provider` | Defaults | DOCS |

Pass model strings through opaquely (same as other Parley vendors).

### Reasoning effort

| Lever | Notes | Evidence |
|-------|-------|----------|
| CLI `--reasoning-effort` / `--effort` | **Not present** on v0.17.0 | VERIFIED help |
| `agent.reasoning_effort` in config.yaml | `"xhigh"\|"high"\|"medium"\|"low"\|"minimal"\|"none"` | VERIFIED `cli-config.yaml.example` + `parse_reasoning_effort` |
| `/reasoning` slash | Interactive display / mid-session | DOCS CLI |

**Parley `task.effort` → write `agent.reasoning_effort` into the private
`config.yaml`.** Do not invent a CLI flag unless a newer release adds one
(re-check help at implement time). Paperclip README mentions
`--reasoning-effort`; that flag is **not** on the 0.17.0 binary we verified —
treat Paperclip as possibly ahead/behind, not authoritative.

### Auth via environment (headless)

Secrets belong in `$HERMES_HOME/.env` or the process environment. Common keys
(DOCS [environment variables](https://hermes-agent.nousresearch.com/docs/reference/environment-variables)):

| Provider | Env vars (non-exhaustive) |
|----------|---------------------------|
| OpenRouter | `OPENROUTER_API_KEY` |
| OpenAI-compatible / custom | `OPENAI_API_KEY`, `OPENAI_BASE_URL` |
| Anthropic | `ANTHROPIC_API_KEY` (OAuth via `hermes auth` / Claude Code files also supported) |
| Nous Portal | OAuth via `hermes setup --portal` / `auth.json`; portal tokens managed by Hermes |
| Google / Gemini | `GOOGLE_API_KEY` / `GEMINI_API_KEY` |
| xAI | `XAI_API_KEY` |
| DeepSeek, Kimi, MiniMax, etc. | See env docs |

OAuth flows (`hermes auth`, `hermes model`) are interactive; for CI/Parley
prefer API keys in env. `CODEX_API_KEY`-style single universal key does **not**
exist — provider-specific.

Config precedence (DOCS): CLI args > `config.yaml` > `.env` > built-ins.

---

## 7. Model enumeration

| Command | Behavior | Evidence |
|---------|----------|----------|
| `hermes model` | **Interactive** provider + model picker (TUI/curses). Can OAuth and write keys. | VERIFIED help: no `--json` list mode |
| `hermes model --refresh` | Wipe model-picker disk cache and re-fetch `/v1/models` | VERIFIED help |
| Non-interactive list | **No** `hermes models` / `hermes model --list` in 0.17.0 | VERIFIED help |

**Implication for `VendorAdapter.listModels`**: either

1. Skip probe (return empty → catalog keeps hand patches), or
2. Call provider `/v1/models` yourself using the same keys Hermes would use
   (OpenRouter `https://openrouter.ai/api/v1/models`, etc.), or
3. Shell a small Python one-liner importing Hermes' internal
   `hermes_cli.models.fetch_*` helpers — **fragile / private API**, mark
   UNKNOWN for stability.

There is no Codex-equivalent `codex debug models` or Grok `grok models`
stable CLI surface to pin.

---

## 8. Token usage

### Not in the quiet event stream

Quiet mode does **not** print usage JSON. No token fields on stdout/stderr
in the quiet path (VERIFIED source: only `final_response` + `session_id`).

### Where usage lives

| Location | Fields | Evidence |
|----------|--------|----------|
| SQLite `sessions` table | `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `estimated_cost_usd`, … | VERIFIED schema in `hermes_state.py` |
| `hermes insights [--days N] [--source tool]` | Analytics over history | VERIFIED help |
| `hermes sessions export out.jsonl --session-id <id>` | Post-hoc transcript JSONL | VERIFIED help |
| Interactive `/usage` | Human status bar / slash command | DOCS CLI |
| ACP `UsageUpdate` | Structured usage over ACP | Source `acp_adapter/server.py` imports |

### Worked example (post-hoc; shape from schema — not a live successful run)

A session row conceptually stores:

```json
{
  "id": "20260716_143052_a1b2c3",
  "input_tokens": 12840,
  "output_tokens": 952,
  "cache_read_tokens": 4000,
  "cache_write_tokens": 0,
  "reasoning_tokens": 600,
  "estimated_cost_usd": 0.042
}
```

**Adapter strategy**: after exit 0, optionally query
`$HERMES_HOME/state.db` or run `hermes sessions export` and attach usage to a
synthesized `session_meta` / final event. Live mid-run usage is UNKNOWN without
ACP or log scraping.

---

## 9. Adapter recommendation

### Proposed `prepare(task, hub) → SpawnPlan`

**Isolation model**: private `HERMES_HOME` directory per task (not the user's
`~/.hermes`), materialized under the worktree and git-excluded (same spirit as
Grok's `.grok/config.toml`).

```text
SpawnPlan.cwd  = task.cwd                          # worktree
SpawnPlan.env  = {
  HERMES_HOME: "<cwd>/.parley/hermes-home",
  HERMES_YOLO_MODE: "1",           # belt-and-braces with --yolo
  HERMES_ACCEPT_HOOKS: "1",
  # Forward orchestrator provider keys as needed, e.g.:
  # OPENROUTER_API_KEY, ANTHROPIC_API_KEY, …
  # Optional:
  # HERMES_INFERENCE_MODEL: task.model,
  # HERMES_WRITE_SAFE_ROOT: "<cwd>:<gitDir>:<gitCommonDir>:<HERMES_HOME>",  # workspace posture
}
SpawnPlan.argv = [
  "hermes", "chat",
  "--quiet",
  "--yolo",
  "--accept-hooks",
  "--source", "tool",
  // if task.model:  "-m", task.model,
  // if provider known: "--provider", provider,
  "-q", task.prompt,
]
SpawnPlan.files = [
  {
    path: ".parley/hermes-home/config.yaml",
    contents: """
approvals:
  mode: off
agent:
  reasoning_effort: <task.effort or omit>
  max_turns: 90
terminal:
  backend: local          # or docker for stronger isolation
  # docker_network: false # if network off + docker
mcp_servers:
  parley:
    url: "<hub.url>"
    headers:
      <each hub.headers entry>
    timeout: <ceil(answerTimeoutMs/1000)+60>
    connect_timeout: 15
    enabled: true
"""
  },
  # optional: ".parley/hermes-home/.env" with API keys if not in process env
]
```

Do **not** pass `--ignore-user-config` (would ignore the private home's
MCP/posture config if Hermes resolves config only via that flag's semantics —
safer to treat private home as the real user config). Do **not** pass
`--safe-mode` (disables MCP).

### Proposed `resume(task, hub) → SpawnPlan`

Same env/files as prepare (same `HERMES_HOME` path must be reused). Argv:

```text
hermes chat --quiet --yolo --accept-hooks --source tool \
  --resume <task.sessionId> \
  [-m <model>] \
  -q <task.prompt>
```

If `task.sessionId` is missing, fail the resume — `-z` / continue-latest are
racy across concurrent tasks.

### Event-parse table (`parseEvent`)

Because Hermes quiet mode is **not** JSONL, choose one:

**A. Line-oriented pseudo-events (recommended for spawn-per-turn)**

Capture stdout and stderr separately (or tag lines). Normalize:

| Raw input | → `VendorEvent` |
|-----------|-----------------|
| Non-empty stdout chunk / full stdout at close | `{ kind: "message", text }` |
| stderr line matching `/^session_id:\s*(\S+)/` | `{ kind: "session_meta", session_id }` |
| stdout/stderr matching provider/auth errors (`No inference provider`, `Error:`, `hermes -z: agent failed:`) | `{ kind: "error", text, fatal: true }` |
| Process exit ≠ 0 with no prior fatal | `{ kind: "error", text: "hermes exit <code>", fatal: true }` |
| Everything else | `[]` (opaque; keep raw log) |

`sessionId(events)`: last `session_meta.session_id`.

`usage`: optional post-exit SQLite/`sessions export` probe →
`{ kind: "session_meta", usage: { input_tokens, output_tokens, … } }`.

**B. ACP long-lived child (future / alternative)**

Map ACP `session/update` notifications (message chunks, tool start/complete,
usage) onto VendorEvent kinds. Requires a different adapter lifecycle than
codex/grok. Partially documented via `hermes acp`; **not VERIFIED** end-to-end
in this pass.

### Top risks / unknowns

1. **No live tool/file events** — cockpit timeline will be thin unless Parley
   scrapes agent logs under `$HERMES_HOME/logs/` (format UNKNOWN for stable
   parse) or switches to ACP.
2. **Version drift** — verified 0.17.0; upstream already at 0.18.2. Quiet
   stderr contract is source-backed but not a published API. Pin + re-verify.
3. **Sandbox fidelity gap** — local backend is full host user access; write
   guards do not cover `terminal`. Docker backend changes semantics (cwd mount
   opt-in via `docker_mount_cwd_to_workspace`).
4. **MCP tool timeout default 300s** — still raise for long human answers.
5. **Auth surface is multi-provider** — adapter must document which keys Parley
   forwards; no single `HERMES_API_KEY`.
6. **Model enumeration** — no clean CLI list; `listModels` may stay stub.
7. **Effort only via config file** on 0.17.0 — must materialize config even if
   MCP were somehow flagged.
8. **User global pollution** — without `HERMES_HOME` isolation, children write
   sessions/skills/memory into the operator's `~/.hermes`. Isolation is
   load-bearing.
9. **Hardline blocklist** can block some ops even with yolo (by design).
10. **`--worktree` / hermes-native worktrees** — Parley already owns worktrees;
    do **not** pass `hermes -w` (double isolation / confusing git state).
11. ACP / Paperclip patterns exist but were not run live here — treat richer
    integration as a follow-up spike.

### Implementation checklist for the adapter author

- [ ] Require `hermes` on PATH; record `hermes --version` in diag.
- [ ] Private `HERMES_HOME` per task with MCP hub + approvals off + effort.
- [ ] Always `--quiet -q --yolo --accept-hooks --source tool`.
- [ ] Parse `session_id:` from stderr; store for resume.
- [ ] Raise MCP `timeout` above answer timeout.
- [ ] Map sandbox best-effort; document residual host access on local backend.
- [ ] Tolerate non-JSON stdout; never assume JSONL.
- [ ] Golden-test auth-failure stdout and a mocked successful quiet transcript
      once API keys are available in CI.

---

## Sources

| Source | Role |
|--------|------|
| Live binary `hermes` v0.17.0 (2026.6.19) | VERIFIED help, version, auth error shape, HERMES_HOME MCP list |
| Installed source tree `/var/lib/hermes/.hermes/hermes-agent` (`efd87a15`) | VERIFIED quiet path, oneshot, session id format, MCP timeout, SQLite usage columns |
| [hermes-agent.nousresearch.com/docs](https://hermes-agent.nousresearch.com/docs/) | DOCS install, CLI, MCP, security, configuration, env vars |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | DOCS identity, releases |
| [hermes-paperclip-adapter](https://github.com/NousResearch/hermes-paperclip-adapter) | DOCS prior integration shape (stdout parse, `--source tool`) |

Primary claim discipline: every operational fact above is tagged VERIFIED (ran
or read installed source at pin), DOCS (URL), or UNKNOWN (blocked on live
authed run / unpublished API).
