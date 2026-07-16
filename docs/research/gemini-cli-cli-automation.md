# Gemini CLI — automation surface for Parley

Research asset for documenting Google's Gemini CLI so a Parley vendor adapter can be written without re-research. Verified against primary sources and a local install of **`@google/gemini-cli@0.50.0`** (binary `gemini`, `gemini --version` → `0.50.0`) on 2026-07-16. Repo: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli). Docs: [geminicli.com](https://geminicli.com/docs/).

**Evidence markers:** **VERIFIED** = ran against 0.50.0 in this worktree research (scratch install under `/tmp`, not committed). **DOCS** = official docs / bundled package docs / source strings. **UNKNOWN** = blocked without a valid API key, live multi-turn resume of a real session, or platform-specific sandbox (Docker/Seatbelt).

## TL;DR for Parley

Gemini CLI **can** do headless single-shot automation. Closest viable shape is spawn-per-turn, same family as Codex/Grok:

- **Spawn**: `gemini -p "<prompt>" --output-format stream-json --approval-mode=yolo --skip-trust -m <model>` with `GEMINI_API_KEY`.
- **Streaming**: JSONL on stdout (`init` → `message` → `tool_use`/`tool_result` → `result`). Session id is `init.session_id` (snake_case UUID).
- **MCP injection**: **no CLI flag**. Materialize project **`.gemini/settings.json`** with `mcpServers.parley` using **`httpUrl` + `headers` + `timeout` + `trust: true`**. Must also pass **`--skip-trust`** (or `GEMINI_CLI_TRUST_WORKSPACE=true`) or project MCP is disabled for untrusted folders.
- **Resume**: `gemini -r <session_id> -p "<follow-up>" …` (same output/approval/trust flags). Sessions are project-scoped under `~/.gemini/tmp/<project_hash>/chats/`.
- **Approvals**: `--approval-mode=yolo` (or `-y`) auto-approves tools; non-interactive mode already denies `ask_user`.
- **Main caveats**: exit codes are messy (API HTTP codes truncated to 8 bits); no `gemini models` list command; no first-class effort CLI flag; sandbox/network mapping is weaker than Codex; product banner mentions a transition to “Antigravity CLI” for some tiers (**DOCS** product risk).

---

## 1. Identity & install

| Field | Value | Evidence |
| --- | --- | --- |
| Product | Gemini CLI — open-source terminal coding agent (Google) | **DOCS** [github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) |
| npm package | `@google/gemini-cli` | **VERIFIED** `npm view` / `npm pack` → 0.50.0 |
| Binary | `gemini` | **VERIFIED** package.json `"bin": { "gemini": "bundle/gemini.js" }` |
| Engines | Node.js `>=20` | **VERIFIED** package.json |
| License | Apache-2.0 | **VERIFIED** package.json |
| Pinned version | **0.50.0** | **VERIFIED** `gemini --version` |

**Install (recommended pin for adapter work):**

```bash
npm install -g @google/gemini-cli@0.50.0
# or local scratch (do not commit):
npm install @google/gemini-cli@0.50.0 --prefix /tmp/gemini-cli-research
/tmp/gemini-cli-research/node_modules/.bin/gemini --version   # → 0.50.0
```

**DOCS** also document `npx @google/gemini-cli` and global install ([installation](https://geminicli.com/docs/get-started/installation)).

**Product note (DOCS):** official site banners state unpaid / Google One tiers may be transitioned to “Antigravity CLI.” The npm package and headless surface above still work as of 0.50.0; re-check identity before shipping a long-lived adapter.

---

## 2. Headless invocation

### One-shot argv

**VERIFIED** (0.50.0 `--help` + live runs):

```bash
gemini \
  -p "<prompt>" \
  --output-format stream-json \
  --approval-mode=yolo \
  --skip-trust \
  [-m <model>]
```

| Flag | Role |
| --- | --- |
| `-p` / `--prompt` | Forces non-interactive (headless) mode; prompt text (appended to stdin if any). |
| `-o` / `--output-format` | `text` \| `json` \| **`stream-json`** (JSONL events — Parley default). |
| `--approval-mode=yolo` | Auto-approve all tools (required for agentic headless; `-y` is deprecated alias). |
| `--skip-trust` | Trust workspace for this session so project `.gemini/settings.json` MCP loads. |
| `-m` / `--model` | Model id or alias (optional; default `auto`). |

**DOCS:** headless also triggers when stdin/stdout is non-TTY without `-p`, but Parley should always pass `-p` explicitly ([headless reference](https://geminicli.com/docs/cli/headless), [automation tutorial](https://geminicli.com/docs/cli/tutorials/automation)).

**Positional prompts** (`gemini "query"`) default to **interactive** mode — do not use for Parley.

**Working directory:** no `--cwd` flag in 0.50.0. Spawn with `cwd: task.cwd` (process working directory). **VERIFIED** `--help` has no cwd option.

### Streaming JSON (`stream-json`) event types

**DOCS** list: `init`, `message`, `tool_use`, `tool_result`, `error`, `result` ([headless.md](https://geminicli.com/docs/cli/headless)).  
**VERIFIED** enum in bundle source (`JsonStreamEventType`): same six types.

#### Real example lines (auth fail path — still valid schema)

Command (**VERIFIED** 0.50.0):

```bash
GEMINI_API_KEY=invalid-key-for-test \
  gemini -p "say hi only" --output-format stream-json \
  --approval-mode=yolo --skip-trust
```

Stdout JSONL (stderr had YOLO banners + stack traces; **parse stdout only**):

```json
{"type":"init","timestamp":"2026-07-16T08:11:55.484Z","session_id":"a559d264-82c8-48a4-85ec-0fbe645d82e0","model":"auto"}
{"type":"message","timestamp":"2026-07-16T08:11:55.485Z","role":"user","content":"say hi only"}
{"type":"result","timestamp":"2026-07-16T08:11:56.681Z","status":"error","error":{"type":"unknown","message":"[API Error: … API_KEY_INVALID …]"},"stats":{"total_tokens":0,"input_tokens":0,"output_tokens":0,"cached":0,"input":0,"duration_ms":0,"tool_calls":0,"models":{"gemini-3.1-flash-lite":{"total_tokens":0,"input_tokens":0,"output_tokens":0,"cached":0,"input":0},"gemini-3.1-pro-preview":{"total_tokens":0,"input_tokens":0,"output_tokens":0,"cached":0,"input":0}}}}
```

#### Event field shapes (source + live)

| `type` | Fields | Evidence |
| --- | --- | --- |
| `init` | `timestamp`, **`session_id`** (UUID string), `model` | **VERIFIED** live; emitted at start of non-interactive run |
| `message` | `timestamp`, `role` (`user` \| `assistant`), `content`, optional **`delta: true`** on assistant chunks | **VERIFIED** user line live; assistant `delta: true` from source emitters |
| `tool_use` | `timestamp`, `tool_name`, `tool_id`, `parameters` | **DOCS** + **VERIFIED** source (`emitEvent` with those keys) — not live-run without valid auth |
| `tool_result` | `timestamp`, `tool_id`, `status` (`success` \| `error`), optional `output`, optional `error: { type, message }` | **DOCS** + **VERIFIED** source |
| `error` | `timestamp`, `severity` (`warning` \| `error`), `message` | **DOCS** (non-fatal mid-stream); **VERIFIED** source. Distinct from terminal `result` with `status:"error"`. |
| `result` | `timestamp`, `status` (`success` \| `error`), optional `error`, **`stats`** | **VERIFIED** live error path; success path same shape without `error` (**VERIFIED** source) |

**Single-shot `json` format** (not recommended as Parley’s primary stream) returns one object with `session_id`, optional `response`/`stats`, or `error`. Missing-auth example (**VERIFIED**):

```json
{
  "session_id": "d6071ecd-3459-43ca-97ce-3ace88a2bd80",
  "error": {
    "type": "Error",
    "message": "Please set an Auth method in your … or specify one of the following environment variables …: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA",
    "code": 41
  }
}
```

### Exit codes

**DOCS** ([headless.md](https://geminicli.com/docs/cli/headless)): `0` success, `1` general/API failure, `42` input error, `53` turn limit.

**VERIFIED** 0.50.0 observations (do not rely on docs alone):

| Situation | Observed exit | Notes |
| --- | --- | --- |
| Missing auth (`json`) | **41** | Matches `error.code` in JSON body |
| Missing auth (`stream-json`) | **41** | No JSONL events emitted (fails before `init`) |
| Invalid `GEMINI_API_KEY` (`stream-json`) | **144** | API returned HTTP 400; Node `process.exit(400)` → `400 & 0xff = 144` |
| Invalid `--approval-mode` | **1** | yargs validation |
| Resume unknown session id | **42** | stderr: `Error resuming session: Invalid session identifier "…".` |

**Adapter implication:** treat **`result.status === "error"`** (and missing `result` after non-zero exit) as failure. Exit codes alone are unreliable for API failures.

### Stderr noise

**VERIFIED:** YOLO mode prints `YOLO mode is enabled…` (sometimes twice) to stderr; missing ripgrep warns; API stack traces go to stderr. Keep **stdout** as the durable JSONL record.

---

## 3. MCP injection

### Transport & headers

**DOCS** ([MCP servers](https://geminicli.com/docs/tools/mcp-server), bundled `docs/tools/mcp-server.md`, `docs/reference/configuration.md`):

| Transport | Config key | Notes |
| --- | --- | --- |
| Streamable HTTP | **`httpUrl`** | Prefer for Parley hub (daemon Streamable-HTTP). |
| SSE | `url` | Alternate remote transport. |
| stdio | `command` + optional `args`/`env`/`cwd` | Not needed for hub injection. |

Precedence if multiple present: **`httpUrl` > `url` > `command`**.

**Custom headers:** `headers` object on the server entry — **DOCS** explicitly support maps like `Authorization`, `X-Custom-Header`. **VERIFIED** project file is accepted by `gemini mcp list` when workspace is trusted.

**Timeout:** `timeout` number in **milliseconds**. **DOCS** default **600_000 ms (10 minutes)** per server. Raise above Parley’s `answerTimeoutMs` for blocking `ask_orchestrator` (same load-bearing gotcha as Codex).

**Trust:** `trust: true` bypasses per-tool confirmation for that MCP server. Still use `--approval-mode=yolo` for built-in tools.

**Server naming:** avoid underscores in server aliases (`parley` not `par_ley`). Tools are registered as FQNs `mcp_<server>_<tool>` (e.g. `mcp_parley_submit_report`). **DOCS** warn underscore aliases break policy parsing.

### Flags vs config vs env

| Mechanism | Usable for Parley? | Notes |
| --- | --- | --- |
| CLI flag for arbitrary MCP URL/headers | **No** | **VERIFIED** no per-run MCP inject flag in `--help`. |
| `gemini mcp add --transport http -H "…" -s project` | Possible but mutates files | Writes project/user settings; not ideal vs materializing once. |
| **Project `.gemini/settings.json`** | **Yes — recommended** | **DOCS** workspace settings override user; Parley owns worktree. |
| User `~/.gemini/settings.json` | Avoid | Bleeds across tasks; not hermetic. |
| Env only | Partial | `GEMINI_CLI_TRUST_WORKSPACE=true` for trust; no MCP URL via env. |

### Project-scoped config path

**DOCS** + **VERIFIED**:

- User: `~/.gemini/settings.json`
- **Project: `<cwd>/.gemini/settings.json`**

### Folder trust (load-bearing for MCP)

Without trust, project MCP is **disabled**:

```text
Warning: MCP servers are configured but disabled because this folder is untrusted.
… ○ parley: … (http) - Disabled
```

**VERIFIED** on fresh temp dir with only project settings.

Bypass for headless (**DOCS** [trusted folders — headless](https://geminicli.com/docs/cli/trusted-folders) + **VERIFIED**):

1. `--skip-trust` (sets `GEMINI_CLI_TRUST_WORKSPACE=true` internally — **VERIFIED** source), or  
2. `GEMINI_CLI_TRUST_WORKSPACE=true` env.

With trust, **VERIFIED**:

```text
Configured MCP servers:
✗ parley: http://127.0.0.1:9/mcp (http) - Disconnected
```

(`Disconnected` only because port 9 had no server — config **was** loaded.)

### Recommended materialized file

`SpawnPlan.files` → `.gemini/settings.json`:

```json
{
  "mcpServers": {
    "parley": {
      "httpUrl": "http://127.0.0.1:<daemon-port>/mcp",
      "headers": {
        "X-Parley-Task": "<task-id>",
        "<other correlation headers>": "…"
      },
      "timeout": 3600000,
      "trust": true
    }
  }
}
```

Set `timeout` to `answerTimeoutMs + headroom` (ms). Always pair with `--skip-trust` on argv.

**UNKNOWN / risk:** GitHub issue history includes reports of MCP not connecting in `-p` mode on some versions. On 0.50.0 with trust, headless emitted `MCP issues detected. Run /mcp list for status.` when the hub was down — evidence discovery **runs** in headless. Live tool-call success against a real hub was **not** verified (no daemon + valid model key in this research).

---

## 4. Session resume

### Session id emission

**VERIFIED:** first stream event is `init` with:

```json
{"type":"init","timestamp":"…","session_id":"<uuid>","model":"auto"}
```

Also present as `session_id` on `--output-format json` top-level objects (including error objects).

**DOCS** ([session management](https://geminicli.com/docs/cli/session-management)): sessions stored under `~/.gemini/tmp/<project_hash>/chats/`, **project-scoped** (cwd/project root hash). Retention defaults to 30 days (`general.sessionRetention`).

Optional: `--session-id <uuid>` forces the id of a **new** session (**VERIFIED** `init.session_id` matched the provided UUID).

### Resume argv

**VERIFIED** `--help` + docs:

```bash
gemini \
  -r <session_id> \
  -p "<follow-up prompt>" \
  --output-format stream-json \
  --approval-mode=yolo \
  --skip-trust \
  [-m <model>]
```

Aliases: `-r` / `--resume`. Also accepts `"latest"` or list index (**DOCS**); for Parley prefer the UUID from `init.session_id`.

**Listing / delete (ops, not adapter-critical):**

```bash
gemini --list-sessions
gemini --delete-session <index-or-id>
```

**VERIFIED** resume of non-existent UUID:

- stderr: `Error resuming session: Invalid session identifier "…".`
- exit **42**, no JSONL.

**UNKNOWN:** full multi-turn resume of a real successful chat (requires valid API key). Shape of `-r` + `-p` combination is supported by docs and accepted by the binary (resume without existing sessions falls through with a “No previous sessions…” message when using `latest`).

**Hermetic note:** session files live under the user’s `~/.gemini/…` (or isolated `HOME`). If Parley isolates `HOME` per child, resume must reuse the same home so the chat file remains findable.

---

## 5. Sandbox & approvals

### Approvals (disable interactive prompts)

| Mechanism | Effect | Evidence |
| --- | --- | --- |
| `--approval-mode=yolo` | Auto-approve all tools | **VERIFIED** help + YOLO stderr banner |
| `-y` / `--yolo` | Deprecated alias of yolo | **VERIFIED** help: “Use `--approval-mode=yolo` instead” |
| `--approval-mode=auto_edit` | Auto-approve edit tools only | **VERIFIED** choices |
| `--approval-mode=plan` | Read-only plan mode | **DOCS** plan-mode; **VERIFIED** flag |
| `--approval-mode=default` | Prompt for approval | Unusable headless |
| Built-in non-interactive policy | `ask_user` **denied** when non-interactive | **VERIFIED** `policies/non-interactive.toml` |
| Built-in write policy (headless) | write/shell tools that would `ask_user` are **deny**ed unless yolo/auto_edit | **VERIFIED** `policies/write.toml` (`interactive = false` deny rules) |
| MCP `trust: true` | Skip confirmation for that server’s tools | **DOCS** |

**Parley default:** always pass `--approval-mode=yolo` so the agent can run tools and call MCP without a TTY.

YOLO cannot be set via settings alone — **DOCS** `general.defaultApprovalMode` allows `default` \| `auto_edit` \| `plan` only; yolo is CLI-only.

### Sandbox

| Mechanism | Notes | Evidence |
| --- | --- | --- |
| `-s` / `--sandbox` | Boolean enable | **VERIFIED** help |
| `GEMINI_SANDBOX=true\|docker\|podman\|sandbox-exec\|runsc\|lxc` | Provider selection | **DOCS** sandbox.md |
| `tools.sandbox` in settings | e.g. `"docker"` or object with image | **DOCS** |
| macOS Seatbelt profiles (`SEATBELT_PROFILE`) | `permissive-open` (default), `*-proxied`, `restrictive-*`, `strict-*` — network allowed vs via proxy | **DOCS** |
| Linux default without Docker | Weaker isolation unless container/gVisor configured | **DOCS** |

There is **no** Codex-style `--sandbox read-only|workspace-write|danger-full-access` triad.

### Parley posture mapping (recommended)

| Parley `Posture` | Gemini mapping | Notes |
| --- | --- | --- |
| `sandbox: "read-only"`, network any | `--approval-mode=plan` (+ optional `-s` / `GEMINI_SANDBOX`) | Plan mode is the documented read-only tool policy. Network still not a clean independent switch. |
| `sandbox: "workspace"`, `network: true` (**default**) | `--approval-mode=yolo`, **no** `-s` *or* `-s` with permissive profile | Unsandboxed yolo matches “write worktree freely.” With sandbox on, default seatbelt restricts writes outside project but allows network (**DOCS**). |
| `sandbox: "workspace"`, `network: false` | macOS: `SEATBELT_PROFILE=permissive-proxied` or `restrictive-proxied` with sandbox on; Linux: **UNKNOWN** without custom Docker network off | No first-class “network=false” flag. |
| `sandbox: "full"`, network on | `--approval-mode=yolo`, sandbox **off** | Full host access. |
| `sandbox: "full"`, network off | **UNKNOWN** / not a natural mode | Full + no network is contradictory on most OS sandboxes. |

**Git dirs outside worktree:** Gemini sandbox (when on) mounts/restricts relative to project dir (**DOCS**). Whether `gitDir` / `gitCommonDir` outside `cwd` need extra writable roots is **UNKNOWN** — likely only matters when sandbox is enabled; default Parley path (yolo, no sandbox) should allow normal git in worktrees.

---

## 6. Model & effort flags; auth env vars

### Model

| Surface | Value |
| --- | --- |
| Flag | `-m` / `--model <string>` (**VERIFIED**) |
| Default | `auto` (help default; **VERIFIED** `init.model` is `"auto"` when unset) |
| Aliases (**DOCS** cheatsheet) | `auto`, `pro`, `flash`, `flash-lite` → concrete Gemini models (version-dependent) |
| Concrete ids observed in error `stats.models` / defaults | e.g. `gemini-3.1-flash-lite`, `gemini-3.1-pro-preview` (**VERIFIED** empty usage keys under those names) |

Pass model strings through opaquely (same as other vendors).

### Effort / reasoning

**No** `--effort` / `--reasoning-effort` flag on 0.50.0 (**VERIFIED** `--help`).

**DOCS** advanced generation settings use `modelConfigs` / `thinkingConfig` (`thinkingBudget`, `thinkingLevel`) in settings — not a simple Parley `effort` passthrough.

| Parley `effort` | Recommendation |
| --- | --- |
| `null` | Omit; vendor default |
| non-null | **UNKNOWN** best mapping. Options: (a) ignore and document no effort surface; (b) materialize `modelConfigs` thinking overrides — needs design + verification. |

### Auth env vars (headless)

**VERIFIED** missing-auth message lists:

- `GEMINI_API_KEY`
- `GOOGLE_GENAI_USE_VERTEXAI`
- `GOOGLE_GENAI_USE_GCA`

**DOCS** ([authentication](https://geminicli.com/docs/get-started/authentication)):

| Method | Env / setup | Headless fit |
| --- | --- | --- |
| Gemini API key (AI Studio) | **`GEMINI_API_KEY`** | **Primary for Parley** |
| Vertex AI | `GOOGLE_GENAI_USE_VERTEXAI` + `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`; ADC / service account / `GOOGLE_API_KEY` | CI-friendly if GCP is already provisioned |
| Google account login | Browser OAuth, cached credentials | Poor for pure headless unless pre-provisioned |
| Code Assist / GCA | `GOOGLE_GENAI_USE_GCA` (flag-style env) | Org setups |

**Adapter env passthrough:** at minimum forward `GEMINI_API_KEY` when set. Optionally forward Vertex-related vars if present. Do not require interactive login in the child.

---

## 7. Model enumeration

| Command | Result |
| --- | --- |
| `gemini models` / `gemini debug models` | **Does not exist** (**VERIFIED** `--help` only has `gemma` for local Gemma routing) |
| `gemini --list-extensions` | Lists extensions, not models |
| Interactive `/model` | Dialog only (**DOCS**) |

**Recommended probe for `listModels`:**

1. **Static catalog** from docs + bundle defaults (aliases + known ids), hand-maintained; or  
2. Skip probe / return empty and keep manual catalog patches (Grok-style efforts story).

**Documented aliases** (**DOCS** CLI reference):

| Alias | Resolves toward (docs; may drift) |
| --- | --- |
| `auto` | Pro/preview routing |
| `pro` | Pro family |
| `flash` | Flash family |
| `flash-lite` | Flash-Lite family |

**Bundle default model config aliases** (**VERIFIED** source `DEFAULT_MODEL_CONFIGS`): includes concrete names such as `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3-pro-preview`, `gemini-3-flash-preview`, `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`, etc. No per-model effort list.

**Output format for a probe:** N/A — no CLI list command. Adapter `listModels` should either return a static table or refuse refresh.

---

## 8. Token usage

### Where it appears

| Format | Location | Evidence |
| --- | --- | --- |
| `stream-json` | Terminal **`result.stats`** | **VERIFIED** live error result; success path same converter (**VERIFIED** source `convertToStreamStats`) |
| `json` | Top-level `stats` on success object | **DOCS** headless schema |

Mid-stream `message` / `tool_*` events do **not** carry usage.

### Field names (`result.stats`)

**VERIFIED** live + source:

```json
{
  "total_tokens": 0,
  "input_tokens": 0,
  "output_tokens": 0,
  "cached": 0,
  "input": 0,
  "duration_ms": 0,
  "tool_calls": 0,
  "models": {
    "<model-id>": {
      "total_tokens": 0,
      "input_tokens": 0,
      "output_tokens": 0,
      "cached": 0,
      "input": 0
    }
  }
}
```

Notes from source aggregation:

- Aggregates `input_tokens` from per-model `tokens.prompt` (API `promptTokenCount`).
- Aggregates `output_tokens` from `tokens.candidates` (`candidatesTokenCount`).
- Per-model object also includes a separate `input` field (from `tokens.input` — distinct from prompt in telemetry).
- `cached` from cached content tokens.

**Worked example (error path, zero usage — real run):** see §2 `result` line with all zeros and empty models still keyed for the router’s candidates.

**UNKNOWN:** non-zero live usage with a valid key (shape should match; numbers not observed).

**Adapter parse:** on `type === "result"`, map numeric fields from `stats` into `VendorEvent.usage` (ignore nested `models` or flatten as needed). Prefer `input_tokens` / `output_tokens` / `total_tokens` as the stable set.

---

## 9. Adapter recommendation

### `prepare(task, hub)` → `SpawnPlan`

**argv:**

```text
gemini
  -p <task.prompt>
  --output-format stream-json
  --approval-mode=yolo          # or plan if sandbox=read-only
  --skip-trust
  [-m <task.model>]             # if task.model !== null
  # optional: -s / env GEMINI_SANDBOX when mapping demands isolation
```

**env:**

| Key | When |
| --- | --- |
| `GEMINI_API_KEY` | if parent has it |
| `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_API_KEY` | optional passthrough if parent uses Vertex |
| `GEMINI_CLI_TRUST_WORKSPACE=true` | optional belt-and-braces with `--skip-trust` |
| `SEATBELT_PROFILE` / `GEMINI_SANDBOX` | only for sandbox/network postures that need them |

**files:**

| Path | Contents |
| --- | --- |
| `.gemini/settings.json` | MCP hub injection (§3). Optionally later: modelConfigs for effort. |

**cwd:** `task.cwd` (required — no `--cd` flag).

**effort:** omit until a verified mapping exists (§6).

### `resume(task, hub)` → `SpawnPlan`

Same as prepare, but insert:

```text
-r <task.sessionId>
```

before or after other flags (order not critical; **VERIFIED** `-r` + `-p` accepted). Re-materialize `.gemini/settings.json` so hub/headers/timeout remain present. Reject if `sessionId` missing (same as Grok adapter).

Ensure the same `HOME` / project path so `~/.gemini/tmp/<hash>/chats/` still resolves.

### `parseEvent` table

| Stream `type` | → `VendorEvent` | Notes |
| --- | --- | --- |
| `init` | `{ kind: "session_meta", session_id }` | Primary session id source |
| `message` + `role=="assistant"` | `{ kind: "message", text: content }` | May stream many `delta: true` chunks — either concatenate for display or emit each chunk |
| `message` + `role=="user"` | `[]` or message | Usually echo of prompt; optional |
| `tool_use` | `{ kind: "command", text: tool_name + " " + JSON(parameters) }` or `[]` opaque | Prefer thin display; raw log keeps full line |
| `tool_result` | if `status=="error"`: `{ kind: "error", text }` (non-fatal); else `[]` or command | Tag MCP failures with `PARLEY-DIAG` when `tool_name`/output implicates hub tools if detectable |
| `error` | `{ kind: "error", text: message }` | Mid-run; `severity` may be warning — non-fatal |
| `result` + `status=="success"` | `{ kind: "session_meta", usage: pick_numeric(stats) }` | |
| `result` + `status=="error"` | `{ kind: "error", text: error.message, fatal: true }` (+ usage if present) | Prefer this over exit code |
| non-JSON / unknown | `[]` | Opaque; raw JSONL is durable |

**`sessionId(events)`:** last `session_meta.session_id` from `init` (walk reverse).

### Top risks / unknowns

1. **Exit codes lie / truncate** — HTTP 400 → process exit 144. Always parse `result`.
2. **Folder trust** — forgetting `--skip-trust` silently disables project MCP (and project settings). Load-bearing.
3. **No MCP CLI inject** — only settings file; must git-exclude `.gemini/settings.json` if the worktree is committed by the agent.
4. **MCP timeout units are ms** (default 10 min) — easy to confuse with Codex’s seconds.
5. **MCP tool FQNs** — model sees `mcp_parley_*`; prompt/protocol should name tools accordingly or rely on discovery descriptions.
6. **No effort flag** — Parley `effort` has no verified mapping.
7. **No model list command** — catalog is static/handish.
8. **Sandbox ≠ Codex matrix** — network-off and extra git writable roots are rough/UNKNOWN on Linux without custom Docker.
9. **Sessions in `~/.gemini`** — not worktree-local; HOME isolation and multi-tenant hosts need care.
10. **Product transition** — Antigravity CLI messaging on official docs; pin package version and re-verify before production.
11. **Live success path** — tool_use/tool_result lines and non-zero token stats not captured end-to-end without a valid key + hub (**UNKNOWN** only for golden numbers, not for field names).
12. **stderr contamination** — never parse mixed streams; stdout only.

### Closest integration shape (summary)

Gemini CLI **supports** headless single-shot automation. Implement a **files + flags** adapter (like Grok): materialize `.gemini/settings.json` for HTTP MCP + headers, spawn `gemini -p … --output-format stream-json --approval-mode=yolo --skip-trust`, capture `init.session_id`, resume with `-r`, and normalize the six JSONL event types above. Do not depend on exit codes for success/failure.

---

## Sources

| Source | Use |
| --- | --- |
| Local `@google/gemini-cli@0.50.0` binary (`--help`, headless runs, `mcp list`) | VERIFIED |
| Bundled docs in package: `docs/cli/headless.md`, `session-management.md`, `sandbox.md`, `trusted-folders.md`, `model.md`, `tools/mcp-server.md`, `reference/configuration.md`, `get-started/authentication.mdx`, `policies/*.toml` | DOCS + source |
| https://geminicli.com/docs/cli/headless | DOCS |
| https://geminicli.com/docs/cli/cli-reference | DOCS |
| https://geminicli.com/docs/tools/mcp-server | DOCS |
| https://geminicli.com/docs/cli/trusted-folders | DOCS |
| https://github.com/google-gemini/gemini-cli | DOCS / repo |
| Bundle source emitters (`StreamJsonFormatter`, non-interactive stream path) | VERIFIED (read, not executed unit tests) |

Re-verify flags and event fields at implementation time if the pinned version moves past 0.50.0.
