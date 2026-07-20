# Claude Code CLI — automation surface for Parley

Research asset for the wayfinder ticket [Research: Claude Code CLI automation surface](https://github.com/femoral/parley/issues/96). Verified against the installed native binary **2.1.211** (Claude Code) on 2026-07-16, cross-checked with primary docs at [code.claude.com](https://code.claude.com/docs/en/cli-reference). Every claim is tagged **VERIFIED** (ran on 2.1.211), **DOCS** (official docs with URL), or **UNKNOWN** (what blocks confirmation).

## TL;DR for Parley

Claude Code is a **strong, first-class adapter candidate**. Headless single-shot automation is fully supported:

| Parley need | Claude Code surface | Status |
| --- | --- | --- |
| One-shot headless | `claude -p "<prompt>"` | **VERIFIED** |
| Streaming JSONL | `--output-format stream-json --verbose` (both required) | **VERIFIED** |
| MCP-over-HTTP + custom headers | `--mcp-config` (file or JSON string) + `"type":"http"` + `"headers"` | **VERIFIED** |
| Hermetic MCP | `--strict-mcp-config` (ignore user/project MCP + claude.ai connectors) | **VERIFIED** |
| Session resume | `session_id` on `system/init` + `result`; resume with `-r` / `--resume <uuid>` | **VERIFIED** |
| Approvals off for headless | `--permission-mode bypassPermissions` (or `acceptEdits` / `dontAsk`) | **VERIFIED** |
| Model / effort | `--model <alias\|id>`, `--effort <level>` | **VERIFIED** (flags) |
| Auth via env | `ANTHROPIC_API_KEY` (and/or `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`) | **DOCS** + partial **VERIFIED** (error shapes) |
| Token usage | `result.usage` + `result.modelUsage` (incl. `contextWindow`) | **VERIFIED** |

Main caveats (not blockers):

1. **`--output-format stream-json` hard-requires `--verbose`** — without it the CLI exits 1 with a clear error and produces no events. **VERIFIED**.
2. **Exit codes are unreliable for logical failure** — invalid API key returned exit 0 with `is_error: true` in the `result` event; parse the stream. **VERIFIED**.
3. **No dedicated `claude models` catalog command** — best probe is `claude -p "/model" --output-format json` (slash command in print mode). **VERIFIED**.
4. **Default `-p` loads user MCP/connectors/plugins** — use `--strict-mcp-config` and preferably `--bare` (or `--settings` with `disableClaudeAiConnectors`) so the orchestrator's own Claude config does not bleed into the child. **VERIFIED**.
5. **`--bare` skips OAuth/keychain** — requires `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings`; subscription login alone fails with `"Not logged in · Please run /login"`. **VERIFIED**.

Closest integration shape: **spawn-per-turn** like codex/grok — `claude -p … --output-format stream-json --verbose`, inject hub via `--mcp-config`, capture `session_id`, resume with `--resume <id> -p "<follow-up>"`. No need for the Python/TS Agent SDK unless Parley later wants structured callbacks.

---

## Session provenance: deterministic hook, incomplete metadata

**Finding for [#191](https://github.com/femoral/parley/issues/191): no, not for all four required values.** Claude Code does expose a deterministic, pre-model `SessionStart` hook and an environment-persistence channel. That hook can reliably supply `PARLEY_SESSION_ID=stdin.session_id` and the constant `PARLEY_HARNESS=claude`. It cannot reliably supply harness-ground-truth `PARLEY_MODEL` because the documented `stdin.model` field is optional and was absent in the installed CLI probe, and it cannot supply `PARLEY_EFFORT` because the hook schema exposes no resolved effort field. This is an incomplete metadata surface, not an absent lifecycle signal. **DOCS** [hooks reference](https://code.claude.com/docs/en/hooks#sessionstart); **VERIFIED** on 2.1.216.

### Exact lifecycle and plugin mechanism

A distributable plugin places its optional manifest at `.claude-plugin/plugin.json` and hook configuration at the plugin-root `hooks/hooks.json` (not inside `.claude-plugin/`). The hook entry is a `SessionStart` command hook, normally matching `startup|resume` so it runs for both a new and resumed session:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/scripts/session-env.sh\""
          }
        ]
      }
    ]
  }
}
```

Claude Code invokes the command itself and sends hook input as JSON on stdin. `SessionStart` fires whenever a session starts or resumes; its matcher is the start source (`startup`, `resume`, `clear`, or `compact`). It occurs outside the agentic/model loop: in a 2.1.216 probe, `hook_started` and successful `hook_response` events appeared before `system/init`, and the hook completed before an intentionally invalid API key produced an authentication failure with zero model tokens. The hook input already contained the same generated UUID later emitted by `system/init`. No prompt interpretation or tool choice caused the hook to run. **DOCS** [hook lifecycle and schema](https://code.claude.com/docs/en/hooks#sessionstart); **VERIFIED** with `--include-hook-events`.

There are two operational exceptions to “always”: `--bare` explicitly skips hooks and plugin sync, while `--safe-mode` disables hooks and plugins. Enterprise `allowManagedHooksOnly` policy can also block ordinary user, project, and plugin hooks (managed force-enabled plugin hooks are exempt). These are explicit harness postures/policies rather than nondeterminism in an enabled plugin. **VERIFIED** `claude --help`; **DOCS** [hook locations](https://code.claude.com/docs/en/hooks#hook-locations).

### Metadata available at `SessionStart`

| Parley variable | Hook source | Result |
| --- | --- | --- |
| `PARLEY_SESSION_ID` | Required common input `session_id` | **Available.** The probe received a UUID equal to the `system/init.session_id`, before authentication/model execution. |
| `PARLEY_HARNESS` | Plugin-owned constant `claude` | **Available.** This is identity of the native integration, not inferred from the model. |
| `PARLEY_MODEL` | Optional SessionStart input `model` | **Not deterministic.** Docs call it the active model identifier but explicitly allow omission after `/clear` or conversation recovery. More importantly, 2.1.216 omitted it on a fresh `startup` even when invoked with `--model sonnet`; the later `system/init` reported `claude-sonnet-5`. A plugin must not substitute the CLI flag, settings, or environment because those are not the harness's resolved ground truth across all precedence/fallback paths. |
| `PARLEY_EFFORT` | None | **Unavailable.** `--effort`, `/effort`, `CLAUDE_CODE_EFFORT_LEVEL`, and settings `effortLevel` configure effort, but `SessionStart` input has no resolved effort/thinking field. Reading one configuration source would miss precedence, defaults, and later `/effort` changes. |

The other common fields are `transcript_path`, `cwd`, and `hook_event_name`; `SessionStart` adds `source` plus optional `model`, `agent_type`, and `session_title`. There is no documented hook input containing the resolved effort. **DOCS** [SessionStart input](https://code.claude.com/docs/en/hooks#sessionstart-input), [model/effort configuration](https://code.claude.com/docs/en/model-config#adjust-effort-level).

### Environment effect and its boundary

`SessionStart` command hooks receive `CLAUDE_ENV_FILE`. Appending shell-safe `export NAME=value` statements to that file makes the values available to **subsequent Bash commands executed by Claude Code**; Claude Code sources the file as a preamble before each Bash command. This is the supported nearest equivalent to exporting into a running process. A child hook cannot mutate the already-running Claude Code process or its parent shell, so the variables do not become ambient outside Claude's Bash-tool environment. **DOCS** [persist environment variables](https://code.claude.com/docs/en/hooks#persist-environment-variables), [hooks guide](https://code.claude.com/docs/en/hooks-guide#reload-environment-when-directory-or-files-change); **VERIFIED** that `CLAUDE_ENV_FILE` was present in the 2.1.216 hook process.

That channel is sufficient for later `parley` commands launched through Claude Code's Bash tool, without asking the model to report or interpolate provenance. It does not cure the missing `model` and `effort` ground truth. A correct plugin could export the two known values and omit/mark the other two unknown, but it cannot meet ADR-0013's four-variable requirement from current hook metadata. Per the ADR, this finding does not recommend transcript or log scraping.

### Install and uninstall

For development, load the plugin for one session with `claude --plugin-dir ./plugin` (a directory or `.zip`). For persistent distribution, publish the plugin through a Claude Code marketplace containing `.claude-plugin/marketplace.json`, add that marketplace, and install the qualified plugin id:

```bash
claude plugin marketplace add <owner/repository-or-marketplace-source>
claude plugin install parley@useparley

# Remove it from the same scope (user is the default):
claude plugin uninstall parley@useparley
```

`--scope user|project|local` is accepted by both install and uninstall; user scope writes `~/.claude/settings.json`, project scope writes `.claude/settings.json`, and local scope writes `.claude/settings.local.json`. Marketplace installations are copied into `~/.claude/plugins/cache`; callers should not install by copying directly into that cache. The package name proposed by ADR-0013 (`@useparley/plugin-claude-code`) is the npm/repository artifact identity, while Claude's install operand is the marketplace entry id in `plugin-name@marketplace-name` form. **VERIFIED** `claude plugin install --help` and `uninstall --help`; **DOCS** [plugin reference](https://code.claude.com/docs/en/plugins-reference#cli-commands-reference), [marketplace installation](https://code.claude.com/docs/en/discover-plugins#install-plugins).

---

## 1. Identity & install

| Field | Value | Evidence |
| --- | --- | --- |
| Product | Claude Code (Anthropic CLI coding agent) | **DOCS** [overview](https://code.claude.com/docs/en/overview) |
| npm package | `@anthropic-ai/claude-code` | **VERIFIED** `npm view` → `2.1.211` |
| Binary name | `claude` | **VERIFIED** `claude --version` |
| Verified version | **2.1.211 (Claude Code)** | **VERIFIED** native binary at `~/.local/share/claude/versions/2.1.211` |
| Install (npm) | `npm install -g @anthropic-ai/claude-code` | **DOCS** / npm registry |
| Install (native) | `claude install [stable\|latest\|<version>]` or first-run installer | **DOCS** [CLI reference](https://code.claude.com/docs/en/cli-reference), **VERIFIED** `claude install` is a subcommand |
| Repo / homepage | https://github.com/anthropics/claude-code | **VERIFIED** `npm view homepage` |
| Docs host | https://code.claude.com/docs/… (formerly docs.anthropic.com redirects) | **DOCS** |

`claude --version` prints `2.1.211 (Claude Code)`. The npm package's `bin` field points at `bin/claude.exe` (cross-platform wrapper name); the native install path used here is a standalone ELF/binary under `~/.local/share/claude/versions/<ver>`.

**Adapter note:** pin the version at implementation time (`claude --version` preflight). The product ships frequent minor releases; event fields have grown over 2.1.x (`capabilities`, `terminal_reason`, `modelUsage.contextWindow`, etc.).

---

## 2. Headless invocation

### Canonical one-shot argv

```bash
claude -p "<prompt>" \
  --output-format stream-json \
  --verbose \
  --permission-mode bypassPermissions \
  --strict-mcp-config \
  --mcp-config /path/to/parley-mcp.json \
  --model <alias-or-id> \
  --effort <level>
```

| Piece | Role | Evidence |
| --- | --- | --- |
| `-p` / `--print` | Non-interactive: run prompt, print, exit. Skips workspace trust dialog when stdout is not a TTY. | **VERIFIED** help text; **DOCS** [headless](https://code.claude.com/docs/en/headless) |
| Prompt | Positional `prompt` arg, and/or stdin pipe (`cat file \| claude -p "query"`). Piped stdin capped at 10MB (v2.1.128+). | **DOCS** headless |
| `--output-format stream-json` | NDJSON / JSONL events on stdout | **VERIFIED** |
| `--verbose` | **Required** with `stream-json` under `-p` | **VERIFIED** — without it: `Error: When using --print, --output-format=stream-json requires --verbose` (exit 1, empty stdout) |
| `--output-format json` | Single final JSON object (includes usage + `session_id`) | **VERIFIED** |
| `--output-format text` | Default plain text | **DOCS** |
| `--include-partial-messages` | Token-level `stream_event` deltas (optional) | **DOCS** headless |
| `--json-schema '<schema>'` | Structured final output → `structured_output` on json format | **DOCS** headless |
| `--bare` | Skip hooks/LSP/plugins/MCP auto-discovery/CLAUDE.md/keychain OAuth; only explicit flags count. Sets `CLAUDE_CODE_SIMPLE=1`. Auth must be `ANTHROPIC_API_KEY` or `apiKeyHelper`. Recommended for CI. | **DOCS** headless; **VERIFIED** auth failure without key |
| `--no-session-persistence` | Do not write session to disk (not resumable) | **VERIFIED** flag in `--help` |
| Working directory | **Process cwd** — there is **no** `--cd` / `--cwd` flag. Parley must `spawn` with `cwd: task.cwd`. | **VERIFIED** help; init event `cwd` matches process cwd |
| `--add-dir <dirs…>` | Extra directories for tool file access (not config discovery) | **VERIFIED** help; **DOCS** CLI reference |
| `-w` / `--worktree` | Claude creates its own git worktree — **do not use** when Parley owns the worktree | **VERIFIED** help |

### Real stream-json lines (2.1.211)

Command (cwd `/tmp/claude-parley-scratch`):

```bash
claude -p "say hi" --output-format stream-json --verbose
```

Observed sequence (abbreviated; full fields present in capture):

```json
{"type":"system","subtype":"init","cwd":"/tmp/claude-parley-scratch","session_id":"98428278-d240-475c-ad41-b840a6a42ffb","tools":["Task","Bash",...],"mcp_servers":[...],"model":"claude-fable-5","permissionMode":"default","apiKeySource":"none","claude_code_version":"2.1.211","capabilities":["interrupt_receipt_v1","msg_lifecycle_v1"],"uuid":"..."}
{"type":"assistant","message":{"model":"claude-fable-5","id":"msg_…","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"…"}],"usage":{"input_tokens":2,"cache_creation_input_tokens":7923,"cache_read_input_tokens":15042,"output_tokens":2}},"parent_tool_use_id":null,"session_id":"98428278-…","uuid":"…","timestamp":"2026-07-16T08:11:21.809Z"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Hi Felipe! 👋 What can I help you with today?"}],"usage":{…}},"session_id":"98428278-…"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed",…},"session_id":"98428278-…"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":7603,"num_turns":1,"result":"Hi Felipe! 👋 What can I help you with today?","stop_reason":"end_turn","session_id":"98428278-…","total_cost_usd":0.175672,"usage":{"input_tokens":2,"cache_creation_input_tokens":7923,"cache_read_input_tokens":15042,"output_tokens":43,…},"modelUsage":{"claude-fable-5":{"inputTokens":2,"outputTokens":43,"cacheReadInputTokens":15042,"cacheCreationInputTokens":7923,"costUSD":0.175672,"contextWindow":1000000,"maxOutputTokens":64000}},"permission_denials":[],"terminal_reason":"completed"}
```

Tool-use example (Bash under `acceptEdits`):

```json
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_…","name":"Bash","input":{"command":"echo hello-parley","description":"Echo hello-parley"}}],"…":"…"},"session_id":"…"}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_…","type":"tool_result","content":"hello-parley","is_error":false}]},"tool_use_result":{"stdout":"hello-parley","stderr":"","interrupted":false},"session_id":"…"}
```

**Event types observed (2.1.211):** `system` (`init`, and docs mention `api_retry`, `plugin_install`, hook events), `assistant`, `user` (tool results), `rate_limit_event`, `result` (`subtype: success` even when `is_error: true`). Optional: `stream_event` with `--include-partial-messages`. **DOCS** also document hook lifecycle events when `--include-hook-events` is set.

**Exit codes:** process exit is **not** a sufficient success signal. Auth failures often still emit a `result` with `is_error: true` / `terminal_reason: "api_error"`. Invalid key: exit **0** with `is_error: true`. Missing login under `--bare`: exit **1**. **VERIFIED**. Adapter must treat `result.is_error` and fatal stream errors as the source of truth (same lesson as codex's 0/1 binary exits).

---

## 3. MCP injection

### Transports

| Transport | Config `type` | Notes | Evidence |
| --- | --- | --- | --- |
| Streamable HTTP | `"http"` (`"streamable-http"` accepted as alias in JSON files) | **Recommended** for Parley hub; supports `url`, `headers`, `headersHelper`, `timeout` (ms), OAuth fields | **DOCS** [MCP](https://code.claude.com/docs/en/mcp) |
| SSE | `"sse"` | Deprecated; still works | **DOCS** |
| stdio | `"stdio"` or omit type with `command` | Local process | **DOCS** |
| WebSocket | `"ws"` | Header auth only | **DOCS** |

A JSON entry with `url` but no `type` is treated as misconfigured stdio and skipped. **DOCS**.

### Custom headers

Yes. HTTP servers accept a static `headers` object (string key → string value). Env expansion `${VAR}` / `${VAR:-default}` works in `.mcp.json` `headers` and `url`. Dynamic headers via `headersHelper` (shell command → JSON object of headers). **DOCS**.

**VERIFIED** (2.1.211): config with headers accepted; server appears in `system/init` `mcp_servers`:

```json
{
  "mcpServers": {
    "parley": {
      "type": "http",
      "url": "http://127.0.0.1:9/mcp",
      "headers": {
        "X-Parley-Task": "t238",
        "Authorization": "Bearer test-token"
      },
      "timeout": 3600000
    }
  }
}
```

Init line: `"mcp_servers":[{"name":"parley","status":"pending"}]` (later `"failed"` when nothing listens on `:9`). Status values observed: `pending`, `failed`, `needs-auth`.

### Injection mechanisms (priority for Parley)

| Mechanism | Hermetic? | How | Evidence |
| --- | --- | --- | --- |
| **`--mcp-config <file-or-json>`** | Yes, with `--strict-mcp-config` | File path **or** inline JSON string; space-separated for multiple | **VERIFIED** both file and inline; **DOCS** CLI reference |
| **`--strict-mcp-config`** | Required companion | *Only* servers from `--mcp-config`; ignores user/project/plugin/claude.ai MCP | **VERIFIED** — without it, default `-p` listed claude.ai connectors; with it + file, only `parley` |
| Project `.mcp.json` | No (trust / approval) | Project-scoped; may stay `Pending approval` until interactive trust | **DOCS** MCP |
| User `~/.claude.json` | No | Local/user scopes | **DOCS** |
| `claude mcp add --transport http … --header "…"` | No (writes user config) | Interactive admin path — not for Parley spawn | **DOCS** |

**Recommended Parley path:** materialize a temp file (or pass inline JSON if argv length allows) and pass:

```text
--mcp-config <path> --strict-mcp-config
```

Optionally disable claude.ai connectors via settings:

```json
{ "disableClaudeAiConnectors": true }
```

(`ENABLE_CLAUDEAI_MCP_SERVERS=false` is an env equivalent.) **DOCS**. Servers passed via `--mcp-config` are unaffected by `disableClaudeAiConnectors`.

### Timeouts (load-bearing for `ask_orchestrator`)

| Knob | Default | Role | Evidence |
| --- | --- | --- | --- |
| Per-server `"timeout"` (ms) in MCP JSON | Falls through to env / ~28h wall-clock | Hard wall-clock per tool call; also raises HTTP per-request first-byte timer when ≥ 60s | **DOCS** MCP |
| `MCP_TOOL_TIMEOUT` env (ms) | ~28 hours if unset | Global tool timeout | **DOCS** MCP; name **VERIFIED** in binary strings |
| `MCP_TIMEOUT` env (ms) | (startup) | MCP *server startup* timeout | **DOCS** MCP tip |
| HTTP per-request timer | **60s** to first response byte | Raised by per-server `timeout` or `MCP_TOOL_TIMEOUT` when set ≥ 60s | **DOCS** MCP |
| Idle timeout | 5 min (HTTP) / 30 min (stdio) with no progress | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (ms); `0` disables | **DOCS** MCP |

**Adapter implication:** set per-server `"timeout"` (ms) to `answerTimeoutMs + headroom` (and/or `MCP_TOOL_TIMEOUT`) so a blocking `ask_orchestrator` is not killed by the 60s HTTP first-byte timer. Progress notifications do **not** extend the wall-clock `timeout`. **DOCS**.

### Project-scoped path

- **Project MCP file:** `.mcp.json` at project root (git-friendly). **DOCS**.
- **Settings:** `.claude/settings.json` (shared) / `.claude/settings.local.json` (local).
- **Do not rely on `.mcp.json` alone for untrusted worktrees** — project servers require approval; use `--mcp-config` + `--strict-mcp-config` instead. **DOCS**.

Tool names in permission rules use the form `mcp__<server>__<tool>` (e.g. `mcp__parley__submit_report`). **DOCS** permissions / MCP.

---

## 4. Session resume

### Where `session_id` appears

| Location | Field | Evidence |
| --- | --- | --- |
| First stream event | `system` / `init` → top-level **`session_id`** (UUID) | **VERIFIED** |
| Every subsequent event | top-level `session_id` | **VERIFIED** |
| Terminal event | `result.session_id` | **VERIFIED** |
| Single-shot JSON mode | root `.session_id` | **VERIFIED** |

Capture from the first `system/init` (or any line); prefer the latest non-empty `session_id` if re-emitted.

### Resume argv

```bash
# Resume a specific session (same project directory / worktree scope)
claude -p "<follow-up prompt>" \
  --resume "<session-id-uuid>" \
  --output-format stream-json \
  --verbose \
  …same posture flags as prepare…
```

Aliases / variants:

| Flag | Behavior | Evidence |
| --- | --- | --- |
| `-r` / `--resume [value]` | Resume by session ID, or interactive picker if omitted/search | **VERIFIED** help; resume re-emitted same `session_id` |
| `-c` / `--continue` | Most recent conversation **in the current directory** | **DOCS** headless; cwd-scoped — safe across worktrees if each has its own cwd |
| `--session-id <uuid>` | Force session id for a **new** conversation (must be valid UUID) | **VERIFIED** — `claude -p "ping" --session-id <uuid> --output-format json` returned that same `session_id` |
| `--fork-session` | With resume/continue: new session id, transcript forked | **VERIFIED** help |
| `--no-session-persistence` | No disk write; cannot resume | **VERIFIED** help |

**Scope rule (DOCS):** session ID lookup is scoped to the current project directory and its git worktrees — run resume from the **same `cwd`** as the original spawn. **DOCS** [headless continue](https://code.claude.com/docs/en/headless#continue-conversations).

**No mid-run stdin steering of a single `-p` process** for human Q&A — same architecture as codex: live questions go through Parley's MCP `ask_orchestrator`. Optional multi-turn input exists via `--input-format stream-json` (agent chaining), not Parley's primary path. **DOCS**.

---

## 5. Sandbox & approvals

Claude Code splits **permission modes** (whether tools prompt / run) from **Bash sandboxing** (OS-level FS/network isolation for shell). Neither is named identically to Parley's `read-only | workspace | full`, but both map cleanly.

### Permission modes (`--permission-mode`)

| Mode | Headless behavior | Evidence |
| --- | --- | --- |
| `default` / `manual` | Reads free; writes/shell prompt — **stalls or aborts in `-p`** without a TTY | **DOCS** [permission modes](https://code.claude.com/docs/en/permission-modes) |
| `acceptEdits` | Auto-approves file edits + common FS bash (`mkdir`, `mv`, `cp`, …); other shell/network still need allow rules | **DOCS**; **VERIFIED** flag + tool run |
| `plan` | Read-only exploration; no source edits | **DOCS** |
| `dontAsk` | Never prompt; deny anything not pre-allowed / read-only set — good locked CI | **DOCS**; **VERIFIED** appears in init |
| `auto` | Classifier auto-approves with safety checks; needs eligible account/model | **DOCS** |
| `bypassPermissions` | Skip permission prompts (still some circuit breakers: org `ask` tools, `requiresUserInteraction` MCP, `rm -rf ~`/`/`) | **DOCS**; **VERIFIED** init `permissionMode` |
| `--dangerously-skip-permissions` | Alias of `bypassPermissions` | **VERIFIED** help / **DOCS** |

**Always set an explicit mode for headless children.** Default mode is unsafe for automation.

### Parley posture → Claude Code mapping (recommended)

| Parley `sandbox` | Parley `network` | Recommended Claude flags / settings | Notes |
| --- | --- | --- | --- |
| `read-only` | on/off | `--permission-mode plan` **or** `dontAsk` + allow only `Read` / read-only Bash; optional sandbox `denyWrite` | Plan mode blocks edits. Network off only affects sandboxed Bash if sandbox enabled. |
| `workspace` | `true` (default) | `--permission-mode acceptEdits` **or** `bypassPermissions`; optional `sandbox.enabled` with write to cwd | **DOCS**: linked git worktrees get write access to the shared main-repo `.git` for commit/index — important for Parley worktrees. |
| `workspace` | `false` | Same + `--settings` with `sandbox.enabled: true` and network allowlist that **includes the hub host** (`127.0.0.1` / `localhost`) but not the public internet | Sandbox network applies to **Bash**, not necessarily Claude's own MCP HTTP client — **UNKNOWN** whether MCP hub traffic is subject to sandbox proxy; still allowlist localhost for safety. |
| `full` | (always on) | `--permission-mode bypassPermissions` / `--dangerously-skip-permissions` | Docs warn: isolated containers only. |

Extra writable roots outside cwd: `--add-dir <gitDir> <gitCommonDir>` (Parley worktree gitdirs). **DOCS** say `--add-dir` grants file access; sandbox `filesystem.allowWrite` can also grant OS-level write paths when sandbox is on. **DOCS** sandboxing.

### Disabling interactive approvals

Minimum for unattended runs:

```bash
--permission-mode bypassPermissions
# or
--dangerously-skip-permissions
```

Safer middle ground when you still want edit auto-approve but not full bypass:

```bash
--permission-mode acceptEdits \
--allowedTools "Bash,Read,Edit,Write,mcp__parley__*"
```

Permission rule syntax supports prefixes like `Bash(git *)`. **DOCS**.

MCP tools marked `_meta["anthropic/requiresUserInteraction"]` **still prompt even in bypassPermissions** and are **denied in dontAsk** — Parley's hub tools must **not** set that flag. **DOCS** MCP.

### Bash sandbox (optional second layer)

Configured via settings (`sandbox.enabled`, `sandbox.filesystem.*`, `sandbox.network.allowedDomains`, …), not a simple CLI enum like codex `--sandbox`. Interactive `/sandbox` panel exists. **DOCS** [sandboxing](https://code.claude.com/docs/en/sandboxing).

Pass settings per invocation:

```bash
--settings /path/to/settings.json
# or --settings '{"sandbox":{"enabled":true,…}}'
```

**VERIFIED** `--settings` file accepted (init showed `permissionMode: acceptEdits` from settings + MCP from `--mcp-config`).

---

## 6. Model & effort flags; auth env vars

### Model & effort

| Flag / env | Values | Evidence |
| --- | --- | --- |
| `--model <alias\|name>` | Aliases: `sonnet`, `opus`, `haiku`, `fable`, `best`, `default`, `opusplan`, `sonnet[1m]`, `opus[1m]`, … or full id e.g. `claude-fable-5` | **VERIFIED** help; **DOCS** [model config](https://code.claude.com/docs/en/model-config) |
| `ANTHROPIC_MODEL` | Same, session env override | **DOCS** env-vars |
| `--effort <level>` | `low`, `medium`, `high`, `xhigh`, `max`, `ultracode` (model-dependent; `ultracode` is Claude Code orchestration + xhigh) | **VERIFIED** help; **DOCS** model-config |
| `CLAUDE_CODE_EFFORT_LEVEL` | Env override of effort | **DOCS** model-config |
| `--fallback-model a,b` | Fallback chain on overload | **VERIFIED** help |

Pass Parley's opaque `task.model` / `task.effort` through unchanged; do not hard-validate against a fixed list (aliases and full ids both move).

### Auth (headless)

Precedence (**DOCS** [authentication](https://code.claude.com/docs/en/authentication)):

1. Cloud provider flags (`CLAUDE_CODE_USE_BEDROCK` / `VERTEX` / `FOUNDRY`)
2. `ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer …`
3. **`ANTHROPIC_API_KEY`** → `X-Api-Key` — **always used in `-p` when set**
4. `apiKeyHelper` (settings script)
5. **`CLAUDE_CODE_OAUTH_TOKEN`** — long-lived token from `claude setup-token` (subscription CI)
6. Interactive `/login` OAuth (keychain / `~/.claude/.credentials.json` on Linux)

| Env | Use for Parley | Evidence |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Preferred for hermetic/API-billed children; required with `--bare` | **DOCS**; **VERIFIED** invalid key → `result` `"Invalid API key · Fix external API key"`, `api_error_status: 401`, `is_error: true` |
| `CLAUDE_CODE_OAUTH_TOKEN` | Subscription CI without browser; **not** read in `--bare` | **DOCS** |
| `ANTHROPIC_AUTH_TOKEN` | Gateway/proxy bearer | **DOCS** |
| (none; logged-in host) | Default `-p` uses subscription OAuth from disk | **VERIFIED** successful run with `apiKeySource: "none"` while `claude auth status` showed claude.ai Max login |

`claude auth status` prints JSON (`loggedIn`, `authMethod`, …); exit 0 if logged in, 1 if not. **DOCS** / **VERIFIED**.

`claude setup-token` → print long-lived OAuth token for `CLAUDE_CODE_OAUTH_TOKEN`. **DOCS**.

---

## 7. Model enumeration

**There is no `claude models` / `claude debug models` subcommand** in 2.1.211. **VERIFIED** (`claude models` is not a registered command; unknown subcommands are treated as prompts or suggestions).

### Practical probe for `listModels()`

```bash
claude -p "/model" --output-format json
```

**VERIFIED** output (abridged):

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "Current model: Fable 5 (effort: high)\nUsage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.",
  "session_id": "…",
  "total_cost_usd": 0,
  "usage": { "input_tokens": 0, "output_tokens": 0, … }
}
```

Parse the `Available: …` clause from `.result` into model ids. **No per-model effort list** in this output — efforts are model-family tables in docs (`low`…`max` / `xhigh`). Carry efforts as a static table or leave empty like grok.

Alternative (interactive only): `/model` picker. Gateway deployments may use `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` against `/v1/models` — **DOCS** model-config; not verified here.

**Risk:** `/model` in `-p` is a slash-command convenience (v2.1.205+ for several slash cmds in print mode per **DOCS** headless). Re-verify on version bump; tolerate parse failure and keep catalog hand-patches.

---

## 8. Token usage

### Where it appears

| Source | Fields | When | Evidence |
| --- | --- | --- | --- |
| **`result` event** (primary) | `usage.input_tokens`, `usage.output_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`, `usage.server_tool_use`, `usage.iterations[]`, **`total_cost_usd`**, **`modelUsage`** | End of run | **VERIFIED** |
| `result.modelUsage[<modelId>]` | `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`, **`contextWindow`**, `maxOutputTokens` | End of run | **VERIFIED** — includes **context window** (unlike codex/grok streams) |
| Mid-stream `assistant.message.usage` | Partial per-message usage | During stream | **VERIFIED** |
| `--output-format json` | Same usage on the single result object | One-shot | **VERIFIED** |

### Worked example (from real 2.1.211 capture)

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "session_id": "98428278-d240-475c-ad41-b840a6a42ffb",
  "total_cost_usd": 0.175672,
  "usage": {
    "input_tokens": 2,
    "cache_creation_input_tokens": 7923,
    "cache_read_input_tokens": 15042,
    "output_tokens": 43,
    "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
    "service_tier": "standard",
    "cache_creation": {
      "ephemeral_1h_input_tokens": 7923,
      "ephemeral_5m_input_tokens": 0
    },
    "iterations": [
      {
        "input_tokens": 2,
        "output_tokens": 43,
        "cache_read_input_tokens": 15042,
        "cache_creation_input_tokens": 7923,
        "type": "message"
      }
    ],
    "speed": "standard"
  },
  "modelUsage": {
    "claude-fable-5": {
      "inputTokens": 2,
      "outputTokens": 43,
      "cacheReadInputTokens": 15042,
      "cacheCreationInputTokens": 7923,
      "webSearchRequests": 0,
      "costUSD": 0.175672,
      "contextWindow": 1000000,
      "maxOutputTokens": 64000
    }
  },
  "terminal_reason": "completed"
}
```

**Adapter extraction:** on `type === "result"`, map numeric fields from `usage` into `VendorEvent.usage` (and optionally flatten `modelUsage` / `total_cost_usd`). Prefer the terminal `result` over mid-stream assistant usage (session totals). Multi-model runs (e.g. auto classifier) put multiple keys under `modelUsage` — **VERIFIED** in tool run (`claude-haiku-4-5-…` + `claude-fable-5`).

---

## 9. Adapter recommendation

### `prepare()` — proposed `SpawnPlan`

```ts
// Conceptual — not committed code
{
  argv: [
    "claude",
    "-p", task.prompt,
    "--output-format", "stream-json",
    "--verbose",
    // Hermetic MCP
    "--mcp-config", "<abs-or-rel path written via files[]>",
    "--strict-mcp-config",
    // Approvals / posture
    "--permission-mode", mapPermission(task.sandbox), // see table below
    // Optional: safer than full bypass when workspace
    // "--allowedTools", "Bash,Read,Edit,Write,mcp__parley__*",
    ...(task.model ? ["--model", task.model] : []),
    ...(task.effort ? ["--effort", task.effort] : []),
    // Optional isolation
    // "--bare",  // only if ANTHROPIC_API_KEY is always provisioned
    // "--settings", settingsPath,  // sandbox network, disableClaudeAiConnectors
    ...(task.gitDir ? ["--add-dir", task.gitDir] : []),
    ...(task.gitCommonDir ? ["--add-dir", task.gitCommonDir] : []),
  ],
  env: {
    ...(process.env.ANTHROPIC_API_KEY && {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    }),
    ...(process.env.CLAUDE_CODE_OAUTH_TOKEN && {
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    }),
    ...(process.env.ANTHROPIC_AUTH_TOKEN && {
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    }),
    // Raise MCP tool timeout above answerTimeoutMs (ms)
    MCP_TOOL_TIMEOUT: String(task.answerTimeoutMs + 60_000),
  },
  files: [
    {
      path: ".parley/claude-mcp.json", // gitignore / exclude from agent commits
      contents: JSON.stringify({
        mcpServers: {
          parley: {
            type: "http",
            url: hub.url,
            headers: hub.headers,
            timeout: task.answerTimeoutMs + 60_000,
          },
        },
      }),
    },
    // Optional settings for network-off / connector disable:
    // { path: ".parley/claude-settings.json", contents: "…" }
  ],
  cwd: task.cwd,
}
```

**Permission mapping helper:**

| `task.sandbox` | `--permission-mode` | `--allowedTools` (adapter-validation-a / #107) |
| --- | --- | --- |
| `read-only` | `dontAsk` (not `plan` — plan was unproven for hub MCP tool execution) | `Read,Grep,Glob,mcp__parley__*` |
| `workspace` | `acceptEdits` (not silent `bypassPermissions`) | `Read,Edit,Write,Bash,mcp__parley__*` |
| `full` | `bypassPermissions` | (none — full tool privilege) |

### `resume()` — proposed argv

Same as `prepare`, with resume id and follow-up prompt:

```text
claude -p <task.prompt> --resume <task.sessionId> --output-format stream-json --verbose \
  --mcp-config … --strict-mcp-config --permission-mode … [model/effort/add-dir]
```

Re-materialize MCP/settings files. **Require `task.sessionId`** — without it, Claude starts a new session (unlike a hard error). Fail loud in the adapter if missing (same as grok).

Optional: `--session-id <uuid>` on first prepare if Parley wants to pre-assign ids (**VERIFIED** works).

### Event-parse table (`parseEvent` → `VendorEvent`)

| Stream line | → `VendorEvent` | Notes |
| --- | --- | --- |
| `type: "system", subtype: "init"` | `{ kind: "session_meta", session_id }` | Primary session id capture |
| `type: "assistant"` with `content[].type === "text"` | `{ kind: "message", text }` | Concatenate text blocks; ignore pure thinking if desired |
| `type: "assistant"` with `content[].type === "tool_use"` | `{ kind: "command", text }` if `name === "Bash"` (use `input.command`); else opaque or `file_change` for Edit/Write | Map MCP tool failures separately if needed |
| `type: "user"` with `tool_result` | opaque `[]` (or message on error) | Raw log keeps full detail |
| `type: "result"` | `{ kind: "session_meta", session_id, usage }` + if `is_error`: `{ kind: "error", text: result, fatal: true }` | **Always** parse usage here; treat `is_error` as fatal |
| `type: "rate_limit_event"` | `[]` opaque | Optional future: surface as diagnostic |
| `type: "stream_event"` | `[]` or message deltas | Only with `--include-partial-messages` |
| Non-JSON / unknown | `[]` | Tolerant parser; raw JSONL is durable record |

`sessionId(events)`: last `session_meta.session_id` (same pattern as codex/grok).

### `listModels` (optional)

```ts
runProbe("claude", ["-p", "/model", "--output-format", "json"])
// parse .result "Available: a, b, c, …"
```

### Top risks / unknowns

1. **`--verbose` is mandatory for stream-json** — easy footgun; bake into argv. **VERIFIED**.
2. **Exit code ≠ success** — always read `result.is_error` / `terminal_reason`. **VERIFIED**.
3. **Config bleed** — default `-p` loads user MCP, plugins, skills, claude.ai connectors. Mitigate with `--strict-mcp-config`, optional `--bare`, `disableClaudeAiConnectors`. **VERIFIED**.
4. **`--bare` vs subscription auth** — bare mode ignores OAuth token/keychain; needs API key. Decide whether Parley children use API keys or host login. **VERIFIED**.
5. **MCP HTTP 60s first-byte timer** — set per-server `timeout` / `MCP_TOOL_TIMEOUT` above `answerTimeoutMs`. **DOCS**.
6. **Sandbox network vs MCP hub** — Bash sandbox network isolation is separate from Claude's MCP client; whether restricting `allowedDomains` breaks hub calls is **UNKNOWN** (not load-tested against a live hub). Allowlist `127.0.0.1` / `localhost` when enabling sandbox network lockdown.
7. **Model catalog probe is informal** — `/model` text parse can drift; efforts not enumerated by CLI. **VERIFIED** / **DOCS**.
8. **Permission mode vs MCP `requiresUserInteraction`** — org/connector tools can still block headless runs even under bypass. Ensure Parley tools don't set that meta flag. **DOCS**.
9. **Protected paths** (`.git`, `.claude`, `.mcp.json`, …) — not auto-approved except under `bypassPermissions`. Workspace `acceptEdits` may still prompt/deny edits under `.claude/`. Prefer not writing agent-owned files into protected paths; Parley materialization under `.parley/` is safer. **DOCS**.
10. **Rapid 2.1.x churn** — re-run `claude --help` and a golden stream capture at adapter implementation time; pin min version (suggest ≥ 2.1.205 for print-mode slash commands + capabilities field).

### Comparison to existing adapters

| Concern | Codex | Grok | Claude Code |
| --- | --- | --- | --- |
| Spawn | `codex exec --json` | `grok -p --output-format streaming-json` | `claude -p --output-format stream-json --verbose` |
| MCP inject | `-c` TOML overrides | Materialize `.grok/config.toml` | `--mcp-config` JSON (+ optional file) |
| Session id | `thread.started.thread_id` | `end.sessionId` | `system/init.session_id` + `result.session_id` |
| Resume | `codex exec resume <id>` | `-r <id>` | `--resume <id>` / `-r` |
| Usage | `turn.completed.usage` | none in stream | `result.usage` + `modelUsage` (**has contextWindow**) |
| Hermetic | `--ignore-user-config` | disable Claude scanners via env | `--strict-mcp-config` / `--bare` |

---

## Sources

- **VERIFIED** binary: Claude Code `2.1.211` (`claude --version`, `--help`, live `-p` runs, 2026-07-16).
- **DOCS**: [CLI reference](https://code.claude.com/docs/en/cli-reference), [Headless / programmatic](https://code.claude.com/docs/en/headless), [MCP](https://code.claude.com/docs/en/mcp), [Permission modes](https://code.claude.com/docs/en/permission-modes), [Sandboxing](https://code.claude.com/docs/en/sandboxing), [Authentication](https://code.claude.com/docs/en/authentication), [Environment variables](https://code.claude.com/docs/en/env-vars), [Model configuration](https://code.claude.com/docs/en/model-config).
- npm: `@anthropic-ai/claude-code@2.1.211`.
