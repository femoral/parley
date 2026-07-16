# OpenHands CLI — automation surface for Parley

Research asset for documenting the headless automation surface of **OpenHands**
(All Hands AI / [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands)) so a
Parley vendor adapter can be written without re-research. Verified against
**OpenHands CLI `1.16.0`** (PyPI package `openhands`, entry point `openhands`;
bundled **OpenHands SDK `1.21.0`**) installed into a worktree-local venv on
2026-07-16. Primary docs host: [docs.openhands.dev](https://docs.openhands.dev).

## TL;DR for Parley

OpenHands **does** support headless one-shot automation and is a viable adapter
target, but it is **file/env-heavy** (like Grok), not flags-only (like Codex):

| Parley need | OpenHands CLI 1.16.0 |
| --- | --- |
| Headless one-shot | `openhands --headless --json -t "…"` **VERIFIED** |
| Streaming JSON events | `--json` (requires `--headless`) → JSONL on **stdout** (mixed with human text) **VERIFIED** |
| MCP-over-HTTP + custom headers | `~/.openhands/mcp.json` (or `$OPENHANDS_PERSISTENCE_DIR/mcp.json`); HTTP/SSE + `headers` **VERIFIED** (format) / **DOCS** (runtime) |
| Session resume | `openhands --headless --json --resume <id> -t "follow-up"` **VERIFIED** |
| Sandbox read-only/workspace/full + network | **No** CLI sandbox matrix; process-local workspace only **VERIFIED** |
| Disable interactive approvals | Headless hard-codes `NeverConfirm` **VERIFIED** |
| Model selection | `LLM_MODEL` + `--override-with-envs` (or settings file) **VERIFIED** |
| Auth via env | `LLM_API_KEY` (+ optional `LLM_BASE_URL`) with `--override-with-envs` **VERIFIED** |
| Token usage in stream | **Not in JSONL**; stats live in conversation `base_state.json` **VERIFIED** |
| Model enumeration CLI | **None** — SDK `VERIFIED_MODELS` only **VERIFIED** |

**Closest viable integration shape:** isolate each child with
`OPENHANDS_PERSISTENCE_DIR` / `OPENHANDS_CONVERSATIONS_DIR` / `OPENHANDS_WORK_DIR`,
materialize `mcp.json` (and optionally `agent_settings.json`) under the persistence
dir, spawn with `--headless --json --override-with-envs -t <prompt>`, parse JSON
objects from a **polluted** stdout, treat `ConversationErrorEvent` as fatal, scrape
session id from trailing `Conversation ID:` text (or the conversations dir), and
read token usage from `base_state.json` after exit — not from the event stream.

---

## 1. Identity & install

**Package / binary**

| Item | Value | Evidence |
| --- | --- | --- |
| Product | OpenHands CLI (terminal UI + headless) | [Installation](https://docs.openhands.dev/openhands/usage/cli/installation) **DOCS** |
| PyPI package (current CLI) | **`openhands`** | PyPI `openhands` 1.16.0 summary: “OpenHands CLI…” **VERIFIED** |
| Console entry point | `openhands` → `openhands_cli.entrypoint:main` | `importlib.metadata` on installed dist **VERIFIED** |
| Also installs | `openhands-acp` entry point | same **VERIFIED** |
| Legacy / wrong package | `openhands-ai` (1.11.0 on PyPI) installs an `openhands` *library* package **without** the CLI entry point — **do not use for Parley** | local pip install **VERIFIED** |
| Runtime deps (pinned by 1.16.0) | `openhands-sdk==1.21.0`, `openhands-tools==1.21.0`, `openhands-workspace==1.11.1` | installed package metadata **VERIFIED** |

**Version pinned (this research)**

```text
OpenHands CLI 1.16.0
OpenHands SDK v1.21.0
```

`openhands --version` prints `OpenHands CLI 1.16.0` and also dumps an SDK banner
unless `OPENHANDS_SUPPRESS_BANNER=1` is set. **VERIFIED**

**Install commands** (docs + local practice)

Recommended (docs):

```bash
uv tool install openhands --python 3.12
openhands --version
```

**DOCS:** [Installation](https://docs.openhands.dev/openhands/usage/cli/installation)

Ephemeral / adapter-host probe:

```bash
uvx --python 3.12 --from openhands openhands --version
```

Venv (what this research used):

```bash
uv venv --python 3.12 .venv
source .venv/bin/activate
uv pip install 'openhands==1.16.0'
```

**VERIFIED** (2026-07-16, Linux, Python 3.12.13, uv 0.11.17).

Binary install script (docs alternative): `curl -fsSL https://install.openhands.dev/install.sh | sh` — **DOCS**, not run here.

**Config / data roots** (dynamic; all overrideable by env) — source:
`openhands_cli/locations.py` **VERIFIED**:

| Env | Default | Purpose |
| --- | --- | --- |
| `OPENHANDS_PERSISTENCE_DIR` | `~/.openhands` | `agent_settings.json`, `mcp.json`, CLI settings |
| `OPENHANDS_CONVERSATIONS_DIR` | `$OPENHANDS_PERSISTENCE_DIR/conversations` | conversation persistence |
| `OPENHANDS_WORK_DIR` | `cwd` | agent workspace root |
| `OPENHANDS_SUPPRESS_BANNER` | unset | hide SDK banner on every invocation |

---

## 2. Headless invocation

### Exact argv (one-shot)

Minimum documented shape (**DOCS** + **VERIFIED**):

```bash
openhands --headless --json -t "Your task here"
```

**Parley-ready hermetic shape (recommended):**

```bash
OPENHANDS_SUPPRESS_BANNER=1 \
OPENHANDS_PERSISTENCE_DIR=<task-private-dir>/persist \
OPENHANDS_CONVERSATIONS_DIR=<task-private-dir>/conversations \
OPENHANDS_WORK_DIR=<worktree> \
LLM_API_KEY=<key> \
LLM_MODEL=<provider/model> \
LLM_BASE_URL=<optional> \
openhands --headless --json --override-with-envs -t "<prompt>"
```

Equivalents:

- `-t` / `--task` — prompt string
- `-f` / `--file` — seed conversation from file contents (takes precedence over `-t` in `create_seeded_instructions_from_args`) **VERIFIED** (source)
- `--json` **requires** `--headless`; without headless it is ignored (`json_mode = args.json and args.headless`) **VERIFIED** (source)
- Headless **requires** `--task` or `--file` — missing both → argparse exit **2** **VERIFIED**

### Approvals in headless

Headless always uses `NeverConfirm` (auto-approve all actions). `--llm-approve` is
not available in headless. **DOCS:**
[Headless Mode](https://docs.openhands.dev/openhands/usage/cli/headless). **VERIFIED**
in `textual_app.main`: `if headless or always_approve: NeverConfirm()`.

### Streaming JSON output format

With `--headless --json`, a callback dumps each SDK event as one JSON object via
`print(json.dumps(event.model_dump()))` (`openhands_cli.utils.json_callback`).
**SystemPromptEvent is intentionally skipped.** **VERIFIED** (source).

**Critical gotcha:** stdout is **not pure JSONL**. Human/status text is interleaved
on the same stream:

- `Initializing agent...`
- `✓ Agent initialized with model: …`
- `Agent is working`
- Rich “CONVERSATION SUMMARY” panel
- `Goodbye! 👋`
- `Conversation ID: <hex>`
- `Hint: run openhands --resume <uuid> …`

**VERIFIED** (auth-fail sample run, CLI 1.16.0). Parser must skip non-JSON lines.

### Real example lines (VERIFIED, CLI 1.16.0, fake API key)

Command:

```bash
LLM_API_KEY=sk-fake-key-for-parley-research LLM_MODEL=openai/gpt-4o \
OPENHANDS_PERSISTENCE_DIR=… OPENHANDS_CONVERSATIONS_DIR=… OPENHANDS_WORK_DIR=… \
openhands --headless --json --override-with-envs -t "say hi"
```

JSON events observed on stdout (pretty-printed here; actual stream is one object per line):

```json
{"id": "d9a2e92c-acb8-4952-b87f-7398728a320d", "timestamp": "2026-07-16T04:13:32.061764", "source": "user", "llm_message": {"role": "user", "content": [{"cache_prompt": false, "type": "text", "text": "say hi"}], "tool_calls": null, "tool_call_id": null, "name": null, "reasoning_content": null, "thinking_blocks": [], "responses_reasoning_item": null}, "llm_response_id": null, "activated_skills": [], "extended_content": [], "sender": null, "critic_result": null, "kind": "MessageEvent"}
```

```json
{"id": "07f58ff9-ad98-49a4-8613-bfef8e925a7d", "timestamp": "2026-07-16T04:13:32.946167", "source": "environment", "code": "AuthenticationError", "detail": "litellm.AuthenticationError: AuthenticationError: OpenAIException - Incorrect API key provided: sk-fake-*******************arch. You can find your API key at https://platform.openai.com/account/api-keys.", "kind": "ConversationErrorEvent"}
```

Event discriminator field: **`kind`** (Pydantic `DiscriminatedUnionMixin`), not `type`.
Docs’ illustrative `{"type":"action",…}` lines are schematic only. **VERIFIED** vs **DOCS** mismatch — trust the binary.

### Event kinds the adapter should know

| `kind` | Role | Streamed by `--json`? |
| --- | --- | --- |
| `MessageEvent` | User/agent text (`llm_message.role`, content blocks) | yes (user message observed) |
| `ActionEvent` | Tool call (`tool_name`, `action.kind`, `thought`, …) | yes (when agent acts) — shape **VERIFIED** via SDK dump |
| `ObservationEvent` | Tool result (`tool_name`, `observation`, …) | yes when tools run — **DOCS**/SDK |
| `AgentErrorEvent` | Per-tool error (`error`, `tool_name`) | yes when raised — SDK |
| `ConversationErrorEvent` | Run-terminal failure (`code`, `detail`) | yes **VERIFIED** |
| `SystemPromptEvent` | System prompt + tools | **filtered out** of `--json` callback **VERIFIED** |
| `ConversationStateUpdateEvent` | State field patches (incl. possible `stats`) | used for remote/WS; **not observed** on local CLI JSON stdout in auth-fail run **UNKNOWN** whether emitted on success |
| `TokenEvent` | Raw token **IDs** (vLLM), not usage counts | SDK only — not useful for billing |

Sample `ActionEvent` shape (constructed against SDK 1.21.0, not from a live successful run) **VERIFIED** (model dump):

```json
{
  "kind": "ActionEvent",
  "source": "agent",
  "tool_name": "terminal",
  "tool_call_id": "call_1",
  "action": {
    "kind": "TerminalAction",
    "command": "ls -la",
    "is_input": false,
    "timeout": null,
    "reset": false
  },
  "thought": [{"type": "text", "text": "listing", "cache_prompt": false}],
  "security_risk": "UNKNOWN"
}
```

File edits use `tool_name: "file_editor"` / `action.kind: "FileEditorAction"` with
`command` ∈ `view|create|str_replace|insert|undo_edit` and `path`. **VERIFIED** (SDK).

### Exit codes

| Situation | Exit | Evidence |
| --- | --- | --- |
| `--headless` without `-t`/`-f` | **2** | **VERIFIED** |
| `--override-with-envs` missing `LLM_API_KEY`/`LLM_MODEL` | **1** | **VERIFIED** |
| Auth failure after conversation starts (`ConversationErrorEvent`) | **0** | **VERIFIED** |
| Docs claim: 0 success, 1 error/failed, 2 invalid args | — | [Command Reference](https://docs.openhands.dev/openhands/usage/cli/command-reference) **DOCS** |

**Implication:** exit code alone is **insufficient**. Parse `ConversationErrorEvent`
(`kind` + `code`/`detail`) as fatal task failure.

### Auth/settings preflight errors (no JSON)

Without disk settings and without `--override-with-envs`:

```text
Headless mode requires existing settings.
Please run: openhands to configure your settings before using --headless.
```

Exit **0** in the sample (app exits cleanly after message). **VERIFIED**

With `--override-with-envs` and no env:

```text
Error: Missing required environment variable(s): LLM_API_KEY, LLM_MODEL
When using --override-with-envs, you must set:
  - LLM_API_KEY: Your LLM API key
  - LLM_MODEL: The model to use (e.g., claude-sonnet-4-5-20250929)
```

Exit **1**. **VERIFIED**

Without `--override-with-envs`, if `LLM_*` are set in the environment the CLI
**warns on stderr** that they will be ignored. **VERIFIED** (source + docs).

---

## 3. MCP injection

### Transport & headers

CLI MCP management supports **`http`**, **`sse`**, and **`stdio`**. Custom HTTP
headers are first-class (`--header "Key: Value"`, repeatable). **DOCS:**
[MCP Servers](https://docs.openhands.dev/openhands/usage/cli/mcp-servers). **VERIFIED**
(`openhands mcp add --help`).

Example (writes config; not for Parley runtime use):

```bash
openhands mcp add parley --transport http \
  --header "X-Parley-Task: t244" \
  --header "Authorization: Bearer …" \
  http://127.0.0.1:PORT/mcp
```

### Config file path (global, not project)

| Path | Role |
| --- | --- |
| `$OPENHANDS_PERSISTENCE_DIR/mcp.json` | **Only** MCP config path the CLI loads (`list_enabled_servers` → agent `mcp_config`) **VERIFIED** |
| Default | `~/.openhands/mcp.json` **DOCS** + **VERIFIED** |

There is **no** project-scoped `.openhands/mcp.json` load path in the CLI package
(project `.openhands/` is used for hooks/skills/setup, not MCP). **VERIFIED** (source
grep of `openhands_cli`). Hooks do load from `~/.openhands/hooks.json` **or**
`{work_dir}/.openhands/hooks.json` **VERIFIED** (setup.py comment + SDK HookConfig).

### Materialized file format (for `SpawnPlan.files` or pre-spawn write)

**VERIFIED** after `openhands mcp add` / `RemoteMCPServer.model_dump()`:

```json
{
  "mcpServers": {
    "parley": {
      "url": "http://127.0.0.1:1234/mcp",
      "transport": "http",
      "headers": {
        "X-Parley-Task": "t244",
        "X-Foo": "bar"
      },
      "enabled": true
    }
  }
}
```

- `transport`: `"http"` | `"sse"` | `"stdio"` (stdio uses `command`/`args`/`env` instead of `url`/`headers`) **DOCS** + **VERIFIED**
- Disabled servers are omitted at runtime via `list_enabled_servers()` (default `enabled: true` if field absent) **VERIFIED**
- Config is merged into the agent on every load in `_apply_runtime_config` **VERIFIED**

### Flags vs env vs files

| Mechanism | Works for Parley? |
| --- | --- |
| Per-invocation CLI flag for MCP | **No** **VERIFIED** (`--help`) |
| Env var carrying MCP JSON | **No** **VERIFIED** |
| Write `$OPENHANDS_PERSISTENCE_DIR/mcp.json` | **Yes** — preferred with private `OPENHANDS_PERSISTENCE_DIR` **VERIFIED** |
| `openhands mcp add` at runtime | Mutates shared user config — **not** for multi-tenant children |

### MCP tool timeout (Q&A risk)

SDK hardcodes `MCP_TOOL_TIMEOUT_SECONDS = 300` in
`openhands/sdk/mcp/tool.py` for tool execution. Connection/list-tools default is
30s (`create_mcp_tools(timeout=30)`). **VERIFIED** (source).

There is **no** per-server `tool_timeout_sec` field in `RemoteMCPServer` (fields:
`url`, `transport`, `headers`, `auth`, `sse_read_timeout`, `timeout`, …). **VERIFIED**.

**Implication for Parley:** `ask_orchestrator` blocking longer than **300s** will
time out unless the SDK default is raised elsewhere (not exposed via CLI config
today). Compare Codex’s configurable `tool_timeout_sec`. **No raise path** without
patching the SDK (#107). **Adapter decision:** do not claim full Q&A beyond
300s; emit a PARLEY-DIAG when `answerTimeoutMs > 300_000`; cap effective Q&A
waits at ≤300s for this vendor.

### OAuth MCP

OAuth MCP servers need a browser flow and are **not** suitable for headless
automation. **DOCS:** [SDK MCP guide](https://docs.openhands.dev/sdk/guides/mcp). Use
header/API-key HTTP for Parley’s hub.

---

## 4. Session resume

### How the session id appears

OpenHands names sessions **conversation IDs** (UUID).

| Surface | Format | When | Evidence |
| --- | --- | --- | --- |
| Trailing stdout | `Conversation ID: 826e542142564e7bbf353d2a7d9ae7ff` (hex, **no dashes**) | end of run | **VERIFIED** |
| Resume hint | `openhands --resume 826e5421-4256-4e7b-bf35-3d2a7d9ae7ff` (canonical UUID) | end of run | **VERIFIED** |
| On-disk dir | `$OPENHANDS_CONVERSATIONS_DIR/<hex-without-dashes>/` | during run | **VERIFIED** |
| `base_state.json` | `"id": "826e5421-4256-4e7b-bf35-3d2a7d9ae7ff"` | persisted | **VERIFIED** |
| JSONL events | **No** `session_id` / `conversation_id` field on observed events | — | **VERIFIED** (auth-fail stream) |

**Adapter must not** expect a Codex-style `thread.started` event. Extract session id by:

1. Regex on stdout: `Conversation ID:\s*([0-9a-f]{32})` or the dashed form in the hint, **or**
2. After spawn, watch `OPENHANDS_CONVERSATIONS_DIR` for a new subdirectory, **or**
3. Read `base_state.json` after exit.

Resume accepts both dashed and undashed IDs (store normalizes by stripping dashes).
**VERIFIED** (source + successful resume with dashed id).

### Exact resume argv

Headless resume **still requires** `-t`/`-f` (seeded follow-up). Resume alone fails:

```text
openhands: error: --headless requires either --task or --file to be specified
```

Exit **2**. **VERIFIED**

Working form **VERIFIED**:

```bash
openhands --headless --json --override-with-envs \
  --resume 826e5421-4256-4e7b-bf35-3d2a7d9ae7ff \
  -t "continue please"
```

Also documented:

```bash
openhands --resume                 # list recent (interactive listing)
openhands --resume --last          # most recent (needs non-headless or still -t for headless?)
```

`--last` requires `--resume`. **DOCS:**
[Resume Conversations](https://docs.openhands.dev/openhands/usage/cli/resume). Headless
`--resume --last -t "…"` is plausible from source but **UNKNOWN** (not run).

Storage layout **DOCS** + **VERIFIED**:

```text
$OPENHANDS_CONVERSATIONS_DIR/<conversation-id-hex>/
  base_state.json
  events/event-NNNNN-<event-id>.json
```

---

## 5. Sandbox & approvals

### Approvals (easy)

| Mode | Mechanism |
| --- | --- |
| Headless | Always `NeverConfirm` — no interactive prompts **VERIFIED** |
| Interactive default | `AlwaysConfirm` (ask every action) **VERIFIED** / **DOCS** |
| Interactive YOLO | `--always-approve` / `--yolo` → `NeverConfirm` **VERIFIED** |
| Interactive LLM gate | `--llm-approve` **VERIFIED** (help); **not** for headless **DOCS** |

Parley should always use `--headless` (approvals already disabled). Belt-and-braces
`--always-approve` is redundant in headless but harmless if ever needed outside it.

### Sandbox matrix (hard)

The **CLI path uses `LocalWorkspace(working_dir=OPENHANDS_WORK_DIR|cwd)`** — a host
process with the agent’s user privileges. **VERIFIED** (`setup_conversation`).

There is **no** CLI flag analogous to Codex `--sandbox read-only|workspace-write|…`
or Grok `GROK_SANDBOX=…`. Docker/process/remote “sandbox providers” in the product
docs apply primarily to the **web/agent-server** stack (`RUNTIME=docker|process|remote`),
not to `openhands --headless` local workspace. **DOCS:**
[Sandboxes overview](https://docs.openhands.dev/openhands/usage/sandboxes/overview),
[Process sandbox](https://docs.openhands.dev/openhands/usage/sandboxes/process).

| Parley posture | OpenHands CLI 1.16.0 mapping | Notes |
| --- | --- | --- |
| `read-only` | **No native support** | Agent can write anywhere the OS user can; only soft constraint is prompt/cwd |
| `workspace` | Set `OPENHANDS_WORK_DIR=<worktree>` and spawn cwd = worktree | Soft isolation only; `terminal` can `cd /` and write outside |
| `full` | Default local workspace | Matches process sandbox “unsafe but fast” **DOCS** |
| `network: true` | Default (unrestricted) | No flag to enable |
| `network: false` | **No native support** | Would need OS-level controls outside OpenHands |

**Honest adapter recommendation:** document OpenHands as **full-ish host process**
with workdir hint; do not claim read-only/network-off until a real mechanism exists
(or Parley wraps the child in bubblewrap/Firejail itself). **UNKNOWN** whether
future CLI versions add sandbox flags.

---

## 6. Model & effort flags; auth env vars

### Model selection

| Mechanism | Details | Evidence |
| --- | --- | --- |
| Env + flag | `LLM_MODEL` **only applied with** `--override-with-envs` | **VERIFIED** |
| Env base URL | `LLM_BASE_URL` (optional) with same flag | **VERIFIED** / **DOCS** |
| Disk settings | `agent_settings.json` under persistence dir (full `Agent` JSON incl. `llm.model`) | **DOCS** / source **VERIFIED** |
| CLI flag `-m` | **Does not exist** | `--help` **VERIFIED** |

Model strings follow LiteLLM conventions (`openai/gpt-4o`,
`anthropic/claude-sonnet-4-5-20250929`, `openhands/…` for All Hands proxy). **DOCS**
(SDK metrics / LLM guides).

### Reasoning effort

SDK `LLM.reasoning_effort`:
`Optional[Literal['low','medium','high','xhigh','none']]`, **default `'high'`**.
**VERIFIED** (SDK 1.21.0 field introspection).

| Mechanism | Available? |
| --- | --- |
| CLI flag | **No** **VERIFIED** |
| `LLM_REASONING_EFFORT` env via `--override-with-envs` | **No** — env override struct only has `api_key`, `base_url`, `model` **VERIFIED** (agent_store.py) |
| Persist in `agent_settings.json` on `llm.reasoning_effort` | **Yes** (set when creating/saving agent) **VERIFIED** (field exists on LLM) |

**Adapter path for `task.effort` (#107 major):** do **not** write a partial
`agent_settings.json` stub (`{llm:{reasoning_effort}}`) — merge with
env-created agents is unproven and may wipe LLM settings. Accept SDK default
effort (or put effort in the prompt) until a full agent materialization path
is verified end-to-end.

Web product env table still lists `LLM_REASONING_EFFORT` for the server `config.toml`
world ([Environment Variables](https://docs.openhands.dev/openhands/usage/environment-variables))
— that is **not** the same as CLI `--override-with-envs`. Mark **DOCS** (server) vs
**VERIFIED** (CLI ignores it for overrides).

### Auth env vars (headless)

| Variable | Role |
| --- | --- |
| `LLM_API_KEY` | Provider (or OpenHands Cloud) API key — **required** for env-only headless |
| `LLM_MODEL` | Model id — **required** for env-only headless |
| `LLM_BASE_URL` | Optional custom endpoint |
| `--override-with-envs` | **Required** for the above to take effect |

**VERIFIED**. Interactive first-run also stores secrets in `agent_settings.json`
under the persistence dir (**DOCS**). Cloud login (`openhands login`) is a separate
OAuth device flow for Cloud, not the BYOK path. **DOCS**

Without `--override-with-envs`, set `LLM_*` vars are **ignored** with a stderr
warning. **VERIFIED**

---

## 7. Model enumeration

**No CLI subcommand** lists models (`openhands --help` has no `models`). **VERIFIED**

Closest machine-readable catalog inside the install:

```python
from openhands.sdk.llm.utils.verified_models import VERIFIED_MODELS
# dict[provider, list[model_id]]  e.g. "openai": ["gpt-5.5", "gpt-5.4", ...]
```

**VERIFIED** against SDK 1.21.0 (keys: `openhands`, `anthropic`, `openai`, `mistral`,
`gemini`, `deepseek`, `moonshot`, `minimax`, `glm`, `nvidia`, `qwen`). This is a
**static allowlist**, not a live provider probe — no efforts, no context windows.

**Adapter `listModels` recommendation:** either

1. Shell out to `python -c '…VERIFIED_MODELS…'` against the same install, or
2. Ship a static catalog in Parley and refresh by hand,

and always pass `--model`/env through opaquely (same rule as Codex/Grok).

---

## 8. Token usage

### In the event stream

On the auth-fail headless run, **no usage fields** appeared in JSONL. The only
error event was `ConversationErrorEvent`. **VERIFIED**

`TokenEvent` exists in the SDK but carries **`prompt_token_ids` / `response_token_ids`**
(raw ids for vLLM), **not** billing counters. **VERIFIED** (token.py).

`ConversationStateUpdateEvent` *can* serialize `ConversationStats` (snapshot with
`usage_to_metrics`) for websocket clients — **VERIFIED** (source). Whether the local
CLI `--json` callback ever emits these on a successful multi-turn run is
**UNKNOWN** (not observed; local conversation primarily appends agent events, not
state patches, to the same callback chain).

### Where usage actually lives (VERIFIED)

After a run, `$OPENHANDS_CONVERSATIONS_DIR/<id>/base_state.json` contains:

```json
"stats": {
  "usage_to_metrics": {
    "agent": {
      "model_name": "openai/gpt-4o",
      "accumulated_cost": 0.0,
      "accumulated_token_usage": {
        "model": "openai/gpt-4o",
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "reasoning_tokens": 0,
        "context_window": 0,
        "per_turn_token": 0,
        "response_id": ""
      },
      "token_usages": [],
      "costs": [],
      "response_latencies": []
    },
    "condenser": { "...": "same shape" }
  }
}
```

(Auth-fail sample showed zeros — expected, no successful completion.) **VERIFIED**

Field names for adapter `usage` mapping (when non-zero):

| Source field | Suggested `VendorEvent.usage` key |
| --- | --- |
| `accumulated_token_usage.prompt_tokens` | `input_tokens` or `prompt_tokens` |
| `accumulated_token_usage.completion_tokens` | `output_tokens` or `completion_tokens` |
| `accumulated_token_usage.cache_read_tokens` | `cache_read_tokens` |
| `accumulated_token_usage.cache_write_tokens` | `cache_write_tokens` |
| `accumulated_token_usage.reasoning_tokens` | `reasoning_tokens` |
| `accumulated_cost` | `cost` (USD float) |

SDK metrics docs: [Metrics Tracking](https://docs.openhands.dev/sdk/guides/metrics) **DOCS**.

### Worked adapter pattern

1. During stream: do **not** expect usage events (treat like Grok: “not reported”).
2. On process exit: if conversation id known, read
   `base_state.json` → `stats.usage_to_metrics.agent.accumulated_token_usage`.
3. Optionally sum `agent` + `condenser` for full task cost.

---

## 9. Adapter recommendation

### `prepare(task, hub)` → `SpawnPlan`

**argv**

```text
openhands
  --headless
  --json
  --override-with-envs
  -t <task.prompt>
```

**env**

| Key | Value |
| --- | --- |
| `OPENHANDS_SUPPRESS_BANNER` | `1` |
| `OPENHANDS_PERSISTENCE_DIR` | absolute task-private dir (e.g. `<cwd>/.parley-openhands/persist`) |
| `OPENHANDS_CONVERSATIONS_DIR` | absolute task-private conversations dir |
| `OPENHANDS_WORK_DIR` | `task.cwd` (worktree) |
| `LLM_API_KEY` | from host env (required) |
| `LLM_MODEL` | `task.model` if set, else host default / fail prepare |
| `LLM_BASE_URL` | optional passthrough |
| `cwd` (spawn) | `task.cwd` |

Do **not** pass user `~/.openhands` — isolation prevents MCP/settings bleed.

**files** (relative to `OPENHANDS_PERSISTENCE_DIR`, written pre-spawn — either via
`SpawnPlan.files` with `cwd=persistence_dir` or an absolute write outside the plan):

1. **`mcp.json`** — required for hub injection:

```json
{
  "mcpServers": {
    "parley": {
      "url": "<hub.url>",
      "transport": "http",
      "headers": { "<from hub.headers>": "…" },
      "enabled": true
    }
  }
}
```

2. **`agent_settings.json`** — only if effort must be set or disk agent is preferred;
   otherwise env-only creation is enough (`LLM_API_KEY` + `LLM_MODEL`).

**Sandbox:** no argv/env mapping today; document posture as host-process / full.
Optionally set spawn `cwd` + `OPENHANDS_WORK_DIR` for soft workspace affinity.

### `resume(task, hub)` → `SpawnPlan`

Same env/files as `prepare`, plus:

```text
openhands
  --headless
  --json
  --override-with-envs
  --resume <task.sessionId>
  -t <task.prompt>   # follow-up text; required in headless
```

Use the dashed UUID form from `base_state.id` or normalize hex → UUID. Ensure
`OPENHANDS_CONVERSATIONS_DIR` points at the **same** dir as the original run.

### `parseEvent` table

Skip lines that are not JSON objects. On success, switch on `kind`:

| Vendor `kind` | → `VendorEvent.kind` | Notes |
| --- | --- | --- |
| `MessageEvent` | `message` | `text` from `llm_message.content[].text` (role agent/user); ignore pure system if any |
| `ActionEvent` + `tool_name=="terminal"` | `command` | `text` = `action.command` or `tool_call.arguments` |
| `ActionEvent` + `tool_name=="file_editor"` | `file_change` | `text` = `action.command` + `action.path` |
| `ActionEvent` + other / MCP tools | `message` or skip | include `tool_name` in text; raw JSONL is durable record |
| `ObservationEvent` | skip or `message` | optional progress noise |
| `AgentErrorEvent` | `error` (`fatal: false`) | agent may recover |
| `ConversationErrorEvent` | `error` (`fatal: true`) | **task failure** — auth, run crash, etc. |
| `SystemPromptEvent` | n/a | not emitted in `--json` |
| non-JSON / unknown | `[]` | stdout pollution |

**Session id:** not in events. Implement `sessionId()` by scanning accumulated raw
lines for `Conversation ID:\s*([0-9a-fA-F-]{32,36})`, or by external dir watch.
Emit a synthetic `session_meta` when found.

**Usage:** post-process `base_state.json`; optionally emit synthetic `session_meta`
with `usage` after exit (engine may need a small extension if it only reads stream
events today).

### Top risks / unknowns

1. **Stdout pollution** — non-JSON noise will break naïve JSONL parsers. Must tolerate.
2. **Exit 0 on conversational failure** — `ConversationErrorEvent` is load-bearing.
3. **No stream session id** — resume depends on end-of-run scrape or filesystem.
4. **No real sandbox / network-off** — Parley postures cannot be enforced by the CLI.
5. **MCP tool timeout fixed at 300s** — may kill long `ask_orchestrator` waits; no
   config dial like Codex `tool_timeout_sec`.
6. **Effort not overridable via env/flags** — needs settings file surgery or default `high`.
7. **Model list not a CLI probe** — static SDK list only; catalog will rot.
8. **Token usage not in stream** — post-hoc `base_state.json` only (like a worse Grok).
9. **Package name trap** — `openhands-ai` ≠ CLI; pin `openhands==1.16.0` (or later).
10. **First-run settings** — without `--override-with-envs` + env, headless aborts asking
    for interactive setup.
11. **Resume requires a new `-t` prompt** — empty resume is invalid in headless.
12. **UNKNOWN:** full successful multi-turn JSONL sample (Action/Observation/Message
    agent turns) — shapes above from SDK models + partial live run; re-snapshot with
    a real key before locking golden fixtures.
13. **UNKNOWN:** whether `ConversationStateUpdateEvent` with `stats` ever appears on
    local `--json` stdout during a successful run.

### Comparison to existing adapters

| Concern | Codex | Grok | OpenHands (this doc) |
| --- | --- | --- | --- |
| Spawn style | flags-only `exec --json` | flags + `.grok/config.toml` | flags + isolated `mcp.json` / env dirs |
| MCP HTTP headers | `-c mcp_servers…http_headers` | project TOML headers | persistence-dir `mcp.json` headers |
| Session id in stream | `thread.started` | `end.sessionId` etc. | trailing text / filesystem only |
| Usage in stream | `turn.completed` | none | none (file after exit) |
| Sandbox | first-class | `GROK_SANDBOX` | absent (host process) |

---

## Sources

- **VERIFIED** against local install `openhands==1.16.0` / SDK `1.21.0` (2026-07-16):
  `--help`, `--version`, headless JSON runs (auth fail + resume), `mcp.json` write,
  conversation `base_state.json`, package entry points, SDK event/LLM/metrics models.
- **DOCS:**
  - [Headless Mode](https://docs.openhands.dev/openhands/usage/cli/headless)
  - [Command Reference](https://docs.openhands.dev/openhands/usage/cli/command-reference)
  - [Installation](https://docs.openhands.dev/openhands/usage/cli/installation)
  - [MCP Servers](https://docs.openhands.dev/openhands/usage/cli/mcp-servers)
  - [Resume Conversations](https://docs.openhands.dev/openhands/usage/cli/resume)
  - [Environment Variables](https://docs.openhands.dev/openhands/usage/environment-variables)
  - [Sandboxes](https://docs.openhands.dev/openhands/usage/sandboxes/overview)
  - [SDK Metrics](https://docs.openhands.dev/sdk/guides/metrics)
  - [SDK Events](https://docs.openhands.dev/sdk/arch/events)
  - [SDK MCP](https://docs.openhands.dev/sdk/guides/mcp)
