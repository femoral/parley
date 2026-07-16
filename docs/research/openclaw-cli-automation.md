# OpenClaw CLI — automation surface for Parley

Research asset for documenting OpenClaw so a Parley vendor adapter can be written
without re-research. Verified against the npm package **`openclaw@2026.7.1`**
(git sha `2d2ddc4`) installed locally in a scratch worktree dir on **2026-07-16**,
plus primary docs at [docs.openclaw.ai](https://docs.openclaw.ai) and
[github.com/openclaw/openclaw](https://github.com/openclaw/openclaw).

Formerly **Clawdbot** / **Moltbot**. Legacy env prefixes `CLAWDBOT_*` and
`MOLTBOT_*` are **silently ignored** (DOCS).

## Loud up-front: headless single-shot *is* possible — with caveats

OpenClaw is **gateway/daemon-shaped** (personal multi-channel assistant), **not**
a pure one-shot coding CLI like `codex exec` or `grok -p`. That said, a Parley-style
spawn-per-turn path **does exist**:

| Path | Command shape | Gateway required? |
| ---- | ------------- | ----------------- |
| **Recommended for Parley** | `openclaw agent --local --agent <id> --message "…" --json` | **No** (embedded runtime) |
| Gateway-backed | `openclaw agent --agent <id> --message "…"` (default) | **Yes** (falls back to embedded if gateway fails) |
| Lean model probe only | `openclaw infer model run --prompt "…" --json` | No — **no tools, no MCP, no session agent loop** |

**Critical differences from codex/grok adapters:**

1. **No streaming JSONL event stream on stdout.** `--json` emits a **single JSON
   document at the end** of the turn (pretty-printed via `JSON.stringify(…, null, 2)`
   in 2026.7.1 — no compact flag). Mid-run tool/message events are **not**
   available as codex-style `item.completed` / grok `text` JSONL lines.
   **Adapter decision (#107):** wrap the binary so stdout is re-emitted as one
   compact JSON line before the engine's line reader (registry singleton cannot
   safely buffer multi-line JSON across concurrent tasks). Auth failures on
   stderr are dual-fed into `parseEvent`.
2. **No per-invocation MCP / sandbox / cwd flags** on `openclaw agent`. MCP, sandbox,
   workspace root, and exec-approvals are **config-file / env isolation** concerns
   (closer to grok's materialized `.grok/config.toml` than codex's `-c` overrides).
3. **Workspace is not the process cwd by default.** The agent's file-tool root is
   `agents.defaults.workspace` / `agents.list[].workspace` (default
   `~/.openclaw/workspace`). Parley **must** point that at `task.cwd` (or isolate
   state and configure it) or the child will not edit the worktree.
4. **Default product surface is a personal assistant** (channels, skills, memory,
   heartbeats). For hermetic task runs, isolate state with `OPENCLAW_STATE_DIR` /
   `OPENCLAW_CONFIG_PATH` so the user's real `~/.openclaw` is never touched.

Closest viable integration shape for Parley: **per-task isolated state dir +
materialized `openclaw.json` (MCP hub, workspace, sandbox, exec-policy) +
`openclaw agent --local … --json` spawn-per-turn**, session resume via
`--session-id` / `--session-key`.

---

## 1. Identity & install

| Field | Value | Evidence |
| ----- | ----- | -------- |
| Product | OpenClaw — open-source personal AI assistant / multi-channel gateway | DOCS: [openclaw.ai](https://openclaw.ai), [docs](https://docs.openclaw.ai) |
| Package | npm **`openclaw`** | VERIFIED: `npm view openclaw version` → `2026.7.1` |
| Binary | `openclaw` (Node; requires Node 22.22.3+ / 24.15+ / 25.9+) | DOCS: [install](https://docs.openclaw.ai/install); VERIFIED help banner |
| Pinned verified version | **`2026.7.1`** (`OpenClaw 2026.7.1 (2d2ddc4)`) | VERIFIED: local install `--version` |
| Install (global) | `npm install -g openclaw@2026.7.1` then typically `openclaw onboard --install-daemon` | DOCS: [install](https://docs.openclaw.ai/install) |
| Install (scratch / adapter probe) | `npm install openclaw@2026.7.1` in an isolated prefix; invoke `node_modules/.bin/openclaw` | VERIFIED this research |
| One-liner | `curl -fsSL https://openclaw.ai/install.sh \| bash` | DOCS / site |
| Config path | default `~/.openclaw/openclaw.json`; override `OPENCLAW_CONFIG_PATH` | DOCS: [environment](https://docs.openclaw.ai/help/environment) |
| State dir | default `~/.openclaw`; override `OPENCLAW_STATE_DIR` | DOCS: same |
| Profile isolation | `--profile <name>` → `~/.openclaw-<name>`; `--dev` → `~/.openclaw-dev` + gateway port 19001 | VERIFIED: top-level `--help` |

**Do not** treat `openclaw infer` as the agent adapter path: docs explicitly say local
`infer model run` is a lean one-shot completion **without** tools, agent context, or
bundled MCP (DOCS: [infer](https://docs.openclaw.ai/cli/infer)).

---

## 2. Headless invocation

### One-shot agent turn (primary)

```bash
openclaw agent \
  --local \
  --agent main \
  --message "Implement the feature described in TASK.md" \
  --json \
  --timeout 600
```

| Flag | Role | Evidence |
| ---- | ---- | -------- |
| `--local` | Embedded agent on this machine; skips Gateway | VERIFIED help; DOCS: [cli/agent](https://docs.openclaw.ai/cli/agent) |
| `--agent <id>` | Session selector (required unless `--to` / `--session-key` / `--session-id`) | VERIFIED |
| `-m` / `--message <text>` | Prompt body (exactly one of message / message-file) | VERIFIED |
| `--message-file <path>` | UTF-8 multiline prompt from file | VERIFIED help |
| `--json` | Single JSON result on **stdout**; diagnostics → **stderr** | DOCS + VERIFIED auth-fail behavior |
| `--timeout <seconds>` | Run timeout (default **600**); `0` disables | VERIFIED help |
| `--model <id>` | `provider/model` or bare model id | VERIFIED help |
| `--thinking <level>` | `off \| minimal \| low \| medium \| high \| xhigh \| adaptive \| max` | VERIFIED help |
| `--session-id <id>` | Resume / target explicit session UUID | VERIFIED help |
| `--session-key <key>` | Explicit session key (`agent:<id>:<rest>` or bare, scoped to `--agent`) | DOCS |
| `--deliver` | Also send reply to a chat channel (not for Parley) | VERIFIED help |

**VERIFIED auth-fail sample** (`openclaw@2026.7.1`, isolated `OPENCLAW_STATE_DIR`,
no provider keys):

```text
# argv
openclaw agent --local --agent main --message "say hi" --json --timeout 30

# exit code: 1
# stdout: (empty)
# stderr (truncated):
[diagnostic] lane task error: lane=main durationMs=1067
  error="ProviderAuthError: No API key found for provider \"openai\".
  Auth store: <STATE>/agents/main/agent/openclaw-agent.sqlite ..."
FailoverError: No API key found for provider "openai". ... | missing-provider-auth
```

Even on auth failure, a session row is created (VERIFIED via
`openclaw sessions --json` immediately after):

```json
{
  "path": "/tmp/.../agents/main/sessions/sessions.json",
  "count": 1,
  "sessions": [
    {
      "key": "agent:main:main",
      "sessionId": "3a944b05-b121-4269-8576-48b24306e10d",
      "sessionFile": "/tmp/.../agents/main/sessions/3a944b05-b121-4269-8576-48b24306e10d.jsonl",
      "model": "gpt-5.5",
      "modelProvider": "openai",
      "totalTokens": null,
      "agentId": "main",
      "kind": "direct"
    }
  ]
}
```

### Successful `--json` envelope (shape)

There is **no mid-stream JSONL**. On success, stdout is one pretty-printed object.
Documented core fields (DOCS: [cli/agent](https://docs.openclaw.ai/cli/agent);
source: `delivery.runtime` / `agent-via-gateway` in 2026.7.1):

```json
{
  "payloads": [
    { "text": "Report ready", "mediaUrl": null }
  ],
  "meta": {
    "durationMs": 1200,
    "agentMeta": {
      "sessionId": "3a944b05-b121-4269-8576-48b24306e10d",
      "provider": "openai",
      "model": "gpt-5.5",
      "usage": {
        "input": 1200,
        "output": 340,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 1540
      }
    },
    "transport": "embedded"
  }
}
```

Notes:

- With gateway fallback, `meta.transport: "embedded"` and
  `meta.fallbackFrom: "gateway"` (and optionally `fallbackReason: "gateway_timeout"`)
  are documented (DOCS).
- With `--json --deliver`, top-level `deliveryStatus` is added (DOCS example).
- Gateway-backed JSON may wrap a richer RPC `result` and promote
  `result.deliveryStatus` → top-level `deliveryStatus` (source
  `buildGatewayJsonResponse`).
- **Usage field names inside `meta.agentMeta.usage`:** `input`, `output`,
  `cacheRead`, `cacheWrite`, `total` (VERIFIED from
  `emitIngressModelUsageDiagnostic` in package source 2026.7.1). Exact presence
  is provider-dependent (DOCS: [token-use](https://docs.openclaw.ai/reference/token-use)).
- **Full successful envelope was not live-verified** in this research (no API key
  in the sandbox). Mark success-path field completeness as **DOCS + source**,
  re-verify with a real key at adapter implementation time.

### What is *not* streaming-json

| Surface | Role for Parley |
| ------- | --------------- |
| `openclaw agent --json` | Terminal JSON only — **primary** |
| `openclaw sessions tail [--follow]` | Human progress lines; tool args **redacted** (`{...redacted...}`) — poor for structured parse (DOCS: [sessions](https://docs.openclaw.ai/cli/sessions)) |
| `openclaw gateway run --raw-stream` | Raw model stream to a jsonl **file** on the gateway process — not child stdout (DOCS: gateway help) |
| Gateway file logs | JSONL gateway logs, not agent CLI stdout (DOCS: [logging](https://docs.openclaw.ai/logging)) |

### Exit codes

| Situation | Observed / documented |
| --------- | --------------------- |
| Auth failure (`--local --json`) | **exit 1**, empty stdout, error text on stderr | VERIFIED 2026.7.1 |
| Missing `--message` | Error text; exit behavior not systematically mapped | VERIFIED message |
| Success | Expected 0 | DOCS / convention; **not live-verified** |
| Gateway missing credentials | `GatewayCredentialsRequiredError` on stderr | VERIFIED |

Adapter must not rely on exit code alone for failure detail; parse stderr and/or
JSON error payloads when present.

### Slash commands

`openclaw agent --message '/compact …'` is **rejected** (non-zero). Use
`openclaw sessions compact <key>` (DOCS).

---

## 3. MCP injection

OpenClaw is both:

1. **MCP server** for external clients: `openclaw mcp serve` (stdio bridge to Gateway
   channel conversations) — **not** Parley's injection direction.
2. **MCP client registry** for servers its agent runtimes consume: config key
   `mcp.servers` managed by `openclaw mcp add|set|…`.

### HTTP transport + custom headers — **yes**

DOCS + config schema (VERIFIED `openclaw config schema` includes
`mcp.servers.*.headers` and `transport: streamable-http | sse | stdio`):

```json5
{
  mcp: {
    servers: {
      parley: {
        url: "http://127.0.0.1:PORT/mcp",
        transport: "streamable-http",
        timeout: 600,           // seconds (or requestTimeoutMs)
        connectTimeout: 10,     // seconds
        headers: {
          "X-Parley-Task-Id": "t246",
          // values may use ${ENV} substitution (DOCS example)
        },
      },
    },
  },
}
```

CLI equivalent (writes **user/state config**, not a project file):

```bash
openclaw mcp set parley '{
  "url":"http://127.0.0.1:PORT/mcp",
  "transport":"streamable-http",
  "timeout":600,
  "headers":{"X-Parley-Task-Id":"t246"}
}'
# or:
openclaw mcp add parley \
  --url "http://127.0.0.1:PORT/mcp" \
  --transport streamable-http \
  --header "X-Parley-Task-Id=t246" \
  --timeout 600 \
  --no-probe
```

VERIFIED: `openclaw mcp add --help` lists `--url`, `--transport`, `--header`,
`--timeout`, `--connect-timeout`, `--no-probe`.

### Flags vs config vs env

| Mechanism | Works for Parley hub injection? |
| --------- | ------------------------------- |
| CLI flag on `openclaw agent` | **No** — no `--mcp` / `-c` style override (VERIFIED agent help) |
| `mcp.servers` in `openclaw.json` | **Yes** — primary path (DOCS) |
| `openclaw mcp set/add` | **Yes** — mutates that config |
| Process env for header values | **Indirect** — header values support `${VAR}` in config (DOCS example) |
| Project-scoped config in worktree | **No first-class project `openclaw.json` for MCP** (unlike grok's `.grok/config.toml`). Config lives under state dir / `OPENCLAW_CONFIG_PATH` (DOCS) |
| Workspace `.env` | **Blocked** for `OPENCLAW_*` and provider credentials (DOCS: environment) |

### Parley-oriented isolation (recommended)

Materialize a **per-task** config/state tree and point the child at it:

```bash
export OPENCLAW_STATE_DIR="/path/to/task/.openclaw-state"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
# write openclaw.json including mcp.servers.parley + agents.list workspace
```

Or use `openclaw --profile parley-t246 …` (state under `~/.openclaw-parley-t246`) —
global-ish; **prefer task-local `OPENCLAW_STATE_DIR`**.

### Tool timeout (load-bearing for `ask_orchestrator`)

- Per-server: `timeout` / `requestTimeoutMs` (seconds or ms) — DOCS config reference.
- Default MCP request timeout is **not** the same as codex's 60s default; still
  **raise** hub server `timeout` above Parley's `--answer-timeout` so blocking
  `ask_orchestrator` is not killed early.
- One-shot embedded runs **retire bundled MCP runtimes at run end** (DOCS: agent
  notes) — good for spawn-per-turn hygiene.

### Profile note

Embedded OpenClaw exposes MCP tools in `coding` and `messaging` tool profiles;
`minimal` hides them; `tools.deny: ["bundle-mcp"]` disables explicitly (DOCS: mcp).
Adapter should ensure the agent is **not** on a profile that strips MCP.

---

## 4. Session resume

### How session id appears

| Source | Field | When |
| ------ | ----- | ---- |
| `openclaw sessions --json` | `sessions[].sessionId` (UUID), `sessions[].key` (`agent:<id>:…`) | After any turn that creates/updates a session — **VERIFIED** even on auth fail |
| Agent `--json` success envelope | `meta.agentMeta.sessionId` | Successful embedded/gateway runs (source + DOCS diagnostics) |
| Event stream on stdout | **N/A** — no streaming session event | VERIFIED design |

There is **no** codex-like `thread.started` JSONL line. The adapter should:

1. Prefer `meta.agentMeta.sessionId` from the final JSON when present.
2. Else query `openclaw sessions --json` filtered by session key / agent after exit.
3. Persist **both** `sessionId` and the stable **session key** Parley chose
   (e.g. `agent:parley:task-<id>`).

### Resume argv

```bash
# By session UUID:
openclaw agent --local --session-id 3a944b05-b121-4269-8576-48b24306e10d \
  --message "Orchestrator answer: …" --json

# By explicit session key (preferred for isolation):
openclaw agent --local --agent parley \
  --session-key agent:parley:task-t246 \
  --message "Orchestrator answer: …" --json
```

DOCS: bare `--session-key incident-42` with `--agent ops` scopes to
`agent:ops:incident-42`. Agent-prefixed keys must match `--agent` when both given.

**Resume is spawn-per-turn**, same binary; history lives in the agent session store
under `$OPENCLAW_STATE_DIR/agents/<id>/…` (SQLite + transcript jsonl). State dir
must be stable across prepare/resume for the same task.

---

## 5. Sandbox & approvals

OpenClaw does **not** expose codex-style `--sandbox` on `openclaw agent`. Posture
is **config + host approvals file**.

### Sandbox (filesystem / process isolation)

DOCS: [sandboxing](https://docs.openclaw.ai/gateway/sandboxing)

| Setting | Values | Default |
| ------- | ------ | ------- |
| `agents.defaults.sandbox.mode` | `off` \| `non-main` \| `all` | **`off`** |
| `agents.defaults.sandbox.scope` | `agent` \| `session` \| `shared` | `agent` |
| `agents.defaults.sandbox.backend` | `docker` \| `ssh` \| `openshell` | `docker` |
| `agents.defaults.sandbox.workspaceAccess` | `none` \| `ro` \| `rw` | `none` (isolated sandbox workspace) |
| Docker network | `agents.defaults.sandbox.docker.network` | **`"none"`** (no egress) when sandboxing |

Gateway process stays on the host; **only tool execution** moves into the sandbox
when enabled.

Workspace without sandbox: tools use the agent workspace as **default cwd**, but
**absolute paths can escape** unless sandboxing is on (DOCS: agent-workspace).

### Exec approvals (interactive gates)

DOCS: [approvals](https://docs.openclaw.ai/cli/approvals)

Headless "never prompt" / YOLO:

```bash
openclaw exec-policy preset yolo
# or sync:
openclaw approvals set --stdin <<'EOF'
{
  version: 1,
  defaults: { security: "full", ask: "off", askFallback: "full" }
}
EOF
openclaw config set tools.exec.host gateway
openclaw config set tools.exec.security full
openclaw config set tools.exec.ask off
```

Approvals file: `$OPENCLAW_STATE_DIR/exec-approvals.json` (default
`~/.openclaw/exec-approvals.json`).

### Map Parley posture → OpenClaw

| Parley | OpenClaw mapping (proposed) |
| ------ | --------------------------- |
| `sandbox=read-only`, network n/a | `sandbox.mode=all`, `workspaceAccess=ro` (or tool policy deny writes); network remains sandbox-docker default `none` |
| `sandbox=workspace`, `network=true` | Prefer **`sandbox.mode=off`** + `agents.*.workspace = task.cwd` + `tools.fs.workspaceOnly=true` if available, **or** `mode=all` + `workspaceAccess=rw` + docker network allowing egress; host exec with `security=full` `ask=off` |
| `sandbox=workspace`, `network=false` | Sandbox `mode=all`, `workspaceAccess=rw`, leave docker `network: "none"` |
| `sandbox=full` | `sandbox.mode=off`, exec `security=full` `ask=off` (full host access — dangerous) |
| Disable interactive approvals | `exec-policy preset yolo` / `ask: "off"` + `security: "full"` in **task-isolated** state dir |

**Caveats:**

- Docker sandbox needs image `openclaw-sandbox:bookworm-slim` built on the host
  (DOCS); fails closed if missing when mode ≠ off.
- Sandbox + network is **not** a simple boolean flag like codex
  `sandbox_workspace_write.network_access`.
- **gitDir / gitCommonDir** extra writable roots: OpenClaw sandbox bind mounts are
  configured via `sandbox.docker.binds` (DOCS). Mapping parley worktree private
  gitdirs is **adapter design work** — not a built-in flag. Mark partial
  **UNKNOWN** until implemented and tested.

---

## 6. Model & effort flags; auth env vars

### Model / thinking

| Concern | Mechanism | Evidence |
| ------- | --------- | -------- |
| Model per run | `--model <provider/model>` on `openclaw agent` | VERIFIED help |
| Default model | `openclaw models set <ref>` → `agents.defaults.model.primary` | DOCS: [models](https://docs.openclaw.ai/cli/models) |
| Reasoning / effort | **`--thinking <level>`** (not `--effort`) | VERIFIED help |
| Thinking levels | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `adaptive`, `max` (provider-dependent) | VERIFIED help + DOCS infer notes (`adaptive`→medium, `max`→max/xhigh) |

Parley `task.effort` should map opaquely to `--thinking <effort>` (same string
pass-through policy as other vendors).

### Auth env vars

DOCS: [environment](https://docs.openclaw.ai/help/environment),
[authentication](https://docs.openclaw.ai/gateway/authentication),
[model-providers](https://docs.openclaw.ai/concepts/model-providers).

Trusted sources (never workspace `.env` for provider keys):

1. Process environment of the CLI/gateway process
2. `$OPENCLAW_STATE_DIR/.env` (global runtime dotenv)
3. Config `env` block / SecretRefs in `openclaw.json`

Common provider keys (non-exhaustive):

| Provider | Env |
| -------- | --- |
| Anthropic | `ANTHROPIC_API_KEY` (+ rotation `ANTHROPIC_API_KEYS`, `ANTHROPIC_API_KEY_1`, …) |
| OpenAI API | `OPENAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| xAI | `XAI_API_KEY` |
| Google / Gemini | `GEMINI_API_KEY`, `GOOGLE_API_KEY` |
| Others | `GROQ_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, … |

Also: `OPENCLAW_GATEWAY_TOKEN` / password for gateway auth; path overrides
`OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_HOME`.

Auth can also live in per-agent auth profiles / SQLite under
`$OPENCLAW_STATE_DIR/agents/<id>/agent/` (`openclaw models auth …`).

**VERIFIED:** without keys, default model `openai/gpt-5.5` fails with
`ProviderAuthError` / `missing-provider-auth` against the agent SQLite auth store.

---

## 7. Model enumeration

```bash
openclaw models list --json          # configured / default view
openclaw models list --all --json    # full catalog (may wait on discovery)
openclaw models list --plain
openclaw models status --json        # default + auth health
```

**VERIFIED sample** (`models list --json`, fresh state, 2026.7.1):

```json
{
  "count": 1,
  "models": [
    {
      "key": "openai/gpt-5.5",
      "name": "gpt-5.5",
      "input": "text",
      "contextWindow": 200000,
      "local": false,
      "available": false,
      "tags": ["default"],
      "missing": false
    }
  ]
}
```

**VERIFIED** `models list --all --json`: `count: 86`; per-model keys only
`key`, `name`, `input`, `contextWindow`, `local`, `available`, `tags`, `missing`
— **no per-model efforts / thinking levels** in this listing.

For Parley `listModels()`:

- Parse `models[].key` as `id`.
- `efforts`: carry forward from existing catalog (like grok) or hardcode the
  `--thinking` vocabulary as advisory; probe does not supply efforts.
- `source`: `"openclaw models list --all --json"`.

`models status --json` is useful for auth preflight (`missingProvidersInUse`,
`runtimeAuthRoutes`) but is not the full catalog.

---

## 8. Token usage

### Where usage appears

| Surface | Fields | Evidence |
| ------- | ------ | -------- |
| Agent `--json` result | `meta.agentMeta.usage.{input,output,cacheRead,cacheWrite,total}` | Source 2026.7.1 (`emitIngressModelUsageDiagnostic`); DOCS token-use |
| `openclaw sessions --json` | `sessions[].totalTokens`, `totalTokensFresh`, `contextTokens` | VERIFIED (null until a successful billed turn) |
| Chat `/usage`, `/status` | Human footers | DOCS: [token-use](https://docs.openclaw.ai/reference/token-use) |
| `openclaw gateway usage-cost` | Aggregated cost from session logs | DOCS: gateway |
| Diagnostics `model.usage` events | Same bucket names when diagnostics enabled | Source |

### Worked example (constructed from source field names)

Success path **not live-verified** without API keys. Expected shape:

```json
{
  "payloads": [{ "text": "Done." }],
  "meta": {
    "durationMs": 4521,
    "agentMeta": {
      "sessionId": "3a944b05-b121-4269-8576-48b24306e10d",
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "usage": {
        "input": 15234,
        "output": 892,
        "cacheRead": 12000,
        "cacheWrite": 200,
        "total": 16326
      },
      "lastCallUsage": { "input": 500, "output": 100 },
      "contextTokens": 200000,
      "promptTokens": 15234
    }
  }
}
```

Adapter `parseEvent` / post-process should map:

- `usage.input` → `input` (or `input_tokens` in Parley usage bag)
- `usage.output` → `output`
- `usage.total` → `total`
- include `cacheRead` / `cacheWrite` when present

Provider aliases (`input_tokens` / `prompt_tokens`) are normalized **inside**
OpenClaw before display (DOCS); the agentMeta path already uses the short names
above in source.

---

## 9. Adapter recommendation

### Integration shape

**Spawn-per-turn embedded agent** with **task-local OpenClaw state** and a
**materialized config file** (grok-like, not codex-flags-only).

Do **not** require a long-lived Gateway for the MVP adapter; use `--local`.
(Optional later: shared gateway + `openclaw agent` without `--local` for multi-user
channel features — out of scope for Parley's coding worktree use case.)

### `prepare()` — proposed

**Env:**

```text
OPENCLAW_STATE_DIR=<taskMetaDir>/openclaw-state
OPENCLAW_CONFIG_PATH=<taskMetaDir>/openclaw-state/openclaw.json
# pass through any provider keys present on the parent:
ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, XAI_API_KEY, …
```

**Files (`SpawnPlan.files`):** write
`<taskMetaDir>/openclaw-state/openclaw.json` (or materialize via absolute path
outside the worktree so agents cannot easily edit their own policy). Suggested
contents:

```json5
{
  agents: {
    defaults: {
      workspace: "<task.cwd>",
      model: { primary: "<task.model or omit>" },
      sandbox: { /* see §5 mapping */ },
      // ensure MCP tools visible — avoid tools.profile "minimal"
    },
    list: [
      {
        id: "parley",
        workspace: "<task.cwd>",
        // optional per-agent sandbox overrides
      },
    ],
  },
  tools: {
    exec: { host: "gateway", security: "full", ask: "off" },
    // optionally: fs: { workspaceOnly: true }
  },
  mcp: {
    servers: {
      parley: {
        url: "<hub.url>",
        transport: "streamable-http",
        timeout: <ceil(answerTimeoutMs/1000) + headroom>,
        headers: { /* hub.headers */ },
      },
    },
  },
}
```

Also materialize or write **exec-approvals** YOLO defaults into
`$OPENCLAW_STATE_DIR/exec-approvals.json` (or run `exec-policy preset yolo` once
against that state dir during prepare).

**Argv:**

```text
openclaw agent --local
  --agent parley
  --session-key agent:parley:<task.id>
  --message <task.prompt>          # or --message-file for large prompts
  --json
  --timeout <seconds from answerTimeout / task budget>
  [--model <task.model>]
  [--thinking <task.effort>]
```

**cwd:** `task.cwd` (process cwd); file tools still honor configured
`agents.*.workspace` — keep them equal.

### `resume()` — proposed

Same env/files as prepare (re-materialize hub headers/timeouts). Argv:

```text
openclaw agent --local
  --agent parley
  --session-id <task.sessionId>    # preferred if UUID known
  # OR --session-key agent:parley:<task.id>
  --message <orchestrator answer as prompt>
  --json
  [--model] [--thinking] [--timeout]
```

Reject resume if neither session id nor stable session key can be resolved
(same loud failure pattern as grok adapter).

### Event-parse table

Because stdout is **one JSON document**, the engine/adapter should either:

- **Buffer entire stdout** then call `parseEvent` once, or
- Split on newlines but reassemble JSON (pretty-print spans multiple lines —
  **do not** parse line-by-line as independent events).

| OpenClaw observation | → `VendorEvent` |
| -------------------- | --------------- |
| Final JSON `payloads[].text` (joined) | `{ kind: "message", text }` |
| `meta.agentMeta.sessionId` | `{ kind: "session_meta", session_id }` |
| `meta.agentMeta.usage` numeric fields | `{ kind: "session_meta", usage }` |
| Non-zero exit + stderr `ProviderAuthError` / `FailoverError` / `GatewayCredentialsRequiredError` | `{ kind: "error", text, fatal: true }` |
| Final JSON with error-like payloads (`payload.isError`) | `{ kind: "error", text }` (fatal TBD) |
| Mid-run tool/command lines on stderr diagnostics | opaque / optional `{ kind: "error", text }` non-fatal; raw log retains |
| `sessions tail` progress | **do not** map unless a separate pipe is added (redacted) |

`sessionId(events)`: last `session_meta.session_id`, else post-run
`openclaw sessions --json` lookup by key.

### Top risks / unknowns

1. **No streaming JSONL** — largest semantic mismatch with codex/grok adapters and
   Parley's live UI feed. Plan for "silent until complete" or secondary log
   tails.
2. **Config materialization surface area** — sandbox, exec-approvals, workspace,
   MCP, tool profile must all be correct in isolated state; easy to leak host
   `~/.openclaw` if env overrides are missing.
3. **git worktree writable roots** under Docker sandbox — **UNKNOWN** until
   binds for `gitDir`/`gitCommonDir` are designed and tested.
4. **Success JSON envelope** field stability — re-verify with a real API key;
   this research only fully exercised the auth-fail path.
5. **Default model / auth coupling** — unconfigured state defaults to
   `openai/gpt-5.5` and fails without OpenAI auth (VERIFIED); pass `--model`
   and matching provider env explicitly.
6. **Product drift** — calendar versioning (`2026.7.1`), large surface, gateway
   features evolving quickly; pin version in adapter docs and re-probe
   `models list` / agent help at implementation.
7. **MCP tool discovery latency / timeouts** on first embedded run — raise
   `timeout`; consider `openclaw mcp doctor --probe` preflight.
8. **Approvals guardian equivalents** — if exec `ask` is not fully off, headless
   runs hang; YOLO must be in the **same** `OPENCLAW_STATE_DIR` as the child.
9. **`infer` trap** — must not use `infer model run` as the agent vendor path
   (no tools/MCP).
10. **Exit codes** — failures are non-zero in the verified auth case, but map
    stderr carefully; never assume rich JSON on failure.

### Feasibility summary for Parley

| Parley need | OpenClaw 2026.7.1 |
| ----------- | ----------------- |
| Headless one-shot | **Yes** — `agent --local` |
| Streaming JSON events | **No** — terminal JSON only |
| MCP HTTP + custom headers | **Yes** — config `mcp.servers` |
| Session resume | **Yes** — `--session-id` / `--session-key` |
| Sandbox / approvals control | **Yes** — config + exec-policy (not agent flags) |
| Model selection | **Yes** — `--model` |
| Effort / thinking | **Yes** — `--thinking` |
| Auth via env | **Yes** — provider `*_API_KEY` + state isolation |
| Token usage capture | **Yes** — `meta.agentMeta.usage` (+ sessions) |
| Worktree as workspace | **Yes if configured** — not automatic from cwd |

**Verdict:** Adapter is **viable but higher-friction** than codex/grok: treat as a
**config-materializing, non-streaming** vendor. Closest sibling pattern is
**grok** (files + env isolation), not **codex** (flags-only).

---

## Sources

- Package: `openclaw@2026.7.1` (local VERIFIED)
- Docs: https://docs.openclaw.ai/cli/agent  
- Docs: https://docs.openclaw.ai/cli/mcp  
- Docs: https://docs.openclaw.ai/cli/models  
- Docs: https://docs.openclaw.ai/cli/sessions  
- Docs: https://docs.openclaw.ai/cli/approvals  
- Docs: https://docs.openclaw.ai/gateway/sandboxing  
- Docs: https://docs.openclaw.ai/help/environment  
- Docs: https://docs.openclaw.ai/reference/token-use  
- Docs: https://docs.openclaw.ai/cli/infer  
- Site: https://openclaw.ai  
- Repo: https://github.com/openclaw/openclaw  
