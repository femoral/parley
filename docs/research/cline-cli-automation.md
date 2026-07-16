# Cline CLI — automation surface for Parley

Research asset for writing a Parley vendor adapter for the Cline agent CLI
([issue #96](https://github.com/femoral/parley/issues/96)). Verified against a
local install of **`cline@3.0.42`** on 2026-07-16 (linux x64 native binary from
`@cline/cli-linux-x64@3.0.42`). Primary sources: npm package, `cline --help`,
live headless runs (auth failures — error shapes are evidence),
`@cline/core` / `@cline/shared` type declarations shipped with the package, and
official docs at [docs.cline.bot](https://docs.cline.bot).

Re-verify flags and the NDJSON schema against the version you ship with before
implementing. Docs still describe an older `{"type":"say"|"ask"}` JSON shape in
places; **3.0.42 emits a different event envelope** (VERIFIED).

## TL;DR for Parley

Cline **is** a standalone headless CLI (not extension-only). One-shot automation
works today:

| Need | Cline answer (3.0.42) | Quality |
|------|------------------------|---------|
| One-shot headless | `cline --json --auto-approve true -c <cwd> "<prompt>"` | Strong |
| Streaming JSON events | NDJSON on stdout (`hook_event` / `agent_event` / `run_result`); fatal line also on stderr | Strong (schema drifts vs docs) |
| MCP HTTP + custom headers | Materialize `cline_mcp_settings.json` under isolated `--data-dir`, or `CLINE_MCP_SETTINGS_PATH`, or `cline mcp install --yes` | Strong |
| Session resume | `--id <session-id>` in help; **headless JSON resume failed** in verification | Weak / blocked for stream-only design |
| Sandbox / approvals | No codex-style FS sandbox; `--auto-approve true` (default) + optional `CLINE_COMMAND_PERMISSIONS` + `.clineignore` | Partial |
| Model / effort | `-m` / `-P` / `--thinking` | Strong |
| Auth via env | `ANTHROPIC_API_KEY`, `CLINE_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, …; or `-k` | Strong |
| Model enumeration CLI | **None** (`cline models` is treated as a prompt) | Weak |
| Token usage | `run_result.usage` / `aggregateUsage` (+ mid-run `agent_event` `usage` in types) | Strong for terminal totals |

Recommended default: **files-heavy adapter** (Grok-like). Per task:

1. Allocate a private `--data-dir` (session store + MCP settings + providers).
2. Materialize MCP hub config into `<data-dir>/settings/cline_mcp_settings.json`.
3. Spawn `cline --json --data-dir … --auto-approve true -c <worktree> … "<prompt>"`.
4. Capture session id from the data-dir session manifest on disk (not from the
   JSONL stream — see §4).
5. Treat process exit codes as **unreliable** (auth failures exited 0); parse
   `run_result` / `agent_event` `error` instead.

---

## 1. Identity & install

| Field | Value | Evidence |
|-------|-------|----------|
| Product | Cline — coding agent (IDE extension + CLI + SDK + Kanban) | DOCS [overview](https://docs.cline.bot/cline-overview), [cline.bot/cli](https://cline.bot/cli) |
| Official CLI package | **`cline`** on npm | VERIFIED `npm view cline` → `3.0.42`; DOCS `npm install -g cline` |
| Experimental package | `@cline/cli@0.0.13`, binary **`clite`** — lightweight SDK-based CLI | VERIFIED `npm view @cline/cli`; **not** the production path |
| Binary | `cline` (wrapper → platform package binary) | VERIFIED |
| Platform binary (this host) | `@cline/cli-linux-x64@3.0.42` → ~118 MB native (Bun-packed) | VERIFIED |
| Verified version | **3.0.42** | VERIFIED `cline --version` / `cline -V` / `cline version` |
| Install (global) | `npm install -g cline` | DOCS [installing](https://docs.cline.bot/getting-started/installing-cline), [apps/cli README](https://github.com/cline/cline/blob/main/apps/cli/README.md) |
| Install (local / pin) | `npm install cline@3.0.42` then `node_modules/.bin/cline` | VERIFIED |
| Nightly | `npm install -g cline@nightly` | DOCS README |
| Default state dir | `~/.cline` (`--data-dir` / `CLINE_DATA_DIR` override) | VERIFIED help + DOCS [config](https://docs.cline.bot/getting-started/config) |
| Repo | [github.com/cline/cline](https://github.com/cline/cline) (`apps/cli/`) | DOCS |

**Standalone headless CLI: yes.** Confirmed by package description, README
“Headless mode for CI/CD”, docs CLI overview, and live `--json` runs without an
editor (VERIFIED). The VS Code extension remains a separate surface sharing the
agent core; Parley should target the **`cline` npm binary**, not the extension.

Do **not** use `@cline/cli` / `clite` for the adapter unless a later research
pass re-validates it — it is marked experimental and is a different binary.

---

## 2. Headless invocation

### Preferred Parley argv (one-shot)

```bash
cline \
  --json \
  --auto-approve true \
  --data-dir <task-private-dir> \
  -c <worktree> \
  -P <provider> \
  -m <model-id> \
  --thinking <none|low|medium|high|xhigh> \   # optional effort
  -k <api-key> \                               # optional; prefer env
  "<prompt>"
```

| Flag / behavior | Role | Evidence |
|-----------------|------|----------|
| positional `prompt` | One-shot task text; default act mode | VERIFIED help |
| `--json` | NDJSON messages on stdout; non-interactive | VERIFIED help + live run |
| `--auto-approve <bool>` | Tool auto-approval (default **true**) | VERIFIED help |
| `-c / --cwd <path>` | Working directory for tools | VERIFIED help |
| `--data-dir <path>` | Isolated local state (sessions, settings, logs); “sandbox mode” in docs | VERIFIED help; DOCS [CLI reference](https://docs.cline.bot/cli/cli-reference) |
| `-P / --provider` | Provider id (default `cline`) | VERIFIED help |
| `-m / --model` | Model id for selected provider | VERIFIED help |
| `-k / --key` | Per-run API key override (takes precedence over env) | VERIFIED help + live `-k` wrote `providers.json` |
| `--thinking [level]` | Reasoning effort when supported | VERIFIED help |
| `-p / --plan` | Plan mode instead of act | VERIFIED help |
| `-t / --timeout <seconds>` | Run timeout (`0` = none) | VERIFIED help |
| `--retries [n]` | Max consecutive mistakes before halt (default **6** in 3.0.42 help) | VERIFIED help (docs sometimes say 3 — trust binary) |
| Headless triggers | `--json`, piped stdin, or redirected stdout | DOCS [CLI overview](https://docs.cline.bot/usage/cli-overview) |

Also accepted but **not listed** in `cline --help` for 3.0.42: `--yolo` / `-y`
still run a prompt path (VERIFIED live). Prefer the documented
`--auto-approve true` for adapters; treat `--yolo` as undocumented legacy from
README/blog posts ([CLI 2.0 post](https://cline.ghost.io/introducing-cline-cli-2-0/)).

### Streaming JSON format (3.0.42 — VERIFIED)

Each stdout line is one JSON object. Observed top-level `type` values:

| `type` | Role |
|--------|------|
| `hook_event` | Lifecycle hooks (`hookEventName`: `agent_start`, `agent_error`, …) with `agentId`, `taskId`, `parentAgentId` |
| `agent_event` | Nested agent stream: `{ "event": { "type": "…", … } }` |
| `run_result` | Terminal summary: `finishReason`, `usage`, `aggregateUsage`, `text`, `model`, `durationMs`, `iterations` |
| `error` | Also emitted on **stderr** as `{"type":"error","message":"…"}` |

Nested `agent_event.event.type` values (from `@cline/shared` types + observed
errors) include: `iteration_start`, `iteration_end`, `content_start`,
`content_update`, `content_end`, `usage`, `notice`, `done`, `error`.

**Worked example — unauthenticated default provider (VERIFIED 3.0.42):**

```bash
cline --data-dir /tmp/cline-data --json --auto-approve true \
  -c /tmp/cwd "say hello and exit"
```

Stdout (abridged, real lines):

```json
{"ts":"2026-07-16T08:13:03.966Z","type":"hook_event","hookEventName":"agent_start","agentId":"agent_1784189583943_d23j2v","taskId":"conv_1784189583958_5p0jqwi","parentAgentId":null}
{"ts":"2026-07-16T08:13:03.968Z","type":"agent_event","event":{"type":"iteration_start","iteration":1}}
{"ts":"2026-07-16T08:13:04.240Z","type":"hook_event","hookEventName":"agent_error","agentId":"agent_1784189583943_d23j2v","taskId":"conv_1784189583958_5p0jqwi","parentAgentId":null}
{"ts":"2026-07-16T08:13:04.241Z","type":"agent_event","event":{"type":"error","error":{"name":"Error","message":"Unauthorized: Please make sure you're using the latest version of Cline and re-authenticate your Cline account.","stack":"Error: …"},"recoverable":false,"iteration":1}}
{"ts":"2026-07-16T08:13:04.254Z","type":"run_result","finishReason":"error","iterations":1,"usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"totalCost":0},"aggregateUsage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"totalCost":0},"durationMs":281,"text":"Unauthorized: …","model":{"id":"kwaipilot/kat-coder-air-v2.5","provider":"cline","info":{…}}}
```

Stderr:

```json
{"ts":"2026-07-16T08:13:04.255Z","type":"error","message":"Unauthorized: Please make sure you're using the latest version of Cline and re-authenticate your Cline account."}
```

**Process exit code was `0`** on that auth failure (VERIFIED). Session manifest
on disk recorded `"exit_code": 1`, `"status": "failed"`. **Adapters must not
trust process exit alone** — parse `run_result.finishReason` /
`agent_event` errors / stderr `type:error`.

### Docs drift (important)

Official CLI docs still document:

```json
{"type":"say","text":"…","ts":1760501486669,"say":"text"}
```

([CLI overview](https://docs.cline.bot/usage/cli-overview), [CLI reference](https://docs.cline.bot/cli/cli-reference)).
CI samples still filter `.type == "agent_event" and .event.type == "done"`
([GitHub Issue RCA sample](https://docs.cline.bot/cli/samples/github-issue-rca)).
Both can appear in literature; **pin parsers to the 3.0.42 envelope above** and
keep the raw JSONL log as the durable record (Parley adapter contract).

### AGENTS.md / project instructions

On a run from a repo with `AGENTS.md`, the model request’s system prompt
included a “Workspace AGENTS.md” section with that file’s contents (VERIFIED in
provider error payload). Project skills under `.agents` / Cline skills discovery
also appeared in tool metadata. Parley worktree `AGENTS.md` will reach the
child without extra flags (VERIFIED for this host layout).

---

## 3. MCP injection

### Transports & headers (HTTP)

Cline MCP settings support:

| Transport | Config shape | Headers |
|-----------|--------------|---------|
| stdio | `transport.type: "stdio"`, `command`, `args`, `cwd?`, `env?` | n/a |
| Streamable HTTP | `transport.type: "streamableHttp"`, `url`, `headers?` | **yes** `Record<string,string>` |
| SSE (legacy) | `transport.type: "sse"`, `url`, `headers?` | **yes** |

Evidence: VERIFIED noninteractive install JSON; DOCS
[MCP overview](https://docs.cline.bot/mcp/mcp-overview); types in
`@cline/core` `McpStreamableHttpTransportConfig`.

**Canonical settings file name:** `cline_mcp_settings.json` with root key
`mcpServers` (VERIFIED write path + `@cline/shared` `CLINE_MCP_SETTINGS_FILE_NAME`).

Example (Parley hub):

```json
{
  "mcpServers": {
    "parley": {
      "transport": {
        "type": "streamableHttp",
        "url": "http://127.0.0.1:<port>/mcp",
        "headers": {
          "X-Parley-Task": "<task-id>",
          "Authorization": "Bearer <…>"
        }
      }
    }
  }
}
```

### Injection routes (ranked for Parley)

1. **Materialize into isolated data-dir (recommended)**  
   Write  
   `<data-dir>/settings/cline_mcp_settings.json`  
   and pass `--data-dir <data-dir>`.  
   VERIFIED: a server named `from-data-dir` was loaded (log:
   `[mcp] Failed to load tools from MCP server "from-data-dir", skipping: Unable to connect…` —
   connection failed as expected for a dummy URL, but **registration happened**).

2. **`CLINE_MCP_SETTINGS_PATH=/abs/path/to/cline_mcp_settings.json`**  
   VERIFIED: env path server `from-env-path` was loaded the same way.

3. **`cline mcp install|add --yes`** (noninteractive)  
   ```bash
   cline mcp install parley \
     --transport streamableHttp \
     "http://127.0.0.1:<port>/mcp" \
     --header "X-Parley-Task: <task-id>" \
     --header "Authorization: Bearer …" \
     --yes --json
   ```  
   VERIFIED: exit 0, stdout  
   `{"name":"parley","status":"installed","transport":{"type":"streamableHttp","url":"…","headers":{…}},"warnings":[]}`.  
   Without `--data-dir`/`--config` isolation this writes under the process home
   (`~/.cline/data/settings/…`). Prefer materializing the file yourself so the
   adapter does not mutate the user’s global MCP config.

4. **`--config <dir>`** — configuration directory (default
   `~/.cline/data/settings`). Path nesting when combined with `--data-dir` is
   easy to get wrong (VERIFIED odd `…/settings/data/settings/…` write when
   mis-set). Prefer `--data-dir` + explicit
   `<data-dir>/settings/cline_mcp_settings.json`.

### Project `.cline/mcp.json`

DOCS / CLI reference list `.cline/mcp.json` under the project root as an MCP
config location. A live run with only project `.cline/mcp.json` present did
**not** log a load attempt for that server name, while the data-dir settings
file **did** (VERIFIED). Treat project `.cline/mcp.json` as **UNKNOWN / unreliable
for 3.0.42 headless** until re-proven; do not rely on it for Parley injection.

### No per-invocation MCP CLI flags on the prompt command

There is no `-c mcp…` style override on `cline "<prompt>"` (VERIFIED help).
Injection is **file- or install-command-based**.

### MCP tool timeout (ask_orchestrator)

`CreateMcpToolsOptions.timeoutMs` exists in `@cline/core` types (DOCS/types).
Whether `timeoutMs` (or similar) is honored inside `cline_mcp_settings.json`
per server is **UNKNOWN** — not observed in install output shape. Adapter
authors should:

- Prefer raising any documented request timeout once confirmed, **or**
- Rely on Cline’s default if it is already long enough for
  `task.answerTimeoutMs` (codex’s 60s trap may not apply; do not assume).

Mark tool-timeout raise as a **implementation-time verification** item.

---

## 4. Session resume

### Session id on disk (VERIFIED)

Each run creates:

```text
<data-dir>/sessions/<session_id>/<session_id>.json
```

Manifest fields include `session_id`, `status`, `exit_code`, `provider`,
`model`, `cwd`, `prompt`, `messages_path`, usage under `metadata`.

Example id shape: `1784189583906_bj2xq` (timestamp-ish + short suffix).

Messages sibling: `<session_id>.messages.json` with `sessionId` camelCase.

### Session id in the JSONL stream

**Not observed** on stdout for failed or short runs (VERIFIED multiple runs).
`hook_event` carries `agentId` and `taskId` (`conv_…`) which are **different**
from the resume session id. Telemetry log lines include
`"sessionId":"1784…"` / `"ulid":"1784…"` under `<data-dir>/logs/cline.log`, but
that is not the automation stream.

**Adapter session capture options:**

| Method | Notes |
|--------|-------|
| Read newest `<data-dir>/sessions/*/*.json` after spawn / on first events | Reliable if data-dir is task-private (recommended) |
| Parse `cline.log` `session.started` | Brittle; log is side-channel |
| Expect `session_id` on NDJSON | **Not available** in verified 3.0.42 stream |

### Resume argv

Help documents:

```text
--id <session-id>   Resume an existing session by ID
```

(VERIFIED `cline --help`).

**Headless resume attempts failed (VERIFIED 3.0.42):**

```bash
cline --data-dir <dir> --json --id <session_id> "follow up"
# → {"type":"error","message":"JSON output mode requires a prompt argument or piped stdin (interactive mode is unsupported)"}
# exit 0
```

Also failed with stdin piped and with `--id=<sid>`. Without `--json`, non-TTY
errors with `interactive mode requires a TTY`. So **spawn-per-turn resume via
`--id` is currently blocked for headless JSON automation** on this version.

**Closest viable shapes if resume is required:**

1. Re-open the same `--data-dir` and re-test `--id` on a newer Cline (or with
   TTY/PTY) — UNKNOWN fix.
2. Use hub/ACP surfaces (`--acp`, `cline hub`) — different process model;
   not fully mapped here.
3. Degrade: no vendor resume; Parley restarts with a fresh session and embeds
   prior context in the prompt (lossy).

`cline history --json` returned `[]` for isolated data-dirs that clearly
contained sessions (VERIFIED) — do not depend on history listing for capture.

---

## 5. Sandbox & approvals

Cline does **not** expose codex-style
`read-only | workspace-write | danger-full-access` sandbox flags.

| Parley posture | Cline mapping (best effort) | Evidence |
|----------------|-----------------------------|----------|
| Approvals off (headless) | `--auto-approve true` (default already true) | VERIFIED help; DOCS overview |
| Approvals on (interactive) | `--auto-approve false` — non-TTY denies tool calls that need approval | DOCS [apps/cli README](https://github.com/cline/cline/blob/main/apps/cli/README.md) |
| `sandbox: workspace` | No true FS sandbox; rely on worktree cwd + agent tools. Optional `CLINE_COMMAND_PERMISSIONS` allow/deny globs for shell | DOCS CLI reference |
| `sandbox: read-only` | **No hard read-only mode.** Approximate with prompt/rules + deny-heavy `CLINE_COMMAND_PERMISSIONS` + `.clineignore`; agent can still have edit tools unless further constrained (UNKNOWN fine-grained tool disable via CLI) | DOCS [.clineignore](https://docs.cline.bot/customization/clineignore), command permissions |
| `sandbox: full` | Default unconstrained tools with auto-approve | VERIFIED tool list in API errors includes write/run/MCP/team tools |
| `network: false` | **No first-class network toggle.** Unknown whether command permissions alone can block network; not equivalent to codex `network_access` | UNKNOWN |
| State isolation | `--data-dir <path>` or `CLINE_DATA_DIR` / `CLINE_SANDBOX=1` (+ `CLINE_SANDBOX_DATA_DIR`) — isolates **Cline’s own state**, not OS-level FS | VERIFIED help; DOCS config |

`CLINE_COMMAND_PERMISSIONS` example (DOCS):

```bash
export CLINE_COMMAND_PERMISSIONS='{"allow":["npm *","git *"],"deny":["rm -rf *","sudo *"],"allowRedirects":false}'
```

YOLO mode in product docs is an IDE “approve everything” concept
([auto-approve](https://docs.cline.bot/features/auto-approve)); CLI equivalent
for automation is **`--auto-approve true`** (and historically `--yolo`).

**Implication:** Parley’s ADR-0006 matrix cannot be enforced as tightly as with
Codex/Grok bubblewrap profiles. Prefer running children inside Parley worktrees
and treating Cline as **trust-the-agent + auto-approve**, with optional shell
allowlists.

---

## 6. Model & effort flags; auth env vars

### Model / provider / effort

| Mechanism | Flag / env | Notes | Evidence |
|-----------|------------|-------|----------|
| Model | `-m / --model <id>` | Opaque string; provider-specific | VERIFIED |
| Provider | `-P / --provider <id>` | Default `cline` | VERIFIED |
| Effort / thinking | `--thinking [none\|low\|medium\|high\|xhigh]` | Bare `--thinking` ⇒ medium; omit ⇒ provider default | VERIFIED help |
| Reasoning ratios | SDK `REASONING_EFFORT_RATIOS` includes `minimal` as well | Types only; CLI enum is the help list | `@cline/shared` types |
| API key override | `-k / --key` | Wins over env; may persist into data-dir `providers.json` | VERIFIED |
| System prompt | `-s / --system` | Full override | VERIFIED help |
| Env model/provider | `CLINE_MODEL`, `CLINE_PROVIDER` present in binary strings | **Not fully verified** as sole selectors without flags | strings scan |

Default unauthenticated model observed: provider `cline`, model
`kwaipilot/kat-coder-air-v2.5` (VERIFIED `run_result.model`).

### Auth (headless)

| Mechanism | Notes | Evidence |
|-----------|-------|----------|
| `ANTHROPIC_API_KEY` | Used with `-P anthropic` without `-k`; key not necessarily written to `providers.json` | VERIFIED (API returned `invalid x-api-key`) |
| `CLINE_API_KEY` | Read for default `cline` provider; fake key produced provider re-auth error (not “missing key”) | VERIFIED |
| `OPENAI_API_KEY` | Documented for OpenAI-family providers | DOCS apps/cli README |
| `OPENROUTER_API_KEY` | Documented for `-P openrouter` | DOCS apps/cli README |
| `AI_GATEWAY_API_KEY`, `V0_API_KEY`, … | Documented / present in binary | DOCS / strings |
| `cline auth --provider <id> --apikey <k> --modelid <m> --data-dir <dir>` | Noninteractive seed into isolated data-dir | VERIFIED help; DOCS README |
| OAuth (`cline auth cline`, ChatGPT, …) | Interactive / browser; fails fast headless if credentials missing | DOCS README |

`-k` takes precedence over environment variables (DOCS README). Prefer env
passthrough in `SpawnPlan.env` so keys are not copied into worktree files;
note that `-k` **did** persist `apiKey` into
`<data-dir>/settings/providers.json` (VERIFIED) — isolate data-dir or avoid `-k`
if that is undesirable.

---

## 7. Model enumeration

**No CLI probe command** for listing models in 3.0.42:

- `cline models` / `cline model` / `cline dev` are **not** subcommands; they fall
  through to the prompt path (VERIFIED `--help` routing and top-level command
  list).
- `cline config --json` requires a TTY in this build when interactive
  (VERIFIED error).

| Approach | Feasibility | Evidence |
|----------|-------------|----------|
| `listModels` shell-out like `codex debug models` | **Unavailable** | VERIFIED |
| Hand-maintained catalog + opaque `--model` pass-through | Recommended | Matches Parley `#29` advisory catalog design |
| Cline HTTP API model catalog | Possible for `cline` provider billing path | DOCS [API models](https://docs.cline.bot/api/models) (ids like `provider/model-name`) |
| `@cline/llms` `getModelsForProvider` / `getAllProviders` | SDK-level only; not a stable CLI | Package types |

Adapter `listModels?` should either be omitted or implement a best-effort HTTP
fetch against the configured provider — **do not** invent a `cline models`
command.

---

## 8. Token usage

### Where usage appears (3.0.42)

1. **Terminal `run_result` (VERIFIED)** — always present on the short auth-fail
   runs:

```json
{
  "type": "run_result",
  "finishReason": "error",
  "iterations": 1,
  "usage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0,
    "totalCost": 0
  },
  "aggregateUsage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0,
    "totalCost": 0
  },
  "durationMs": 281,
  "text": "…",
  "model": { "id": "…", "provider": "…", "info": { … } }
}
```

2. **Mid-run `agent_event` with `event.type === "usage"`** — defined in
   `@cline/shared` `AgentUsageEvent` with fields `inputTokens`, `outputTokens`,
   `cacheReadTokens?`, `cacheWriteTokens?`, `cost?`, plus totals
   `totalInputTokens`, `totalOutputTokens`, … (types). Not observed on
   auth-fail runs (no successful LLM turn). **Expect these on successful
   multi-iteration tasks** (UNKNOWN exact live line until a paid run is
   captured).

3. **Session manifest `metadata.usage` / `metadata.aggregateUsage`** — same
   field names (VERIFIED on disk).

4. **Legacy `tokensIn` / `tokensOut` fields** — reported removed from older CLI
   headless JSON ([issue #9539](https://github.com/cline/cline/issues/9539),
   versions ~1.0.10 → 2.2.1). Do not look for those names on 3.0.x.

### Worked mapping for Parley `VendorEvent.usage`

From `run_result`:

```ts
{
  kind: "session_meta",
  usage: {
    inputTokens: run_result.usage.inputTokens,
    outputTokens: run_result.usage.outputTokens,
    cacheReadTokens: run_result.usage.cacheReadTokens,
    cacheWriteTokens: run_result.usage.cacheWriteTokens,
    totalCost: run_result.usage.totalCost,
  }
}
```

Prefer `aggregateUsage` when both are present and you want the whole run.

---

## 9. Adapter recommendation

### Proposed `prepare()` → `SpawnPlan`

**argv**

```text
cline
  --json
  --auto-approve true
  --data-dir <taskDataDir>
  -c <task.cwd>
  [-P <provider>]          # if Parley models vendor as provider/model, split or pass through
  [-m <task.model>]
  [--thinking <task.effort>]
  <task.prompt>
```

Do **not** pass `--worktree` (Cline would create its own detached worktree under
`~/.cline/worktrees/`); Parley owns worktrees.

**env** (opaque passthrough of whatever the orchestrator has)

```text
ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / CLINE_API_KEY / …
# optional:
CLINE_MCP_SETTINGS_PATH=<taskDataDir>/settings/cline_mcp_settings.json  # if not using default under data-dir
CLINE_COMMAND_PERMISSIONS=…   # only if mapping network/shell posture
```

Avoid putting secrets in argv when env works; if using `-k`, expect persistence
into `<dataDir>/settings/providers.json`.

**files** (`SpawnPlan.files`, paths relative to cwd **or** write into
`taskDataDir` outside the worktree — prefer outside so git does not see them)

| Path | Contents |
|------|----------|
| Managed outside worktree: `<taskDataDir>/settings/cline_mcp_settings.json` | MCP hub HTTP + headers (see §3) |

If the daemon only materializes under `task.cwd`, use something gitignored like
`.cline-parley/…` and point `--data-dir` there — but then sessions live in the
worktree; better: daemon-private directory + `--data-dir` absolute path (argv
only; no `files` entry).

### Proposed `resume()`

```text
cline
  --json
  --auto-approve true
  --data-dir <same taskDataDir>
  -c <task.cwd>
  --id <task.sessionId>
  [-P …] [-m …] [--thinking …]
  <follow-up prompt>
```

**Status: VERIFIED broken on 3.0.42 for headless JSON** (§4). Ship resume only
after re-verification, or fall back to prepare-with-context. Reject loudly if
`sessionId` is missing (same pattern as grok adapter).

### Session id extraction

```text
primary:  after spawn, read <taskDataDir>/sessions/*/<id>.json → session_id
fallback: none in NDJSON (3.0.42)
```

Expose via adapter `sessionId(events)` only if you later find a stream field;
otherwise the engine may need a data-dir side channel (implementation detail
beyond this research doc — flag as adapter design risk).

### Event-parse table (`parseEvent` → `VendorEvent`)

| Raw line | → `VendorEvent` |
|----------|-----------------|
| non-JSON | `[]` (opaque) |
| `type: "hook_event"`, `hookEventName: "agent_start"` | `session_meta` (optional; no session_id) or `[]` |
| `type: "agent_event"`, `event.type: "content_start"\|"content_end"`, `contentType: "text"` | `message` (`text` / final `text`) |
| `type: "agent_event"`, `contentType: "tool"`, tool name looks like shell | `command` (`toolName` + input summary) |
| `type: "agent_event"`, tool name is file edit/write | `file_change` |
| `type: "agent_event"`, `event.type: "error"` | `error` (`event.error.message`); `fatal: !event.recoverable` |
| `type: "agent_event"`, `event.type: "usage"` | `session_meta` + `usage` map |
| `type: "agent_event"`, `event.type: "done"` | `message` from `event.text` optional; usage if present |
| `type: "run_result"` | `session_meta` + `usage` from `usage`/`aggregateUsage`; if `finishReason === "error"` also `error` with `text`, `fatal: true` |
| `type: "error"` (stdout or stderr) | `error`, `fatal: true` |
| `iteration_*`, `notice`, reasoning content | `[]` (raw log keeps them) |

### Top risks / unknowns

1. **`--id` headless resume broken** on 3.0.42 — blocks spawn-per-turn Q&A
   resume unless fixed upstream or a PTY/hub path is used.
2. **Session id not in NDJSON** — requires private `--data-dir` + filesystem
   scrape; races if multiple sessions share a data-dir.
3. **Exit code 0 on failure** — never use exit alone for task success.
4. **Docs JSON schema is stale** (`say`/`ask` vs `agent_event`/`run_result`).
5. **No FS sandbox / network switch** — weaker than codex/grok posture matrix.
6. **No `cline models`** — catalog is hand-maintained or provider-API based.
7. **MCP tool timeout for long `ask_orchestrator`** — confirm defaults before
   relying on blocking MCP tools.
8. **`--yolo` / help drift** — binary and README disagree; pin to `--help` of
   the installed version.
9. **Global MCP pollution** if install/auth runs without `--data-dir`.
10. **Rapid CLI versioning** (3.x line) — pin `cline@x.y.z` in the environment
    that runs Parley children.

### Closest viable integration shape

**Viable for Parley today:** headless one-shot `cline --json` with isolated
`--data-dir`, materialized streamable-HTTP MCP + headers, env auth, model/effort
flags, and usage from `run_result`.

**Not viable without more work:** codex-class session resume purely from the
event stream + `--id` flag on 3.0.42.

If resume is load-bearing for the product, either (a) re-verify `--id` on a
newer Cline before writing the adapter, or (b) design the Cline adapter as
prepare-only until upstream fixes headless resume.

---

## Verification log

| Check | Result |
|-------|--------|
| Install `cline@3.0.42` | OK (`@cline/cli-linux-x64` binary) |
| `cline --version` | `3.0.42` |
| `cline --help` | Captured (flags in §2/§6) |
| `cline --json` unauthenticated | NDJSON + stderr error; exit 0 |
| `cline --json -P anthropic -k sk-…` | `invalid x-api-key` in stream |
| `ANTHROPIC_API_KEY` / `CLINE_API_KEY` | Env accepted |
| MCP install `--yes` + headers | Installed JSON; settings file shape |
| MCP load from `--data-dir` settings | Log shows server registration attempt |
| MCP load via `CLINE_MCP_SETTINGS_PATH` | Same |
| Project `.cline/mcp.json` | Not observed loading |
| `--id` + `--json` resume | Failed (“requires a prompt…”) |
| Session manifest on disk | `session_id` present |
| `cline models` | Not a command |

Scratch install lived under `/tmp/parley-t242-cline-scratch` (not committed).
