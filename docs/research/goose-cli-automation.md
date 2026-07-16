# Goose CLI — automation surface for Parley

Research asset for documenting Block/AAIF goose so a Parley vendor adapter can be written without re-research. Verified against the CLI binary **v1.43.0** (release tag `v1.43.0`, 2026-07-14) on Linux x86_64, plus official docs at [goose-docs.ai](https://goose-docs.ai/) and source at [github.com/aaif-goose/goose](https://github.com/aaif-goose/goose) (formerly `block/goose`; now under the Agentic AI Foundation).

**Evidence key:** every claim is tagged **VERIFIED** (ran on v1.43.0), **DOCS** (cited URL), **SOURCE** (read v1.43.0 Rust sources), or **UNKNOWN** (what blocks verification).

## TL;DR for Parley

Goose **can** do headless one-shot automation via `goose run`. It is a viable adapter, with different seams than Codex/Grok:

| Need | Goose surface | Fit |
| --- | --- | --- |
| One-shot headless | `goose run -t "<prompt>"` | Good |
| Streaming JSON events | `--output-format stream-json` | Good (JSONL) |
| MCP-over-HTTP + custom headers | Config `type: streamable_http` + `headers:` under `GOOSE_PATH_ROOT` isolation | Good (file/env isolation, **not** a pure flag) |
| Session resume | `--resume --session-id <id>` or `--resume -n <name>` | Usable, but **session id is not in the JSONL stream** |
| Sandbox / network | **No OS sandbox**; only `GOOSE_MODE` tool-approval modes | Weak vs Codex/Grok |
| Model selection | `--provider` / `--model` or env | Good |
| Auth via env | Provider-specific keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …) | Good |
| Token usage | `complete` event fields; richer in `session list -f json` | Partial |
| Model enumeration | No stable headless catalog command | Weak |

**Closest viable integration shape:** hermetic per-task `GOOSE_PATH_ROOT` with a materialized `config/config.yaml` (MCP hub + headers + `GOOSE_MODE: auto` + raised extension `timeout`), spawn:

```bash
goose run \
  --output-format stream-json \
  --provider <provider> --model <model> \
  -n "parley-<taskId>" \
  -t "<prompt>"
```

Resume:

```bash
goose run \
  --output-format stream-json \
  --resume --session-id <id> \
  --provider <provider> --model <model> \
  -t "<follow-up prompt>"
```

Do **not** pass `--no-session` if resume matters. Prefer assigning a stable session **name** (`-n`) so resume can fall back to name if id capture fails.

---

## 1. Identity & install

| Field | Value | Evidence |
| --- | --- | --- |
| Product | goose — open-source on-machine AI agent (CLI + Desktop + ACP server) | DOCS: [README](https://github.com/aaif-goose/goose), [install](https://goose-docs.ai/docs/getting-started/installation) |
| Org / repo | Agentic AI Foundation; `github.com/aaif-goose/goose` (historical: Block / `block/goose`) | DOCS |
| Binary | `goose` | VERIFIED v1.43.0: `goose --version` → `1.43.0` |
| Language | Rust | DOCS / SOURCE |
| Headless surface | `goose run` | VERIFIED; DOCS: [running tasks](https://goose-docs.ai/docs/guides/running-tasks/), [CLI commands](https://goose-docs.ai/docs/guides/goose-cli-commands/) |
| Verified version | **1.43.0** (`v1.43.0`, published 2026-07-14) | VERIFIED: downloaded `goose-x86_64-unknown-linux-gnu.tar.gz` from GitHub Releases |

**Install commands (pick one):**

```bash
# Latest stable installer (may prompt configure; disable for CI)
curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash

# Pin a release (recommended for adapters / CI)
# Linux x86_64 example for the version this doc verified:
curl -fsSL -o goose.tar.gz \
  https://github.com/aaif-goose/goose/releases/download/v1.43.0/goose-x86_64-unknown-linux-gnu.tar.gz
tar -xzf goose.tar.gz   # extracts ./goose
# or: brew install block-goose-cli  (Homebrew formula; version floats)
```

DOCS: [installation](https://goose-docs.ai/docs/getting-started/installation), [CI version pin](https://goose-docs.ai/docs/getting-started/installation#pin-a-goose-version-in-cicd) (`GOOSE_VERSION`).

**Not an npm package** for the official CLI (binary release / Homebrew / deb/rpm). UNKNOWN: whether third-party npm wrappers exist — ignore them for the adapter.

**Default paths (Linux, without isolation):**

| Path | Role |
| --- | --- |
| `~/.config/goose/config.yaml` | Provider, mode, extensions |
| `~/.local/share/goose/sessions/sessions.db` | SQLite session store (since ≥1.10.0) |
| `~/.local/state/goose/logs` | Logs |

VERIFIED via `goose info`. Override root with `GOOSE_PATH_ROOT` (creates `config/`, `data/`, `state/` under that root). DOCS: [environment variables — GOOSE_PATH_ROOT](https://goose-docs.ai/docs/guides/environment-variables#development--testing). VERIFIED: `GOOSE_PATH_ROOT=/tmp/… goose info` rewrites all three path families.

---

## 2. Headless invocation

### 2.1 One-shot argv

**Canonical one-shot (Parley-shaped):**

```bash
goose run \
  --output-format stream-json \
  --provider openai \
  --model gpt-4o \
  -n "parley-<taskId>" \
  -t "<prompt text>"
```

| Flag | Role | Evidence |
| --- | --- | --- |
| `run` | Non-interactive task execution; exits when the turn finishes | VERIFIED; DOCS |
| `-t` / `--text` | Prompt text on the argv | VERIFIED |
| `-i` / `--instructions <file>` | Prompt from file; `-i -` = stdin | DOCS / `--help` |
| `--output-format stream-json` | JSONL events on stdout as they occur | VERIFIED |
| `--output-format json` | Single pretty-printed JSON object at end | VERIFIED |
| `--output-format text` | Default human output | VERIFIED (default) |
| `-q` / `--quiet` | Suppress non-response noise (including the session banner) | VERIFIED: with `-q`, no session id appears on stdout |
| `--no-session` | Discard session persistence | VERIFIED in `--help`; **do not use** if resume is required |
| `-n` / `--name` | Human session name (also used with `--resume`) | VERIFIED |
| `--session-id` | Resume a specific id (requires `--resume`) | VERIFIED |
| `-r` / `--resume` | Continue a previous run | VERIFIED |
| `--provider` / `--model` | Per-run overrides | VERIFIED |
| `--with-streamable-http-extension <url [timeout=N]>` | Ephemeral HTTP MCP (no headers) | VERIFIED |
| `--with-extension '<ENV=… cmd args…>'` | Ephemeral stdio MCP | `--help` / DOCS |
| `--with-builtin <names>` | Enable builtins (comma-separated) | DOCS |
| `--no-profile` | Skip default extensions; only CLI-specified | VERIFIED in `--help` |
| `--max-turns <N>` | Cap agent turns without user input (default 1000) | DOCS / env `GOOSE_MAX_TURNS` |
| `--stats` | Print generation stats after run (text mode) | `--help`; not useful with stream-json alone |
| `-s` / `--interactive` | Stay interactive after the initial prompt | Not for Parley children |

**Working directory:** process `cwd` is the project root (no `--cd` flag on `run`). Parley should `spawn` with `cwd: task.cwd`. VERIFIED: banner prints the cwd of the process.

### 2.2 Streaming JSON format (`stream-json`)

**SOURCE** (`crates/goose-cli/src/session/mod.rs` @ v1.43.0): events are `#[serde(tag = "type", rename_all = "snake_case")]` and printed one JSON object per line via `emit_stream_event`.

**Event types:**

| `type` | Fields | When |
| --- | --- | --- |
| `message` | `message: Message` | Each agent message (assistant text, tool requests/responses, …) |
| `notification` | `extension_id`, plus flattened log/progress payload | MCP server notifications |
| `error` | `error: string` | Agent/provider errors mid-stream |
| `complete` | `total_tokens`, optional `input_tokens`, `output_tokens` | End of run (always emitted in stream-json mode) |

**Message shape** (SOURCE: `goose-provider-types` message types use `camelCase` fields; content is tagged with `type`):

```json
{
  "type": "message",
  "message": {
    "id": null,
    "role": "assistant",
    "created": 1784189502,
    "content": [{ "type": "text", "text": "…" }],
    "metadata": { "userVisible": true, "agentVisible": true }
  }
}
```

Content variants include (SOURCE): `text`, `image`, `toolRequest`, `toolResponse`, `toolConfirmationRequest`, `actionRequired`, `frontendToolRequest`, `thinking`, `redactedThinking`, `systemNotification`.

**Real example lines — VERIFIED v1.43.0** (auth failure, no API key; still valid event shapes):

```json
{"type":"message","message":{"id":null,"role":"assistant","created":1784189502,"content":[{"type":"text","text":"Ran into this error: Authentication error: Authentication failed for https://api.openai.com/v1/chat/completions. Status: 401 Unauthorized. Response: You didn't provide an API key. …"}],"metadata":{"userVisible":true,"agentVisible":true}}}
{"type":"complete","total_tokens":null}
```

Without `-q`, a human banner is mixed onto **stdout** *before* the JSONL (same stream). Example (VERIFIED):

```text

    __( O)>  ● new session · openai gpt-4o
   \____)    20260716_9 · ~/.parley/worktrees/parley/t240
     L L     goose is ready
{"type":"message",…}
{"type":"complete","total_tokens":null}
```

**Implication:** `parseEvent` must ignore non-JSON lines; the banner is the only place the session id appears in the child stdout for a normal run.

### 2.3 Batch JSON (`json`)

Single object after completion (VERIFIED):

```json
{
  "messages": [ /* user + assistant Message objects */ ],
  "metadata": {
    "total_tokens": null,
    "status": "completed"
  }
}
```

Optional `input_tokens` / `output_tokens` on metadata when present (SOURCE). Less suitable for Parley's live JSONL log than `stream-json`.

### 2.4 Exit codes

| Situation | Exit code | Evidence |
| --- | --- | --- |
| No provider configured | **1** | VERIFIED: `goose run -t x` → exit 1, stderr `No provider configured. Run 'goose configure' first.` |
| Provider set, auth fails (401) | **0** | VERIFIED: auth error delivered as assistant `message` + `complete`; process still exits 0 |
| MCP extension fails to start | **0** (warn + continue) | VERIFIED: `Warning: Failed to start extension 'parley' … continuing without it` |

**Adapter consequence:** exit code alone is **not** a reliable success signal. Parse the stream for auth/fatal text and for a missing `submit_report`. Prefer surfacing assistant error text as `VendorEvent` `error` when it matches auth/fatal patterns.

---

## 3. MCP injection

Goose calls MCP servers **extensions**.

### 3.1 Transports

| Transport | Config `type` | CLI flag | Headers | Evidence |
| --- | --- | --- | --- | --- |
| Streamable HTTP | `streamable_http` | `--with-streamable-http-extension` | **Config only** | DOCS + VERIFIED + SOURCE |
| stdio | `stdio` | `--with-extension` | N/A (use env on command) | DOCS |
| Builtin / platform | `builtin` / `platform` | `--with-builtin` | N/A | DOCS |
| SSE | legacy | — | — | DOCS: migrate to streamable_http |

DOCS: [using extensions](https://goose-docs.ai/docs/getting-started/using-extensions/), [config files](https://goose-docs.ai/docs/guides/config-files/).

### 3.2 Custom headers

**Supported on config entries, not on the CLI flag.**

Config shape (DOCS + VERIFIED with isolated config):

```yaml
extensions:
  parley:
    enabled: true
    type: streamable_http
    name: parley
    description: Parley daemon MCP hub
    uri: "http://127.0.0.1:PORT/mcp"
    headers:
      X-Parley-Task: "<task-id>"
      # any correlation headers from HubInfo.headers
    timeout: 600   # seconds; default 300 (SOURCE DEFAULT_EXTENSION_TIMEOUT)
```

VERIFIED: with `GOOSE_PATH_ROOT` pointing at a temp tree containing that `config/config.yaml`, `goose info -v` shows the extension and headers; a run attempts `initialize` against the URI (connection refused on port 9 still proves the client path).

CLI flag parser (SOURCE `cli.rs` `parse_streamable_http_extension`): accepts only `url` and optional `timeout=<seconds>` — **no header key**. Headers map is always empty for CLI-injected HTTP extensions (SOURCE `parse_streamable_http_extension` in `session/mod.rs`).

```bash
# Headers impossible here:
goose run --with-streamable-http-extension "http://127.0.0.1:9/mcp timeout=600" …
# Extension name becomes host_port_path, e.g. 127_0_0_1_9_mcp (VERIFIED warning text)
```

### 3.3 Flags vs config vs env vs project path

| Mechanism | Headers? | Isolation | Parley use |
| --- | --- | --- | --- |
| `--with-streamable-http-extension` | **No** | Per-process ephemeral | Only if hub needs no correlation headers (not Parley's case) |
| User `~/.config/goose/config.yaml` | Yes | Shared with human sessions — **unsafe** | Avoid |
| **`GOOSE_PATH_ROOT=<task-private-dir>` + `config/config.yaml`** | Yes | Full hermetic config/data/state | **Recommended** |
| Project-local extension config file | — | UNKNOWN: no first-class project `config.yaml` for extensions found | Do not rely on |
| Env alone | No for MCP URL/headers | — | Mode/provider/model only |

Project context files that *do* exist (not MCP):

- Local `.goosehints` and `AGENTS.md` (default context filenames) — DOCS: [goosehints](https://goose-docs.ai/docs/guides/context-engineering/using-goosehints/), env `CONTEXT_FILE_NAMES`.

**Tool timeout for `ask_orchestrator`:** extension `timeout` is in **seconds**, default **300**. Raise above Parley's answer timeout (same class of gotcha as Codex `tool_timeout_sec`). SOURCE/DOCS. There is no separate per-tool timeout field in the streamable_http config shape observed.

**Failure mode:** failed MCP init is a **warning**, not a hard error (VERIFIED). The agent continues without the hub — a silent integration failure. Adapter should treat start warnings as `PARLEY-DIAG`-class diagnostics if captured from stderr, or probe the hub separately.

**`--no-profile`:** drops default extensions so only CLI-listed ones load. When using config-injected MCP under `GOOSE_PATH_ROOT`, usually leave profile loading on so `developer` stays available (writes/shell). If the isolated config only lists `parley`, builtins may still be auto-merged (VERIFIED `info -v` still showed bundled platform extensions alongside the custom entry).

---

## 4. Session resume

### 4.1 Session id format

- Format: `YYYYMMDD_N` (e.g. `20260716_9`) — VERIFIED via banner and `goose session list -f json`.
- Stored in SQLite under `$GOOSE_PATH_ROOT/data/sessions/sessions.db` (or default user path).

### 4.2 Emission in the event stream

| Channel | Session id present? | Evidence |
| --- | --- | --- |
| `stream-json` events | **No** — not on `message` / `complete` / `error` | VERIFIED + SOURCE (`StreamEvent` has no session field) |
| Banner (stdout, non-quiet) | **Yes** — middle line `YYYYMMDD_N · <cwd>` | VERIFIED |
| `-q` quiet mode | **No** banner | VERIFIED |
| `goose session list -f json` | Yes (`id`, `name`, `working_dir`, …) | VERIFIED |
| Env inside tools | `AGENT_SESSION_ID` for stdio/shell contexts | DOCS: [env vars](https://goose-docs.ai/docs/guides/environment-variables#using-session-ids-in-workflows) |

**Adapter strategies (in order):**

1. Assign a stable name `-n parley-<taskId>` on every prepare/resume.
2. Parse the banner line with a regex like `\b(\d{8}_\d+)\b` from non-JSON stdout **or** run without `-q` and strip non-JSON lines.
3. After the child exits, query `goose session list -f json -w <cwd> -l 5` (or by name) under the same `GOOSE_PATH_ROOT` to resolve `id`.
4. Prefer resume by **name** if id was lost: `goose run --resume -n parley-<taskId> -t "…"`.

### 4.3 Resume argv

```bash
# By id (preferred once captured)
goose run --output-format stream-json \
  --resume --session-id 20260716_9 \
  --provider openai --model gpt-4o \
  -t "<orchestrator answer / follow-up>"

# By name
goose run --output-format stream-json \
  --resume -n parley-<taskId> \
  --provider openai --model gpt-4o \
  -t "<follow-up>"
```

VERIFIED: `--resume --session-id 20260716_1` prints banner `resuming · … · 20260716_1` and continues (auth still failed in the probe, but resume path executed). Resume by name with `-n parley-banner` also accepted.

Interactive equivalent: `goose session --resume --session-id <id>` — DOCS; Parley should stick to `goose run` for headless JSONL.

**Do not use `--no-session`** on prepare if resume is required.

---

## 5. Sandbox & approvals

### 5.1 What goose does *not* have

Unlike Codex (`--sandbox`) or Grok (`GROK_SANDBOX`), goose **v1.43.0 has no OS-level filesystem/network sandbox** for CLI tool execution. The Developer extension can run shell and edit files with the permissions of the process user. DOCS emphasize autonomy; a third-party sandbox analysis notes the same gap.

**Parley posture mapping is therefore policy-only, not true isolation.**

### 5.2 Approval / mode controls

| Mode (`GOOSE_MODE`) | Behavior | Headless safety |
| --- | --- | --- |
| `auto` | Fully autonomous tool use (default) | Correct for unattended children |
| `approve` | Prompt before tools | **Will hang or refuse** without TTY |
| `smart_approve` | Risk-based prompts | **Unsafe** headless |
| `chat` | No tools / file mods | Too restricted for coding tasks |

DOCS: [goose permissions](https://goose-docs.ai/docs/guides/managing-tools/goose-permissions/). Config key / env: `GOOSE_MODE`. Default is autonomous (`auto`).

**SOURCE headless behavior:** in non-interactive runs, if a tool confirmation is required while mode is `approve` or `smart_approve`, goose **cancels** rather than auto-allowing (comment in `session/mod.rs`: refuse to bypass safety contract). So wrong mode fails closed — good — but tasks that need tools still need `auto`.

### 5.3 Parley posture → goose

| Parley `sandbox` | Parley `network` | Goose mapping | Notes |
| --- | --- | --- | --- |
| `read-only` | * | **No native map.** Closest: `GOOSE_MODE=chat` (no tools) **or** external OS sandbox (bubblewrap/firejail) around the process | UNKNOWN whether chat mode still allows read-only developer tools — treat as insufficient for true RO |
| `workspace` | on (default) | `GOOSE_MODE=auto`; rely on worktree cwd + OS user perms | Default recommendation |
| `workspace` | off | **No native network toggle.** Use external sandbox / netns / `HTTPS_PROXY` blackhole | UNKNOWN without host controls |
| `full` | * | `GOOSE_MODE=auto` | Same as workspace in practice |

**Disable interactive approvals for headless:** set `GOOSE_MODE=auto` via env (highest precedence) or config under `GOOSE_PATH_ROOT`. DOCS: env overrides config.

Optional security extras (not a substitute for sandbox): `SECURITY_PROMPT_ENABLED`, extension allowlist `GOOSE_ALLOWLIST` — DOCS.

---

## 6. Model & effort flags; auth env vars

### 6.1 Model / provider

| Mechanism | Example | Evidence |
| --- | --- | --- |
| CLI | `--provider anthropic --model claude-sonnet-4-5-20250929` | VERIFIED / DOCS |
| Env | `GOOSE_PROVIDER`, `GOOSE_MODEL` | DOCS |
| Config | `active_provider` + `providers.<id>` (newer) or legacy flat keys | DOCS: [config files](https://goose-docs.ai/docs/guides/config-files/) |

CLI flags override env for that run (DOCS running-tasks).

**Hermetic path root (`GOOSE_PATH_ROOT`) drops `~/.config/goose` provider state** (adapter-validation-a / #107). Headless children therefore need `GOOSE_PROVIDER` in the daemon env **or** `extraArgs: ["--provider", …]`; without either, `goose run` exits 1 with `No provider configured`. Adapter prepare should refuse loudly rather than spawn a doomed child.

### 6.2 Effort / thinking

There is **no** general `--effort` / `--reasoning-effort` flag on `goose run` (VERIFIED: absent from `--help`).

Provider-specific knobs:

| Variable | Scope | Values | Evidence |
| --- | --- | --- | --- |
| `CLAUDE_THINKING_TYPE` | Anthropic / Databricks Claude | `adaptive`, `enabled`, `disabled` | DOCS env vars |
| `GEMINI3_THINKING_LEVEL` | Gemini 3 | `low`, `high` | DOCS |
| `GOOSE_TEMPERATURE` | Global | 0.0–1.0 | DOCS |
| `GOOSE_MAX_TOKENS` | Global | positive int | DOCS |

**Adapter recommendation:** pass Parley `effort` through only when the selected provider documents a mapping (e.g. Claude → `CLAUDE_THINKING_TYPE`); otherwise leave unset. Opaque passthrough of unknown effort strings as a CLI flag will fail.

### 6.3 Auth env vars (headless)

API keys are **not** read from `config.yaml` (DOCS security note). Prefer env (or keyring / `secrets.yaml` when keyring disabled).

Common provider envs (DOCS: [providers](https://goose-docs.ai/docs/getting-started/providers)):

| Provider | Primary env |
| --- | --- |
| OpenAI | `OPENAI_API_KEY` (+ optional `OPENAI_HOST`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT`, `OPENAI_CUSTOM_HEADERS`) |
| Anthropic | `ANTHROPIC_API_KEY` (+ optional `ANTHROPIC_HOST`) |
| Google Gemini | `GOOGLE_API_KEY` |
| xAI | `XAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Databricks | `DATABRICKS_HOST`, `DATABRICKS_TOKEN` |
| Generic override | `GOOSE_PROVIDER__API_KEY`, `GOOSE_PROVIDER__HOST`, `GOOSE_PROVIDER__TYPE` |

Headless CI: set `GOOSE_DISABLE_KEYRING=1` so secrets do not require a desktop keyring (DOCS). Keys then live in env or `secrets.yaml` under the config root.

VERIFIED auth failure shape (no key): assistant message text begins with `Ran into this error: Authentication error: … Status: 401`.

---

## 7. Model enumeration

| Command | Purpose | Machine-readable? | Evidence |
| --- | --- | --- | --- |
| `goose configure` → Configure Providers | Interactive model pick | No | DOCS |
| `goose local-models list` | Downloaded **local** GGUF/MLX models only | Text | VERIFIED `--help` subcommands: `search`, `download`, `list`, `delete` |
| `goose info -v` | Active config, not full catalog | YAML dump | VERIFIED |
| Provider HTTP catalogs | e.g. OpenAI/OpenRouter list models APIs | Via provider, not goose | DOCS mentions provider-specific catalogs |

**There is no `goose models` / `goose debug models` equivalent to Codex/Grok for cloud models** in v1.43.0.

**Adapter `listModels` recommendation:**

- Return **UNKNOWN / skip probe** and keep a hand-maintained catalog; or
- Shell out to a provider-specific API when `GOOSE_PROVIDER` is known; or
- Document models as free-form strings (`--model` is opaque).

---

## 8. Token usage

### 8.1 In the event stream

Terminal `complete` event (SOURCE + VERIFIED with nulls on failed auth):

```json
{"type":"complete","total_tokens":null}
```

When usage is known, SOURCE also serializes:

```json
{
  "type": "complete",
  "total_tokens": 1234,
  "input_tokens": 1000,
  "output_tokens": 234
}
```

(`input_tokens` / `output_tokens` use `skip_serializing_if = Option::is_none`.)

Values come from session `accumulated_usage` falling back to per-turn `usage` (SOURCE).

### 8.2 Richer post-hoc usage

`goose session list -f json` includes (VERIFIED fields on session objects):

```json
"usage": {
  "input_tokens": null,
  "output_tokens": null,
  "total_tokens": null,
  "cache_read_input_tokens": null,
  "cache_write_input_tokens": null
},
"accumulated_usage": { /* same shape */ },
"accumulated_cost": null
```

**Worked example (auth-fail run, VERIFIED):** stream ends with `complete.total_tokens: null`; session list shows all usage fields null — consistent.

**Successful-run numeric example:** UNKNOWN (no API key in the research environment). Field names above are pinned from SOURCE + list JSON; re-verify once with a live key before billing logic.

`--stats` prints human generation stats after a run in text mode; not required if you parse `complete`.

---

## 9. Adapter recommendation

### 9.1 `prepare(task, hub)` → `SpawnPlan`

**Env:**

```text
GOOSE_PATH_ROOT=<taskPrivateDir>          # required for hermetic MCP+mode
GOOSE_DISABLE_KEYRING=1                   # headless
GOOSE_MODE=auto                           # disable approval prompts
GOOSE_PROVIDER=<from task or host>        # optional if --provider set
GOOSE_MODEL=<task.model>                  # optional if --model set
GOOSE_DISABLE_SESSION_NAMING=true         # avoid extra model call for titles (DOCS)
# Pass through provider API keys from parent env, e.g.:
OPENAI_API_KEY / ANTHROPIC_API_KEY / XAI_API_KEY / …
# Effort mapping when applicable:
CLAUDE_THINKING_TYPE=<mapped>             # only for Claude-family effort
```

**Files** (under `GOOSE_PATH_ROOT`, *not* necessarily task cwd — write before spawn; daemon can treat these as absolute materialization outside `SpawnPlan.files` or set `files` if the plan root is the path root):

`config/config.yaml`:

```yaml
GOOSE_MODE: auto
extensions:
  parley:
    enabled: true
    type: streamable_http
    name: parley
    description: Parley hub
    uri: "<hub.url>"
    headers:
      # each hub.headers entry
      X-Parley-Task: "<task.id>"
    timeout: <ceil(answerTimeoutMs/1000) + headroom>   # e.g. 600+
```

If `SpawnPlan.files` is cwd-relative only, prefer env `GOOSE_PATH_ROOT` + adapter-owned write of that tree (same pattern as provisioning `CODEX_HOME`).

**Argv:**

```text
goose run
  --output-format stream-json
  --provider <provider>
  --model <task.model>          # if non-null
  -n parley-<task.id>
  -t <task.prompt>
```

Omit `--no-session`. Omit `-q` if you want banner-based session-id capture; keep parser tolerant either way.

**cwd:** `task.cwd`.

### 9.2 `resume(task, hub)`

Same env + re-materialized config (hub URL/headers may change). Argv:

```text
goose run
  --output-format stream-json
  --resume
  --session-id <task.sessionId>   # required if using id path
  --provider <provider>
  --model <task.model>
  -t <task.prompt>                # orchestrator answer / continuation
```

Fallback if only name is known: `--resume -n parley-<task.id>` without `--session-id`.

Reject resume when neither `sessionId` nor recoverable name exists (same fail-loud pattern as Grok adapter).

### 9.3 Event-parse table

| Goose stream line | → `VendorEvent` |
| --- | --- |
| Non-JSON (banner, warnings) | `[]` opaque; optionally regex session id → `{ kind: "session_meta", session_id }` |
| `type: "message"` + content `type: "text"` | `{ kind: "message", text }` (join text parts) |
| `type: "message"` + content `toolRequest` | `{ kind: "command", text: tool name + args }` (or opaque if noisy) |
| `type: "message"` + auth/error assistant text | `{ kind: "error", text, fatal?: true }` when matching auth/fatal patterns |
| `type: "message"` + `toolResponse` with error | `{ kind: "error", text }` with `PARLEY-DIAG` if tool is hub `submit_report` / `ask_orchestrator` |
| `type: "notification"` | `[]` or message for log payloads |
| `type: "error"` | `{ kind: "error", text: event.error, fatal: true }` |
| `type: "complete"` | `{ kind: "session_meta", usage: { total_tokens, input_tokens?, output_tokens? } }` (drop nulls) |
| Unknown | `[]` |

**`sessionId(events)`:** last `session_meta.session_id` from banner parse; if missing, post-process via `session list`.

### 9.4 Top risks / unknowns

1. **No OS sandbox** — workspace/read-only/network postures cannot be enforced in-process; document host-level isolation or accept reduced guarantees vs Codex/Grok.
2. **Session id not in JSONL** — resume depends on banner parse, stable `-n` name, or post-hoc `session list` under the same `GOOSE_PATH_ROOT`.
3. **MCP headers require config isolation** — CLI HTTP flag cannot carry Parley correlation headers; `GOOSE_PATH_ROOT` is load-bearing.
4. **MCP start failures are soft** — agent runs without hub; must detect "Failed to start extension 'parley'" on **stderr** (engine now feeds stderr to `parseEvent`, #107) and emit a fatal/PARLEY-DIAG event. Resume misses (`No session found…`) also land on stderr only.
5. **Exit code 0 on auth failure** — do not trust exit status; parse stream text.
6. **No cloud model catalog CLI** — `listModels` will be weak or provider-specific.
7. **No unified effort flag** — map only known provider envs.
8. **Bundled extensions auto-enable** — Developer can shell/edit freely under `auto`; intentional for coding agents but high blast radius.
9. **Version churn** — pin `v1.43.0` (or later known-good) in CI (`GOOSE_VERSION` / release tarball); re-verify `StreamEvent` if upgrading.
10. **UNKNOWN:** exact notification JSON shape under live MCP progress (SOURCE defines `Log` / `Progress`; not observed live). **UNKNOWN:** numeric token fields on a successful paid run. **UNKNOWN:** whether recipe/ACP paths are better long-term than `goose run` for multi-turn steering (ACP exists: `goose acp` / `goose serve` — DOCS; out of scope for spawn-per-turn ADR-0004 unless revisited).

### 9.5 Viability summary

Goose **supports** headless single-shot automation (`goose run` + `stream-json`). It is **not** blocked. The integration is **config-file + env isolation** heavy (like Grok) rather than flags-only (like Codex), and **weaker on sandbox and session-id streaming**. With `GOOSE_PATH_ROOT`, `GOOSE_MODE=auto`, streamable_http headers in config, and careful session naming, a stranger can implement `packages/daemon/src/adapters/goose.ts` from this document alone.

---

## Sources

- VERIFIED binary: goose **1.43.0** Linux x86_64 release asset `goose-x86_64-unknown-linux-gnu.tar.gz`
- DOCS: https://goose-docs.ai/docs/guides/running-tasks/
- DOCS: https://goose-docs.ai/docs/guides/goose-cli-commands/
- DOCS: https://goose-docs.ai/docs/guides/environment-variables
- DOCS: https://goose-docs.ai/docs/guides/config-files/
- DOCS: https://goose-docs.ai/docs/getting-started/using-extensions/
- DOCS: https://goose-docs.ai/docs/guides/managing-tools/goose-permissions/
- DOCS: https://goose-docs.ai/docs/getting-started/providers
- DOCS: https://goose-docs.ai/docs/getting-started/installation
- SOURCE: https://github.com/aaif-goose/goose/tree/v1.43.0 (esp. `crates/goose-cli/src/session/mod.rs`, `cli.rs`, `crates/goose/src/agents/extension.rs`)
- Releases: https://github.com/aaif-goose/goose/releases/tag/v1.43.0
