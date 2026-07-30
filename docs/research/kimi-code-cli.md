# Kimi Code CLI — automation surface for Parley

Research ticket asset: can Parley add a vendor adapter for **Kimi Code**
(Moonshot AI's terminal coding agent)? This document was written from public
docs/repo research only — no local install or execution of the binary was
performed in this environment. Claims are tagged **DOCS** (cited URL),
**UNVERIFIED** (could not confirm from available sources; flagged explicitly,
not guessed), or **VERIFIED** (re-checked against the primary source during a
later adversarial validation pass — note this still means "confirmed in the
official docs/repo," not "confirmed by running the binary," which the
codex/goose docs mean by VERIFIED). Corrections applied in that pass are marked
inline with *Correction:*.

Kimi Code is the *current* product name; it superseded an earlier Python CLI
called `kimi-cli` (`MoonshotAI/kimi-cli`), now described by Moonshot as
"evolving into Kimi Code CLI." Some docs pages still live under the
`kimi-cli` docs domain/URL path even though they describe the current
TypeScript CLI — this doc cites whichever page had the content, noting the
legacy-domain caveat where relevant.

## TL;DR for Parley

Kimi Code **can** support one-shot headless automation and looks like a
strong adapter candidate — closer in shape to Codex (flags-only, JSON event
stream, resumable sessions, native MCP-over-HTTP client) than to weaker
targets like Grok:

| Need | Kimi Code surface | Fit |
| --- | --- | --- |
| One-shot headless | `kimi -p "<prompt>" --output-format stream-json` | Good |
| Streaming JSON events | `--output-format stream-json` (JSONL: user/assistant/tool records) | Good, but event *type* taxonomy beyond message/tool_call/tool-result is UNVERIFIED |
| MCP-over-HTTP + custom headers | `mcp.json` — `url` + `headers` + `toolTimeoutMs`/`startupTimeoutMs` | Good (file materialization, same shape as Grok's `.grok/config.toml`) |
| Session resume | `-S/--session <id>` (alias `-r/--resume`); auto-prints a `kimi -r <id>` hint on exit | Plausible but **combining `-S <id>` with `-p` for a non-interactive follow-up turn is UNVERIFIED** — no doc source confirms this composition |
| Sandbox / network | **No OS-level sandbox** (no landlock/seccomp/container mode found); only an approval-prompt model (`--yolo` / `--auto` / per-rule `[[permission.rules]]`) | Weak, same posture as Grok/Goose |
| Model selection | `-m/--model <alias>`; `KIMI_MODEL_*` env family for ad hoc provider/model without touching config | Good |
| Auth via env | **Not general-purpose** — provider API keys must live in `config.toml`; shell env vars for named providers (`KIMI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) are explicitly *not* read automatically. Only the `KIMI_MODEL_*` family is a real env channel. | Weak — needs a materialized/patched `config.toml`, not a passthrough env var like Codex's `CODEX_API_KEY` |
| Token usage | Wire-protocol JSONL under `~/.kimi-code` (or `KIMI_CODE_HOME`) records input/output/cache tokens; third-party tools (tokscale, ccusage) parse it. Whether `--output-format stream-json` on stdout itself carries a usage record is UNVERIFIED | Partial |
| Model enumeration | `kimi provider catalog list [providerId]` browses the models.dev catalog | Plausible `listModels()` source, exact JSON shape UNVERIFIED |

**Overall verdict: feasible, second-tier priority.** The headless/JSON/MCP
story is solid enough to write `prepare()`/`parseEvent()`/`sessionId()`
today. The two real gaps before this is a *safe* Parley vendor are (1)
auth — no plain env-var passthrough, so the adapter must materialize/patch
`config.toml` rather than just setting `env` on the `SpawnPlan`, and (2) no
verified non-interactive resume composition or sandbox mechanism — both need
a hands-on probe against a real install before `resume()`/posture-mapping
ship with confidence.

---

## 1. Identity, install, license

- Product: **Kimi Code CLI**, Moonshot AI's open-source terminal coding
  agent, TypeScript (94.7%), MIT-licensed, ~3.4k GitHub stars. [MoonshotAI/kimi-code
  README](https://github.com/MoonshotAI/kimi-code). Its predecessor
  [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli) is a
  **separate** repo — Python-majority, **Apache-2.0**, ~9.2k stars — "evolving
  into Kimi Code CLI," not a mirror of it. (VERIFIED against both repo pages;
  the license/language/stars differ between the two.)
- Language / runtime: TypeScript; distributed as a **single binary** (no
  Node.js required for the install-script/Homebrew path) or via npm
  (`npm install -g @moonshot-ai/kimi-code`, requires Node.js ≥22.19.0 —
  VERIFIED). Latest npm version at research time: `0.27.0` (repo). *UNVERIFIED:*
  the "development needs Node ≥24.15.0 + pnpm 10.33.0" figures were not found on
  the getting-started page and are not load-bearing for an adapter.
  [Getting started](https://moonshotai.github.io/kimi-code/en/guides/getting-started.html),
  [MarkTechPost coverage](https://www.marktechpost.com/2026/06/06/moonshot-ai-releases-kimi-code-cli-a-terminal-ai-coding-agent-built-in-typescript-for-next-gen-agents/).
- Install:
  - macOS/Linux: `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`
  - Homebrew: `brew install kimi-code`
  - Windows: `irm https://code.kimi.com/kimi-code/install.ps1 | iex` (needs
    Git for Windows; `KIMI_SHELL_PATH` env var for a custom Git Bash path)
  - npm: `npm install -g @moonshot-ai/kimi-code` (or `pnpm add -g …`)
  [Getting started](https://moonshotai.github.io/kimi-code/en/guides/getting-started.html).
- Default model: the CLI catalog key (and `default_model` value) is the
  **namespaced** form `kimi-code/kimi-for-coding`. Under
  `[models."kimi-code/kimi-for-coding"]`, the inner provider-level field is
  the bare name `model = "kimi-for-coding"`. Earlier notes that recorded only
  the bare `kimi-for-coding` as `default_model` were out of date relative to
  an authenticated kimi home. Backed by Moonshot's **Kimi K2.6** (VERIFIED
  via the model's own product page). *UNVERIFIED:* the specific
  "~1T total / ~32B active parameters, released 2026-04-20" figures — the
  cited MarkTechPost article does **not** mention Kimi K2.6, `kimi-for-coding`,
  parameter counts, or a release date, so those numbers had no supporting
  source in this pass.
  [Config files](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html),
  [Kimi K2.6 model page](https://www.kimi.com/ai-models/kimi-k2-6).
- Platform support: macOS, Linux, Windows (via Git for Windows shim).
  [Getting started](https://moonshotai.github.io/kimi-code/en/guides/getting-started.html).

## 2. Headless / non-interactive invocation

`kimi -p "<prompt>"` (long form `--prompt`) runs a single prompt
non-interactively and streams the assistant output to stdout, exiting when
the turn completes ("Run a single prompt non-interactively and stream the
Assistant output to stdout. This mode does not open the TUI" — VERIFIED on the
command reference). Print mode automatically enables an "afk" (away from
keyboard) posture that auto-approves tool calls **and** auto-dismisses any
`AskUserQuestion` — "`--print` implicitly enables `--afk`" (VERIFIED on the
interaction guide).

*Correction:* the earlier claim that `-p` "conflicts with `--yolo`/`--auto`/
`--plan` at the CLI-parser level (mutually exclusive, rejected at startup)" is
**UNVERIFIED / likely wrong** — the interaction guide and command reference
describe no such mutual exclusion or startup rejection between these flags.
Print mode implies auto-approve on its own, so an adapter need not pass
`--yolo`/`--auto`, but must not assume the parser rejects them either.
[`kimi` command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html),
[Interaction and Input (legacy `kimi-cli` docs domain, `--print`/`--afk`)](https://moonshotai.github.io/kimi-cli/en/guides/interaction.html),
[Print Mode doc (legacy `kimi-cli` docs domain, describes the same
mechanism)](https://moonshotai.github.io/kimi-cli/en/customization/print-mode.html).

Exit codes documented for print mode: `0` success, `1` permanent failure
(config/auth), `75` transient/retryable (rate limit, timeout).
[Print Mode](https://moonshotai.github.io/kimi-cli/en/customization/print-mode.html).

Caveat: the print-mode page describing exit codes and the exact JSON
transcript schema is hosted under the **legacy `kimi-cli` docs domain**
(`moonshotai.github.io/kimi-cli/...`), while the current `kimi-command`
reference lives under `moonshotai.github.io/kimi-code/...` /
`kimi.com/code/docs`. Both describe the `-p`/`--output-format` flags
consistently, so this is treated as the same feature documented on two doc
trees during the rename, but it is worth a live smoke-test before relying on
exit-code semantics.

## 3. Prompt passing

Three ways to pass the prompt, mirroring Codex/Claude Code conventions:

- argv: `kimi -p "instruction"`. *Correction:* `kimi -c "instruction"` for
  prompt content is a **legacy `kimi-cli`** form only. The current `kimi-code`
  command reference documents `-c` as `--continue` (resume most recent session)
  — VERIFIED — so an adapter must pass the prompt via `-p/--prompt`, never `-c`.
- stdin: `echo "Explain what this code does" | kimi --print` (note: doc
  text alternates between `--print` and `-p`/`--prompt` as the flag name
  across pages — see §4).
- JSONL input: `--input-format=stream-json` for structured input alongside
  `--output-format=stream-json`.

[Print Mode](https://moonshotai.github.io/kimi-cli/en/customization/print-mode.html),
[kimi command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html).

**Doc inconsistency — now resolved (VERIFIED):** the legacy `kimi-cli`
print-mode/interaction pages use a bare `--print` boolean flag in examples
(`kimi --print -p "..."`), while the current `kimi-code` command reference (both
the `kimi-code` GitHub-pages and `kimi.com/code/docs` mirrors) documents only
`-p/--prompt <prompt>` as the trigger for non-interactive mode, with **no**
separate `--print` boolean listed. Conclusion: `--print` is legacy naming;
**in current Kimi Code, `-p/--prompt` alone** triggers headless mode. An
adapter should wire `-p`, not `--print` (a stale `--print` flag would risk a
hard-fail against a `-p`-only parser). Still worth a `kimi --help` smoke-test
on the pinned binary version, since the two doc trees diverge.

## 4. Session resume

- `-S, --session [id]` — resume a specific session by id, or open an
  interactive picker with no id given.
- `-r` / `--resume` — documented alias for `--session` (VERIFIED on the
  Sessions guide, which lists `--session`, `--resume`, `-S`, `-r` together;
  the resume hint Kimi prints on exit uses `-r`).
- `-c, --continue` — resume the most recent session in the current
  directory (mutually exclusive with `--session`).
- On any session exit (normal, Ctrl-C, `/undo`, `/fork`, `/sessions`
  switch), Kimi Code prints a resume hint (`kimi -r <session-id>`) the user
  can copy for next time.
- If a given session id doesn't exist, Kimi Code silently starts a **new**
  session under that id rather than erroring — relevant for an adapter's
  `resume()`: a stale/garbage-collected session id degrades to a fresh
  session instead of a hard failure.
- In `--output-format stream-json`, Kimi Code "mints the session id and
  announces it via a `role:"meta", type:"session.resume_hint"` record on
  stdout," which is the session-id capture point an adapter's
  `sessionId(events)` would key on — analogous to Codex's `thread.started`
  event.

[Sessions and Context](https://moonshotai.github.io/kimi-cli/en/guides/sessions.html),
[kimi command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html),
[WebSearch synthesis citing the `session.resume_hint` meta record — could not
be independently confirmed on a primary docs page in this
research pass](https://www.kimi.com/resources/kimi-code-cheat-sheet).

**UNVERIFIED and load-bearing:** no primary doc page was found that shows
`-S <id>` combined with `-p "<follow-up>"` in one non-interactive command
(the ADR-0009 `resume()` shape parley needs — spawn, not attach). The
Sessions guide covers interactive resume only. A GitHub issue exists
requesting *the opposite* composition (keep interactive mode while seeding
an initial prompt) — [Feature Request #2240,
`MoonshotAI/kimi-cli`](https://github.com/MoonshotAI/kimi-cli/issues/2240) —
which is circumstantial evidence that `-p` + `-S` together may not yet be a
first-class, documented combination. Must be hands-on verified before an
adapter's `resume()` ships.

## 5. Structured output / event stream

`--output-format stream-json` (only valid alongside `-p`) emits one JSON
object per stdout line (JSONL):

- User message: `{"role": "user", "content": "instruction"}`
- Assistant reply: `{"role": "assistant", "content": "...", "tool_calls": [...]}`
  when the model calls a tool: `{"type": "function", "id": "tc_1",
  "function": {"name": "Shell", "arguments": "{...}"}}`
- Tool result: `{"role": "tool", "tool_call_id": "tc_1", "content": "result"}`
- Session/meta record announcing the session id (`role: "meta", type:
  "session.resume_hint"`, cited above but not independently confirmed on a
  primary page).

**UNVERIFIED** (was asserted as DOCS): "thinking content is not written to the
JSONL stream; tool-progress and 'resuming session' notices go to stderr, not
stdout." The print-mode page does **not** discuss thinking content or a
stderr/stdout split — this could not be confirmed from the cited sources and
must be checked against a real binary. `--final-message-only` (and its shortcut,
`--quiet` = `--print --output-format text --final-message-only`) trims to just
the final assistant message — VERIFIED on the print-mode page (both are legacy
`kimi-cli`-domain and are **not** listed on the current command reference; treat
as version-drift risk).

[Print Mode](https://moonshotai.github.io/kimi-cli/en/customization/print-mode.html),
[kimi command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html).

**Gap vs. Codex's event model:** Codex's `parseEvent` keys off explicit
`type` discriminants (`thread.started`, `turn.completed`, `turn.failed`,
`item.completed` with sub-`type`s for `agent_message`/`command_execution`/
`file_change`/`error`/`mcp_tool_call`). Kimi Code's documented schema is a
flatter OpenAI-chat-style transcript (`role` + optional `tool_calls`), with
no documented explicit `error`/fatal-turn event type distinct from a normal
assistant/tool message. **UNVERIFIED**: how a fatal run failure (auth error,
crash, unrecoverable tool loop) surfaces in the stream — whether there is a
distinct fatal event or the adapter must infer failure from the process exit
code (`1`/`75` per §2) plus absence of a final assistant message. This is
the single biggest unknown for a faithful `VendorEvent.fatal` mapping.

## 6. Usage / token reporting

Kimi Code writes a **wire-protocol JSONL log** to its data directory
(`~/.kimi-code`, relocatable via `KIMI_CODE_HOME`; one summary cited
`~/.kimi` / `KIMI_DATA_DIR` for the legacy `kimi-cli`, likely stale) that
records input, output, cached, and cache-creation token counts per model,
project, and time window in `StatusUpdate`-shaped records. Third-party usage
trackers (`tokscale`, `ccusage`, `kimi-code-usage`) parse this file rather
than stdout, because it is a **passive reader of the same log Kimi Code
writes for its own visualizer** (`kimi vis`), not a documented stable API.

[tokscale (junhoyeo/tokscale) — Kimi
support](https://github.com/junhoyeo/tokscale),
[ccusage Kimi guide](https://ccusage.com/guide/kimi/),
[Golden0Voyager/kimi-code-usage](https://github.com/Golden0Voyager/kimi-code-usage).

**UNVERIFIED**: whether the `--output-format stream-json` stdout stream
*itself* carries a per-turn usage record (the way Codex's `turn.completed`
event carries a `usage` object parley's codex adapter reads directly). No
primary docs page confirms a `usage` field in the JSONL schema shown in §5.
If it doesn't, a Kimi adapter's usage extraction would have to tail the
wire-log file under `KIMI_CODE_HOME` instead of parsing stdout — a materially
different, filesystem-based mechanism vs. every other parley adapter's
stdout-only `parseEvent`.

## 7. MCP support

Kimi Code is a genuine **MCP client** — it connects to external MCP servers
and exposes their tools to the agent as `mcp__<server>__<tool>`, alongside
its `kimi acp` ACP-server mode for IDE integration (a different protocol,
JSON-RPC 2.0 over stdio, for editors like Zed/JetBrains — not relevant to
parley's child→daemon channel).

Three transports: **stdio** (child process), **HTTP** (streamable,
`url` field, no `transport` key), and **SSE** (legacy, `transport: "sse"`).
Config lives in `mcp.json` at two scopes: user
(`~/.kimi-code/mcp.json` / `$KIMI_CODE_HOME/mcp.json`) and project
(`.kimi-code/mcp.json` in cwd). An HTTP entry supports:

```json
{
  "mcpServers": {
    "parley": {
      "url": "https://example.com/mcp",
      "headers": { "x-parley-task": "..." },
      "startupTimeoutMs": 30000,
      "toolTimeoutMs": 60000
    }
  }
}
```

`headers` is exactly the per-task correlation-header injection parley's
Codex adapter does via `-c mcp_servers.<name>.http_headers.<key>=<value>`
(ADR-0003 / ADR-0011's `x-parley-task` correlation) — Kimi Code would take
it via a materialized `mcp.json` file instead of `-c` flags (closer to
Grok's `.grok/config.toml` file-materialization shape than Codex's
flags-only shape). `toolTimeoutMs` is the analog of Codex's
`tool_timeout_sec` — needed to raise above `task.answerTimeoutMs` so a
blocking `ask_orchestrator` MCP call isn't killed early (same "spec §4
gotcha" as codex.ts documents).

[Model Context Protocol
doc](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html),
[`kimi mcp` subcommand
reference](https://moonshotai.github.io/kimi-cli/en/reference/kimi-mcp.html).

**VERIFIED (was UNVERIFIED):** project scope reliably isolates per-task config.
The MCP doc states "**Project-level entries override user-level ones with the
same name**," so a per-task `.kimi-code/mcp.json` in `task.cwd` cleanly
overrides any pre-existing user-level `~/.kimi-code/mcp.json` entry of the same
server name — the "no cross-task bleed" property parley's file-materialization
adapters (codex/grok) rely on. The HTTP entry also exposes `bearerTokenEnvVar`
(bearer token from a named env var), `enabledTools`/`disabledTools` allow/block
lists, in addition to the `url`/`headers`/`startupTimeoutMs`/`toolTimeoutMs`
fields above — all VERIFIED on the MCP doc.

## 8. Sandbox implications

No evidence of an OS-level sandbox (no landlock/seccomp/container/jail
mechanism found in any doc page or the GitHub README). Kimi Code's only
documented gating mechanism is **tool-call approval**:

- Interactive default: read-only tool calls run automatically; file
  writes/shell commands prompt for confirmation.
- `-y, --yolo` — auto-approves *regular* tool calls (not Plan-mode-exit
  approval), for use only in trusted directories; explicitly does **not**
  bypass MCP-tool-call approval unless combined with `--auto`-equivalent
  trust of the server.
- `--auto` — "automatic permission mode," agent handles approvals with no
  user questions (mutually exclusive with `--yolo`).
- `--plan` — read-only exploration/planning mode.
- `[[permission.rules]]` in `config.toml` — persistent allow/deny rules via a
  `pattern` field, either `"ToolName"` or `"ToolName(arg-pattern)"` (e.g.
  `"Read"`, `"Bash(rm -rf*)"`). *Correction:* for **MCP and custom tools,
  argument patterns are not supported — they match by tool name only**
  (`mcp__filesystem__write_file`); `*`/`**` wildcards are supported on names
  (`mcp__github__*`). VERIFIED on config-files/MCP docs.
- `-p`/print mode auto-enables an "afk" approval posture per §2 — meaning a
  headless parley task likely doesn't need `--yolo`/`--auto` explicitly (and
  the CLI parser rejects combining them with `-p` anyway).

No documented flag maps to parley's normalized `SandboxMode` (`read-only` /
`workspace` / `full`) or to filesystem-writable-root scoping the way Codex's
`sandbox_workspace_write.writable_roots` does, and no documented flag
controls **network access** independent of approval (i.e., no equivalent to
Codex's `sandbox_workspace_write.network_access`). This is the same gap
documented for Goose and Grok in prior parley research
(`docs/research/goose-cli-automation.md`, `docs/research/grok-build-cli-automation.md`)
— a Kimi adapter would, like those, only be able to approximate
`read-only`→`--plan`, `workspace`/`full`→ default print-mode auto-approve,
with no real posture-to-mechanism mapping and no way to honor
`network: false`.

[kimi command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)
(flags `--yolo`/`--auto`/`--plan` VERIFIED here),
[Config files (`[[permission.rules]]`, `pattern` field)](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html),
[Tenten AI forum note on Kimi/Codex YOLO
mode](https://university.tenten.co/t/kimi-code-cli-codex-cli-yolo-mode/2235).

Separately, the `kimi server`/`kimi web` local REST/WebSocket server mode has a
bearer-auth-bypass footgun ("anyone who can reach the port gets full access")
— irrelevant to the `exec`-style spawn-per-turn shape parley uses, but worth
flagging. *UNVERIFIED:* the exact flag spelling `kimi server run
--dangerous-bypass-auth` was not confirmed on the command reference (which lists
`kimi server` but not its sub-flags); confirm before quoting it anywhere
load-bearing.

## 9. Auth & config

- Interactive: `/login` inside the TUI offers **OAuth** (device-code flow,
  RFC 8628) via Kimi Code's own auth service, or a **Moonshot AI Open
  Platform API key** (from `platform.kimi.com` / `platform.kimi.ai`).
  `kimi login` also exists as a non-interactive OAuth-device-flow
  subcommand. `/logout` signs out.
- **Provider credentials are config-file-resident, not env-var-resident.**
  API keys go under `[providers.<name>]` (`api_key` field) or
  `[providers.<name>.env]` in `~/.kimi-code/config.toml` (relocatable via
  `KIMI_CODE_HOME`). Exporting `KIMI_API_KEY`/`ANTHROPIC_API_KEY`/
  `OPENAI_API_KEY` etc. in the shell **does nothing** — they are not read
  automatically by ordinary provider resolution.
- The **one** real env-var auth channel is the `KIMI_MODEL_*` family. The
  documented set (VERIFIED on the env-vars page) is: `KIMI_MODEL_NAME`
  (required, acts as the enable switch), `KIMI_MODEL_API_KEY` (required),
  `KIMI_MODEL_PROVIDER_TYPE` (defaults to `kimi`), `KIMI_MODEL_BASE_URL`,
  `KIMI_MODEL_MAX_CONTEXT_SIZE` (default 262144), `KIMI_MODEL_CAPABILITIES`,
  `KIMI_MODEL_DISPLAY_NAME`, `KIMI_MODEL_MAX_OUTPUT_SIZE` (Anthropic only),
  `KIMI_MODEL_REASONING_KEY` (OpenAI only), `KIMI_MODEL_THINKING_EFFORT`, and
  `KIMI_MODEL_ADAPTIVE_THINKING` (Anthropic only). *Correction:* the previously
  listed `KIMI_MODEL_TEMPERATURE`/`KIMI_MODEL_TOP_P` are **not** on the env-vars
  page (removed); `KIMI_MODEL_REASONING_KEY` was missing (added). This is an
  explicit, documented "test a model without touching config" escape hatch.
  This is plausibly what a parley adapter
  would lean on for `SpawnPlan.env`-only auth injection, in lieu of a
  Codex-style single `CODEX_API_KEY` passthrough — but it requires
  supplying the model/provider *shape* via env too, not just a bare key.
- Config precedence: CLI flags > `config.toml` > env vars, for ordinary
  runtime parameters ("ordinary runtime parameters do not fall back to
  shell environment variables" — i.e., this precedence order does **not**
  apply to provider credentials, which are config.toml/`.env`-table only
  per above).
- `KIMI_CODE_HOME` relocates the whole data root (config, sessions, logs,
  cache) — default `~/.kimi-code`.
- Model selection: `-m/--model <alias>` at launch, `/model` interactively,
  or `KIMI_MODEL_*` env family. No public doc found enumerating the full
  set of "effort"/thinking-level values beyond
  `KIMI_MODEL_THINKING_EFFORT`/`KIMI_MODEL_ADAPTIVE_THINKING` existing as
  knobs — exact accepted values UNVERIFIED.
- Model catalog probing: `kimi provider catalog list [providerId] [--filter
  <substring>]` browses the models.dev catalog; `kimi provider list
  [--json]` lists configured providers. Plausible source for an adapter's
  optional `listModels()`, but the exact JSON shape of `catalog list --json`
  (if `--json` applies there) was not found in this pass — UNVERIFIED.

[Getting
started](https://moonshotai.github.io/kimi-code/en/guides/getting-started.html),
[Environment
variables](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars.html),
[Config
overrides](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/overrides.html),
[Providers and Models (legacy `kimi-cli` docs
domain)](https://moonshotai.github.io/kimi-cli/en/configuration/providers.html),
[kimi command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html).

## 10. Versioning, distribution, open-source status

- Repo: [github.com/MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)
  (current), predecessor
  [github.com/MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli).
  MIT license, ~3.4k stars, ~95% TypeScript.
- Distribution: install script (curl/PowerShell), Homebrew, npm
  (`@moonshot-ai/kimi-code`). Self-update via `kimi upgrade`; opt out with
  `KIMI_CODE_NO_AUTO_UPDATE`.
- `kimi migrate` imports legacy `kimi-cli` session/config data
  interactively — relevant only to end users migrating, not to an adapter.
- Independent, unrelated npm packages exist with confusingly similar names
  (`@jacksontian/kimi-cli`, `@jacksontian/kimi`) — third-party Node clients
  for the Moonshot API, **not** Moonshot's own CLI. An adapter's `CODEX_BIN`-
  equivalent constant must resolve the official `kimi` binary, not one of
  these.

[MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code),
[MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli),
[npm search results distinguishing official vs. third-party
packages](https://www.npmjs.com/package/@jacksontian/kimi-cli).

---

## Capability table: Kimi Code feature → parley adapter need

| Parley need (ADR-0009 hook / ADR-0011 concept) | Kimi Code surface | Confidence |
| --- | --- | --- |
| `prepare()` spawn argv | `kimi -p "<prompt>" --output-format stream-json -m <model> [--add-dir <dir>]` | DOCS |
| `resume()` spawn argv | `kimi -S <sessionId> -p "<follow-up>" --output-format stream-json` | UNVERIFIED composition (§4) |
| `parseEvent()` | Parse JSONL: `role: user/assistant/tool`, `tool_calls[]`, `role:"meta"` session record | DOCS for shape; fatal-error event UNVERIFIED (§5) |
| `sessionId()` | `role:"meta", type:"session.resume_hint"` record (or process's printed resume hint) | Partially DOCS, primary-source confirmation UNVERIFIED |
| `listModels()` | `kimi provider catalog list [providerId] [--json?]` | UNVERIFIED shape |
| Model/effort passthrough | `-m/--model`, `KIMI_MODEL_THINKING_EFFORT`/`KIMI_MODEL_ADAPTIVE_THINKING` | DOCS (existence); accepted values UNVERIFIED |
| Sandbox posture mapping (`SandboxMode`) | No OS sandbox; approval-only (`--plan`, print-mode auto-approve, `[[permission.rules]]`) | DOCS; no faithful mapping (§8) |
| Network posture (`Posture.network`) | No documented flag | Gap — same as Goose/Grok |
| Auth injection (`SpawnPlan.env`) | Not a plain-env passthrough; needs `config.toml` `[providers.*]`/`.env` table, or `KIMI_MODEL_*` full env family | DOCS — different shape than Codex's single env var |
| MCP hub injection (ADR-0003/0011 `HubInfo`) | Materialize `mcp.json` (project scope, `.kimi-code/mcp.json`) with `url` + `headers` + `toolTimeoutMs` | DOCS, file-materialization shape (like Grok); scope-isolation now VERIFIED (project entries override same-named user entries) |
| Child→daemon channel (ADR-0011) | **MCP** primary candidate — real MCP client, HTTP transport, header injection all present. HTTP/CLI fallback channels (`parley child report`/`ask`) also usable since they're just `curl`/`parley` subprocess calls, independent of Kimi's own capabilities | DOCS for MCP; HTTP/CLI fallback always works regardless of vendor |
| `answerTimeoutMs` → vendor tool timeout headroom | `toolTimeoutMs` in `mcp.json` server entry | DOCS |
| `gitDir`/`gitCommonDir` extra writable roots | No documented mechanism (no workspace-write-roots concept found) | Gap |
| Usage/token extraction | Wire-log JSONL under `KIMI_CODE_HOME`, not confirmed in stdout stream | DOCS for file; stdout usage record UNVERIFIED (§6) |

## Recommended adapter shape

**Feasibility verdict: feasible, but not a flags-only, drop-in-easy port
like Codex.** Kimi Code clears the baseline bar (headless one-shot,
JSONL event stream, native MCP-over-HTTP client with header injection,
resumable sessions with an id) that made Codex/Grok/Goose viable parley
vendors. It should not block on "can this even work" — it should block on
a short hands-on verification pass (see Gaps below) before shipping,
because several load-bearing details (non-interactive resume composition,
fatal-error event shape, whether usage rides stdout or only the wire log)
remain UNVERIFIED from docs alone. Two earlier open items were **resolved during
this validation pass**: the `--print` vs `-p/--prompt` naming (current CLI uses
`-p`; `--print` is legacy — §3) and MCP project-scope isolation (project entries
override same-named user entries — §7), both now VERIFIED against primary docs.

**ADR-0009 hooks it can implement:**

- `prepare(task, hub)` — straightforward: `kimi -p <prompt> --output-format
  stream-json [-m model] [extraArgs]`, materializing `.kimi-code/mcp.json`
  (project-scoped, written into `task.cwd`) as the `SpawnPlan.files` entry
  carrying the MCP hub URL + `x-parley-task` header + raised
  `toolTimeoutMs`. This is the same `SpawnPlan.files`-driven shape ADR-0009
  built the interface for ("flags-vs-files asymmetry between vendors").
- `resume(task, hub)` — plausible via `-S <task.sessionId> -p
  <task.prompt>`, but ship only after confirming the composition works
  non-interactively (§4) — a wrong assumption here silently degrades every
  resumed task into a fresh session per the documented "unknown id → new
  session" fallback, which would be a very quiet failure mode.
- `parseEvent(line)` — parse the chat-style JSONL (`role`/`content`/
  `tool_calls`), normalizing `role: assistant` → `kind: "message"`,
  `tool_calls[].function.name/arguments` → `kind: "command"` or
  `"file_change"` depending on tool name, `role: tool` → opaque/pass-through
  unless it signals a failure. The `role:"meta"` session record → `kind:
  "session_meta"` with `session_id`. Fatal-error detection is the open
  question (§5) — may have to fall back to "exit code 1/75 with no terminal
  assistant message ⇒ fatal", inferred at the engine layer rather than from
  a single event, unless a real fatal-event type turns up on inspection.
  MCP-tool-call-denied-by-approval-gate diagnostics (parley's
  `VENDOR_DIAG_PREFIX` pattern from codex.ts) are **likely a non-issue for
  Kimi**: `-p`/print mode implicitly enables `--afk`, which auto-approves tool
  calls and auto-dismisses `AskUserQuestion` (VERIFIED, §2) — so the approval
  gate should not fire on a headless task the way Codex's guardian gate can.
  Still worth a live check that MCP-tool approval is covered by afk (the docs
  distinguish MCP-tool approval from regular-tool approval for `--yolo`).
- `sessionId(events)` — read the last `session_meta` event's `session_id`,
  same pattern as codex.ts.
- `listModels()` — candidate via `kimi provider catalog list --json`
  (unconfirmed flag), lower priority (optional hook; catalog is advisory
  per ADR-0009).

**Gaps / risks (in priority order to resolve before shipping):**

1. **Auth injection shape differs from every existing adapter.** No single
   env var to drop into `SpawnPlan.env`; needs either a materialized/patched
   `config.toml` (touches shared user config, risking cross-task
   interference unless `KIMI_CODE_HOME` is also sandboxed per-task) or full
   use of the `KIMI_MODEL_*` env family (self-contained, but requires the
   adapter to supply model/provider/base-url shape, not just a key —
   heavier than Codex's `CODEX_API_KEY` passthrough). Recommend
   `KIMI_MODEL_*` + a per-task `KIMI_CODE_HOME` (analogous to Goose's
   `GOOSE_PATH_ROOT` isolation) to avoid mutating the user's real
   `~/.kimi-code/config.toml`.
2. **Non-interactive resume composition unverified** (§4) — must be probed
   against a real binary before `resume()` ships; if it doesn't work, Kimi
   would need the "spawn-per-turn is resume, but only via -S with no -p"
   workaround, or resume may simply not be supported headlessly, dropping
   it to Grok's tier (no faithful resume).
3. **No sandbox/network posture mapping** (§8) — same known gap as
   Goose/Grok; `SandboxMode`/`Posture.network` would only approximate via
   `--plan` (read-only) vs. default (workspace/full), with no way to honor
   `network: false` or scope writable roots (`gitDir`/`gitCommonDir` have no
   home in Kimi's model).
4. **Fatal-error event shape unverified** (§5) — needed for
   `VendorEvent.fatal` to work as intended (surfacing failure detail instead
   of parley's engine only ever seeing opaque exit codes).
5. **Usage/token extraction may require reading the wire-log file, not
   stdout** (§6) — if so, this is a materially different adapter shape
   (filesystem tail vs. stream parse) than every other current adapter, and
   needs its own engine-side plumbing decision, not just an adapter-local
   fix.
6. Minor: confirm real flag name (`--print` vs `-p`/`--prompt` alone, §3)
   against `kimi --help` output before wiring `commonArgs`.

**Suggested `childChannel` (ADR-0011):** **MCP**, matching Codex — Kimi Code
is a documented, capable MCP client with HTTP transport and per-request
header support, which is exactly the `HubInfo.headers` correlation
mechanism ADR-0011 assumes as the canonical channel. Unlike the harnesses
ADR-0011 was written in response to (no MCP client, or no custom-header
support), Kimi Code has both, so there's no forcing reason to fall back to
the HTTP/CLI child surface — though nothing stops a Kimi task from using
`parley child report`/`ask` as a fallback if the MCP-gate/approval question
in item 4 above turns out to actually block `submit_report`/
`ask_orchestrator` calls in some configuration (mirroring the Codex guardian
-gate footgun ADR-0006/codex.ts already documents defenses for).
