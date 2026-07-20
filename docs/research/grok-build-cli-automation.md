# Grok Build CLI — automation surface for Parley

Research asset for the wayfinder ticket [Research: Grok Build CLI automation surface](https://github.com/femoral/parley/issues/3). Base surface verified 2026-07-09 (Grok Build ~v0.2.73); **session provenance / hooks** re-verified live on 2026-07-20 against Grok Build **0.2.106** (beta, ~daily releases, closed source). Docs: [docs.x.ai/build](https://docs.x.ai/build/overview). Not to be confused with the unrelated community project `superagent-ai/grok-cli`.

## TL;DR for Parley

Grok Build (`grok` binary, Rust, installed via `curl -fsSL https://x.ai/cli/install.sh | bash`) is workable but rougher than Codex:

- **Spawn**: `grok -p "<prompt>" --cwd <worktree> --output-format streaming-json -m <model>` with `XAI_API_KEY`.
- **MCP injection**: no `-c`-style CLI override. Documented route: write **`.grok/config.toml` into the worktree** (project scope explicitly allows `[mcp_servers]`, `[plugins]`, `[permission]`). Parley owns the worktree, so this is effectively per-invocation. Alternatives: per-child `GROK_HOME`, or Claude-format `.mcp.json` (Grok reads it natively).
- **Q&A/steering**: best surface is **ACP** (`grok agent stdio`, JSON-RPC over stdio with streamed `session/update` events) — a persistent process per task, unlike Codex. Headless multi-turn also works via `grok -p ... -s <session-id>` respawns.
- **Big compat win**: Grok Build natively reads `CLAUDE.md`, `.claude/rules/`, Claude skills/agents/MCP/hooks (`GROK_CLAUDE_*_ENABLED=1` defaults) and the `AGENTS.md` family. Config translation for Grok may be nearly a no-op — but the same scanners risk cross-contamination and may need explicit disabling per child.
- **Big risks**: streaming-json event schema and exit codes are **undocumented**; ~daily auto-updates. Pin version + `--no-auto-update`, snapshot real output, tolerant parser.

## 1. Product identity

- **Grok Build**, binary `grok`, Rust, closed source (inferred: binary-only distribution, no xai-org repo). Beta since 2026-05-14. Latest confirmed 0.2.73 (2026-06-28) via [releasebot.io/updates/xai](https://releasebot.io/updates/xai); official changelog `x.ai/build/changelog` returns 403 to non-browser fetchers.
- Access: SuperGrok/X Premium+ browser login, or pay-per-token `XAI_API_KEY`.

## 2. Non-interactive execution

Source: [headless-scripting](https://docs.x.ai/build/cli/headless-scripting)

- `grok -p "prompt"` (`--single`) — one prompt then exit. stdin-prompt not documented.
- `--output-format plain | json | streaming-json`. `json` = single object at completion; `streaming-json` = JSONL. **Event schema undocumented** — examples look ACP-shaped (`session/update`, `agent_message_chunk`). Snapshot per pinned version.
- `--json-schema <schema>` constrains the final answer to a JSON Schema (added ~v0.2.67).
- `--no-alt-screen`, `--no-auto-update`.
- **Exit codes undocumented** — treat non-zero as generic failure, verify empirically.

## 3. Model selection

- `-m/--model <MODEL>` per invocation. Default model now `grok-4.5` (2026-07-08; reasoning effort low/medium/high, default high). Env `GROK_DEFAULT_MODEL`.
- `--reasoning-effort <EFFORT>` (alias `--effort`) per invocation — verified in grok 0.2.93 (2026-07-12); earlier finding "config/env only" is stale. Allowed values undocumented in `--help`; config `[models] default_reasoning_effort` remains the fallback.
- Config `[models]`: `default`, `default_reasoning_effort`, per-purpose models (`session_summary`, `web_search`…), `allowed_models`/`disabled_models` globs.
- **Model enumeration**: `grok models` lists the default + available model ids as plain text (no `--json`, no per-model efforts). Format unpinned — parse defensively, snapshot per pinned version.
- BYOK first-class: `[model.<id>]` with `base_url`, `api_backend = "chat_completions" | "responses" | "messages"`, `env_key`, `context_window`. Envs: `GROK_XAI_API_BASE_URL` etc.

Source: [settings reference](https://docs.x.ai/build/settings/reference).

## 4. MCP client (Parley injection point)

Source: [mcp-servers](https://docs.x.ai/build/features/mcp-servers)

- TOML `[mcp_servers.<name>]` in `~/.grok/config.toml` or **project `.grok/config.toml`** (project scope limited to `[mcp_servers]`, `[plugins]`, `[permission]`; project overrides user by name).
  - stdio: `command`, `args`, `env`, `cwd`, `enabled`, `startup_timeout_sec` (30), **`tool_timeout_sec` (default 6000)**, per-tool `tool_timeouts`.
  - HTTP/SSE: `url`, `headers`, `bearer_token_env_var`; headers interpolate `${VAR}`, `${VAR:-default}`, and **`{{session_id}}`** — child sessions can self-identify to Parley's hub with zero plumbing.
- `grok mcp add [--scope project] [--transport http] ...`, `list`, `remove`, `doctor`; `grok inspect` shows all discovery in cwd.
- **No `--mcp-config`-style flag.** Per-invocation routes: (1) write `.grok/config.toml` in the worktree — documented, intended; (2) `GROK_HOME=<dir>` full isolation (config/auth/sessions/skills — must provision credentials); (3) compat files `.mcp.json`, `.claude.json`, `.cursor/mcp.json`.
- Timeout envs: Claude-compatible `MCP_TIMEOUT` (ms) checked **before** `GROK_MCP_STARTUP_TIMEOUT_SECS` — an env already exporting `MCP_TIMEOUT` for Claude leaks into Grok children.

## 5. Sandbox & approvals

Source: [modes-and-commands](https://docs.x.ai/build/modes-and-commands), settings reference.

- `permission_mode = "ask"` (default) | `"always-approve"`; CLI `--always-approve`. Rule strings under `[permission]`: `allow`/`deny`/`ask` (e.g. `Bash(git *)`, `Read(src/**)`), deny > ask > allow. Project-scoped rules OK.
- Sandbox: `GROK_SANDBOX = off (default) | workspace | read-only | strict | <custom>`; custom profiles in `sandbox.toml` (`restrict_network`, `read_only`, `read_write`, `deny`). `GROK_SANDBOX_AUTO_ALLOW_BASH=1` skips bash prompts inside sandbox. `GROK_WRITE_FILE=0` for read-only sessions.
- **Headless still defaults to `ask` — a bare `grok -p` can stall awaiting approval.** Recommended child posture: `GROK_SANDBOX=workspace` + `--always-approve` or explicit allow-rules.

## 6. Working directory / worktrees

- `--cwd <PATH>` per invocation. Discovery (instructions/skills/config) walks cwd → repo root, so a linked worktree's own files win.
- Native worktree features exist (`new_session_worktree_mode`, `fork_worktree_mode`, subagent worktrees). Since Parley creates worktrees itself, set `new_session_worktree_mode = "never"` in the injected project config (inferred recommendation).

## 7. Project instructions & extensibility

Source: [skills-plugins-marketplaces](https://docs.x.ai/build/features/skills-plugins-marketplaces)

- Instructions: **AGENTS.md family** (`AGENTS.md`, `AGENT.md`…) walked cwd→root, **plus native Claude compat**: `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/`. No `GROK.md`. Precedence between families undocumented.
- Skills: `./.grok/skills/`, `~/.grok/skills/`, `~/.agents/skills/`, plugin skills. Plugins `./.grok/plugins/` + `--plugin-dir`. Hooks: see **§10 Session provenance / hooks** — project hooks need folder trust; user/plugin hooks work headless.
- Claude/Cursor scanners (skills, agents, MCP, hooks) default **on** (`GROK_CLAUDE_*_ENABLED`, `GROK_CURSOR_*_ENABLED`) — disable per child if cross-contamination with Claude Code config is unwanted, or exploit it as free config translation.
- Subagents gated behind `GROK_SUBAGENTS` (default off).

## 8. Session resume / steering

- Headless sessions: `-s/--session-id <ID>` (create/resume named), `-r/--resume <ID>`, `-c/--continue` (latest in cwd). Stored in `$GROK_HOME/sessions`. Multi-turn = repeated `grok -p ... -s <id>`.
- **ACP (Agent Client Protocol)**: `grok agent stdio` = JSON-RPC server on stdio (`initialize → authenticate → session/new → session/prompt`, streamed `session/update` events, `session/cancel`). Best orchestration surface: persistent process, streaming, cancellation. Mid-turn interjection exists in the product (release notes v0.2.62–0.2.70) but over ACP specifically is unverified — test empirically. Community ACP clients exist (grok-remote, acpx; Zed integration).
- No SDK; ACP is the SDK.

## 9. Auth (headless)

- **`XAI_API_KEY`** env — fully suppresses browser login since v0.2.72. Bills per-token against xAI API (subscription entitlements ride browser login only — inferred).
- `grok login` / `grok login --device-auth`; credentials under `$GROK_HOME` (filename undocumented). Per-model BYOK via `[model.<id>] env_key`.

## 10. Session provenance / hooks (ADR-0013 / issue #193)

**Question (ADR-0013):** does Grok Build expose a **deterministic session-start signal** — a hook/plugin lifecycle event that runs before/without model involvement — from which a plugin could export `PARLEY_SESSION_ID`, `PARLEY_HARNESS`, `PARLEY_MODEL`, `PARLEY_EFFORT` into the session environment from harness ground truth?

**Short answer (verified Grok Build 0.2.106, 2026-07-20):**

| Capability | Result |
|------------|--------|
| Deterministic session-start signal | **Yes** — lifecycle event `SessionStart` |
| Session id available live at that point | **Yes** — `GROK_SESSION_ID` env + stdin `sessionId` |
| Model available live at that point | **No** — not on hook stdin/env |
| Reasoning effort available live at that point | **No** — not on hook stdin/env |
| Hook can inject env into the session / tool processes | **No** — passive-hook stdout is ignored; Claude-style `updatedEnv` does not apply |

So: the harness **does** expose the required deterministic signal and ground-truth session id. It does **not** currently let a plugin complete the ADR-0013 env-injection contract for all four vars (no session-env mutation; model/effort absent from the live hook surface).

Sources: shipped user guide `~/.grok/docs/user-guide/10-hooks.md` and `09-plugins.md`; online [Hooks](https://docs.x.ai/build/features/hooks) and [Skills/Plugins](https://docs.x.ai/build/features/skills-plugins-marketplaces); live headless probes with a temporary user-level hook (removed after measurement).

### 10.1 Mechanism (deterministic, no model)

- **Event name:** `SessionStart` (snake_case on the wire: `session_start` / `GROK_HOOK_EVENT=session_start`). Cursor alias `sessionStart` is accepted.
- **Why deterministic:** the harness runs the hook as a **child process** when the session is created. It is not a model tool call. Live `updates.jsonl` shows `hook_execution` / `event_name: session_start` as the **first** session event, before `user_prompt_submit` and any model turn.
- **Handler types:** `type: "command"` (shell) or `type: "http"` (POST event JSON). Default timeout 5s; failures are fail-open.
- **Passive contract:** only `PreToolUse` is blocking. For `SessionStart` and other passive events, **stdout is ignored** — exit 0 on success. Official docs and online Hooks page both state this.
- **Also fires:** `UserPromptSubmit`, `PreToolUse` / `PostToolUse` / `PostToolUseFailure`, `PermissionDenied`, `Stop` / `StopFailure`, `Notification`, `SubagentStart` / `SubagentStop`, `PreCompact` / `PostCompact`, `SessionEnd`. None of the later events add model/effort to the hook envelope either (verified for `UserPromptSubmit` and `PreToolUse`).

### 10.2 Hook discovery paths and trust

| Scope | Path | Trusted? | Headless-usable? |
|-------|------|----------|------------------|
| User hooks | `~/.grok/hooks/*.json` | Always | **Yes** (verified) |
| Project hooks | `<project>/.grok/hooks/*.json` | Folder trust (`/hooks-trust` or `--trust`) | Only if folder already trusted |
| Plugin hooks | `hooks/hooks.json` inside an installed/enabled/trusted plugin | Per-plugin trust | **Yes** when installed with `--trust` (user plugins auto-trust for location; hooks still need the plugin trusted/enabled) |
| Claude/Cursor compat | `~/.claude/settings.json`, `~/.cursor/hooks.json`, project equivalents | User always / project needs trust | Same trust rules |

Compat scanners can be disabled via `GROK_CLAUDE_HOOKS_ENABLED=0` / `GROK_CURSOR_HOOKS_ENABLED=0` (or config `[compat.<vendor>] hooks = false`).

**Implication for `@useparley/plugin-grok`:** prefer a **user-scoped plugin install** (or `~/.grok/hooks/`), not project `.grok/hooks/` inside an untrusted worktree. Project hooks are the ones that previously looked “headless-unusable.”

### 10.3 Live metadata on `SessionStart` (what a plugin can read)

**Injected into the hook process environment (always):**

| Variable | Meaning |
|----------|---------|
| `GROK_HOOK_EVENT` | e.g. `session_start` |
| `GROK_HOOK_NAME` | configured hook name (plugin-prefixed for plugin hooks) |
| `GROK_SESSION_ID` | **real session UUID** (matches `-s/--session-id` when set, else harness-generated) |
| `GROK_WORKSPACE_ROOT` | workspace root |
| `CLAUDE_PROJECT_DIR` | alias of workspace root |

**Plugin hooks also get:** `GROK_PLUGIN_ROOT`, `GROK_PLUGIN_DATA` (plus Claude aliases `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA`).

**JSON on stdin (live capture, headless `grok -p`, new session):**

```json
{
  "hookEventName": "session_start",
  "sessionId": "<uuid>",
  "cwd": "<cwd>",
  "workspaceRoot": "<workspace>",
  "timestamp": "<rfc3339>",
  "source": "new"
}
```

Fields observed: `hookEventName`, `sessionId`, `cwd`, `workspaceRoot`, `timestamp`, `source` (`"new"` for a fresh session). **No `model`, `modelId`, `effort`, `reasoningEffort`, or equivalent.**

**How a plugin would map ADR-0013 vars (if env injection existed):**

| Env var | Live harness source? | Notes |
|---------|----------------------|-------|
| `PARLEY_SESSION_ID` | **Yes** | `$GROK_SESSION_ID` or stdin `.sessionId` |
| `PARLEY_HARNESS` | N/A (constant) | Plugin would hardcode `grok` (parley vendor id) — not harness-provided |
| `PARLEY_MODEL` | **No** | Not on hook surface. Config/CLI (`-m`, `GROK_DEFAULT_MODEL`, `[models] default`) are process inputs, not exposed to the hook. Wire id may differ from CLI id (e.g. CLI `grok-4.5` → usage key `grok-4.5-build`) |
| `PARLEY_EFFORT` | **No** | Not on hook surface. CLI `--reasoning-effort` / `--effort` and config `[models] default_reasoning_effort` are not passed in |

**Where model/effort *do* appear (after the fact, not live hook surface):** session dir under `$GROK_HOME/sessions/.../<session-id>/`:

- `summary.json`: `current_model_id`, `reasoning_effort` (e.g. `"low"` / `"high"`)
- `signals.json`: `modelsUsed`, `primaryModelId`
- `updates.jsonl`: later events carry `_meta.modelId` (e.g. on `user_message_chunk`), not on the initial `SessionStart` hook_execution record

Those files are session-log / summary artifacts written around the session, not inputs to `SessionStart`. Per ADR-0013, log scrape is out of scope for this research pass.

### 10.4 Can a hook influence the session environment?

**No — not for passive hooks including `SessionStart`.**

Evidence:

1. **Documented contract:** “For passive events, stdout is ignored; exit 0 on success” ([Hooks](https://docs.x.ai/build/features/hooks); shipped `10-hooks.md`).
2. **Marketing wording is misleading:** the same guide says a `SessionStart` hook can “export environment variables,” but that only describes what the *hook subprocess* can do for itself; it is not a parent-session env API.
3. **Live probe:** a `SessionStart` command hook emitted Claude Code–style JSON (`updatedEnv`, `env`, `hookSpecificOutput.additionalContext`, `systemMessage`). Subsequent `PreToolUse` hooks did **not** see those vars; a `run_terminal_command` tool process also did **not** inherit them. Model thought text reported the probe vars empty.
4. **Tool processes do not even inherit `GROK_SESSION_ID`:** a tool `env | grep GROK_` listing showed sandbox/agent flags (`GROK_AGENT`, `GROK_SANDBOX`, …) but **not** `GROK_SESSION_ID`. Session id is hook-runner–injected only.
5. **Binary surface:** no `updatedEnv` / session-env-apply symbols found; hook output handling is allow/deny for `PreToolUse` only.

**Nearest related mechanism (not env injection):** HTTP MCP server configs can interpolate `{{session_id}}` in headers (see §4) — useful for hub correlation, not for setting `PARLEY_*` in the orchestrator session env.

Hook JSON may declare a static `env` map for **that hook process only** (cannot override reserved `GROK_*` runner keys). That does not propagate to the model turn or tools.

### 10.5 Plugin package format and install / uninstall

**Layout (convention directories; manifest optional):**

```text
my-plugin/
  plugin.json                 # optional metadata (name, version, …)
  # or .claude-plugin/plugin.json (Claude-compat layout also loads)
  hooks/
    hooks.json                # lifecycle hooks
    session-start.sh          # command scripts (paths relative to hooks JSON)
  skills/ … agents/ …         # optional other components
  .mcp.json / .lsp.json       # optional
```

Example `hooks/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "session-start.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

**Install (CLI):**

```bash
grok plugin install <source> --trust
# <source> = local path | github user/repo[@ref|#subdir] | git URL
grok plugin enable <name>          # if not already active
# config may also need:
# [plugins]
# enabled = ["<name-or-id>"]
```

Without `--trust`, install warns and does not activate hooks/MCP. User-scoped discovery also includes `~/.grok/plugins/` (auto-trusted location) and `[plugins] paths`. Process-only: `grok agent --plugin-dir <PATH>` (always trusted; not leader mode).

**Uninstall:**

```bash
grok plugin uninstall <name>       # aliases: rm, remove
# optional: --keep-data  (preserves GROK_PLUGIN_DATA)
grok plugin disable <name>         # keep files, stop loading
```

**Enable vs trust:** enabling loads skills/commands/agents; **trust** gates whether hooks/MCP/LSP *run*. Both are required for a provenance plugin’s `SessionStart` hook to execute. Docs note plugins are disabled by default unless enabled via config/CLI after install — install docs should call out `enable` / `[plugins] enabled`.

**Inspect:** `grok plugin list`, `grok plugin details <name>`, `grok inspect` (shows Hooks section).

### 10.6 Verdict for `@useparley/plugin-grok`

- **Deterministic signal: yes** — `SessionStart` command (or HTTP) hook, no model involvement; works headless for user/plugin-trusted scopes.
- **Partial ground truth only:** session id yes; model and effort **not** exposed on the live hook surface.
- **Env export into the session: no** — cannot fulfill “export `PARLEY_*` into the session’s environment” with the current hook contract.
- **Recommendation back to umbrella (#181 / #193):** treat Grok as having a real session-start hook, but **blocked on full ADR-0013 env provenance** until either (a) Grok gains session-env injection (or documents an equivalent), and/or (b) model + effort appear on the `SessionStart` envelope — decisions for the umbrella issue, not silent log scrape.

## Gotchas for Parley

1. **No per-invocation MCP flag** — injection is file-based (`.grok/config.toml` in worktree) or `GROK_HOME`. Parley's worktree ownership makes this fine, but it means the adapter writes files, not just flags.
2. **Undocumented streaming-json schema + exit codes** — pin version (`--no-auto-update` / `GROK_DISABLE_AUTOUPDATER=1`), snapshot output, tolerant parser. `--json-schema` is the reliable structured-output lever.
3. **Headless stalls on approval by default** — always set permission posture explicitly.
4. **Claude-config bleed, both directions**: Grok reads `CLAUDE.md`/`.claude/*`/`.mcp.json` by default. Free translation win, cross-contamination risk. Decide per-child via `GROK_CLAUDE_*_ENABLED`.
5. **`MCP_TIMEOUT` (ms, Claude convention) silently applies** to Grok children if exported in the environment.
6. **`{{session_id}}` HTTP-header interpolation** — free session correlation for an HTTP-transport hub.
7. `tool_timeout_sec` default 6000s (100 min) — generous, unlike Codex's 60s; human-latency `ask_orchestrator` fine by default.
8. **ACP vs `-p` respawn** is a real adapter design fork — Codex has no ACP equivalent (its analog is `codex app-server`/`codex mcp-server`). The channel-design ticket should decide whether adapters are "spawn per turn" or "persistent protocol process".
9. Whether project-level MCP servers trigger a trust prompt in headless is **undocumented** — must test before relying on route (1).
10. **Session provenance (#193):** `SessionStart` is a real deterministic hook with live `GROK_SESSION_ID`, but it **cannot** inject env into the session and does **not** expose model/effort — see §10.
