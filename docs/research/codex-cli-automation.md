# Codex CLI — automation surface for Parley

Research asset for the wayfinder ticket [Research: Codex CLI automation surface](https://github.com/femoral/parley/issues/2). Verified against primary sources on 2026-07-09; Codex CLI release `rust-v0.144.0`. Docs are migrating from `developers.openai.com/codex/*` to `learn.chatgpt.com/docs/*` (308 redirects); the GitHub `docs/` folder is a stub index.

## TL;DR for Parley

Codex is a strong first adapter. Everything Parley needs exists per-invocation, with no mutation of the user's global config:

- **Spawn**: `codex exec --json "<prompt>"` in a worktree via `--cd <dir>`.
- **Model**: `-m <model>` (+ `-c model_reasoning_effort="high"`).
- **MCP injection**: `-c 'mcp_servers.parley.command="..."'` dot-notation TOML overrides — highest config precedence. Combine with `--ignore-user-config` for hermetic runs, or `CODEX_HOME=<dir>` for full isolation (must provision `auth.json` into that dir).
- **Auth**: `CODEX_API_KEY` env var — works *only* with `codex exec`, which is exactly the Parley case.
- **Reports**: JSONL event stream (`--json`) plus `--output-last-message <file>`; optionally `--output-schema <file>` to force the final message into a JSON Schema.
- **Instructions**: reads `AGENTS.md` (root→cwd walk); skills live in `.agents/skills`.

Main caveat: **no mid-run steering of `codex exec`** — a live question channel must come from Parley's own MCP server (child calls `ask_orchestrator` and blocks on the tool call), not from injecting messages into the session. That fits Parley's decided architecture exactly.

## 1. Non-interactive execution

- `codex exec "PROMPT"` (alias `codex e`); `codex exec -` reads prompt from stdin. If both arg and piped stdin exist, arg = instruction, stdin = context.
- Human mode: progress → stderr, final message → stdout.
- `--json`: JSONL events to stdout. Event types (from `codex-rs/exec/src/exec_events.rs`): `thread.started` (carries `thread_id`), `turn.started`, `turn.completed` (usage), `turn.failed` (error), `item.started`, `item.updated`, `item.completed`, `error`. Item types: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `collab_tool_call`, `web_search`, `todo_list`, `error`.
- `-o/--output-last-message <path>`: final assistant message to a file.
- `--output-schema <path>`: constrain final message to a JSON Schema.
- Exit codes are **binary**: 0 success, 1 fatal. Parse `turn.failed`/`error` events for detail.
- Other flags: `--ephemeral` (no session persistence — also not resumable), `--skip-git-repo-check`, `--ignore-user-config`, `--ignore-rules`.

Sources: [non-interactive docs](https://developers.openai.com/codex/noninteractive), [CLI reference](https://developers.openai.com/codex/cli/reference).

## 2. Model selection

- Flag `-m/--model`; config `model = "gpt-5.6"`, `model_reasoning_effort = "high"` (values up to `"xhigh"`). Per-invocation via `-c model="..."`.
- Custom providers: `model_provider` + `[model_providers.<id>]` (`base_url`, `env_key`, `http_headers`). Built-in ids `openai`, `ollama`, `lmstudio` are reserved.
- Model ids move fast — Parley should pass the model string through opaquely, not validate against a list.

Sources: [config basics](https://developers.openai.com/codex/config-basic), [advanced](https://developers.openai.com/codex/config-advanced).

## 3. MCP client config (the Parley injection point)

`[mcp_servers.<name>]` in config.toml supports:

- **stdio**: `command` (required), `args`, `env`, `env_vars` (allowlist of env vars to forward), `cwd`.
- **Streamable HTTP**: `url` (required), `auth` (`oauth`|`chatgpt`), `bearer_token_env_var`, `http_headers`.
- Universal: `startup_timeout_sec` (10), `tool_timeout_sec` (**default 60 — see gotchas**), `enabled`, `required` (fail startup if unavailable), `enabled_tools`/`disabled_tools`, `default_tools_approval_mode` (`auto`|`prompt`|`writes`|`approve`).

**Per-invocation injection, three mechanisms:**

1. `-c` dot-notation TOML overrides (highest precedence): `-c 'mcp_servers.parley.command="parley-mcp"' -c 'mcp_servers.parley.args=["--task","<id>"]'`.
2. `CODEX_HOME=<dir>` — full config/auth/session isolation; auth must be provisioned in.
3. Project-level `.codex/config.toml` — but loads **only for trusted projects**, so unreliable for fresh worktrees.

Config precedence (highest first): CLI flags & `-c` → project `.codex/config.toml` → profile file (`~/.codex/<name>.config.toml`, `--profile`) → user config → `/etc/codex/config.toml` → defaults.

`codex mcp add` writes the user config — not for Parley's use.

Sources: [MCP docs](https://developers.openai.com/codex/mcp), [config reference](https://developers.openai.com/codex/config-reference).

## 4. Sandbox & approvals

- `--sandbox/-s`: `read-only | workspace-write | danger-full-access`. **`codex exec` defaults to read-only** — Parley must pass `--sandbox workspace-write` for it to edit the worktree.
- `[sandbox_workspace_write]`: `writable_roots`, network config (network **off by default** in workspace-write).
- `--ask-for-approval/-a`: `untrusted | on-request | never`. **`--full-auto` is deprecated** (warns); `--dangerously-bypass-approvals-and-sandbox` has alias `--yolo`.
- Linux sandbox now bubblewrap (user namespaces + Landlock); macOS Seatbelt; native Windows sandbox exists.

Sources: [sandboxing](https://developers.openai.com/codex/sandboxing), [security](https://developers.openai.com/codex/security).

## 5. Working directory & AGENTS.md

- `--cd/-C <dir>` sets the workspace root; works fine with git worktrees (project root = git root, resolved per worktree). `--skip-git-repo-check` if not a repo.
- AGENTS.md discovery: global `$CODEX_HOME/AGENTS.override.md` else `AGENTS.md`; then project walk **root→cwd**, per directory `AGENTS.override.md` > `AGENTS.md` > `project_doc_fallback_filenames`. Concatenated, closer-to-cwd later. Combined cap `project_doc_max_bytes` (default **32 KiB, silently truncates**).
- Also `.rules` files (skippable with `--ignore-rules`) and a hooks system (`hooks.json`, e.g. `PreToolUse`).

Implication for worktree config translation: Parley generates/symlinks `AGENTS.md` at worktree root; keep under 32 KiB; never emit `AGENTS.override.md` (invisible behavior override).

## 6. Session resume / steering

- `codex exec resume <SESSION_ID>` or `codex exec resume --last "follow-up"` (`--last` is **cwd-scoped** — safe across worktrees, races within one dir). `thread_id` comes from the `thread.started` JSON event.
- **No injecting messages into a running `codex exec`.** Live-steering alternatives: `codex mcp-server` (tools `codex` / `codex-reply` with `threadId`; threads die with the process) or `codex app-server` (JSON-RPC over stdio, supports interrupts and mid-session input — the IDE-integration protocol).
- `codex fork` can branch a finished session into a new task with transcript preserved.

## 7. Skills & project instructions

- Skills are first-class, Claude-style `SKILL.md` (name/description frontmatter). Discovery: repo `.agents/skills` (cwd→root walk) → `$HOME/.agents/skills` → `/etc/codex/skills` → built-in. Optional `agents/openai.yaml` per skill (invocation policy, tool deps). Enable/disable via `[[skills.config]]`.
- Translation note for Parley: `.claude/skills` → `.agents/skills` symlink is plausible since the SKILL.md format matches; verify per-skill compatibility rather than assuming.

Source: [skills docs](https://developers.openai.com/codex/skills).

## 8. Codex as MCP server (alternative integration path)

`codex mcp-server` runs Codex itself as a stdio MCP server exposing `codex` (new session; prompt + sandbox/approval/model/cwd overrides) and `codex-reply` (continue by `threadId`). Marked experimental; threads persist only for the server process lifetime and accumulate memory. This is a viable *alternative* to `codex exec` for the adapter — it gives multi-turn without respawning — but adds a long-lived process per… evaluate in the channel-design ticket. Interface doc: [codex_mcp_interface.md](https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md).

## 9. Auth (headless)

- `CODEX_API_KEY` env var: per-invocation API-key auth, **`codex exec` only** — the clean orchestrator path.
- Or ChatGPT login cached in `$CODEX_HOME/auth.json` (or OS keyring; `cli_auth_credentials_store`). Headless: `codex login --device-auth` (beta), copying `auth.json`, or enterprise `CODEX_ACCESS_TOKEN`.
- `codex login status` for preflight checks.

Source: [auth docs](https://developers.openai.com/codex/auth).

## Gotchas for Parley

1. `codex exec` defaults to **read-only sandbox** — always pass an explicit `--sandbox`.
2. Exit codes are 0/1 only — failure detail must come from the event stream.
3. `CODEX_API_KEY` is exec-only; interactive `codex` ignores it.
4. MCP `tool_timeout_sec` defaults to 60s — an `ask_orchestrator` call that waits on a human answer will time out unless Parley sets a large/infinite `tool_timeout_sec` on its injected server config. **Load-bearing for the Q&A design.**
5. `.codex/config.toml` only loads for *trusted* projects — fresh worktrees may skip it; prefer `-c` flags.
6. `--ephemeral` kills resumability; don't use it if post-hoc steering matters.
7. AGENTS.md combined 32 KiB cap, silent truncation; `AGENTS.override.md` silently wins over `AGENTS.md`.
8. Docs host churn (learn.chatgpt.com); pin findings to release `rust-v0.144.0` and re-verify flags at implementation time.
