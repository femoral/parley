# OpenCode CLI — automation surface for Parley

Research asset for the wayfinder ticket [Research: OpenCode CLI automation surface](https://github.com/femoral/parley/issues/96). Verified against OpenCode CLI **1.18.2** (npm package `opencode-ai@1.18.2`, binary interrogated 2026-07-16) plus official docs at [opencode.ai/docs](https://opencode.ai/docs). Upstream repo is now [anomalyco/opencode](https://github.com/anomalyco/opencode) (formerly `sst/opencode`); product site remains [opencode.ai](https://opencode.ai).

## TL;DR for Parley

OpenCode **can** do headless single-shot automation. It is a viable vendor adapter, closer to Grok (config/env injection) than Codex (flags-only):

- **Spawn**: `opencode run --format json --dangerously-skip-permissions --dir <worktree> -m <provider/model> "<prompt>"`.
- **Streaming**: JSONL on stdout (`--format json`). Event types include `step_start`, `text`, `tool_use`, `step_finish` (usage), `error`. Session id is on **every** line as `sessionID`.
- **MCP injection**: remote HTTP MCP with custom `headers` via config. Best per-child routes: `OPENCODE_CONFIG_CONTENT` (inline JSON) or materialize project `opencode.json`. No CLI `-c` overrides.
- **Approvals**: `--dangerously-skip-permissions` and/or `permission: "allow"` / `OPENCODE_PERMISSION` — required for non-interactive runs when any rule would `ask`. **Flag drift (adapter-validation-a / #107):** 1.18.2 help/docs also list `--auto` as the current-line name; OpenCode **≤1.16.x** only has `--dangerously-skip-permissions` (using `--auto` dumps help / fails the run). Prefer the long form for host compatibility.
- **Session resume**: `opencode run -s <sessionID> ...` (or `-c` for last session in directory).
- **Auth**: credentials in `~/.local/share/opencode/auth.json`, provider env keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, …), plus binary-present **`OPENCODE_API_KEY`** for OpenCode Zen/Go.
- **Usage**: `step_finish.part.tokens.{input,output,reasoning,cache.{read,write},total}` and `part.cost`.

**Loud caveats (adapter must handle):**

1. **Process exit code is 0 even on fatal API/auth errors** — failure detail is only in the `error` JSONL event. Do not trust exit codes alone.
2. **No OS-level sandbox** (no bubblewrap/Landlock equivalent). Posture maps to the **permission** system only; network isolation is partial (deny `webfetch`/`websearch`; `bash` can still hit the network).
3. **MCP `timeout` defaults to 5s** (schema: “MCP server requests”; docs: “fetching tools”). Raise it above `answerTimeoutMs` for `ask_orchestrator` — and **verify tool-call duration is covered** at implementation time (docs wording is ambiguous).

---

## 1. Identity & install

| Item | Value | Evidence |
| --- | --- | --- |
| Product | OpenCode — open-source terminal coding agent | DOCS: [opencode.ai/docs](https://opencode.ai/docs) |
| Binary name | `opencode` | VERIFIED 1.18.2 (`opencode --version`) |
| npm package | `opencode-ai` | VERIFIED `npm view opencode-ai` → `1.18.2`; bin maps to `./bin/opencode.exe` (platform binary via postinstall) |
| Platform packages | optionalDeps e.g. `opencode-linux-x64@1.18.2` | VERIFIED package.json of `opencode-ai@1.18.2` |
| Install (npm) | `npm install -g opencode-ai` or local `npm install opencode-ai@1.18.2` | DOCS + VERIFIED local install |
| Install (script) | `curl -fsSL https://opencode.ai/install \| bash` | DOCS |
| Install (brew) | `brew install anomalyco/tap/opencode` (tap preferred over formula) | DOCS |
| GitHub | [github.com/anomalyco/opencode](https://github.com/anomalyco/opencode) | DOCS |
| Pinned verified version | **1.18.2** | VERIFIED 2026-07-16 |

Data/config paths (XDG-aware; VERIFIED via `opencode debug paths` under custom `XDG_*`):

| Role | Default (Linux) |
| --- | --- |
| Config | `~/.config/opencode/` (`opencode.json`) |
| Data / auth / sessions | `~/.local/share/opencode/` (`auth.json`, session DB) |
| Cache | `~/.cache/opencode/` |
| State | `~/.local/state/opencode/` |

Project config: `opencode.json` (or `.jsonc`) in project root (git-root walk). DOCS: [config](https://opencode.ai/docs/config/).

---

## 2. Headless invocation

### Exact argv (one-shot)

```bash
opencode run --format json --auto --dir <worktree> \
  -m <provider/model> \
  [--variant <effort>] \
  "PROMPT TEXT"
```

| Piece | Role | Evidence |
| --- | --- | --- |
| `run [message..]` | Non-interactive one-shot | DOCS [cli#run](https://opencode.ai/docs/cli/#run); VERIFIED help |
| `--format json` | JSONL event stream on **stdout** | VERIFIED help + live runs |
| `--auto` | Auto-approve permissions that are not explicitly `deny` | DOCS [permissions](https://opencode.ai/docs/permissions/); VERIFIED help (`dangerous!`) |
| `--dir <path>` | Working directory (local run) | VERIFIED help + write test created `/tmp/.../hello.txt` under `--dir` |
| `-m` / `--model` | `provider/model` id | DOCS + VERIFIED |
| `--variant` | Provider-specific reasoning effort (e.g. `high`, `max`, `minimal`) | VERIFIED help; DOCS [models#variants](https://opencode.ai/docs/models/) |
| `--agent` | Named agent | VERIFIED help |
| `--title` | Session title | VERIFIED help |
| `--attach http://host:port` | Attach to `opencode serve` instead of spawning local server | DOCS |
| `--pure` | Run without external plugins (global flag) | VERIFIED help |

Prompt may also be multiple positional words: `opencode run Explain closures in JS`.

Human default format prints pretty output; automation **must** pass `--format json`.

### Streaming JSON format (JSONL)

Each stdout line is one JSON object with at least:

- `type` — event kind
- `timestamp` — unix ms
- `sessionID` — e.g. `ses_096042ed7ffegkkH3BpVm5C5CH` (present on **all** observed event types)

Observed event types (VERIFIED 1.18.2):

| `type` | When | Key fields |
| --- | --- | --- |
| `step_start` | Model step begins | `part.type: "step-start"`, `part.messageID` |
| `text` | Assistant text | `part.text`, `part.time.{start,end}` |
| `tool_use` | Tool finished | `part.tool`, `part.callID`, `part.state.{status,input,output,title,metadata,time}` |
| `step_finish` | Step ends | `part.reason` (`stop` \| `tool-calls`), `part.tokens`, `part.cost` |
| `error` | Fatal/API error | `error.name`, `error.data.message`, optional `statusCode` |

**Worked example — successful short run** (VERIFIED 1.18.2, model `opencode/deepseek-v4-flash-free`):

```json
{"type":"step_start","timestamp":1784189541701,"sessionID":"ses_096042ed7ffegkkH3BpVm5C5CH","part":{"id":"prt_…","messageID":"msg_…","sessionID":"ses_…","type":"step-start"}}
{"type":"text","timestamp":1784189542831,"sessionID":"ses_096042ed7ffegkkH3BpVm5C5CH","part":{"id":"prt_…","type":"text","text":"pong","time":{"start":1784189542809,"end":1784189542815}}}
{"type":"step_finish","timestamp":1784189542831,"sessionID":"ses_096042ed7ffegkkH3BpVm5C5CH","part":{"id":"prt_…","reason":"stop","type":"step-finish","tokens":{"total":8084,"input":8069,"output":3,"reasoning":12,"cache":{"write":0,"read":0}},"cost":0}}
```

**Worked example — tool + multi-step** (VERIFIED):

```json
{"type":"tool_use","timestamp":1784189555512,"sessionID":"ses_09603fdbbffeHJQX9GiIjpIfpb","part":{"type":"tool","tool":"bash","callID":"call_00_…","state":{"status":"completed","input":{"command":"echo tool-ok"},"output":"tool-ok\n","metadata":{"output":"tool-ok\n","exit":0,"truncated":false},"title":"echo tool-ok","time":{"start":…,"end":…}},"id":"prt_…","messageID":"msg_…"}}
{"type":"step_finish",…,"part":{"reason":"tool-calls","tokens":{…},"cost":0}}
{"type":"text",…,"part":{"text":"DONE"}}
{"type":"step_finish",…,"part":{"reason":"stop","tokens":{…},"cost":0}}
```

**Worked example — write tool** (VERIFIED):

```json
{"type":"tool_use",…,"part":{"tool":"write","state":{"status":"completed","input":{"filePath":"/tmp/oc-write-test/hello.txt","content":"hi"},"output":"Wrote file successfully.","metadata":{"filepath":"/tmp/oc-write-test/hello.txt",…}}}}
```

**Worked example — API/auth failure** (VERIFIED; **exit code still 0**):

```json
{"type":"error","timestamp":1784189651888,"sessionID":"ses_0960279aeffeh2QyCo5pXi11rd","error":{"name":"APIError","data":{"message":"Invalid API key.","statusCode":401,"isRetryable":false,"responseBody":"{\"type\":\"error\",\"error\":{\"type\":\"AuthError\",\"message\":\"Invalid API key.\"}}","metadata":{"url":"https://opencode.ai/zen/v1/chat/completions"}}}}
```

Billing failure shape (VERIFIED earlier with insufficient Zen balance):

```json
{"type":"error",…,"error":{"name":"APIError","data":{"message":"Insufficient balance. …","statusCode":401,…}}}
```

Invalid model (VERIFIED):

```json
{"type":"error",…,"error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_…"}}}
```

Third-party cheatsheet (not primary, useful cross-check): [takopi stream-json cheatsheet](https://takopi.dev/reference/runners/opencode/stream-json-cheatsheet/).

### Exit codes

| Situation | Exit code | Evidence |
| --- | --- | --- |
| Successful completion | `0` | VERIFIED |
| API auth/billing error (JSONL `error` emitted) | **`0`** | VERIFIED 1.18.2 |
| Invalid model | **`0`** | VERIFIED |

**Adapter implication:** treat any `type:"error"` as task failure (`fatal: true`); never use exit code as sole success signal.

Stderr may carry Bun/Node color warnings when `FORCE_COLOR`/`NO_COLOR` conflict — ignore for parsing; JSONL is on stdout.

---

## 3. MCP injection

### Transport & headers

Remote (HTTP) MCP is first-class:

```json
{
  "mcp": {
    "parley": {
      "type": "remote",
      "url": "http://127.0.0.1:PORT/mcp",
      "enabled": true,
      "headers": {
        "X-Parley-Task": "<task-id>"
      },
      "oauth": false,
      "timeout": 300000
    }
  }
}
```

| Field | Notes | Evidence |
| --- | --- | --- |
| `type: "remote"` | HTTP/streamable remote MCP | DOCS [mcp-servers](https://opencode.ai/docs/mcp-servers/); schema `McpRemoteConfig` |
| `url` | Required | DOCS + schema |
| `headers` | Arbitrary string map — **custom correlation headers OK** | DOCS + VERIFIED via `debug config` merge |
| `oauth: false` | Disable OAuth auto-detect (use for API-key/header auth hubs) | DOCS |
| `timeout` | Integer **ms**; schema default **5000** | Schema: “Timeout in ms for MCP server requests”; docs: “fetching tools… Defaults to 5000” — **ambiguity: startup vs tool-call** → mark UNKNOWN for long `ask_orchestrator` until proven |
| Local MCP | `type: "local"`, `command: string[]`, `environment`, `cwd`, `timeout` | DOCS |

stdio local MCP works for other tools; Parley’s hub is streamable-HTTP, so use **remote**.

### Injection mechanisms (flags vs config vs env)

| Mechanism | Usable for Parley? | Evidence |
| --- | --- | --- |
| CLI flag per MCP | **No** dedicated `--mcp` flag on `run` | VERIFIED `opencode run --help` |
| `OPENCODE_CONFIG_CONTENT` | **Yes** — inline JSON, high precedence | DOCS env table; VERIFIED `debug config` showed injected `mcp.parley` |
| `OPENCODE_CONFIG=/path/to.json` | **Yes** | DOCS; VERIFIED |
| Project `opencode.json` in cwd/`--dir` | **Yes** — materialize via `SpawnPlan.files` | DOCS; VERIFIED project + content merge |
| `OPENCODE_PERMISSION` | Permissions only (not MCP) | DOCS; VERIFIED |
| Global `~/.config/opencode/opencode.json` | Avoid mutating user global | DOCS |

Config precedence (later wins; DOCS [config#precedence](https://opencode.ai/docs/config/#precedence-order)):

1. Remote org `.well-known/opencode`
2. Global `~/.config/opencode/opencode.json`
3. `OPENCODE_CONFIG` file
4. Project `opencode.json`
5. `.opencode/` directory assets
6. **`OPENCODE_CONFIG_CONTENT`** (inline runtime overrides)
7. Managed / MDM configs (highest)

**Recommended hermetic injection for Parley:** set `OPENCODE_CONFIG_CONTENT` to a full JSON blob carrying `mcp.parley` + `permission` (and optionally `autoupdate: false`). Optionally also set `OPENCODE_DISABLE_PROJECT_CONFIG=1` (string present in binary — VERIFIED via binary string table; **behavior not fully re-tested**) so a worktree’s own `opencode.json` cannot shadow or fight the hub.

Alternatively (Grok-style): write `opencode.json` into the task cwd via `SpawnPlan.files` and git-exclude it. Content merge was VERIFIED: project file + `OPENCODE_CONFIG_CONTENT` both appear in resolved config.

### MCP tool naming

MCP tools are registered with a **server-name prefix** (docs: disable with `"mymcpservername_*": false`). Expect Parley tools as something like `parley_submit_report` / `parley_ask_orchestrator` (exact separator/casing **UNKNOWN** until a live hub connect is tested — confirm at adapter smoke test).

---

## 4. Session resume

### Session id emission

- Field name: **`sessionID`** (camelCase, capital ID).
- Present on **every** JSONL event from the first line (including `error` before any model text).
- Format: `ses_` + alphanumeric (VERIFIED examples: `ses_096042ed7ffegkkH3BpVm5C5CH`).
- Also listed via `opencode session list --format json` (`id` field) and `opencode export <sessionID>`.

Adapter `sessionId(events)`: first event’s `sessionID`.

### Resume argv

```bash
# Resume specific session
opencode run --format json --auto --dir <worktree> \
  -s <sessionID> \
  -m <provider/model> \
  "follow-up prompt"

# Continue last session for the directory
opencode run --format json --auto --dir <worktree> \
  -c \
  "follow-up prompt"
```

| Flag | Meaning | Evidence |
| --- | --- | --- |
| `-s` / `--session` | Continue by session id | VERIFIED: resumed `ses_096042…` recalled prior “pong” prompt |
| `-c` / `--continue` | Continue last session (cwd-scoped) | VERIFIED help + live `-c` run |
| `--fork` | Fork before continuing | VERIFIED help; not required for Parley stall-resume |

Resume keeps the same `sessionID` in the new run’s events (VERIFIED).

Session storage is in the OpenCode data dir (SQLite-backed; `opencode db path`). Isolation via `XDG_DATA_HOME` (or equivalent) is possible if Parley wants per-task session silos — then auth must be provisioned into that data dir or via env.

---

## 5. Sandbox & approvals

OpenCode does **not** ship an OS sandbox comparable to Codex bubblewrap or Grok `GROK_SANDBOX`. Control plane is the **permission** system: each tool action resolves to `allow` | `ask` | `deny`. DOCS: [permissions](https://opencode.ai/docs/permissions/).

### Defaults

- Most tools default to **`allow`**.
- `doom_loop` and `external_directory` default to **`ask`**.
- `.env` file reads default **`deny`**.
- DOCS: “By default, opencode **allows all operations** without requiring explicit approval” (config page) — still, `external_directory`/`doom_loop` ask unless overridden.

### Headless: disable interactive approvals

| Mechanism | Effect | Evidence |
| --- | --- | --- |
| `--dangerously-skip-permissions` | Auto-approve anything not explicitly `deny` | VERIFIED help on 1.16.2 + 1.18.2 |
| `--auto` | Same intent; **absent on ≤1.16.x** (yargs rejects) | DOCS (1.18.x) + VERIFIED 1.16.2 lacks flag |
| `"permission": "allow"` in config / `OPENCODE_CONFIG_CONTENT` | Global allow | DOCS + VERIFIED `debug config` |
| `OPENCODE_PERMISSION='{"*":"allow"}'` | Same via env (clobbers structured maps — prefer config content for posture) | DOCS + VERIFIED |

For Parley, use **`--dangerously-skip-permissions`** plus a structured `"permission"` map in `OPENCODE_CONFIG_CONTENT` so children never block on TTY approval while read-only / network denies still apply. Explicit `deny` rules still apply under auto-approve.

### Map Parley posture → OpenCode

| Parley `sandbox` + `network` | OpenCode mapping | Notes |
| --- | --- | --- |
| `read-only` | `permission`: `edit`/`write` path → `deny`; `bash` → `deny` (or tight allowlist); `read`/`glob`/`grep` → `allow` | Soft policy only — not a kernel sandbox. Agent cannot be forced OS-readonly. |
| `workspace` + network on (default) | `permission: "allow"` or `*` allow; keep `external_directory` **deny** (or omit — default ask, but headless needs no ask → set `external_directory: "deny"`) | Worktree writes allowed; outside cwd denied at policy layer. Grant `external_directory` allow for `gitDir` / `gitCommonDir` if git objects live outside cwd (**same worktree gitdir problem as Codex**). |
| `workspace` + network off | Above + `webfetch: "deny"`, `websearch: "deny"` | **Incomplete isolation:** `bash` can still curl. No `restrict_network` equivalent found. |
| `full` | `permission: "allow"` including `external_directory: "allow"` | Full agent freedom; still no OS sandbox. |

**UNKNOWN / risk:** whether MCP tool calls from server `parley` need explicit permission keys (`parley_*` or similar) when using non-`allow` maps. With global `"allow"` they should work.

**No** equivalent of Codex `sandbox_workspace_write.network_access` or Grok `restrict_network`. Document as **capability gap**.

---

## 6. Model & effort flags; auth env vars

### Model selection

| Mechanism | Format | Evidence |
| --- | --- | --- |
| `-m` / `--model` | `provider/model` e.g. `opencode/deepseek-v4-flash-free`, `anthropic/claude-sonnet-4-5` | DOCS + VERIFIED |
| Config `model` | Same string | DOCS |
| Priority | CLI flag > config > last used > internal default | DOCS [models](https://opencode.ai/docs/models/) |

### Effort / variants

| Mechanism | Notes | Evidence |
| --- | --- | --- |
| `--variant <name>` | “Model variant (provider-specific reasoning effort, e.g., high, max, minimal)” | VERIFIED help text |
| Config `provider.<id>.models.<id>.variants` | Built-ins for Anthropic (`high`/`max`), OpenAI (`none`…`xhigh`), Google (`low`/`high`) | DOCS |
| Config `options.reasoningEffort` etc. | Per-model provider options | DOCS |

Parley should pass `task.effort` through as `--variant <effort>` when non-null (opaque string), matching Codex/Grok pass-through posture.

### Auth

| Source | Notes | Evidence |
| --- | --- | --- |
| `~/.local/share/opencode/auth.json` | Written by `opencode auth login` / `/connect` | DOCS; VERIFIED `auth list` path |
| **`OPENCODE_API_KEY`** | Used for OpenCode Zen/Go HTTP API | VERIFIED: invalid key → JSONL `Invalid API key.` against `opencode.ai/zen/v1` |
| **`OPENCODE_AUTH_CONTENT`** | Inline auth JSON blob (binary string present) | VERIFIED: invalid content → same auth error; exact schema **partially UNKNOWN** |
| Provider envs | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY` / `GOOGLE_APPLICATION_CREDENTIALS`, AWS Bedrock vars, etc. | DOCS [providers](https://opencode.ai/docs/providers/); binary string table |
| Project `.env` | Loaded on startup | DOCS |
| Config `{env:VAR}` substitution | In `opencode.json` | DOCS |

For headless Parley children, prefer:

1. Orchestrator’s existing `auth.json` (shared user install), **or**
2. Pass `OPENCODE_API_KEY` / provider keys in `SpawnPlan.env`, **or**
3. Isolated `XDG_DATA_HOME` + provisioned `auth.json` / `OPENCODE_AUTH_CONTENT`.

`opencode auth list` shows configured providers (VERIFIED).

---

## 7. Model enumeration

```bash
opencode models                 # all configured providers: one id per line, provider/model
opencode models <provider>      # filter by provider id
opencode models --verbose       # after each id, a JSON object with metadata
opencode models --refresh       # refresh models.dev cache
```

**Plain output** (VERIFIED 1.18.2 excerpt):

```
opencode/big-pickle
opencode/deepseek-v4-flash-free
opencode/hy3-free
…
github-copilot/claude-sonnet-4.5
github-copilot/gpt-5.4
local/qwen3.6-35b-a3b
```

**Verbose** (VERIFIED structure):

```
opencode/deepseek-v4-flash-free
{
  "id": "deepseek-v4-flash-free",
  "providerID": "opencode",
  "name": "DeepSeek V4 Flash Free",
  "family": "deepseek-flash-free",
  "api": { "id": "…", "url": "https://opencode.ai/zen/v1", "npm": "@ai-sdk/openai-compatible" },
  "status": "active",
  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },
  "limit": { "context": 200000, "output": 128000 },
  "capabilities": { "temperature": true, … }
}
```

**Adapter `listModels` notes:**

- Parse plain lines as model ids (`provider/model`), **or** parse interleaved verbose JSON.
- Per-model **variant/effort lists are not in the plain listing**; may appear under verbose/capabilities or only in docs/config — treat efforts as hand-patched or empty like Grok unless verbose exposes them (confirm at implement time).
- Catalog depends on which providers are authenticated; unauthenticated hosts still list many Zen free/public models (VERIFIED with isolated HOME still listing opencode/*).

Probe source string for catalog: `opencode models`.

---

## 8. Token usage

### Where it appears

Primary live stream location: **`step_finish`** events → `part.tokens` and `part.cost`.

| Field | Meaning | Evidence |
| --- | --- | --- |
| `part.tokens.input` | Input tokens for the step | VERIFIED |
| `part.tokens.output` | Output tokens | VERIFIED |
| `part.tokens.reasoning` | Reasoning tokens | VERIFIED |
| `part.tokens.cache.read` | Cache read | VERIFIED |
| `part.tokens.cache.write` | Cache write | VERIFIED |
| `part.tokens.total` | Step total (observed) | VERIFIED |
| `part.cost` | USD cost for step (number) | VERIFIED |
| `part.reason` | `stop` (final) or `tool-calls` (mid-turn) | VERIFIED |

**Worked example** (VERIFIED):

```json
{
  "type": "step_finish",
  "timestamp": 1784189542831,
  "sessionID": "ses_096042ed7ffegkkH3BpVm5C5CH",
  "part": {
    "type": "step-finish",
    "reason": "stop",
    "tokens": {
      "total": 8084,
      "input": 8069,
      "output": 3,
      "reasoning": 12,
      "cache": { "write": 0, "read": 0 }
    },
    "cost": 0
  }
}
```

Multi-step runs emit **multiple** `step_finish` rows; adapter should **sum** `input`/`output`/`reasoning`/`cache.*` across steps (and optionally sum `cost`) for task-level usage.

Also available post-hoc:

- `opencode export <sessionID>` → `info.tokens` session aggregate + per-message `tokens` (VERIFIED).
- `opencode stats` — human stats CLI (DOCS).

`error` events do not include usage (VERIFIED).

---

## 9. Adapter recommendation

### Proposed `prepare(task, hub)` → `SpawnPlan`

**argv:**

```text
opencode run
  --format json
  --auto
  --dir <task.cwd>          # or rely on SpawnPlan.cwd and omit --dir
  [-m <task.model>]         # if non-null
  [--variant <task.effort>] # if non-null
  [--title <task.name>]     # optional
  -- <task.prompt>          # or single positional; avoid option injection
```

Prefer `SpawnPlan.cwd = task.cwd` **and** `--dir` for clarity (belt-and-braces).

**env (spread over process env carefully):**

| Key | Value |
| --- | --- |
| `OPENCODE_CONFIG_CONTENT` | JSON string (see below) |
| `OPENCODE_DISABLE_AUTOUPDATE` | `1` / `true` — pin behavior (DOCS) |
| `OPENCODE_DISABLE_CLAUDE_CODE` | `1` — prevent `~/.claude` bleed (DOCS; optional but recommended) |
| `OPENCODE_API_KEY` | passthrough if orchestrator has it |
| Provider keys | passthrough `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, … as present |
| Optional isolation | `XDG_DATA_HOME` / `XDG_CONFIG_HOME` under task-private dir if hermetic sessions desired |

**`OPENCODE_CONFIG_CONTENT` skeleton:**

```json
{
  "autoupdate": false,
  "permission": {
    "*": "allow",
    "external_directory": {
      "*": "deny",
      "<gitDir>/**": "allow",
      "<gitCommonDir>/**": "allow"
    },
    "webfetch": "<allow|deny per network>",
    "websearch": "<allow|deny per network>"
  },
  "mcp": {
    "parley": {
      "type": "remote",
      "url": "<hub.url>",
      "enabled": true,
      "oauth": false,
      "timeout": <answerTimeoutMs + headroom>,
      "headers": { "<from hub.headers>": "…" }
    }
  }
}
```

For `read-only`, replace blanket allow with denies on `edit`/`bash` (and any write tools). For `full`, set `external_directory: "allow"`.

**files:** empty if using `OPENCODE_CONFIG_CONTENT` only; **or** materialize `opencode.json` (same JSON) like Grok’s `.grok/config.toml` if env size limits bite.

**Do not** mutate the user’s global `~/.config/opencode/opencode.json`.

### Proposed `resume(task, hub)`

Same as `prepare`, plus:

```text
-s <task.sessionId>
```

Re-inject the same MCP/permission config (session resume does not magically re-apply cwd files if config was only env — re-set env every spawn).

### Event-parse table → `VendorEvent`

| OpenCode `type` | Condition | `VendorEvent` |
| --- | --- | --- |
| any with `sessionID` | first seen | contribute to `session_meta` / `sessionId()` |
| `text` | always | `{ kind: "message", text: part.text }` |
| `tool_use` | `part.tool` ∈ {`bash`, …} | `{ kind: "command", text: part.state.input.command or title }` |
| `tool_use` | `part.tool` ∈ {`write`,`edit`,`patch`} | `{ kind: "file_change", text: filepath }` |
| `tool_use` | other / MCP | optional `command` with `tool` name; or `[]` opaque |
| `step_finish` | always | attach `usage` from `part.tokens` (+ cost); no separate kind required — fold into last message or engine usage accumulator |
| `step_finish` | `reason == "stop"` | optional session completion signal (not a VendorEvent kind) |
| `error` | always | `{ kind: "error", fatal: true, text: error.data.message \|\| error.name }` |
| `step_start` | — | `[]` (ignore) |
| unknown | — | `[]` (raw JSONL is durable record) |

`sessionId(events)`: first `session_id` / from first parse that saw `sessionID`.

Usage aggregation: sum numeric fields across all `step_finish` events:

```ts
usage = {
  input: sum(tokens.input),
  output: sum(tokens.output),
  reasoning: sum(tokens.reasoning),
  cache_read: sum(tokens.cache?.read),
  cache_write: sum(tokens.cache?.write),
  total: sum(tokens.total),
  cost: sum(part.cost), // optional extra key
}
```

### Top risks / unknowns

1. **Exit code always 0 on LLM failures** — must parse `error` events (VERIFIED).
2. **No OS sandbox / no true network off** — policy-only; `bash` bypasses webfetch deny (structural gap vs Codex/Grok).
3. **MCP `timeout` default 5s** — almost certainly too low for `ask_orchestrator`; raise aggressively. Whether timeout applies to **tool execution** vs **tool discovery only** is **UNKNOWN** (docs vs schema wording conflict) — **load-bearing; smoke-test with a blocking MCP tool before shipping**.
4. **MCP tool name prefix** exact form for permission globs — **UNKNOWN** until hub connected.
5. **`OPENCODE_AUTH_CONTENT` schema** — works for invalid-key path; full document shape not fully reverse-engineered.
6. **Variant/effort enumeration** not in `opencode models` plain output — catalog efforts may stay hand-patched.
7. **Binary auto-update** — disable via config/env for reproducible CI (`autoupdate: false`, `OPENCODE_DISABLE_AUTOUPDATE`).
8. **Global auth reuse** — default install shares `auth.json` across all children; intentional for UX, leaky for multi-tenant isolation.
9. **`external_directory` for git dirs** — parley worktrees need gitdir + common-dir grants under workspace posture (same class of bug Codex hit).
10. **Repo/docs churn** — package moves quickly (1.16.2 user install vs 1.18.2 npm latest on research day); pin version in adapter comments and re-verify flags at implementation.
11. **Alternative integration**: `opencode serve` + HTTP/SDK or `opencode acp` — richer than spawn-per-turn, but more process lifecycle; spawn-per-turn `run --format json` matches existing Codex/Grok adapters and is sufficient.

### Closest viable integration shape

If any future release broke `run --format json`, fall back to:

1. `opencode serve --port <p>` long-lived per task or shared, then
2. HTTP `POST /session` + `POST /session/:id/message` and/or SSE `GET /event` (DOCS [server](https://opencode.ai/docs/server/)),

or ACP (`opencode acp`). Prefer **`run --format json`** as primary — verified working headless single-shot today.

---

## Sources

| Source | Role |
| --- | --- |
| Local binary `opencode` **1.18.2** (`opencode-ai` npm) | VERIFIED help, run, models, session, auth, debug config/paths, JSONL samples |
| [opencode.ai/docs/cli](https://opencode.ai/docs/cli/) | Commands, flags, env vars |
| [opencode.ai/docs/mcp-servers](https://opencode.ai/docs/mcp-servers/) | Remote MCP + headers |
| [opencode.ai/docs/config](https://opencode.ai/docs/config/) | Precedence, env injection |
| [opencode.ai/docs/permissions](https://opencode.ai/docs/permissions/) | allow/ask/deny, `--auto` |
| [opencode.ai/docs/models](https://opencode.ai/docs/models/) | Model ids, variants |
| [opencode.ai/docs/providers](https://opencode.ai/docs/providers/) | Auth methods |
| [opencode.ai/docs/server](https://opencode.ai/docs/server/) | HTTP alternative |
| [opencode.ai/config.json](https://opencode.ai/config.json) | Schema (`McpRemoteConfig.timeout`, permissions) |
| [github.com/anomalyco/opencode](https://github.com/anomalyco/opencode) | Upstream |

Research date: **2026-07-16**. Pin adapter comments to **1.18.2** and re-verify at implement time.
