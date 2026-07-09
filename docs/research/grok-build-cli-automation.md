# Grok Build CLI — automation surface for Parley

Research asset for the wayfinder ticket [Research: Grok Build CLI automation surface](https://github.com/femoral/parley/issues/3). Verified against primary sources on 2026-07-09; Grok Build ~v0.2.73 (beta, ~daily releases, closed source). Docs: [docs.x.ai/build](https://docs.x.ai/build/overview). Not to be confused with the unrelated community project `superagent-ai/grok-cli`.

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
- Config `[models]`: `default`, `default_reasoning_effort`, per-purpose models (`session_summary`, `web_search`…), `allowed_models`/`disabled_models` globs. **No headless flag for reasoning effort** — config/env only.
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
- Skills: `./.grok/skills/`, `~/.grok/skills/`, `~/.agents/skills/`, plugin skills. Plugins `./.grok/plugins/` + `--plugin-dir`. Hooks exist but **project hooks require interactive `/hooks-trust`** — unusable in headless children.
- Claude/Cursor scanners (skills, agents, MCP, hooks) default **on** (`GROK_CLAUDE_*_ENABLED`, `GROK_CURSOR_*_ENABLED`) — disable per child if cross-contamination with Claude Code config is unwanted, or exploit it as free config translation.
- Subagents gated behind `GROK_SUBAGENTS` (default off).

## 8. Session resume / steering

- Headless sessions: `-s/--session-id <ID>` (create/resume named), `-r/--resume <ID>`, `-c/--continue` (latest in cwd). Stored in `$GROK_HOME/sessions`. Multi-turn = repeated `grok -p ... -s <id>`.
- **ACP (Agent Client Protocol)**: `grok agent stdio` = JSON-RPC server on stdio (`initialize → authenticate → session/new → session/prompt`, streamed `session/update` events, `session/cancel`). Best orchestration surface: persistent process, streaming, cancellation. Mid-turn interjection exists in the product (release notes v0.2.62–0.2.70) but over ACP specifically is unverified — test empirically. Community ACP clients exist (grok-remote, acpx; Zed integration).
- No SDK; ACP is the SDK.

## 9. Auth (headless)

- **`XAI_API_KEY`** env — fully suppresses browser login since v0.2.72. Bills per-token against xAI API (subscription entitlements ride browser login only — inferred).
- `grok login` / `grok login --device-auth`; credentials under `$GROK_HOME` (filename undocumented). Per-model BYOK via `[model.<id>] env_key`.

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
