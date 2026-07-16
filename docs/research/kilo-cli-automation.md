# Kilo CLI — automation surface for Parley

Research asset for the wayfinder ticket [Research: Kilo CLI automation surface](https://github.com/femoral/parley/issues/96).
Verified against primary sources and a local binary on **2026-07-16**; pinned CLI **`@kilocode/cli@7.4.9`** (binary version `7.4.9`).

Primary sources:

- Official docs: [Kilo CLI](https://kilo.ai/docs/code-with-ai/platforms/cli), [CLI reference](https://kilo.ai/docs/code-with-ai/platforms/cli-reference), [MCP in Kilo](https://kilo.ai/docs/automate/mcp/using-in-kilo-code), [Sandboxing](https://kilo.ai/docs/getting-started/settings/sandboxing)
- npm: [`@kilocode/cli`](https://www.npmjs.com/package/@kilocode/cli)
- Upstream lineage: Kilo CLI is an OpenCode fork ([opencode CLI](https://opencode.ai/docs/cli/), [config](https://opencode.ai/docs/config/), [MCP](https://opencode.ai/docs/mcp-servers/), [permissions](https://opencode.ai/docs/permissions/))
- Config schema: `https://app.kilo.ai/config.json`
- Product stance on sandbox: [Kilo Sandbox blog (2026-07-14)](https://blog.kilo.ai/p/kilo-sandbox-run-auto-mode-without)

Every claim is tagged **VERIFIED** (ran against 7.4.9), **DOCS** (cited URL), or **UNKNOWN** (blocker noted).

## TL;DR for Parley

Kilo is a **viable** headless adapter — closer to Grok (files/env config injection) than Codex (pure `-c` flags):

| Need | Surface |
| --- | --- |
| One-shot headless | `kilo run --format json --auto --dir <cwd> "<prompt>"` |
| Streaming events | JSONL on stdout (`--format json`) |
| MCP hub + headers | Project/global `mcp` in config, or **`KILO_CONFIG_CONTENT`** / **`KILO_CONFIG`** (preferred hermetic) |
| Session resume | `sessionID` on every event; resume with `kilo run -s <id> ...` |
| Approvals | `--auto` and/or `permission: "allow"` / `KILO_PERMISSION` |
| Sandbox | Optional `sandbox.{enabled,network,writable_paths,allowed_hosts}` — **not** a codex-style three-mode matrix; `.git` is read-only when sandbox is on |
| Model / effort | `-m provider/model`, `--variant high\|max\|minimal\|…` |
| Auth | `KILO_API_KEY` (and BYOK provider keys); `kilo auth login` for interactive |
| Usage | `step_finish.part.tokens.{input,output,reasoning,cache}` + `part.cost` (**DOCS**/OpenCode-lineage; not re-emitted in unauthenticated run) |

**Loud caveats (load-bearing):**

1. **Auth failure still exits 0** in 7.4.9 while emitting a JSON `error` event — adapters **must** parse the stream, not trust exit codes alone. **VERIFIED** 7.4.9.
2. MCP `timeout` defaults to **5000 ms** — far below Parley's answer timeout; raise it on the injected server (and consider `experimental.mcp_timeout`). **DOCS** schema + Kilo MCP docs.
3. With `sandbox.network: "deny"`, **MCP tool calls are blocked** — Parley's hub cannot work under network-deny. Prefer sandbox off or `network: "allow"` for delegated tasks that need the hub. **DOCS** sandboxing page.
4. With sandbox enabled, **`.git` is always read-only** — a sandboxed child cannot `git commit` in the worktree. Parley tasks that must commit should leave sandbox disabled (permissions + OS isolation elsewhere). **DOCS**.
5. There is **no codex-style OS sandbox mode flag** on `kilo run`; posture is config-driven permissions (+ optional sandbox object). **VERIFIED** `--help` / schema.

Closest integration shape: **spawn-per-turn `kilo run --format json`**, inject hub via `KILO_CONFIG_CONTENT` (or materialize `.kilo/kilo.jsonc`), force approvals with `--auto` + `permission: "allow"`, capture `sessionID` from the first event, resume with `-s`.

---

## 1. Identity & install

| Item | Value | Evidence |
| --- | --- | --- |
| Product | Kilo Code CLI (agentic terminal agent; OpenCode fork) | **DOCS** [kilo.ai CLI docs](https://kilo.ai/docs/code-with-ai/platforms/cli) |
| npm package | `@kilocode/cli` | **VERIFIED** 7.4.9 `package.json` `name` |
| Binary names | `kilo` and `kilocode` (both → same wrapper) | **VERIFIED** `"bin": { "kilo": "./bin/kilo", "kilocode": "./bin/kilo" }` |
| Version pinned | **7.4.9** | **VERIFIED** `kilo --version` → `7.4.9` |
| Install | `npm install -g @kilocode/cli` or local `npm install @kilocode/cli@7.4.9` | **DOCS** + **VERIFIED** local install |
| npx | `npx --package @kilocode/cli kilo` | **DOCS** package README |
| Platform packages | optionalDeps `@kilocode/cli-linux-x64`, `…-baseline`, darwin/windows/musl variants | **VERIFIED** package.json; binary is a ~152 MB Bun-like payload under `bin/.kilo` |
| Data / config dirs | `~/.config/kilo`, `~/.local/share/kilo`, `~/.cache/kilo`, `~/.local/state/kilo` | **VERIFIED** `kilo debug paths` |
| Repo | https://github.com/Kilo-Org/kilocode | **DOCS** |

**Install command (scratch, as used for this research):**

```bash
mkdir -p .scratch-kilo && npm install --prefix .scratch-kilo @kilocode/cli@7.4.9
./.scratch-kilo/node_modules/.bin/kilo --version   # 7.4.9
```

**Do not commit** scratch installs. Historical note: some GitHub issues report missing platform binary packages on older versions; 7.4.9 installed cleanly on linux-x64 in this worktree. **VERIFIED**.

---

## 2. Headless invocation

### Exact one-shot argv

```bash
kilo run --format json --auto --dir <worktree> -m <provider/model> --variant <effort> \
  "PROMPT TEXT"
```

| Flag | Role | Evidence |
| --- | --- | --- |
| `run [message..]` | Non-interactive prompt run | **VERIFIED** `kilo run --help`; **DOCS** [CLI reference](https://kilo.ai/docs/code-with-ai/platforms/cli-reference) |
| `--format json` | Raw JSON events (JSONL) on stdout; default is human `default` | **VERIFIED** help choices `default\|json` |
| `--auto` | Auto-approve permissions for autonomous/pipeline use | **VERIFIED** help; **DOCS** autonomous mode section |
| `--dangerously-skip-permissions` | Auto-approve non-denied permissions | **VERIFIED** help (belt-and-braces with config `permission`) |
| `--dir <path>` | Working directory | **VERIFIED** help |
| `-m/--model` | `provider/model` | **VERIFIED** help |
| `--variant` | Provider-specific reasoning effort (`high`, `max`, `minimal`, …) | **VERIFIED** help text |
| `-s/--session` | Resume session id | **VERIFIED** help + resume probe |
| `-c/--continue` | Resume last session in workspace | **VERIFIED** help; **DOCS** notes TUI `--continue` limitations with autonomous mode — use `run -s` for headless |

**Sample headless run (unauthenticated, still evidence):**

```bash
kilo run --format json --auto "Say hi in one word"
# stdout (single line), exit 0:
{"type":"error","timestamp":1784189544500,"sessionID":"ses_0960423adffeuBdTh4fmHZMFzY","error":{"name":"APIError","data":{"message":"Unauthorized: {\"error\":{\"code\":\"PAID_MODEL_AUTH_REQUIRED\",\"message\":\"You need to sign in to use this model.\"},\"error_type\":\"paid_model_auth_required\"}","statusCode":401,"isRetryable":false,...}}}
```

**VERIFIED** 7.4.9: process **exit code 0** despite `type:"error"` and HTTP 401. Docs claim exit `0` success / `1` error / `124` timeout (**DOCS** autonomous section) — **do not trust exit code alone**; parse the JSONL stream.

### Streaming JSON event format

Stdout is **JSONL**: one JSON object per line, each with `type`, `timestamp` (ms), and `sessionID` (`ses_…`).

Event types observed / documented (OpenCode lineage; Kilo binary contains the same type strings):

| `type` | Meaning | Evidence |
| --- | --- | --- |
| `step_start` | Turn/step begins; nested `part.type: "step-start"` | **DOCS**/community cheatsheet for `opencode run --format json`; **VERIFIED** strings in binary (`step_start`) |
| `text` | Assistant text chunk; `part.text` | same |
| `tool_use` | Completed tool call (`part.tool`, `part.state.input/output`, …) | same; binary also has `tool_call` / `tool_result` strings — treat parser as tolerant |
| `step_finish` | Step end; usage + cost on `part` | same |
| `error` | Fatal-ish session error | **VERIFIED** real line above |

**Worked success-path examples** (OpenCode stream shape; **binary-verified**
emission in `@kilocode/cli@7.4.9` via `nA("step_start"|"tool_use"|"text"|"step_finish")`
with `part.tool` / tokens — #107; still mark live-auth capture as residual):

```json
{"type":"step_start","timestamp":1767036059338,"sessionID":"ses_494719016ffe85dkDMj0FPRbHK","part":{"id":"prt_…","sessionID":"ses_…","messageID":"msg_…","type":"step-start","snapshot":"71db24a7…"}}
{"type":"tool_use","timestamp":1767036061199,"sessionID":"ses_…","part":{"type":"tool","tool":"bash","callID":"…","state":{"status":"completed","input":{"command":"echo hello"},"output":"hello\n","metadata":{"exit":0},"time":{"start":…,"end":…}}}}
{"type":"text","timestamp":1767036064268,"sessionID":"ses_…","part":{"type":"text","text":"hello","time":{"start":…,"end":…}}}
{"type":"step_finish","timestamp":1767036064273,"sessionID":"ses_…","part":{"type":"step-finish","reason":"stop","cost":0.001,"tokens":{"input":671,"output":8,"reasoning":0,"cache":{"read":21415,"write":0}}}}
```

Sources: [takopi OpenCode JSON cheatsheet](https://takopi.dev/reference/runners/opencode/stream-json-cheatsheet/), binary string inventory **VERIFIED** 7.4.9.

**stderr** may contain banners, color warnings, and `INFO … disposing` lines — keep stdout as the event pipe.

---

## 3. MCP injection

### Transport & headers

Remote MCP (Streamable HTTP, SSE fallback) is first-class:

```jsonc
{
  "$schema": "https://app.kilo.ai/config.json",
  "mcp": {
    "parley": {
      "type": "remote",
      "url": "http://127.0.0.1:PORT/mcp",
      "headers": {
        "X-Parley-Task": "<task-id>"
      },
      "oauth": false,
      "enabled": true,
      "timeout": 600000
    }
  }
}
```

| Field | Notes | Evidence |
| --- | --- | --- |
| `type: "remote"` | HTTP remote server | **DOCS** [MCP](https://kilo.ai/docs/automate/mcp/using-in-kilo-code), schema `McpRemoteConfig` |
| `url` | Hub endpoint | same |
| `headers` | Arbitrary request headers (Parley correlation) | same; **VERIFIED** via `KILO_CONFIG_CONTENT` + `kilo debug config` |
| `oauth: false` | Disable OAuth auto-detect for header-auth hubs | **DOCS** / schema |
| `timeout` | ms for MCP server requests; **default 5000** | **DOCS** schema description |
| Local | `type: "local"`, `command: ["…"]`, `environment`, `cwd` | **DOCS** |

**VERIFIED** injection:

```bash
export KILO_CONFIG_CONTENT='{"permission":"allow","mcp":{"parley":{"type":"remote","url":"http://127.0.0.1:9/mcp","headers":{"X-Test":"1"},"oauth":false}}}'
kilo debug config
# → resolved config includes mcp.parley with headers
```

### Flags vs files vs env

| Mechanism | Hermetic? | Notes |
| --- | --- | --- |
| **`KILO_CONFIG_CONTENT`** | Yes | Inline JSON config; treated as **trusted** (can use `{env:VAR}`). **VERIFIED** + **DOCS** |
| **`KILO_CONFIG`** | Yes | Path to config file. **DOCS** (OpenCode-equivalent `OPENCODE_CONFIG` renamed) |
| **`KILO_CONFIG_DIR`** | Partial | Extra agents/commands/plugins dir. **DOCS** lineage |
| Project `./kilo.json[c]` or `./.kilo/kilo.json[c]` | Worktree-scoped | **DOCS**; good for `SpawnPlan.files` like grok |
| Global `~/.config/kilo/kilo.json[c]` | No | User bleed — avoid for children |
| CLI flag for MCP | **None** | **VERIFIED** no MCP flags on `kilo run --help` |

**Project-scoped paths (precedence project > global):**

| Scope | Path |
| --- | --- |
| Global | `~/.config/kilo/kilo.json` / `kilo.jsonc` |
| Project | `./kilo.json[c]`, `./.kilo/kilo.json[c]`, legacy `./.kilocode/` |

**DOCS** [CLI config locations](https://kilo.ai/docs/code-with-ai/platforms/cli).

**Recommendation:** prefer `KILO_CONFIG_CONTENT` (no worktree file pollution) or materialize `.kilo/kilo.jsonc` via `SpawnPlan.files` if you need on-disk inspectability. Set `oauth: false` and a large `timeout` (≥ answerTimeoutMs + headroom). Also consider `"experimental": { "mcp_timeout": <ms> }` from the config schema. **DOCS** schema.

**Permission for MCP tools:** namespaced as `{server}_{tool}` (e.g. `parley_submit_report`) under `permission`. With `--auto` / `permission: "allow"`, calls should not prompt. **DOCS** MCP auto-approve section.

---

## 4. Session resume

### Session id in the event stream

Every JSON event carries top-level **`sessionID`** (format `ses_<alphanum>`).

**VERIFIED** 7.4.9 on auth-error line:

```json
{"type":"error","timestamp":…,"sessionID":"ses_0960423adffeuBdTh4fmHZMFzY",…}
```

Also listed via:

```bash
kilo session list --format json -n 3
# [{"id":"ses_…","title":"Greeting","updated":…,"created":…,"projectId":"…","directory":"/path"}, …]
```

**VERIFIED** after failed runs.

### Exact resume argv

```bash
kilo run --format json --auto --dir <worktree> -s <sessionID> "follow-up prompt"
```

**VERIFIED** 7.4.9: `-s ses_096031735ffeaK3dDsQWxsEIpA` reuses that id on the subsequent error event.

Also available: `-c/--continue` (last session for workspace), `--fork`, `--cloud-fork`. **VERIFIED** help.

**Note:** Interactive docs say `kilo --continue` cannot combine with autonomous mode / prompt — that is the TUI path. Headless resume is **`kilo run -s …`**, which accepts `--auto` and a message. **DOCS** vs **VERIFIED** help divergence — trust `run --help` for automation.

Persistence: sessions live under Kilo data dir / sqlite (`kilo debug paths` → `~/.local/share/kilo`). **VERIFIED** paths + `kilo.db` presence after runs.

---

## 5. Sandbox & approvals

### Approvals (disable interactive prompts)

| Mechanism | Effect | Evidence |
| --- | --- | --- |
| `--auto` | Auto-approve for autonomous/pipeline | **VERIFIED** help; **DOCS** |
| `--dangerously-skip-permissions` | Auto-approve non-denied | **VERIFIED** help |
| `permission: "allow"` or object rules | Config-level allow/ask/deny | **DOCS** permissions; **VERIFIED** via `KILO_PERMISSION` / `KILO_CONFIG_CONTENT` |
| `KILO_PERMISSION` | Inline JSON permission override | **VERIFIED** `kilo debug config` shows merged permission |

Permission actions: `"allow" | "ask" | "deny"`. Tools include `bash`, `edit`, `read`, `external_directory`, MCP namespaced tools, etc. **DOCS**.

**Headless recipe:** always pass **`--auto`** and inject `"permission": "allow"` (or a tighter allow-list that still allows MCP + workspace edits).

### Sandbox (OS confinement)

Kilo has an **optional** OS sandbox (macOS Seatbelt / Linux bubblewrap+seccomp). Disabled by default. **DOCS** [Sandboxing](https://kilo.ai/docs/getting-started/settings/sandboxing), [blog](https://blog.kilo.ai/p/kilo-sandbox-run-auto-mode-without).

```jsonc
{
  "sandbox": {
    "enabled": true,
    "network": "deny",          // or "allow"
    "allowed_hosts": ["registry.npmjs.org"],
    "writable_paths": ["~/scratch"]
  }
}
```

**VERIFIED** 7.4.9: `KILO_CONFIG_CONTENT` with `sandbox.enabled/network` appears in `kilo debug config`. `writable_paths` from that env payload was **dropped** in the resolved config (docs: only **global** config may add writable paths / destinations) — **VERIFIED** quirk; project/`CONFIG_CONTENT` can tighten, not expand.

### Mapping Parley posture → Kilo

| Parley `sandbox` / `network` | Recommended Kilo mapping | Notes |
| --- | --- | --- |
| `read-only` | `permission: { "*": "deny", "read": "allow", "grep": "allow", "glob": "allow" }` (+ optional `sandbox.enabled: true`) | No dedicated read-only sandbox flag. **DOCS** permissions |
| `workspace` + network on | `permission: "allow"` or allow bash/edit; **`sandbox` off** *or* `enabled:true, network:"allow"` | Network-deny **blocks MCP tools** — unusable with Parley hub. **DOCS** |
| `workspace` + network off | `sandbox.enabled:true, network:"deny"` + permissions | Breaks hub MCP tool calls; only if task needs no hub tools. **DOCS** |
| `full` | `permission: "allow"`, `sandbox.enabled: false` | Closest to danger-full-access. **DOCS** defaults are already permissive |

**Critical for Parley git commits:** when sandbox is enabled, **`.git` is always read-only** even inside the workspace. **DOCS**. Children that must `git commit` should run with sandbox **disabled**. Extra gitdirs outside cwd need `external_directory` permission allows and, if sandbox is on, global `writable_paths` (still won't unlock `.git`).

**Windows:** sandbox unsupported; enabled policy fails closed. **DOCS**.

---

## 6. Model & effort flags; auth env vars

### Model & effort

| Control | Usage | Evidence |
| --- | --- | --- |
| `-m` / `--model` | `provider/model` e.g. `kilo/anthropic/claude-sonnet-4.6`, `anthropic/claude-sonnet-4-20250514` | **VERIFIED** help + `kilo models` lines |
| `--variant` | Reasoning effort: `high`, `max`, `minimal`, … (provider-specific) | **VERIFIED** help |
| Config `model` | Default model string | **DOCS** / schema |
| `KILO_PROVIDER` | Override active provider id | **DOCS** env overrides section |
| `KILOCODE_<FIELD>` | Fields for kilocode provider | **DOCS** |
| `KILO_<FIELD>` | e.g. `KILO_API_KEY` → `apiKey` | **DOCS**; **VERIFIED** binary env string inventory includes `KILO_API_KEY` |

Pass Parley's opaque `model` / `effort` through as `-m` and `--variant` without validating.

### Auth

| Method | Notes | Evidence |
| --- | --- | --- |
| **`KILO_API_KEY`** | Gateway / provider API key for non-interactive use | **DOCS** CLI env overrides + gateway auth docs |
| BYOK | `provider.<id>.options.apiKey: "{env:ANTHROPIC_API_KEY}"` etc. in trusted config | **DOCS** |
| `kilo auth login` / `kilo auth list` | Interactive credential store under Kilo data dir | **VERIFIED** help; **DOCS** |
| `KILO_ORG_ID` | Org routing for `kilo run` (no `--org` flag) | **DOCS** |
| Unauthenticated error shape | `PAID_MODEL_AUTH_REQUIRED` / 401 via Kilo OpenRouter gateway | **VERIFIED** 7.4.9 |

Other useful isolation envs (**VERIFIED** in binary strings; semantics mostly OpenCode-lineage **DOCS**):

- `KILO_DISABLE_AUTOUPDATE=1` — pin version behavior for children
- `KILO_DISABLE_CLAUDE_CODE=1` — avoid Claude config bleed
- `KILO_DISABLE_PROJECT_CONFIG=1` — skip project config if relying solely on `KILO_CONFIG_CONTENT` (**UNKNOWN** exact semantics without source; name is suggestive)
- `KILO_SERVER_PASSWORD` — for `kilo serve` / attach, not one-shot run

---

## 7. Model enumeration

```bash
kilo models                  # plain text: one provider/model id per line
kilo models <provider>       # filter
kilo models --verbose        # id line + JSON metadata (cost, api, …)
kilo models --refresh        # refresh models.dev cache
```

**VERIFIED** 7.4.9 sample (plain):

```
kilo/~anthropic/claude-fable-latest
kilo/~anthropic/claude-haiku-latest
kilo/anthropic/claude-sonnet-4.6
kilo/anthropic/claude-opus-4.8
…
```

**VERIFIED** verbose block starts with the id line then a JSON object:

```
kilo/~anthropic/claude-fable-latest
{
  "id": "~anthropic/claude-fable-latest",
  "providerID": "kilo",
  "name": "Anthropic: Claude Fable Latest ($$$$)",
  "family": "claude",
  "api": { "id": "…", "url": "https://api.kilo.ai/api/openrouter/", "npm": "@kilocode/kilo-gateway" },
  "status": "active",
  "cost": { "input": 10, "output": 50, "cache": { … } },
  …
}
```

For `listModels()`: run `kilo models` (or `--verbose` if efforts/variants needed — variant catalog on verbose is **UNKNOWN** without a full dump parse). Catalog is advisory only (Parley passes model strings opaquely).

---

## 8. Token usage

### Where it appears

On **`step_finish`** events, nested under `part`:

| Field | Meaning | Evidence |
| --- | --- | --- |
| `part.tokens.input` | Input tokens | **DOCS** OpenCode JSON cheatsheet |
| `part.tokens.output` | Output tokens | same |
| `part.tokens.reasoning` | Reasoning tokens | same |
| `part.tokens.cache.read` / `.write` | Cache tokens | same |
| `part.cost` | USD cost estimate | same |
| `part.reason` | `"stop"` (final) or `"tool-calls"` (continuing) | same |

Aggregate **session** stats also via `kilo stats` (not the per-task stream). **DOCS** CLI reference.

### Worked example (lineage / expected shape)

```json
{"type":"step_finish","timestamp":1767036064273,"sessionID":"ses_494719016ffe85dkDMj0FPRbHK","part":{"type":"step-finish","reason":"stop","cost":0.001,"tokens":{"input":671,"output":8,"reasoning":0,"cache":{"read":21415,"write":0}}}}
```

**DOCS** (OpenCode stream). **UNKNOWN** for live Kilo 7.4.9 with real auth — unauthenticated runs only emitted `error` (no `step_finish`). Adapter should map defensively:

- On `step_finish` with `part.tokens` → `VendorEvent { kind: "session_meta", usage: { input, output, reasoning, cache_read, cache_write }, session_id }`
- Prefer last `reason === "stop"` (or last step_finish) as turn completion usage; shallow-merge if multiple steps

Also `kilo export <sessionID>` for full transcript JSON if stream parsing is insufficient. **DOCS**.

---

## 9. Adapter recommendation

### `prepare()` → `SpawnPlan`

```ts
// Conceptual — not implementation
argv: [
  process.env.PARLEY_KILO_BIN ?? "kilo",
  "run",
  "--format", "json",
  "--auto",
  "--dir", task.cwd,
  ...(task.model ? ["-m", task.model] : []),
  ...(task.effort ? ["--variant", task.effort] : []),
  task.prompt,
],
env: {
  ...(process.env.KILO_API_KEY ? { KILO_API_KEY: process.env.KILO_API_KEY } : {}),
  KILO_DISABLE_AUTOUPDATE: "1",
  // Optional: reduce scanner bleed
  KILO_DISABLE_CLAUDE_CODE: "1",
  KILO_CONFIG_CONTENT: JSON.stringify({
    $schema: "https://app.kilo.ai/config.json",
    permission: permissionFor(task),       // see matrix below
    sandbox: sandboxFor(task),             // usually disabled for hub+git
    experimental: {
      mcp_timeout: task.answerTimeoutMs + 60_000,
    },
    mcp: {
      parley: {
        type: "remote",
        url: hub.url,
        headers: hub.headers,
        oauth: false,
        enabled: true,
        timeout: task.answerTimeoutMs + 60_000,
      },
    },
  }),
},
files: [], // or [{ path: ".kilo/kilo.jsonc", contents: same JSON }] if preferring files
cwd: task.cwd,
```

**Permission / sandbox helpers (proposed):**

```text
read-only  → permission { "*":"deny", "read":"allow", "grep":"allow", "glob":"allow", "parley_*":"allow" }
             sandbox optional enabled:true network:allow|deny
workspace  → permission "allow" (or allow bash/edit + parley_*)
             sandbox: disabled  (git commit + hub MCP)
             if isolation required: sandbox enabled + network allow, accept no git writes to .git
full       → permission "allow", sandbox disabled
network off→ only with sandbox.network "deny" — breaks remote MCP tools; document as unsupported with hub
```

### `resume()`

Same as prepare, but insert `-s`, `task.sessionId` before the prompt (require sessionId).

```text
kilo run --format json --auto --dir <cwd> -s <sessionId> [ -m … --variant … ] "<prompt>"
```

### `parseEvent` table

| Raw `type` | → `VendorEvent.kind` | Fields to lift |
| --- | --- | --- |
| `step_start` | `session_meta` | `session_id = sessionID` |
| `text` | `message` | `text = part.text` |
| `tool_use` (tool bash / shell) | `command` | `text` from `part.state.input.command` or title |
| `tool_use` (write/edit/patch) | `file_change` | path from input |
| `tool_use` (other) | `[]` or soft `command` | keep raw JSONL as record |
| `step_finish` | `session_meta` | `session_id`; `usage` from `part.tokens` (+ cost optional) |
| `error` | `error` | `text = error.data.message`; `fatal: true` |
| unknown / non-JSON | `[]` | pass-through to raw log |

`sessionId(events)`: last `session_id` seen on any event (every line has it once a session exists).

`listModels`: `kilo models` plain lines → `{ id: line.trim() }`; optional `--verbose` for metadata.

### Top risks / unknowns

1. **Exit code 0 on API/auth failure** — treat stream `error` as fatal. **VERIFIED**.
2. **MCP timeout default 5s** — will kill `ask_orchestrator`; must raise. **DOCS**.
3. **Sandbox network-deny disables MCP tools** — incompatible with Parley hub. **DOCS**.
4. **Sandbox freezes `.git` read-only** — incompatible with commit-in-worktree. **DOCS**.
5. **`writable_paths` / `allowed_hosts` only from global config** — cannot expand via project/`KILO_CONFIG_CONTENT`. **DOCS** + **VERIFIED** drop behavior.
6. **Success-path JSONL not re-verified with live Kilo auth** — shapes from OpenCode lineage; pin fixtures once first successful run exists. **UNKNOWN** (auth blocked).
7. **`--auto` vs config permission interaction** under edge deny rules — re-test with real tools. **UNKNOWN**.
8. **Version churn** — daily-ish OpenCode-fork releases; pin `@kilocode/cli` version and set `KILO_DISABLE_AUTOUPDATE`.
9. **Linux install history** — older npm releases had missing platform binaries (GitHub issues); pin 7.4.9+ and CI-check `kilo --version`.
10. **User global config bleed** — children load `~/.config/kilo`; prefer complete `KILO_CONFIG_CONTENT` and evaluate `KILO_DISABLE_PROJECT_CONFIG` if needed.

### Alternative integration surfaces (out of scope, noted)

- `kilo serve` + `kilo run --attach http://…` — persistent server, lower MCP cold start (**DOCS**).
- `kilo acp` — ACP over stdio (**DOCS**); viable persistent-protocol adapter like grok ACP, separate design ticket.

---

## Definition of done checklist

- [x] Package/binary/version pinned with install command  
- [x] Headless argv + real JSON error line  
- [x] MCP HTTP + headers + injection path + timeout warning  
- [x] Session id field + resume argv  
- [x] Sandbox/approvals mapped to Parley postures  
- [x] Model/effort/auth  
- [x] Model list command + sample  
- [x] Token usage field names + example  
- [x] Adapter recommendation with parse table + risks  
)
