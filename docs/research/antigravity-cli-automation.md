# Antigravity CLI (`agy`) — automation surface for Parley

Research asset for writing the Parley vendor adapter `antigravity` (#286).
Verified against a live, authenticated install of **Antigravity CLI `agy`
v1.1.7** (Linux x86-64, container) on 2026-08-02.

**Evidence markers:** **VERIFIED** = an actual command was run against the live
1.1.7 install and its output is recorded below. **DOCS** = bundled
`agy-customizations` skill documentation shipped inside the CLI's own home, or
`agy changelog`. **UNVERIFIED** = could not be checked in this environment, with
the reason stated.

> **Sensitive-info note:** all paths below are written home-relative (`~/…`) or
> container-relative. No tokens, account identifiers, or host paths appear.
> Conversation UUIDs shown are throwaway ids from probe runs.

---

## TL;DR for Parley

`agy` **does** support real headless automation with a **typed NDJSON event
stream**. Closest shape is spawn-per-turn, same family as Codex/Grok.

| Need | Antigravity answer | Quality |
|------|--------------------|---------|
| One-shot headless | `agy -p "<prompt>" --output-format stream-json --dangerously-skip-permissions --model <id> [--effort <lvl>]` | Strong |
| Streaming JSON events | **Yes** — NDJSON on stdout: `init` → `step_update`* → `result` | Strong |
| Session id | `conversation_id` on **every** event (`init` and `result` both carry it) | Strong |
| Resume | `--conversation <uuid>` (VERIFIED across separate process invocations) | Strong |
| MCP injection | **No flag.** Global `~/.gemini/config/mcp_config.json` only → inject via a **per-task `HOME`** | Partial (stdio verified; HTTP/SSE unverified) |
| Approvals | `--dangerously-skip-permissions`, or `permissions.allow` rules in `settings.json` | Strong-ish |
| Process sandbox | `--sandbox` exists but **failed open** in our container | Weak — do not rely |
| Network off | **No lever at all** | Must refuse |
| Model + effort | `--model <id>` + `--effort low\|medium\|high`, validated server-side against a real matrix | Strong |
| Model enumeration | `agy models`; **labels only on a TTY** | Partial |
| Token usage | `usage{}` on `result` and on completed `step_update`s | Strong |
| Exit codes | **Not trustworthy** — see §2 | Weak |

Two things that shape the whole adapter:

1. **Headless auto-denies every permissioned tool by default** — including
   *reads* — and still exits **0** with `result.status:"SUCCESS"` and an empty
   `response`. The only signal is a `jetski: no output produced …` line on
   **stderr**. Always pass `--dangerously-skip-permissions` (or materialize
   `permissions.allow`), and treat *empty `response` + that stderr line* as a
   failure. (§2, §5)
2. **`--output-format` is undocumented in 1.1.7's `--help` but fully
   functional** (it becomes discoverable in 1.1.8 per `agy changelog`). Passing
   an **invalid** value silently falls back to `text` rather than erroring —
   the adapter must not assume a bad value will be caught. (§2)

---

## 1. Identity & install

| Field | Value | Evidence |
|-------|-------|----------|
| Product | Google **Antigravity CLI** | VERIFIED (`agy --help`, bundled `antigravity_guide` skill) |
| Binary | `agy` | VERIFIED `command -v agy` |
| Version pinned here | **1.1.7** | VERIFIED `agy --version` → `1.1.7` on **stdout**, exit 0 |
| Upstream newer | 1.1.8, 1.1.9 exist | DOCS `agy changelog` |
| Packaging | Single stripped Go ELF (~180 MB), glog-style internal logging | VERIFIED `file $(command -v agy)` |
| Self-update | `agy update` | VERIFIED help |
| Shell/env setup | `agy install` | VERIFIED help |
| Parley bin override | **`PARLEY_ANTIGRAVITY_BIN`** (repo convention: `PARLEY_<VENDOR>_BIN`, cf. `packages/daemon/src/adapters/gemini.ts`) | Convention |

### Home layout (VERIFIED `find ~/.gemini`)

`agy` kept the Gemini CLI's directory name. Two roots under `$HOME/.gemini`:

```text
~/.gemini/config/                      # global "customizations" root
  mcp_config.json                      # MCP servers (§3)
  config.json                          # userSettings
  projects/<project-id>.json
  .migrated

~/.gemini/antigravity-cli/             # CLI state root
  settings.json                        # model label, permissions.allow, trustedWorkspaces
  antigravity-oauth-token              # credential (mode 0600)
  installation_id
  conversations/<conversation-uuid>.db # SQLite per conversation (+ -wal, -shm)
  conversation_summaries.db
  history.jsonl                        # interactive input history
  log/cli-YYYYMMDD_HHMMSS.log          # glog file per process
  cli.log -> log/cli-<latest>.log
  brain/<uuid>/{scratch,.system_generated,.user_uploaded}
  knowledge/  cache/  crashes/  implicit/  scratch/
  builtin/skills/{antigravity_guide,agy-customizations,permissioned-github}
  bin/{agentapi,webm_encoder}
  jetski_state.pbtxt
```

`settings.json` observed in an operator home (VERIFIED, label persistence is
load-bearing for §7):

```json
{
  "model": "Gemini 3.6 Flash (Low)",
  "permissions": { "allow": ["command(*)"] },
  "trustedWorkspaces": ["/work"]
}
```

### Relocating the home (load-bearing for Parley isolation)

| Lever | Result | Evidence |
|-------|--------|----------|
| **`HOME`** | **Works.** Everything (auth, settings, MCP config, conversations, logs) re-roots under `$HOME/.gemini`. | VERIFIED: `HOME=/tmp/fresh agy models` → exit 1, stdout `Error: Please sign in to view available models.` |
| `ANTIGRAVITY_EXECUTABLE_DATA_DIR` | **No effect** — dir stayed empty, CLI still used the real home. | VERIFIED |
| `AGY_HOME` / `ANTIGRAVITY_HOME` | Do not exist (no such strings in the binary). | VERIFIED `strings` scan |
| `--log-file <path>` | Overrides the CLI log path only. | VERIFIED help |

**Auth survives a relocated `HOME`** if the token is carried over. VERIFIED:

```bash
TH=/tmp/taskhome
mkdir -p $TH/.gemini/antigravity-cli $TH/.gemini/config
cp ~/.gemini/antigravity-cli/antigravity-oauth-token $TH/.gemini/antigravity-cli/
cp ~/.gemini/antigravity-cli/installation_id        $TH/.gemini/antigravity-cli/
HOME=$TH agy --model gemini-3.6-flash --effort low --output-format stream-json \
  -p "Reply with exactly: OK"
# → exit 0, result.status "SUCCESS", response "OK\n"
```

This is the recommended per-task isolation primitive: **private `HOME`, seeded
with the operator's token, plus a task-private `mcp_config.json`** (§3).

---

## 2. Headless invocation

### `agy --help` surface (VERIFIED — note: help prints to **stderr**, exit 0)

```text
Usage of agy:
  --add-dir                       Add a directory to the workspace (repeatable) (default [])
  --agent                         Agent for the current CLI session
  -c                              Short alias for --continue
  --continue                      Continue the most recent conversation
  --conversation                  Resume a previous conversation by ID
  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting
  --effort                        Reasoning effort for the current CLI session (low|medium|high)
  -i                              Short alias for --prompt-interactive
  --log-file                      Override CLI log file path
  --mode                          Set the agent execution mode for this session (accept-edits, plan)
  --model                         Model for the current CLI session
  --new-project                   Create a new project for this session
  -p                              Short alias for --print
  --print                         Run a single prompt non-interactively and print the response
  --print-timeout                 Timeout for print mode wait (default 5m0s)
  --project                       Project ID for the current CLI session
  --prompt                        Alias for --print
  --prompt-interactive            Run an initial prompt interactively and continue the session
  --sandbox                       Run in a sandbox with terminal restrictions enabled

Available subcommands:
  agent  agents  changelog  help  install  models  plugin  plugins  update
```

`--output-format` and `--json-schema` are **not listed in 1.1.7** but exist
(§ below). `--disable-slash-commands` does **not** exist in 1.1.7 (VERIFIED:
`flags provided but not defined: -disable-slash-commands`, exit **2**).

### Preferred Parley argv

```bash
agy \
  --output-format stream-json \
  --dangerously-skip-permissions \
  --model <id> \
  [--effort low|medium|high] \
  -p "<prompt>"
```

- `-p` **requires** an argument. Piping the prompt on stdin with a bare `-p`
  fails: VERIFIED `echo "…" | agy -p` → stderr `flag needs an argument: -p`,
  exit **2**.
- Working directory = process cwd; `init.cwd` echoes it. No `--cd` flag. Extra
  roots via `--add-dir` (repeatable).
- `--print-timeout` defaults to `5m0s`; raise it for long Parley turns.

### Structured output — **it exists**

`--output-format text | json | stream-json` (DOCS `agy changelog` 1.1.8;
VERIFIED functional on 1.1.7).

**Invalid values are silently accepted and fall back to `text`** — VERIFIED
`agy --output-format bogus -p hi` → exit 0, plain prose on stdout, no error.
(Contrast with a genuinely undefined flag, which exits 2.) Never rely on `agy`
to reject a bad format string.

#### `stream-json` — full VERIFIED transcript

```bash
agy --model gemini-3.6-flash --effort low --output-format stream-json \
  -p "Reply with exactly: OK"
```

stdout (NDJSON; `tools` array elided for length — it lists ~50 builtin tools):

```json
{"event":"init","conversation_id":"6e86e734-6975-4c04-a496-4da04312d36f","init":{"model":"gemini-3.6-flash","cwd":"/scratch","tools":["ask_permission","ask_question","call_mcp_tool","code_search","run_command","write_to_file","view_file","…"],"permission_mode":"request-review"}}
{"event":"step_update","step_update":{"conversation_id":"6e86e734-…","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"6e86e734-…","step_index":1,"state":"DONE","step_type":"unknown","duration_seconds":0.00046232}}
{"event":"step_update","step_update":{"conversation_id":"6e86e734-…","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}
{"event":"step_update","step_update":{"conversation_id":"6e86e734-…","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"\n","duration_seconds":1.005008244,"usage":{"input_tokens":17998,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":17999}}}
{"event":"step_update","step_update":{"conversation_id":"6e86e734-…","step_index":3,"state":"DONE","step_type":"checkpoint","duration_seconds":0.572761634,"usage":{"input_tokens":97,"output_tokens":5,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":102}}}
{"event":"result","result":{"conversation_id":"6e86e734-…","status":"SUCCESS","response":"OK\n","duration_seconds":1.617231391,"num_turns":1,"usage":{"input_tokens":18095,"output_tokens":6,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":18101}}}
```

**Envelope shape (important):** the discriminator is **`event`**, and the
payload is nested under a key with the **same name** as the event:
`{"event":"init","init":{…}}`, `{"event":"step_update","step_update":{…}}`,
`{"event":"result","result":{…}}`. `conversation_id` appears both at envelope
level (on `init`) and inside the payload.

| `event` | Payload fields | Evidence |
|---------|----------------|----------|
| `init` | `model`, `cwd`, `tools[]`, `permission_mode` | VERIFIED |
| `step_update` | `conversation_id`, `step_index`, `state` (`ACTIVE`\|`DONE`), `step_type`, optional `text_delta`, `duration_seconds`, `usage{}`, `tool_name`, `tool_info{name,parameters}` | VERIFIED |
| `result` | `conversation_id`, `status` (`SUCCESS`\|`ERROR`), `response`, optional `error` (string), `duration_seconds`, `num_turns`, `usage{}` | VERIFIED both statuses |

`step_type` values observed live: `user_input`, `agent_response`, `tool`,
`checkpoint`, `unknown`. DOCS (changelog 1.1.8) describe it as a "stable,
closed-vocabulary discriminator" and mention a `subagent_info` payload
(`conversation_id`, `log_uri`) for delegated subagents — **UNVERIFIED**, no
subagent run was performed.

Tool step example (VERIFIED, from the file-creation probe):

```json
{"conversation_id":"d78092ec-…","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"~/.gemini/antigravity-cli/scratch/probe-a.txt"}}}
```

Note tool steps emit twice: `state:"ACTIVE"` then `state:"DONE"` with
`duration_seconds`. `tool_info.parameters` did **not** include the file body in
this run — treat parameter richness as tool-dependent.

#### `json` (single object) — VERIFIED

```json
{"conversation_id":"35ea5c59-0eeb-4a21-b25a-c5eae7c56db6","status":"SUCCESS","response":"OK\n","duration_seconds":1.508488962,"num_turns":1,"usage":{"input_tokens":9946,"output_tokens":5,"thinking_tokens":0,"cache_read_tokens":8141,"total_tokens":9951}}
```

Same object as the `result` payload, unwrapped.

### stdout vs stderr

**stderr is essentially empty on normal headless runs** — the glog `I…`/`W…`/
`E…` chatter goes to `~/.gemini/antigravity-cli/log/cli-*.log`, not to the
parent (VERIFIED across ~20 runs). stderr carries only:

| stderr content | When |
|----------------|------|
| `Usage of agy: …` | `--help`, or a flag error (exit 2) |
| `flag needs an argument: -p` / `flags provided but not defined: -x` | argv misuse |
| `Authentication required. Please visit the URL to log in: …` + `Waiting for authentication (timeout 60s)…` | no valid token (§6) |
| `jetski: no output produced — a tool required the "<perm>" permission that headless mode cannot prompt for, so it was auto-denied. …` | **silent tool denial** (§5) — load-bearing |

**stdout is the durable record.** Keep streams separate; the denial diagnostic
on stderr must still be captured because it is the only failure signal in the
auto-deny case.

### Exit codes — **do not trust**

| Situation | Exit | `result.status` | Evidence |
|-----------|------|-----------------|----------|
| Success | 0 | `SUCCESS` | VERIFIED |
| Invalid `--effort` / unlisted model+effort combo | **1** | (no stream; error on stderr) | VERIFIED |
| Undefined flag / missing `-p` argument | **2** | (usage on stderr) | VERIFIED |
| No auth token | **1** | `ERROR`, `error:"authentication failed or timed out"`, empty `conversation_id` | VERIFIED |
| `--sandbox` runtime failure | **0** | **`ERROR`** with `error:"…connecting to sandbox server: …"` | VERIFIED |
| Tool auto-denied by permissions | **0** | **`SUCCESS`** with **empty `response`** + stderr `jetski:` line | VERIFIED |

**Adapter rule:** success requires `result.status === "SUCCESS"` **and** a
non-empty `response` **and** no `jetski: no output produced` line on stderr.
Exit code alone is insufficient in both directions.

---

## 3. MCP injection

### Mechanism (DOCS bundled `agy-customizations/docs/mcp_servers.md`)

MCP servers are declared in `mcp_config.json`:

```json
{
  "mcpServers": {
    "parley": {
      "command": "node",
      "args": ["/path/to/bridge.js"],
      "env": { "X": "1" }
    },
    "remote": { "serverUrl": "https://host/sse" }
  }
}
```

Documented transports: **stdio** (`command`/`args`/`env`) and **SSE**
(`serverUrl`). There is **no documented Streamable-HTTP key** and no `headers`
key — a material difference from the Gemini CLI's `httpUrl` + `headers`.

Documented locations: **global `~/.gemini/config/mcp_config.json`** and
**plugin-scoped `plugins/<name>/mcp_config.json`**.

### Discovery — VERIFIED empirically

Probe: an `mcpServers` entry whose `command` is `sh -c "touch <marker>; sleep 20"`,
so the marker file proves the server was actually spawned.

| Location | Marker created? | Verdict |
|----------|-----------------|---------|
| `~/.gemini/config/mcp_config.json` | **yes** | **VERIFIED discovered + spawned** |
| `<cwd>/.agents/mcp_config.json` (workspace customization root, git repo) | **no** | **VERIFIED not discovered** |

So although `.agents/` is the workspace customization root for rules/skills/
plugins, **MCP is not workspace-scoped**. Confirms the DOCS location list is
exhaustive for `mcp_config.json`.

| Mechanism | Usable for Parley? |
|-----------|--------------------|
| CLI flag for MCP URL/command | **No** — none in `--help` (VERIFIED) |
| Workspace `.agents/mcp_config.json` | **No** (VERIFIED negative) |
| Global `~/.gemini/config/mcp_config.json` | **Yes — but global**, so it must be a *task-private* `HOME` |
| Plugin `plugins/<name>/mcp_config.json` | Possible; requires installing/enabling a plugin — heavier, not exercised |

### Recommended per-task injection (VERIFIED end-to-end)

```text
HOME = <task-private dir>
  <HOME>/.gemini/antigravity-cli/antigravity-oauth-token   # copied from operator home
  <HOME>/.gemini/antigravity-cli/settings.json             # permissions (§5)
  <HOME>/.gemini/config/mcp_config.json                    # parley hub
```

VERIFIED: with exactly this layout, a `-p` run authenticated normally **and**
the task-private stdio MCP server was spawned (marker file created) — the
operator's own `~/.gemini` was never mutated.

> **Parley decision (#298 / ADR-0026):** this per-task-`HOME` + credential-copy
> recipe is **verified but REJECTED** for the parley adapter. Copying
> `antigravity-oauth-token` / `installation_id` into the task tree is not
> acceptable; mutating the operator's global `mcp_config.json` is not either.
> Parley therefore spawns against the real operator `~/.gemini` (no `HOME`
> override) and delivers the child channel over **http** (daemon
> `POST /child/report` / `POST /child/ask`), not MCP. Conversation-store
> sharing is accepted (ADR-0025 posture). See ADR-0026.

**Open item for #286:** Parley's hub is a Streamable-HTTP MCP endpoint with
correlation **headers**. `agy` documents only `serverUrl` (SSE) with no header
map. A `serverUrl` entry is *accepted* without error (VERIFIED: run completed
normally with `serverUrl: http://127.0.0.1:9/sse` configured), but an actual
remote connection was **UNVERIFIED** — no MCP connection lines appear in
`cli.log`, so neither success nor failure could be observed. **Safest child
channel: a stdio bridge** — a small `command`-launched process that carries the
task id via `env` and proxies to the daemon. That also side-steps the missing
`headers` support.

**Tool naming:** the builtin toolset includes a generic **`call_mcp_tool`**
dispatcher (VERIFIED in `init.tools`). MCP tools therefore appear to be invoked
through that dispatcher rather than being flattened into individually named
tools. Exact naming/namespacing of MCP tools was **UNVERIFIED** (no real MCP
server with tools was attached).

---

## 4. Session resume

### Session id

`conversation_id` is a plain UUID, emitted on **`init`** (envelope level and
inside `init`) and on **every** `step_update` and `result` payload. VERIFIED.

Also observable on disk: `~/.gemini/antigravity-cli/conversations/<uuid>.db`
(SQLite, with `-wal`/`-shm`), plus `conversation_summaries.db` and
`history.jsonl` (whose entries carry `conversationId` and `workspace`).

### Resume — VERIFIED across separate process invocations

```bash
# turn 1
agy --model gemini-3.6-flash --effort low --output-format stream-json \
  -p "Remember the codeword PLUMBUS. Reply with exactly: OK"
# → init.conversation_id = bfa7ed1b-b6d1-4392-ae88-54d79bde48ad
#   result.status SUCCESS, num_turns 1

# turn 2, separate process (separate container run)
agy --model gemini-3.6-flash --effort low --output-format stream-json \
  --conversation bfa7ed1b-b6d1-4392-ae88-54d79bde48ad \
  -p "What was the codeword? Reply with just the word."
# → init.conversation_id = bfa7ed1b-…   (same id reused)
#   result: {"status":"SUCCESS","response":"PLUMBUS\n","num_turns":2}
```

Context carried, id preserved, `num_turns` incremented. This is exactly
Parley's spawn-per-turn model.

| Flag | Meaning | Evidence |
|------|---------|----------|
| `--conversation <uuid>` | Resume that conversation | VERIFIED |
| `-c` / `--continue` | Continue the most recent conversation | VERIFIED help; racy under concurrency — **do not use** |

**Caveat:** conversations live under `$HOME/.gemini/antigravity-cli/conversations/`.
Resume requires **the same `HOME`** used for the original turn, so a per-task
home must persist across prepare→resume.

**UNVERIFIED:** behaviour when `--conversation` is given an unknown UUID (not
probed).

---

## 5. Sandbox & approvals

### Default headless behaviour is **deny-everything**

`init.permission_mode` is **`request-review`** by default, and headless mode
cannot prompt, so **every** permissioned tool is auto-denied — reads included.

VERIFIED, plain `-p` asking for a file read:

```text
# exit 0
# stdout: {"event":"result","result":{…,"status":"SUCCESS","response":"", …}}
# stderr: jetski: no output produced — a tool required the "read_file" permission
#         that headless mode cannot prompt for, so it was auto-denied. Add an
#         allow-rule under permissions.allow in settings.json (e.g.
#         read_file(<target>)). Alternatively, re-run with
#         --dangerously-skip-permissions to auto-approve all tools.
```

Same result for `write_file`. **A Parley child without an approval lever will
silently do nothing and report success.**

### Levers

| Lever | Effect | Evidence |
|-------|--------|----------|
| `--dangerously-skip-permissions` | `init.permission_mode` becomes **`always-proceed`**; all tools auto-approved | VERIFIED (file written) |
| `settings.json` → `permissions.allow: ["write_file(*)"]` | Grants that tool; `permission_mode` stays `request-review` but the tool runs | VERIFIED (file written) |
| `settings.json` → `permissions.allow: ["command(*)"]` | Same for shell | Observed in operator home |
| `--mode accept-edits` | **No effect in print mode** — `permission_mode` stayed `request-review` and the write was still auto-denied | VERIFIED |
| `--mode plan` | **No effect in print mode** — same denial, `permission_mode` unchanged | VERIFIED |
| `--sandbox` | Attempts a sandbox server; see below | VERIFIED |

**Path-scoped allow rules do not work with the obvious syntax.** VERIFIED:
`"allow": ["write_file(/scratch/allowed/*)"]` denied a write to
`/scratch/allowed/probe-i.txt` (inside the stated scope) exactly as it denied
one outside it. Only the bare `*` argument was observed to grant. Treat
directory-scoped permissions as **UNVERIFIED / not available** — the real
pattern syntax is undocumented in the bundled docs.

### `--sandbox` fails **open** — VERIFIED

```bash
agy --output-format stream-json --sandbox --dangerously-skip-permissions \
  -p "Run the shell command: echo SANDBOXPROBE > /scratch/probe-e.txt . Then stop."
```

```json
{"event":"result","result":{"status":"ERROR",
 "response":"I have executed the requested command (`echo SANDBOXPROBE > /scratch/probe-e.txt`).\n",
 "error":"error executing cascade step: CORTEX_STEP_TYPE_RUN_COMMAND: connecting to sandbox server: read unix @ -> @: recvmsg: connection reset by peer", …}}
```

Exit code **0**, `status` `ERROR` — **and the file was created on the host
mount anyway** (`-rw-r--r-- 13 bytes`). The sandbox server failed to attach and
the command ran unsandboxed. In this environment `--sandbox` provides **no
isolation guarantee**; whether it works on a bare host is **UNVERIFIED**.

### Network

**No network lever exists anywhere** — no flag in `--help`, no documented
setting in the bundled customization docs, and `--sandbox` is described only as
"terminal restrictions". VERIFIED absence in help; UNVERIFIED whether the
(broken) sandbox would restrict egress.

### Parley posture mapping (ADR-0006 / ADR-0023)

| Parley posture | `agy` mapping | Can honor? |
|----------------|---------------|-----------|
| `read-only`, network on | Omit `--dangerously-skip-permissions`; materialize `permissions.allow: ["read_file(*)", "code_search(*)", …]` in the task home's `settings.json`. Writes/commands stay auto-denied by `request-review`. | **Partial** — reads are unscoped (host-wide), and any denied tool is silent. Document, do not claim enforcement. |
| `workspace`, network on (default) | `--dangerously-skip-permissions`, cwd = worktree, `--add-dir <gitDir> <gitCommonDir>` as needed | **Partial** — nothing confines writes to the worktree (path-scoped allow rules do not work, §5). This is effectively `full`. |
| `workspace`, network off | — | **Refuse** — no network lever |
| `full`, network on | `--dangerously-skip-permissions`, no `--sandbox` | **Yes** |
| `full`, network off | — | **Refuse** — no network lever |

Follow the gemini adapter's precedent (`assertGeminiNetworkPosture`): refuse
`network:false` loudly for **every** sandbox value rather than under-isolate.
Additionally, the `workspace` posture should either be documented as
best-effort (write confinement not enforced by `agy`) or delegated to Parley's
own outer isolation.

Do **not** pass `--sandbox`: it fails open and turns a `SUCCESS` run into an
`ERROR` result while still executing the command.

---

## 6. Model & effort flags; auth env vars

### Flags

| Flag | Values | Evidence |
|------|--------|----------|
| `--model <id>` | Any id from `agy models`, **with or without** the effort suffix | VERIFIED |
| `--effort <level>` | **`low` \| `medium` \| `high`** only | VERIFIED |

Validation happens **before** any model call, on stderr, exit **1**.

#### Q1 — does `--effort` accept `thinking`? **NO.** (VERIFIED)

```bash
agy --effort thinking -p "Reply with exactly: OK"
# exit 1
# Error: invalid model selection (--model "" --effort "thinking"): invalid --effort "thinking" (valid: low, medium, high)
```

**Consequence for #286:** `claude-opus-4-6-thinking` is **one opaque model id**.
Never split a trailing `-thinking`. Only `-high`/`-medium`/`-low` are effort
suffixes.

#### Q2 — is an unlisted model+effort combo rejected? **YES.** (VERIFIED)

```bash
agy --model gemini-3.1-pro --effort medium -p "Reply with exactly: OK"
# exit 1
# Error: invalid model selection (--model "gemini-3.1-pro" --effort "medium"): gemini-3.1-pro has no "medium" effort (available: low, high)
```

The gap in the listing is a **real constraint**, not a listing artifact. The
error even echoes the true available set. Never synthesize efforts.

#### Q3 — models with no listed suffix reject `--effort` entirely (VERIFIED)

```bash
agy --model claude-sonnet-4-6        --effort low -p …
# Error: … --effort is not supported for model "claude-sonnet-4-6"
agy --model claude-opus-4-6-thinking --effort low -p …
# Error: … --effort is not supported for model "claude-opus-4-6-thinking"
```

So `claude-sonnet-4-6` and `claude-opus-4-6-thinking` must be spawned with
**`--model` only, no `--effort`** — matching #286's "empty efforts" expectation.
The "(Thinking)" in their labels is a product descriptor, not an effort level.

Quirk: an **unknown** model id produces the *same* "effort is not supported"
message rather than "unknown model" (VERIFIED with
`--model no-such-model-xyz --effort low`). Do not parse that message to
distinguish the two cases.

#### Flattened ids are also accepted as `--model` (VERIFIED)

```bash
agy --model gemini-3.6-flash-low             -p "…"   # exit 0
agy --model gemini-3.6-flash-low --effort low -p "…"  # exit 0
```

Harmless, but #286's requirement stands: pass `--model <base-id> --effort <lvl>`
as separate flags — that form is what the validator is designed around, and it
is the only form that lets Parley reason about efforts.

#### No `--effort` at all

Omitting `--effort` is always valid; the CLI uses the account/settings default
(the operator home persists `"model": "Gemini 3.6 Flash (Low)"`). VERIFIED
(`--model gemini-3.6-flash-low -p …` and `-p` with no model flags both run).

### Auth

**OAuth only.** The credential is `~/.gemini/antigravity-cli/antigravity-oauth-token`.
No API-key environment variable was found (no `*_API_KEY` string plausibly wired
into auth; the missing-auth path offers only a browser flow).

Missing-auth headless behaviour (VERIFIED, fresh empty `HOME`):

```text
# stderr
Authentication required. Please visit the URL to log in:
  https://accounts.google.com/o/oauth2/auth?…
Waiting for authentication (timeout 60s)...
Or, paste the authorization code here and press Enter:

# stdout (with --output-format stream-json)
{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{…all zero}}}

# exit 1
```

**Gotcha:** an unauthenticated headless run **blocks for 60 s** waiting for an
interactive paste before failing. The adapter must either pre-verify the token
file exists or expect a minute-long stall.

**Adapter env:** forward nothing for auth; instead seed the task home's
`antigravity-cli/antigravity-oauth-token` (and `installation_id`) from the
operator home (§1, §3).

---

## 7. Model enumeration

### Command

`agy models` — exit 0, output on **stdout**. Requires auth + network (it
fetches; a spinner `Fetching available models...` runs first).

Unauthenticated (VERIFIED): exit **1**, stdout
`Error: Please sign in to view available models. Launch the CLI without arguments to sign in.`

`agy models --help` shows **only** `-h/--help` — there is **no `--json`** or
other machine-readable flag (VERIFIED).

### Output contract — **TTY-dependent** (VERIFIED, load-bearing)

**Piped stdout (what a Parley probe gets by default): ids only, one per line,
no header, no labels, no padding.** VERIFIED via `agy models | cat -A`:

```text
gemini-3.6-flash-high$
gemini-3.6-flash-medium$
gemini-3.6-flash-low$
gemini-3.5-flash-high$
gemini-3.5-flash-medium$
gemini-3.5-flash-low$
gemini-3.1-pro-high$
gemini-3.1-pro-low$
claude-sonnet-4-6$
claude-opus-4-6-thinking$
gpt-oss-120b-medium$
```

**With a TTY attached: two space-padded columns, id then display label.**
VERIFIED via `docker run -t … agy models | cat -A`:

```text
gemini-3.6-flash-high     Gemini 3.6 Flash (High)^M$
gemini-3.6-flash-medium   Gemini 3.6 Flash (Medium)^M$
gemini-3.6-flash-low      Gemini 3.6 Flash (Low)^M$
gemini-3.5-flash-high     Gemini 3.5 Flash (High)^M$
gemini-3.5-flash-medium   Gemini 3.5 Flash (Medium)^M$
gemini-3.5-flash-low      Gemini 3.5 Flash (Low)^M$
gemini-3.1-pro-high       Gemini 3.1 Pro (High)^M$
gemini-3.1-pro-low        Gemini 3.1 Pro (Low)^M$
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)^M$
claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)^M$
gpt-oss-120b-medium       GPT-OSS 120B (Medium)^M$
```

TTY specifics: lines end **`\r\n`**; the id column is padded with spaces to
`len(longest id) + 2` (26 here, from `claude-opus-4-6-thinking`); the first row
is preceded by a spinner that repeatedly rewrites the line with `\r` and ends
with an ANSI erase (`\x1b[K`). A TTY parser must strip the pre-`\x1b[K` prefix
and `\r`, and must not assume a fixed column width.

### Parsing rule for `listModels()`

1. Read stdout lines; drop empties.
2. If a line contains a run of 2+ spaces, split on the **first** such run →
   `id`, `label` (TTY mode). Otherwise the whole line is the `id` and there is
   no label (pipe mode).
3. Strip a trailing **`-high`**, **`-medium`**, or **`-low`** from `id` → base
   model id + effort level. **No other suffix.** `claude-opus-4-6-thinking`
   keeps its suffix (§6 Q1).
4. Collect efforts per base id **only from listed rows** — never synthesize
   (§6 Q2).
5. Preserve `label` when present.

Yield from the listing above:

| model id | efforts | label (TTY only) |
|----------|---------|------------------|
| `gemini-3.6-flash` | high, medium, low | `Gemini 3.6 Flash (<Level>)` per row |
| `gemini-3.5-flash` | high, medium, low | `Gemini 3.5 Flash (<Level>)` |
| `gemini-3.1-pro` | high, low | `Gemini 3.1 Pro (<Level>)` |
| `claude-sonnet-4-6` | *(none)* | `Claude Sonnet 4.6 (Thinking)` |
| `claude-opus-4-6-thinking` | *(none)* | `Claude Opus 4.6 (Thinking)` |
| `gpt-oss-120b` | medium | `GPT-OSS 120B (Medium)` |

### The label→id bridge

`agy` persists the operator's model selection as a **display label**, not an id
— VERIFIED in `~/.gemini/antigravity-cli/settings.json`:

```json
{ "model": "Gemini 3.6 Flash (Low)" }
```

and in `cli.log`:

```text
model_resolver.go: Resolving model gemini-3.6-flash-low
model_config_manager.go: Propagating selected model override to backend: label="Gemini 3.6 Flash (Low)"
```

So the label column is the **only** documented way back from a stored selection
to a usable id — **and it is unavailable in piped output.** If #286 wants labels
on catalog entries (or ever wants to read the operator's selection), the probe
must **allocate a pty** for `agy models`. Labels are not reliably derivable from
ids (`gpt-oss-120b` → `GPT-OSS 120B`, `claude-sonnet-4-6` → `Claude Sonnet 4.6
(Thinking)`).

`-p` runs do **not** rewrite `settings.json` (VERIFIED — mtime unchanged across
all probe runs), so a child cannot clobber the operator's stored selection.

---

## 8. Token usage

VERIFIED — usage appears in two places, same field set:

- on each **completed** `step_update` (`state:"DONE"`), scoped to that step;
- on the terminal **`result`** (and on the `json` single object), aggregated.

```json
"usage": {
  "input_tokens": 18095,
  "output_tokens": 6,
  "thinking_tokens": 0,
  "cache_read_tokens": 0,
  "total_tokens": 18101
}
```

Non-zero `cache_read_tokens` observed on warm runs (e.g. `8141`, `20347`),
confirming prompt-cache attribution (DOCS changelog 1.1.8 introduced this
field). `thinking_tokens` was 0 on all low-effort flash probes; **UNVERIFIED**
non-zero (no high-effort/reasoning run was made).

`result` also carries `duration_seconds` and `num_turns`, both useful for
ADR-0020 run metrics.

**Adapter parse:** map `result.usage` into the terminal `session_meta`. Per-step
usage can be ignored or accumulated; note that step usage does **not** sum to
the result total in the observed run (17999 + 102 ≠ 18101 exactly at the
component level), so prefer `result.usage` as authoritative.

---

## 9. Adapter recommendation

### `prepare(task, hub)` → `SpawnPlan`

**argv:**

```text
agy
  --output-format stream-json
  --dangerously-skip-permissions          # unless posture is read-only (§5)
  --model <task.model>                    # base id, no effort suffix
  [--effort <task.effort>]                # only if the catalog lists it for that model
  [--add-dir <gitDir>] [--add-dir <gitCommonDir>]
  --print-timeout <turn budget>
  -p <task.prompt>
```

**cwd:** `task.cwd` (no `--cd` flag).

**env:**

| Key | Value |
|-----|-------|
| `HOME` | task-private home dir (see files) |

**files** (materialized under the task-private `HOME`):

| Path | Contents |
|------|----------|
| `.gemini/antigravity-cli/antigravity-oauth-token` | copied from the operator home (0600) |
| `.gemini/antigravity-cli/installation_id` | copied from the operator home |
| `.gemini/antigravity-cli/settings.json` | `permissions.allow` per posture (§5) |
| `.gemini/config/mcp_config.json` | `mcpServers.parley` — **stdio bridge recommended** (§3) |

Binary resolution: `env.PARLEY_ANTIGRAVITY_BIN ?? "agy"`.

> **Parley deviation (#298 / ADR-0026):** the table above is the research-verified
> recipe. Parley **does not** set `HOME` or materialize those files; it spawns
> against the operator home and declares child channel `http` (engine injects
> `PARLEY_HUB_URL` / `PARLEY_TASK_ID`). See §3 note and ADR-0026.

### `resume(task, hub)` → `SpawnPlan`

Identical, plus `--conversation <task.sessionId>`, and the **same** `HOME` path
must be reused (conversations live there). Refuse if `sessionId` is missing —
`--continue` is racy under concurrency.

### `parseEvent` table

Parse **stdout** as NDJSON; keep stderr separately but *do* scan it for the
denial diagnostic.

| Line | → `VendorEvent` |
|------|-----------------|
| `event=="init"` | `{ kind: "session_meta", session_id: conversation_id }` |
| `event=="step_update"`, `step_type=="agent_response"` | `{ kind: "message", text: text_delta }` (chunked; concatenate or emit per chunk) |
| `event=="step_update"`, `step_type=="tool"`, `state=="ACTIVE"` | `{ kind: "command", text: tool_name + " " + JSON(tool_info.parameters) }` |
| `event=="step_update"`, `step_type=="tool"`, `state=="DONE"` | `[]` (or a completion marker) |
| `event=="step_update"`, `step_type` in {`user_input`,`checkpoint`,`unknown`, anything new} | `[]` — **pass through opaquely, never error** |
| `event=="result"`, `status=="SUCCESS"`, non-empty `response` | `{ kind: "session_meta", usage }` (+ optional final `message`) |
| `event=="result"`, `status=="SUCCESS"`, **empty** `response` | `{ kind: "error", text: "tools auto-denied (see stderr)", fatal: true }` — see gotcha 1 |
| `event=="result"`, `status=="ERROR"` | `{ kind: "error", text: error, fatal: true }` (+ usage) |
| stderr line matching `/^jetski: no output produced/` | `{ kind: "error", text, fatal: true }`, tagged `PARLEY-DIAG` |
| non-JSON / unknown `event` | `[]` (opaque; raw NDJSON stays durable) |

`sessionId(events)`: last `session_meta.session_id`; every event carries
`conversation_id` so any of them works as a fallback.

### Numbered gotchas checklist

1. **Silent auto-deny.** Default headless `permission_mode` is `request-review`
   and *every* permissioned tool — including `read_file` — is auto-denied, with
   exit **0**, `result.status:"SUCCESS"` and an **empty `response`**. The only
   marker is `jetski: no output produced …` on stderr. Always pass
   `--dangerously-skip-permissions` or materialize `permissions.allow`, and
   treat empty-`response` success as failure.
2. **Exit codes lie both ways.** `--sandbox` failure → exit 0 with
   `status:"ERROR"`; auto-deny → exit 0 with `status:"SUCCESS"`. Parse the
   `result` event.
3. **`--output-format` is hidden in 1.1.7** (documented from 1.1.8) and an
   **invalid value silently falls back to `text`** — a typo yields prose, not an
   error. Verify the first stdout line parses as JSON.
4. **Envelope is doubly nested:** `{"event":"result","result":{…}}`. Do not
   assume flat fields.
5. **`--effort` accepts only `low|medium|high`.** `thinking` is rejected —
   `claude-opus-4-6-thinking` is one id.
6. **Unlisted model+effort combos are hard-rejected** (`gemini-3.1-pro` has no
   `medium`). Never synthesize efforts; never pass `--effort` to a model listed
   without a suffix (hard error).
7. **`agy models` hides the label column when stdout is a pipe.** Labels — the
   only bridge back from `settings.json`'s stored display label to an id —
   require a **pty**. TTY mode also injects a spinner prefix and `\r\n`.
8. **MCP is global-only.** No flag; `.agents/mcp_config.json` is *not*
   discovered (verified). Per-task injection ⇒ per-task `HOME`. **Parley
   rejects that path** (credential copy) and uses the http child channel
   instead (#298 / ADR-0026).
9. **No `headers` and no Streamable-HTTP key** in `mcp_config.json` — only
   stdio and SSE `serverUrl`. Prefer a stdio bridge for the parley hub *if*
   using MCP; correlation must ride in `env`, not headers. Parley does not
   use MCP for antigravity (#298).
10. **`HOME` is the only home override.** `ANTIGRAVITY_EXECUTABLE_DATA_DIR` does
    nothing. Copy `antigravity-oauth-token` (+ `installation_id`) into a task
    home or the run stalls 60 s on an interactive OAuth prompt then exits 1.
    **Parley does not copy credentials** — it spawns with the operator's real
    home (#298 / ADR-0026).
11. **`--sandbox` fails open** — the command still ran and wrote to disk while
    the result reported a sandbox connection error. Do not pass it and do not
    treat it as isolation.
12. **No network lever exists.** Refuse `network:false` for every posture
    (gemini adapter precedent).
13. **Path-scoped `permissions.allow` patterns did not work** —
    `write_file(/scratch/allowed/*)` denied an in-scope write. Only `<tool>(*)`
    was observed to grant, so writes cannot be confined to the worktree by this
    mechanism.
14. **`--mode plan` / `--mode accept-edits` are no-ops in print mode** — neither
    changed `permission_mode` nor unblocked a write. Do not map postures onto
    `--mode`.
15. **Resume needs the same `HOME`** (conversations are SQLite files under it)
    and an explicit `--conversation <uuid>`; `-c/--continue` is racy.
16. **`-p` requires an argument.** Piping the prompt via stdin with a bare `-p`
    exits 2.
17. **Version drift.** Pinned at 1.1.7; 1.1.8/1.1.9 exist upstream and change
    the headless surface (`--output-format` documented, `--disable-slash-commands`
    added, slash/skill expansion in print mode, `init` tool list fixed).
    `agy update` self-updates — record `agy --version` in diag and re-verify.
18. **Slash-command expansion in print mode** lands in 1.1.9 (DOCS changelog):
    from then on a prompt beginning with `/` is interpreted as a command, not
    literal text. Parley prompts starting with `/` become a hazard on ≥1.1.9.

---

## Sources

| Source | Role |
|--------|------|
| Live authenticated `agy` **v1.1.7** (Linux x86-64 container) | VERIFIED — ~25 probe runs: help, models (pipe + pty), print/stream-json/json, effort & model validation, resume, permissions, sandbox, MCP discovery, isolated-HOME auth |
| `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/` (`SKILL.md`, `docs/mcp_servers.md`, `docs/json_configs.md`) | DOCS — customization discovery, precedence, `mcp_config.json` schema and locations |
| `agy changelog` (1.1.6 – 1.1.9) | DOCS — `--output-format`/`stream-json`/`--json-schema` introduction, `cache_read_tokens`, `subagent_info`, print-mode slash expansion |
| `~/.gemini/antigravity-cli/log/cli-*.log` | VERIFIED — model resolution and label propagation lines, backend/workspace init |
| `strings` scan of the `agy` binary | VERIFIED (negative) — no `AGY_HOME`/`ANTIGRAVITY_HOME`, no `httpUrl`/`serverUrl` config keys surfaced |
| `packages/daemon/src/adapters/gemini.ts` | Repo convention — `PARLEY_<VENDOR>_BIN`, loud posture refusal precedent |

### Explicitly unverified

- Real MCP tool call end-to-end (no hub attached): tool naming/namespacing and
  whether `serverUrl` (SSE) actually connects.
- `--conversation` with an unknown UUID.
- `--sandbox` on a bare host (it failed to attach inside the test container).
- Non-zero `thinking_tokens` (only low-effort flash models were probed).
- `subagent_info` events and `--json-schema` (1.1.8+ features not present or not
  exercised on 1.1.7).
- `--agent`, `--project`, `--new-project`, `--add-dir` behaviour beyond help text.
