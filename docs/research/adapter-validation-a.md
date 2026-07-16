# Adversarial validation — group A adapters (#107)

Hostile review of `opencode`, `claude`, `gemini`, `goose`, and `pi` adapters
(`packages/daemon/src/adapters/{opencode,claude,gemini,goose,pi}.ts`).

**Method:** re-derived each harness automation surface from primary sources
(official docs, installed CLI `--help`/live runs, npm package contents) at the
adapter-pinned version and, where available, an adjacent version for flag drift.
Adapters were **not** modified; this file is findings only.

**Date:** 2026-07-16  
**Worktree:** `parley/t271-validate-a`

---

## Verdict table

| Adapter | Verdict | Critical | Major | Minor |
| --- | --- | --- | --- | --- |
| opencode | needs fixes | 0 | 2 | 2 |
| claude | needs fixes | 0 | 2 | 2 |
| gemini | needs fixes | 0 | 2 | 2 |
| goose | needs fixes | 1 | 2 | 1 |
| pi | needs fixes | 2 | 1 | 1 |

Zero critical+major across five adapters would not be credible; several defects
are integration-path silent failures (hub tools missing, weaker isolation than
posture names imply, version flag drift).

---

## Findings

### [opencode] `--auto` does not exist on OpenCode ≤1.16.x (renamed to `--dangerously-skip-permissions`)

- **Severity:** major
- **Evidence:** Installed host binary `opencode --version` → **1.16.2**;
  `opencode run --help` lists only `--dangerously-skip-permissions`, not
  `--auto`. Scratch install `opencode-ai@1.18.2` (and npm `latest` still
  1.18.2) lists `--auto`. On 1.16.2, `opencode run --auto …` dumps help /
  fails to run the agent (yargs does not map the alias). Adapter
  `commonArgs()` hard-codes `--auto` (`opencode.ts`). Official docs at
  https://opencode.ai/docs/permissions/ document `--auto` for current line.
- **Fix:** In `packages/daemon/src/adapters/opencode.ts` `commonArgs()`, prefer
  version-aware flag: try/detect, or document pin ≥1.18.2 and fail preflight if
  `--help` lacks `--auto`. Safer argv:
  - before: `["--format", "json", "--auto", "--dir", task.cwd]`
  - after: `["--format", "json", "--dangerously-skip-permissions", "--dir", task.cwd]`
    **or** emit both only when supported, with a version gate that rejects
    `<1.17` (or whatever release introduced `--auto`). Also set
    `OPENCODE_PERMISSION='{"*":"allow"}'` (or rely on injected permission map)
    so approvals still skip if the flag name drifts again.

### [opencode] MCP `timeout` coverage for long tool calls remains unproven (docs ambiguity)

- **Severity:** major
- **Evidence:** Adapter sets `mcp.parley.timeout = answerTimeoutMs + 60_000` via
  `OPENCODE_CONFIG_CONTENT` (verified merge with `opencode debug config` on
  1.18.2 — injected `mcp.parley` present). Official MCP schema/docs disagree on
  whether `timeout` is tool **execution** or tool **discovery** only (research
  marks UNKNOWN; still UNKNOWN after this pass). Default schema value is **5000
  ms**. A blocking `ask_orchestrator` that exceeds discovery-only timeout would
  be killed while Parley's answer timeout still has budget — silent protocol
  failure class.
- **Fix:** Before shipping, smoke-test a hub tool that sleeps >
  5s with timeout raised; if calls still die at 5s, switch to whatever knob
  actually bounds tool execution (or keep a long-lived attach/`opencode serve`
  path). Document the verified behavior in the adapter comment once proven.
  File: `configContent()` / `mcpTimeoutMs()`.

### [opencode] Host install vs pinned research version not enforced

- **Severity:** minor
- **Evidence:** Adapter comment pins **1.18.2**; no preflight. Users with
  installer-managed `~/.opencode/bin/opencode` at 1.16.2 hit flag drift above.
  `PARLEY_OPENCODE_BIN` can point at anything.
- **Fix:** Optional `opencode --version` parse in prepare (or probe) and warn/fail
  if `< 1.18.2` when using `--auto`.

### [opencode] Multi-step usage keeps only last `step_finish` (engine merge)

- **Severity:** minor
- **Evidence:** Live `step_finish` tokens match fixtures
  (`tests/fixtures/opencode/v1.18.2-fresh.jsonl`). Adapter comment correctly
  notes engine shallow-merges usage (supersede, not sum). Not a field-name bug,
  but multi-step runs under-report cumulative tokens.
- **Fix:** Engine-level sum, or adapter accumulates step tokens before emitting
  usage (out of pure adapter scope; call out in product docs).

---

### [claude] `workspace` posture is effectively `bypassPermissions` (full tool privilege)

- **Severity:** major
- **Evidence:** `permissionMode()` maps both `workspace` and `full` →
  `bypassPermissions` (`claude.ts`). Claude Code 2.1.211 help:
  choices include `acceptEdits`, `auto`, `bypassPermissions`, `dontAsk`, `plan`.
  Docs (https://code.claude.com/docs/en/permission-modes): `bypassPermissions`
  skips nearly all checks including protected paths; `acceptEdits` is the
  middle ground for auto file edits. Adapter comment admits isolation is only
  “worktree cwd” and that `acceptEdits` may still prompt on Bash/MCP — so default
  Parley posture named `workspace` silently grants full-host agent power, not
  workspace-scoped FS policy.
- **Fix:** Map `workspace` → `acceptEdits` plus explicit
  `--allowedTools` including `mcp__parley__*` (and needed builtins), **or** keep
  bypass but rename/document posture as “full tool privilege inside worktree”
  and never claim workspace FS isolation. Prefer:
  - before: `case "workspace": default: return "bypassPermissions"`
  - after: `case "workspace": return "acceptEdits"` + argv
    `--allowedTools` `Read,Edit,Write,Bash,mcp__parley__*` (tune list) once
    MCP tools are verified not to stall under `acceptEdits`.

### [claude] `read-only` → `plan` may block protocol tools (`submit_report` / `ask_orchestrator`)

- **Severity:** major
- **Evidence:** `permissionMode("read-only")` → `plan`. Live init under
  `--permission-mode plan --bare --strict-mcp-config` still lists MCP server
  `parley` as `pending`, but plan mode is documented as exploration / no source
  edits; interaction with MCP tool execution for completion tools was **not**
  end-to-end proven with a live hub. If plan denies MCP writes/calls, every
  read-only Claude task cannot finish the Parley protocol (no `submit_report`).
- **Fix:** Smoke-test plan + `mcp__parley__submit_report`. If blocked, map
  read-only to `dontAsk` + allowlist `Read`/`Grep`/… + `mcp__parley__*`, or
  force `bypassPermissions` only for hub tools via permission rules while
  denying `Edit`/`Write`/`Bash(*)` except read-only shell patterns.

### [claude] Non-`--bare` runs still load user plugins/skills

- **Severity:** minor
- **Evidence:** Live stream with `ANTHROPIC_API_KEY=bad` and adapter-like flags
  (without `--bare`) showed `plugins: [{name: skill-creator, …}]` and a large
  skill list on `system/init`. Adapter intentionally avoids `--bare` for OAuth
  (comment in `commonArgv`). `--strict-mcp-config` hermeticizes MCP only.
- **Fix:** Accept as documented bleed, or add optional
  `PARLEY_CLAUDE_BARE=1` when API key is present; or pass settings that disable
  plugins when a settings key exists.

### [claude] Bash sandbox network allowlist may not cover MCP hub traffic

- **Severity:** minor
- **Evidence:** `settingsJson()` sets `sandbox.enabled` +
  `network.allowedDomains: ["localhost","127.0.0.1"]` when `network:false`.
  Official sandboxing docs: sandbox network applies to **Bash** subprocesses;
  Claude's own MCP HTTP client may bypass it (research UNKNOWN — still
  UNKNOWN). Also: hub bound only on `::1` would not match the allowlist.
- **Fix:** Confirm with a network-off run whether hub HTTP works; add hub host
  from `hub.url` to `allowedDomains` dynamically; document MCP out of sandbox
  if confirmed.

---

### [gemini] Linux `network:false` sandbox mapping is a no-op for network isolation

- **Severity:** major
- **Evidence:** `postureArgs()` for `workspace` + `network:false` sets
  `-s` and `SEATBELT_PROFILE=permissive-proxied`. Gemini 0.50.0 help has `-s` /
  `--sandbox`; `SEATBELT_PROFILE` is a **macOS seatbelt** concept (docs). On
  Linux (this host), seatbelt env is a no-op; `-s` without Docker/gVisor does
  **not** implement Codex-style network-off. Adapter comment marks
  UNKNOWN(research) but still emits the mapping as if it were the posture —
  silent weaker isolation vs Parley's `network:false` contract.
- **Fix:** On Linux, either refuse `network:false` (loud), wrap spawn in a
  real netns/container, or document + surface a capability gap warning on the
  task. Do not imply seatbelt profiles work off-macOS.

### [gemini] No `gitDir` / `gitCommonDir` extra roots when sandbox is enabled

- **Severity:** major
- **Evidence:** Gemini 0.50.0 has `--include-directories` (help verified).
  Adapter never passes it; never maps `task.gitDir` / `task.gitCommonDir`.
  Default path (yolo, no `-s`) is fine; when `network:false` enables `-s`,
  worktree git objects outside project root can break (research UNKNOWN —
  elevated now that flag exists and is unused).
- **Fix:** In `commonArgv()`, if `task.gitDir` / `task.gitCommonDir` set:
  `--include-directories <gitDir>,<gitCommonDir>` (or repeated flags per help
  shape).

### [gemini] Success-path stream fixture is partially synthetic

- **Severity:** minor
- **Evidence:** Live auth-fail JSONL matches
  `tests/fixtures/gemini/v0.50.0-auth-fail.jsonl` shape (`init` /
  `session_id` snake_case, `result.status:error`, `stats.cached`). Success
  fixture `v0.50.0-success-shape.jsonl` includes assistant `delta:true` chunks
  and tool events; research says assistant deltas are from **source**, not a
  live successful multi-tool run with valid API key. Field names used by
  `parseEvent` (`tool_name`, `parameters`, `stats`) match docs/source.
- **Fix:** Re-capture golden success JSONL from a real authenticated run when
  keys are available; keep parser defensive (already is).

### [gemini] Auth-fail exit code is unreliable (observed 0 vs research 144)

- **Severity:** minor
- **Evidence:** Research claimed invalid key stream-json exit **144** (HTTP 400
  truncated). Live run: exit **0** with terminal `result.status:"error"` on
  stdout (0.50.0). Adapter correctly prefers stream `result` over exit codes.
  Exit-code docs still wrong in research; not an adapter logic bug.
- **Fix:** Update research note only; keep `parseEvent` fatal on
  `result.status === "error"`.

---

### [goose] MCP extension init failure is non-fatal; adapter never surfaces it

- **Severity:** critical
- **Evidence:** Live v1.43.0 with materialized
  `.parley-goose/config/config.yaml` streamable_http to `http://127.0.0.1:9/mcp`:
  stderr `Warning: Failed to start extension 'parley' … continuing without it`,
  process continued, stream-json auth message + `complete` emitted, exit 0 when
  provider answered. Engine only `parseEvent`s **stdout** (`engine.ts` pipes
  stderr to `stderr.log` only). Research §3 already warned adapters must treat
  start warnings as PARLEY-DIAG; **adapter does not**. Result: agent runs with
  **no** `ask_orchestrator` / `submit_report` — silent protocol break; task
  eventually fails only as “exited without report,” not “hub missing.”
- **Fix:** Either (1) scan stderr (engine change or adapter side-channel) for
  `Failed to start extension 'parley'` and emit fatal/PARLEY-DIAG; (2) fail
  prepare if hub health-check fails; (3) use a preflight `goose` validate
  path. Minimum adapter-side: document that orchestrators must treat missing
  report + stderr warning as hub-init failure. Prefer engine stderr hook +
  fatal when extension name matches `parley`.

### [goose] Provider/model not injected; headless child depends entirely on parent env

- **Severity:** major
- **Evidence:** `configYaml()` writes `GOOSE_MODE` + `extensions.parley` only —
  no `GOOSE_PROVIDER` / `GOOSE_MODEL` / `active_provider`. `commonFlags` only
  adds `--model` when `task.model` set; **no** `--provider`. Live
  `goose run` without provider → exit 1 `No provider configured`. Auth keys
  are forwarded, but a correctly keyed host with provider only in interactive
  `~/.config/goose` is isolated away by `GOOSE_PATH_ROOT` — hermetic root
  **drops** the user's provider unless env/extraArgs supply it.
- **Fix:** Materialize provider/model into isolated config when known, or
  require `extraArgs: ["--provider", …]` / parent `GOOSE_PROVIDER` and fail
  prepare loudly if neither is set (probe via `goose info`).

### [goose] Resume/session errors land on stderr with no JSONL; parseEvent is blind

- **Severity:** major
- **Evidence:** `goose run --resume -n parley-nonexistent …` → stderr
  `Error: No session found with name '…'`, empty stdout, exit **1**.
  `parseEvent` only scrapes non-JSON stdout for `YYYYMMDD_N` banner ids.
  Engine still fails tasks without `submit_report` on any exit code (so not
  silent success), but diagnosis is generic “exited without report” instead of
  resume failure. Banner scrape can also false-positive on dates in assistant
  text if ever mixed on stdout.
- **Fix:** Treat non-zero exit + empty events as fatal with stderr tail; or
  parse stderr lines matching `/No session found|Cannot resume session/`.
  Prefer always capturing session id on prepare via post-run
  `goose session list -f json` under `GOOSE_PATH_ROOT` (research strategy 3)
  rather than banner-only.

### [goose] `GOOSE_MODE: chat` for read-only is not true filesystem RO

- **Severity:** minor
- **Evidence:** Documented in adapter; chat mode is “no tools” policy only.
  Confirmed no OS sandbox in v1.43.0 docs/help.
- **Fix:** None in-adapter beyond host sandbox; keep capability gap explicit in
  user-facing posture docs.

---

### [pi] Hub MCP is inert unless `pi-mcp-adapter` is installed (default path has no MCP)

- **Severity:** critical
- **Evidence:** Core Pi 0.80.7 `pi --help` has **no** MCP flags (philosophy “No
  MCP”). Adapter materializes `.mcp.json` and relies on community
  `pi-mcp-adapter`. This host: `pi list` → only `npm:pi-effort`; **no**
  `pi-mcp-adapter`. Without `PARLEY_PI_MCP_ADAPTER` and without a global
  install, `.mcp.json` is never read — hub tools never register. Headless
  agent cannot `submit_report` / `ask_orchestrator` (silent). Research
  explicitly requires install or `-e`; adapter defaults to hope-user-installed.
- **Fix:** Fail prepare unless extension present: require
  `PARLEY_PI_MCP_ADAPTER` **or** detect `pi list` / package path and reject
  with a clear error. Or bundle/load a Parley-owned extension via `-e` always
  (`--no-extensions -e <parley-hub.js>`). Do not ship “materialize `.mcp.json`
  only” as sufficient.

### [pi] `directTools` cold-cache means first session may not expose hub tools natively

- **Severity:** critical
- **Evidence:** `pi-mcp-adapter@2.11.0` README: direct tools register from
  metadata cache (`~/.pi/agent/mcp-cache.json`); **first session after adding
  directTools falls back to proxy-only** until `/mcp reconnect` warms cache.
  Adapter sets `directTools: ["ask_orchestrator","submit_report"]` with
  `lifecycle: "eager"`. Proxy tool is `mcp({…})` — models often never call it;
  protocol tools may be invisible on first Parley task in a clean agent dir.
- **Fix:** After materializing config, force cache warm (adapter README:
  reconnect), set `settings.directTools` carefully, or use a Parley-owned
  extension that `registerTool`s without cache. Smoke-test first-run tool list
  in JSON mode before claiming MCP works.

### [pi] `network:false` and workspace vs full are not expressible (soft tools only)

- **Severity:** major
- **Evidence:** `sandboxArgs()`: read-only → `--tools read,grep,find,ls`;
  workspace and full both → default tools; `network:false` ignored. Live help
  confirms no network sandbox flag. Same class of silent weaker isolation as
  gemini/goose.
- **Fix:** Loud capability gap on task when `network:false`; optional external
  sandbox wrapper; don't equate workspace/full in product UX without labels.

### [pi] Fixture / event shapes match 0.80.7 for session + usage paths

- **Severity:** minor (positive / residual risk)
- **Evidence:** Live `--mode json` session header
  `{"type":"session","version":3,"id":…}` matches
  `tests/fixtures/pi/v0.80.7-fresh.jsonl`. Usage fields `input`/`output`/
  `cacheRead`/`cost.total` match `normalizeUsage()`. Error path
  `stopReason:"error"` not re-hit with keyless path (host used codex OAuth).
- **Fix:** Keep fixtures; re-verify error fixture with `--api-key bad` in CI.

---

## Claims that could NOT be verified (and why)

| Claim | Why blocked |
| --- | --- |
| OpenCode MCP `timeout` bounds **tool execution** (not just discovery) | Needs live hub + model call sleeping > default 5s; no long authenticated run in this pass |
| OpenCode MCP tool name form (`parley_*` vs other) under live hub | No listening Parley hub with successful tool list during this pass |
| OpenCode `OPENCODE_DISABLE_PROJECT_CONFIG` full behavior | String present in binary; not A/B tested with project `opencode.json` shadowing hub |
| Claude plan mode allows/denies `mcp__parley__*` end-to-end | Auth-fail before tool use; hub on `:9` never completed initialize |
| Claude sandbox proxy applies to MCP HTTP client | Requires sandbox-enabled success path + packet observation |
| Gemini multi-turn resume with real chat memory | Invalid/missing API key; only invalid-id resume path verified (exit 42, stderr message) |
| Gemini success stream deltas / tool_use live shapes | No valid `GEMINI_API_KEY` for success path; fixtures partially from source |
| Gemini Linux Docker/gVisor sandbox for network-off | Not installed/configured in environment |
| Goose `GOOSE_MODE` in config.yaml alone (no env) full effect | Env always set by adapter; mode isolation from env not A/B'd |
| Goose successful toolRequest/toolResponse hub shapes | Auth failures only; fixtures for tool-request not live-replayed against hub |
| Goose `complete` usage non-null fields | Auth-fail streams emit `total_tokens: null` only |
| Pi end-to-end hub via pi-mcp-adapter | Extension not installed; no live hub smoke |
| Pi `directTools` after cache warm | Depends on above |
| Cross-version gemini beyond 0.50.0 | npm `latest` still 0.50.0; nightlies 0.51–0.52 not installed |
| Goose versions other than 1.43.0 | GitHub latest release tag still `v1.43.0` as of this pass |

---

## Per-adapter primary sources used

| Adapter | Pinned / run | Sources |
| --- | --- | --- |
| opencode | 1.18.2 (npm scratch), host 1.16.2 | `opencode run --help`, `debug config`, https://opencode.ai/docs/permissions/, https://opencode.ai/docs/cli/, binary env strings |
| claude | 2.1.211 native | `claude --help`, live stream-json, https://code.claude.com/docs/en/{cli-reference,permission-modes,sandboxing,mcp,settings} |
| gemini | `@google/gemini-cli@0.50.0` | `gemini --help`, live stream-json, mcp list trust behavior, bundled docs |
| goose | v1.43.0 Linux binary | `goose run --help`, `goose info`, live stream-json + MCP fail warning, https://goose-docs.ai/docs/guides/config-files |
| pi | 0.80.7 | `pi --help`, `--list-models`, live json mode, `pi-mcp-adapter@2.11.0` package types/README |

---

## Suggested fix priority

1. **pi** MCP extension required + directTools first-run cache (protocol broken without).
2. **goose** MCP init failure visibility (protocol broken when hub down/misconfigured).
3. **opencode** version/`--auto` drift (broken on common older installs).
4. **claude** workspace/read-only posture honesty and MCP under plan.
5. **gemini** Linux network-off honesty + include-directories for git roots.
)
