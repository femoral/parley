# Pi CLI — automation surface for Parley

Research asset for [Research: headless automation surface for 10 harness CLIs](https://github.com/femoral/parley/issues/96) (Pi). Verified against `@earendil-works/pi-coding-agent` **0.80.7** on 2026-07-16 (binary `pi`, Node CLI). Primary sources: [pi.dev](https://pi.dev/), [earendil-works/pi-mono](https://github.com/earendil-works/pi-mono) (successor to `badlogic/pi-mono`), package docs under `packages/coding-agent/docs/`.

Evidence tags used throughout:

- **VERIFIED (0.80.7)** — ran against the installed binary on this host.
- **DOCS** — claimed only from official package/repo docs (URL cited).
- **UNKNOWN** — not proven; what blocks verification is stated.

## TL;DR for Parley

Pi **can** do headless single-shot automation. Recommended shape:

```bash
pi --mode json -p "<prompt>" \
  --model <provider/id-or-pattern> \
  [--thinking <level>] \
  [--session-dir <parley-private-dir>] \
  [--session <id> | --session-id <id>] \
  [-e <mcp-extension>] \
  [--tools read,bash,edit,write | --tools read,grep,find,ls] \
  [--approve | --no-approve]
```

What Parley needs vs what Pi gives:

| Parley need | Pi surface | Notes |
|-------------|------------|--------|
| Headless one-shot | `--mode json` (+ optional `-p`) | Streams JSONL to stdout; process exits after turn. **VERIFIED (0.80.7)** |
| Streaming JSON events | `--mode json` | First line is session header; then agent/turn/message/tool events. **VERIFIED** |
| MCP-over-HTTP + headers | **Not built-in** | Core philosophy is “No MCP”. **Preferred (#107):** Parley-owned extension via `-e` that registers `ask_orchestrator` / `submit_report` against the daemon **child REST** surface (`POST /child/ask`, `POST /child/report`). Community `pi-mcp-adapter` is optional but insufficient alone (needs install + cold `directTools` cache). |
| Session resume | `--session <id\|path>` or `--session-id <id>` | Session id is the first JSONL line’s `id`. **VERIFIED** |
| Sandbox / network | **No built-in sandbox** | Soft read-only via `--tools`; real isolation is OS/container. **DOCS** |
| Disable interactive approvals | N/A (no permission popups) | Project trust only: `--approve` / `--no-approve`. **DOCS + VERIFIED flags** |
| Model selection | `--model`, `--provider`, `--thinking` | **VERIFIED** |
| Auth via env | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, … | Plus `~/.pi/agent/auth.json` / OAuth. **DOCS + VERIFIED** |
| Token usage | `message.usage` on assistant `message_end` / `turn_end` | Fields: `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `totalTokens`, `cost`. **VERIFIED** |

**Loud caveats (adapter-blocking if ignored):**

1. **No native MCP client.** Materializing `.mcp.json` alone is **inert** unless `pi-mcp-adapter` is installed (adapter-validation-a / #107). Even then, `directTools` register from a metadata cache that is empty on the first session after config add (tools fall back to proxy-only until `/mcp reconnect`). Prefer a **Parley-owned extension** loaded with `--no-extensions -e .parley/pi-hub-extension.ts` that `registerTool`s protocol tools against child REST — no third-party package, no cold cache.
2. **No native filesystem/network sandbox.** Default Pi is “run as the user.” Soft postures map to `--tools` allowlists; `network:false` cannot be expressed in-process — adapter should **refuse** rather than silently under-isolate (#107). Hard isolation is Docker/OpenShell/Gondolin (see §5).
3. **Exit code is not a success signal.** Auth failures, missing sessions, and API 401s still exit **0**. Parse `stopReason` / `errorMessage` / stderr text. **VERIFIED (0.80.7)**.

Closest viable integration: **print/JSON spawn-per-turn** + **materialized Parley hub extension (`-e`)** calling **`/child/report` + `/child/ask`**. Optional fallback: `pi-mcp-adapter` via `PARLEY_PI_MCP_ADAPTER` / `pi install`, with the cache/first-run caveats above.

---

## 1. Identity & install

### Identity (choice)

**Pi** = the minimal coding-agent harness by Mario Zechner (badlogic), monorepo historically `badlogic/pi-mono`, now published under **Earendil Works** as `earendil-works/pi-mono` / `@earendil-works/*`. Site: [pi.dev](https://pi.dev/). Binary: **`pi`**.

Not to be confused with:

- `@mariozechner/pi` — unrelated CLI for vLLM/GPU pod management (`bin: pi-pods`).
- Forks such as `@oh-my-pi/pi-coding-agent` on npm (third-party).

Package rename: npm deprecates `@mariozechner/pi-coding-agent` (last **0.73.1**) with message *“please use `@earendil-works/pi-coding-agent` instead”*. **DOCS** ([npm package page](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)).

### Install

```bash
# Recommended (official README)
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Installer alternative (DOCS)
curl -fsSL https://pi.dev/install.sh | sh
```

- **Pinned verified version:** `0.80.7` (**VERIFIED** via `pi -v` and `npm view @earendil-works/pi-coding-agent version` on 2026-07-16).
- **Binary path (this host):** global `pi` → `@earendil-works/pi-coding-agent/dist/cli.js`.
- **Config home:** `~/.pi/agent` (override with `PI_CODING_AGENT_DIR`). **DOCS** + **VERIFIED** (empty dir forces “No API key found…” when no env key).

Sources: [coding-agent README](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/README.md), [pi.dev](https://pi.dev/).

---

## 2. Headless invocation

### One-shot argv (recommended for Parley)

```bash
pi --mode json -p "<prompt>" [options...]
```

Also works without `-p` (JSON mode still processes the prompt and exits):

```bash
pi --mode json "<prompt>" [options...]
```

**VERIFIED (0.80.7):** both forms exit after `agent_settled` with code 0 on success.

Human-readable one-shot (no JSONL):

```bash
pi -p "<prompt>"
```

Piped context is merged into the prompt in print mode (**DOCS** README):

```bash
cat README.md | pi -p "Summarize this text"
```

Working directory is **process cwd** (no `--cd` flag in 0.80.7 help). **VERIFIED** help output — Parley should `spawn` with `cwd: task.cwd`.

### Output modes

| Flag | Behavior |
|------|----------|
| (default) | Interactive TUI |
| `-p` / `--print` | Non-interactive text; process and exit |
| `--mode json` | JSONL event stream on stdout |
| `--mode rpc` | Long-lived JSONL RPC over stdin/stdout |

**DOCS:** [json.md](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/json.md), [rpc.md](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/rpc.md).

### Streaming JSON format (real lines, 0.80.7)

First line is always a **session header** (not an `AgentEvent`):

```json
{"type":"session","version":3,"id":"019f69fb-6b24-7326-8836-8218d35d2b78","timestamp":"2026-07-16T08:11:52.484Z","cwd":"/tmp/pi-scratch"}
```

Then lifecycle events (abbreviated real stream from a successful run):

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly the word PONG and nothing else. Do not use tools."}],"timestamp":1784189512749}}
{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly the word PONG and nothing else. Do not use tools."}],"timestamp":1784189512749}}
{"type":"message_start","message":{"role":"assistant","content":[],"api":"openai-codex-responses","provider":"openai-codex","model":"gpt-5.5",...}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"PONG",...},"message":{...}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"PONG",...}],"usage":{"input":424,"output":6,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":430,"cost":{...}},"stopReason":"stop",...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...],"willRetry":false}
{"type":"agent_settled"}
```

Tool call example (**VERIFIED**):

```json
{"type":"tool_execution_start","toolCallId":"call_…","toolName":"bash","args":{"command":"echo HELLO_PARLEY"}}
{"type":"tool_execution_update","toolCallId":"call_…","toolName":"bash","args":{"command":"echo HELLO_PARLEY"},"partialResult":{"content":[{"type":"text","text":"HELLO_PARLEY\n"}],"details":{}}}
{"type":"tool_execution_end","toolCallId":"call_…","toolName":"bash","result":{"content":[{"type":"text","text":"HELLO_PARLEY\n"}]},"isError":false}
```

Event inventory from docs + observed streams: `session`, `agent_start`, `agent_end`, `agent_settled`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, plus compaction/retry/queue variants (**DOCS** json.md / rpc.md).

### Auth / error shapes (still useful)

Missing key (stderr + still exit 0; session header may still print):

```text
No API key found for anthropic.

Use /login to log into a provider via OAuth or API key. See:
  …/docs/providers.md
  …/docs/models.md
```

**VERIFIED (0.80.7)** with `--provider anthropic` and no key.

Invalid key (JSON stream; `stopReason: "error"`; exit still 0):

```json
{"type":"message_end","message":{"role":"assistant","content":[],"provider":"anthropic","model":"claude-sonnet-5","stopReason":"error","errorMessage":"401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"},…}",…}}
```

**VERIFIED (0.80.7)** with `--api-key bad`.

Missing session:

```text
No session found matching 'deadbeef'
```

**VERIFIED** — exit 0.

### Exit codes

Treat as **uninformative** (0 on success, missing auth, bad session, and API auth error). **VERIFIED (0.80.7).** Adapter must parse the stream for `stopReason === "error"`, `errorMessage`, and/or stderr “No API key…”.

---

## 3. MCP injection

### Built-in: none

Pi’s philosophy is explicit **“No MCP”** in the coding-agent README. MCP is listed as something you add via extensions/packages, not a core client. **DOCS:** [README philosophy](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/README.md), [blog: What if you don’t need MCP?](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/).

There is **no** `--mcp`, `-c mcp_servers.…`, or env-based MCP injection in `pi --help` **VERIFIED (0.80.7)**.

### Recommended community path: `pi-mcp-adapter`

npm package **`pi-mcp-adapter@2.11.0`** (keywords `pi-package`, MIT, [nicobailon/pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)). Install:

```bash
pi install npm:pi-mcp-adapter
# or load once: pi -e <path-to-extension>
```

**DOCS (package README, not re-run against a live hub in this research):**

Config files (precedence quoted from adapter README):

1. `~/.config/mcp/mcp.json` (user shared)
2. `$PI_CODING_AGENT_DIR/mcp.json` (default `~/.pi/agent/mcp.json`)
3. **`.mcp.json`** (project shared — best Parley materialization target)
4. **`.pi/mcp.json`** (project Pi override)

Server entry fields relevant to Parley:

| Field | Purpose |
|-------|---------|
| `url` | Streamable HTTP endpoint (SSE fallback) |
| `headers` | Custom HTTP headers; supports `${VAR}` / `$env:VAR` |
| `auth` | `"oauth"` \| `"bearer"` \| `false` |
| `bearerToken` / `bearerTokenEnv` | Static bearer |
| `lifecycle` | `lazy` (default) \| `eager` \| `keep-alive` |
| `requestTimeoutMs` | Per-request timeout (ms) — **raise above `answerTimeoutMs`** |
| `directTools` | `true` / name list — register tools natively (needed so the model sees `submit_report` / `ask_orchestrator` without proxy dance) |
| `command` / `args` / `env` / `cwd` | stdio transport alternative |

Example project file Parley can materialize as `.mcp.json`:

```json
{
  "mcpServers": {
    "parley": {
      "url": "http://127.0.0.1:PORT/mcp",
      "headers": {
        "x-parley-task-id": "TASK_ID"
      },
      "auth": false,
      "lifecycle": "eager",
      "requestTimeoutMs": 1860000,
      "directTools": ["ask_orchestrator", "submit_report"]
    }
  },
  "settings": {
    "requestTimeoutMs": 1860000,
    "samplingAutoApprove": true
  }
}
```

Notes for headless:

- Adapter README: `samplingAutoApprove` is **required for sampling in non-UI sessions** if sampling is used (**DOCS** package README).
- Project trust: non-interactive modes ignore project `.pi` resources unless trusted / `--approve` / `defaultProjectTrust: "always"` (**DOCS** settings.md). If MCP lives in **`.mcp.json` at project root** (not under `.pi/`), trust may not apply the same way — **UNKNOWN** whether `pi-mcp-adapter` reads `.mcp.json` without project trust (adapter claims it does; not re-verified end-to-end here).
- Prefer also shipping **`--approve`** when materializing `.pi/mcp.json` or project extensions.

### Alternative: Parley-owned extension

A minimal TypeScript extension can `pi.registerTool()` for `ask_orchestrator` / `submit_report` and `fetch(hub.url, { headers })` the streamable-HTTP MCP endpoint. Load with:

```bash
pi -e /absolute/or/relative/path/to/parley-pi-hub.ts --no-extensions
```

(`--no-extensions` disables discovery; explicit `-e` still works — **DOCS** README.) This avoids a third-party dependency and gives full control of timeouts/headers. **Not implemented in this research.**

### Flags vs config vs env summary

| Mechanism | Native Pi? | Notes |
|-----------|------------|-------|
| CLI MCP flags | No | — |
| Project `.mcp.json` / `.pi/mcp.json` | Via extension | Best Parley `SpawnPlan.files` target |
| `PI_CODING_AGENT_DIR` | Yes | Isolates agent dir (auth, settings, global mcp.json) |
| Env headers only | Via adapter interpolation | e.g. `"${PARLEY_TASK_HEADER}"` in headers |

---

## 4. Session resume

### Session id emission

First stdout JSONL line:

```json
{"type":"session","version":3,"id":"<session-id>","timestamp":"…","cwd":"…"}
```

**VERIFIED (0.80.7).** Persist `id` as Parley’s vendor `sessionId`.

Sessions store as JSONL under `~/.pi/agent/sessions/` organized by cwd (**DOCS**), or under `--session-dir` (**VERIFIED**: file `…/<timestamp>_<id>.jsonl` written into the given dir).

### Resume argv

```bash
# Resume by id (partial UUID ok when unique) or path
pi --mode json -p "<follow-up prompt>" --session <session-id-or-path>

# Create or resume exact project session id
pi --mode json -p "<prompt>" --session-id <exact-id>

# Continue most recent session for cwd
pi --mode json -c -p "<prompt>"

# Optional private storage (recommended for Parley isolation)
pi --mode json -p "<prompt>" --session-dir <dir> --session <id>
```

**VERIFIED (0.80.7):**

- `--session <uuid>` continued conversation; assistant recalled prior “PONG” instruction.
- `--session-id parley-exact-id-demo` create then resume; second turn answered “ALPHA”.
- `-c` preserved the same session `id` across two print runs.

Other flags: `--no-session` (ephemeral — **do not use** if resume matters), `--fork <path|id>`, `--name` / `-n`. **DOCS** + help **VERIFIED**.

Interactive-only picker: `-r` / `--resume` — not for headless.

### RPC alternative

`pi --mode rpc` keeps a long-lived process; client sends `{"type":"prompt","message":"…"}` and receives the same event stream; `get_state` returns `sessionId`. **DOCS** [rpc.md](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/rpc.md). Fits a different adapter architecture than Parley’s spawn-per-turn ADR-0004 default.

---

## 5. Sandbox & approvals

### No built-in sandbox

**DOCS** [security.md](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/security.md): Pi runs with the OS permissions of the user; built-in tools can read/write/edit and run bash unrestricted. Isolation is intentional external (container / micro-VM). **DOCS** [containerization.md](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/containerization.md): Docker, OpenShell, Gondolin extension.

### Soft posture via tools (best-effort in-process)

Built-in tools (**VERIFIED** help): `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

| Parley `SandboxMode` | Suggested Pi mapping | Network |
|----------------------|----------------------|---------|
| `read-only` | `--tools read,grep,find,ls` | Cannot enforce; host network still available to process/LLM API. |
| `workspace` (default) | Default tools (or explicit `--tools read,bash,edit,write,grep,find,ls`) | On by default. |
| `full` | Same as workspace for in-process Pi (no extra privilege flag) | On. |
| `network: false` | **No first-class flag.** Options: run whole `pi` in a net-restricted container; or load example sandbox extension (bash-only domain allowlist via `@anthropic-ai/sandbox-runtime`) — **DOCS** example `examples/extensions/sandbox`. | |

`--no-tools` / `-nt` disables all tools; `--exclude-tools` denylists. **VERIFIED** help.

### Approvals / interactive prompts

- Core philosophy: **“No permission popups.”** **DOCS** README.
- `--approve` / `-a` and `--no-approve` / `-na` control **project trust** (whether to load `.pi/settings.json`, project extensions, packages) — **not** per-tool allow/deny. **DOCS** settings.md + **VERIFIED** help text.
- Non-interactive modes never show the trust prompt; without a saved trust decision, `defaultProjectTrust` of `ask`/`never` **ignores** project-local resources; `always` trusts them. **DOCS.**
- Example `permission-gate` extension **blocks** dangerous bash when `!ctx.hasUI` (headless-safe deny). **DOCS** example source — optional, not default.

**Headless recommendation:** do not rely on interactive confirmations (there are none by default). Use tool allowlists + OS sandbox for real containment. Pass `--approve` if the adapter materializes project `.pi/*` that must load.

---

## 6. Model & effort flags; auth env vars

### Model / thinking

| Flag | Role |
|------|------|
| `--provider <name>` | Provider id (default observed on this host: from settings / oauth; help text says default `google` but user settings may override — pass explicitly). **VERIFIED** help. |
| `--model <pattern>` | Model pattern or id; supports `provider/id` and optional `:<thinking>` (e.g. `sonnet:high`, `openai/gpt-4o`). **DOCS** + help. |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. **VERIFIED** help. |
| `--api-key <key>` | Overrides env for the selected provider. **VERIFIED** (bad key produced 401 stream). |
| `--models <patterns>` | Ctrl+P cycling set (interactive). |

**Effort:** core surface is **`--thinking`**, not a separate reasoning-effort flag. Help lists Extension CLI Flag `--effort` from the installed `pi-effort` package on this host — **not** core, do not rely on it in the adapter unless Parley installs that package. Map Parley `task.effort` → `--thinking <value>` when the string matches Pi’s levels; otherwise pass through opaquely or ignore. **VERIFIED** help shows both.

### Auth env vars (from `pi --help`, 0.80.7)

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_OAUTH_TOKEN` | Anthropic |
| `OPENAI_API_KEY` | OpenAI |
| `AZURE_OPENAI_API_KEY` (+ base URL / resource / version / deployment map) | Azure |
| `GEMINI_API_KEY` | Google Gemini |
| `XAI_API_KEY` | xAI |
| `OPENROUTER_API_KEY` | OpenRouter |
| `DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`, `FIREWORKS_API_KEY`, `TOGETHER_API_KEY`, … | Others (full list in help) |
| `AWS_*` / `AWS_BEARER_TOKEN_BEDROCK` | Bedrock |
| `HF_TOKEN` | Hugging Face (**DOCS** providers.md) |

Also: OAuth/`auth.json` under `$PI_CODING_AGENT_DIR` (default `~/.pi/agent/auth.json`). **DOCS** [providers.md](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/providers.md).

Isolation env:

| Variable | Purpose |
|----------|---------|
| `PI_CODING_AGENT_DIR` | Config/auth/settings root |
| `PI_CODING_AGENT_SESSION_DIR` | Session storage (overridden by `--session-dir`) |
| `PI_OFFLINE` / `--offline` | Disable startup network (version check, telemetry, package checks) |
| `PI_SKIP_VERSION_CHECK` | Skip update check only |
| `PI_TELEMETRY` | `0`/`1` telemetry override |

**VERIFIED:** `PI_OFFLINE=1` used throughout; empty `PI_CODING_AGENT_DIR` isolates auth.

---

## 7. Model enumeration

```bash
pi --list-models            # all available for configured auth
pi --list-models <search>   # fuzzy filter
```

**Output format (plain text table, not JSON)** — **VERIFIED (0.80.7):**

```text
provider      model                         context  max-out  thinking  images
openai-codex  gpt-5.3-codex-spark           128K     128K     yes       no
openai-codex  gpt-5.4                       272K     128K     yes       yes
openai-codex  gpt-5.5                       272K     128K     yes       yes
xai-oauth     grok-4.5                      500K     500K     yes       yes
…
```

Columns: `provider`, `model`, `context`, `max-out`, `thinking` (yes/no), `images` (yes/no).

Notes:

- Listing reflects **authenticated / configured** providers on the host (OAuth Codex + custom extensions on this machine). A clean `PI_CODING_AGENT_DIR` with no keys returns a much smaller (possibly empty) set — **partially VERIFIED**.
- No `--json` on `--list-models`. Adapter `listModels` should parse the table defensively.
- Thinking levels are not per-row enums in the table (only yes/no); use fixed Pi level list for efforts: `off|minimal|low|medium|high|xhigh|max`.

---

## 8. Token usage

### Where it appears

On assistant messages at **`message_end`** and again on **`turn_end`** (same `message.usage` object). **VERIFIED (0.80.7).** Streaming `message_update` lines often show zeroed usage until the final `message_end`.

There is no top-level `turn.completed.usage` event like Codex; aggregate yourself from assistant messages or call RPC `get_session_stats` in RPC mode (**DOCS** rpc.md).

### Field names (worked example)

From a real `message_end` (PONG run):

```json
{
  "type": "message_end",
  "message": {
    "role": "assistant",
    "content": [{"type": "text", "text": "PONG"}],
    "provider": "openai-codex",
    "model": "gpt-5.5",
    "usage": {
      "input": 424,
      "output": 6,
      "cacheRead": 0,
      "cacheWrite": 0,
      "reasoning": 0,
      "totalTokens": 430,
      "cost": {
        "input": 0.0021200000000000004,
        "output": 0.00018,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 0.0023000000000000004
      }
    },
    "stopReason": "stop"
  }
}
```

Recommended normalization into `VendorEvent.usage`:

| Pi field | Suggested key |
|----------|----------------|
| `usage.input` | `input` |
| `usage.output` | `output` |
| `usage.cacheRead` | `cacheRead` |
| `usage.cacheWrite` | `cacheWrite` |
| `usage.reasoning` | `reasoning` |
| `usage.totalTokens` | `totalTokens` |
| `usage.cost.total` | `cost` (optional; float USD) |

Sum per-turn `usage` across all assistant `message_end` events in a run for task totals (multi-turn with tools emits multiple assistant messages). **VERIFIED** multi-turn tool run showed separate usage objects on toolUse and final stop turns.

---

## 9. Adapter recommendation

### Architecture choice

Prefer **spawn-per-turn JSON mode** (matches Codex/Grok adapters and ADR-0004):

- `prepare` / `resume` → `pi --mode json -p …`
- Parse JSONL; durable raw log remains source of truth.

Reserve **RPC mode** for a future “persistent child” design if mid-turn steering is required; not needed for Parley’s MCP `ask_orchestrator` pattern.

### Proposed `prepare()` plan

```ts
// Pseudocode — SpawnPlan
{
  argv: [
    "pi",
    "--mode", "json",
    "-p", task.prompt,
    "--offline",                    // hermetic startup network
    "--session-dir", sessionDir,    // private per-task or per-cwd storage
    // optional stable id for easy resume:
    // "--session-id", task.id,
    ...(task.model ? ["--model", task.model] : []),
    ...(task.effort ? ["--thinking", task.effort] : []),
    ...sandboxArgs(task),           // see below
    "--approve",                    // load materialized project MCP/extension files
    // MCP extension load (pick one strategy):
    "-e", pathToPiMcpAdapterOrParleyExt,
    // "--no-extensions",          // if using only -e and no discovery
  ],
  env: {
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    // Optional full isolation (then provision auth into this dir):
    // PI_CODING_AGENT_DIR: privateAgentDir,
    // Pass through whatever keys the orchestrator has:
    ...(process.env.ANTHROPIC_API_KEY && { ANTHROPIC_API_KEY: … }),
    ...(process.env.OPENAI_API_KEY && { OPENAI_API_KEY: … }),
    ...(process.env.XAI_API_KEY && { XAI_API_KEY: … }),
    // …other provider keys as needed
  },
  files: [
    {
      path: ".mcp.json",
      contents: JSON.stringify({
        mcpServers: {
          parley: {
            url: hub.url,
            headers: hub.headers,
            auth: false,
            lifecycle: "eager",
            requestTimeoutMs: task.answerTimeoutMs + 60_000,
            directTools: ["ask_orchestrator", "submit_report"],
          },
        },
        settings: {
          requestTimeoutMs: task.answerTimeoutMs + 60_000,
          samplingAutoApprove: true,
        },
      }),
    },
    // If using a vendored extension instead of global pi install:
    // { path: ".pi/extensions/parley-hub.ts", contents: "…" },
  ],
  cwd: task.cwd,
}
```

`sandboxArgs(task)`:

```ts
function sandboxArgs(task: TaskSpec): string[] {
  switch (task.sandbox) {
    case "read-only":
      return ["--tools", "read,grep,find,ls"];
    case "full":
    case "workspace":
    default:
      // No native write sandbox; optional: omit bash for tighter workspace
      return [];
  }
  // network:false → not expressible; document host-level isolation or skip.
}
```

### Proposed `resume()` plan

```ts
{
  argv: [
    "pi",
    "--mode", "json",
    "-p", task.prompt,              // orchestrator answer / follow-up
    "--offline",
    "--session", task.sessionId!,   // or --session-id if you used fixed ids
    "--session-dir", sessionDir,    // MUST match prepare
    ...(task.model ? ["--model", task.model] : []),
    ...(task.effort ? ["--thinking", task.effort] : []),
    ...sandboxArgs(task),
    "--approve",
    "-e", pathToPiMcpAdapterOrParleyExt,
  ],
  env: /* same as prepare */,
  files: /* re-materialize .mcp.json */,
  cwd: task.cwd,                    // cwd-scoped session lookup
}
```

Reject resume if `sessionId` is missing (same posture as Grok adapter).

### Event-parse table (`parseEvent`)

| Stream `type` | → `VendorEvent` | Notes |
|---------------|-----------------|--------|
| `session` | `session_meta` + `session_id: id` | First line; primary session capture |
| `message_update` with `assistantMessageEvent.type === "text_delta"` | `message` + `text: delta` | Optional streaming display |
| `message_end` + `message.role === "assistant"` + text content | `message` + full text (prefer end over deltas to avoid dupes) | Also extract `usage` into `session_meta` |
| `message_end` + `stopReason === "error"` | `error` + `text: errorMessage`, `fatal: true` | Exit code useless |
| `tool_execution_start` / `end` | `command` when `toolName === "bash"` (`args.command`); `file_change` when `write`/`edit` (path from args) | Be defensive on arg shapes |
| `tool_execution_end` + `isError: true` | `error` (non-fatal) + `PARLEY-DIAG` prefix if tool is MCP/`submit_report`/`ask_orchestrator` | Mirrors codex guardian diag |
| `agent_end` with `willRetry: true` | opaque / ignore | Retry follows |
| `agent_settled` | optional terminal marker (opaque) | Run finished for spawn-per-turn |
| `extension_error` | `error` | Extension failures |
| other / non-JSON | `[]` | Raw log keeps them |

`sessionId(events)`: last `session_meta.session_id` (the opening `session` line).

`listModels`: shell `pi --list-models`, parse table rows; efforts = `["off","minimal","low","medium","high","xhigh","max"]` (or empty + hand-patched catalog like Grok).

### Top risks / unknowns

1. **MCP is third-party.** `pi-mcp-adapter` is community-maintained; pin version; re-verify `url`/`headers`/`requestTimeoutMs`/`directTools` against the installed adapter before shipping. End-to-end hub injection was **not** live-tested in this research (**UNKNOWN** until implementation smoke test).
2. **No real sandbox.** `workspace` vs `full` are nearly identical in-process; `network: false` unsupported. Parley may need to document Pi as “soft isolation only” or wrap spawn in bubblewrap/Docker.
3. **Exit code always 0.** Must parse fatal errors from stream/stderr or tasks look successful when auth fails.
4. **Project trust vs materialization.** Headless ignores untrusted `.pi/*`; use `--approve` or global `PI_CODING_AGENT_DIR` files. Exact interaction of trust with root `.mcp.json` under the adapter is **UNKNOWN**.
5. **Package / org rename churn.** `@mariozechner/*` → `@earendil-works/*`; monorepo may still be cited as `badlogic/pi-mono` in older links. Pin `@earendil-works/pi-coding-agent@0.80.7` (or later) in adapter docs.
6. **Auth surface is multi-provider.** Unlike Codex’s single `CODEX_API_KEY`, Pi expects the orchestrator to pass the right provider key(s) or share `auth.json` via `PI_CODING_AGENT_DIR`.
7. **`--effort` is not core.** Map Parley effort → `--thinking`; do not depend on `pi-effort` unless installed.
8. **Global user extensions leak.** This host had custom OAuth extensions in `~/.pi/agent/settings.json`. Use `--no-extensions -e …` and/or private `PI_CODING_AGENT_DIR` for hermetic children.
9. **RPC framing caveat** if used later: split only on `\n`, not Node `readline` (Unicode separators). **DOCS** rpc.md.

### Implementation checklist for the stranger writing `packages/daemon/src/adapters/pi.ts`

1. Pin `pi` ≥ 0.80.7; re-run `pi --help` and a dry `--mode json -p` for flag drift.
2. Implement `prepare`/`resume` argv as above; `cwd = task.cwd`.
3. Materialize `.mcp.json` + ensure MCP extension is loadable (`-e` or preinstalled package).
4. Parse `session` → session id; assistant `message_end.usage` → usage; `stopReason: error` → fatal.
5. Soft-map sandbox via `--tools`; document network isolation gap.
6. Pass provider API keys from parent env; optional private `PI_CODING_AGENT_DIR` if hermetic auth is required.
7. Add fixtures from a real `--mode json` transcript (session + tool + usage + error).
8. Smoke-test `ask_orchestrator` blocking call with raised `requestTimeoutMs`.

---

## Appendix: verification matrix (0.80.7)

| Claim | Status |
|-------|--------|
| Binary `pi`, package `@earendil-works/pi-coding-agent@0.80.7` | VERIFIED |
| `pi --mode json -p "…"` one-shot JSONL | VERIFIED |
| `pi --mode json "…"` without `-p` also exits | VERIFIED |
| Session header `type:session` + `id` | VERIFIED |
| `--session` / `--session-id` / `-c` resume | VERIFIED |
| `--session-dir` writes session files | VERIFIED |
| Tool events `tool_execution_*` | VERIFIED |
| Usage on `message_end` | VERIFIED |
| Exit 0 on auth failure / missing session | VERIFIED |
| `--list-models` text table | VERIFIED |
| Auth env isolation via `PI_CODING_AGENT_DIR` | VERIFIED |
| No CLI MCP flags | VERIFIED (help) |
| `pi-mcp-adapter` HTTP `url` + `headers` | DOCS (package README/types) |
| Live MCP hub call through adapter | UNKNOWN (not smoke-tested) |
| OS sandbox / network off | DOCS only (containerization); no native flag |
| RPC mode protocol | DOCS (not driven end-to-end here) |
