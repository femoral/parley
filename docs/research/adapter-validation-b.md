# Adversarial validation — group B adapters (#107)

Hostile review of vendor adapters: **cline**, **kilo**, **openhands**, **hermes**, **openclaw**.

**Date:** 2026-07-16  
**Worktree:** `parley/t272-validate-b`  
**Method:** re-derive CLI surfaces from pinned installs + primary docs; grill adapters line-by-line; compare fixtures; note engine wiring (`packages/daemon/src/engine.ts` feeds **stdout only**, line-by-line).

**Installs used (scratch, not committed):**

| Harness | Pinned (adapter/research) | Binary probed | Latest npm/PyPI (same day) |
| --- | --- | --- | --- |
| cline | 3.0.42 | `/tmp/parley-cli-b` + monorepo `node_modules` → 3.0.42 | 3.0.42 (no drift) |
| kilo | `@kilocode/cli@7.4.9` | same → 7.4.9 | 7.4.9 (no drift) |
| openhands | CLI 1.16.0 / SDK 1.21.0 | `.scratch-validate-b/.venv-oh` | not re-pinned latest (see unverifiable) |
| hermes | v0.17.0 (`efd87a15`) | `~/.local/bin/hermes` | GitHub latest tag `v2026.7.7.2` / research notes 0.18.2 |
| openclaw | `2026.7.1` (`2d2ddc4`) | `/tmp/parley-cli-b` → 2026.7.1 | 2026.7.1 (no drift) |

---

## Verdict table

| Adapter | Verdict | Critical | Major | Minor |
| --- | --- | --- | --- | --- |
| cline | **needs fixes** | 2 | 2 | 1 |
| kilo | **needs fixes** | 0 | 1 | 2 |
| openhands | **needs fixes** | 1 | 1 | 2 |
| hermes | **needs fixes** | 1 | 1 | 1 |
| openclaw | **needs fixes** | 1 | 2 | 1 |

Zero findings across five adapters would not be credible; the engine/adapter contract alone surfaces multiple silent-loss paths.

---

## Findings

### [cline] Session id never reaches `sessionId()` — resume is impossible

- **Severity:** critical
- **Evidence:** Live `cline@3.0.42` auth-fail stream (2026-07-16) has no session id on NDJSON; disk path is `<data-dir>/sessions/<id>/<id>.json` (observed `1784193198730_nqinf`). Adapter `parseEvent` never emits `session_meta.session_id`; `sessionId()` only walks those events. Engine (`engine.ts` ~1417–1421) only persists `session_id` from parseEvent. Research §4 and adapter comments admit stream has no id but **do not implement data-dir scrape**.
- **Fix:** In `cline.ts` (or engine post-exit hook for this vendor): after process exit (or on first events), read newest `<dataDir>/sessions/*/*.json` `session_id` and emit/return it from `sessionId()`. Do not rely on stream fields that 3.0.42 does not emit.

### [cline] Headless `--id` resume is broken on 3.0.42 (fails; does not resume)

- **Severity:** critical
- **Evidence:** Re-ran  
  `cline --json --auto-approve true --data-dir <dir> -c /tmp --id <sid> "follow up"`  
  → exit **1**, stderr  
  `{"type":"error","message":"JSON output mode requires a prompt argument or piped stdin (interactive mode is unsupported)"}`  
  even with a trailing prompt. Same failure documented in research §4. Adapter still builds that argv in `resume()` “so a fixed release can work”.
- **Fix:** Until Cline fixes headless `--id`: either (a) degrade resume to re-prompt with prior context (no `--id`) and document lossy resume, or (b) refuse vendor `resume` always with a clear error that 3.0.42 cannot headless-resume, or (c) use a non-JSON resume path if one is ever verified. Do not ship broken `--id` as if it works.

### [cline] Provider env keys ignored without `-P` — default provider stays `cline`

- **Severity:** major
- **Evidence:** Fresh data-dir run with `ANTHROPIC_API_KEY=sk-ant-fake` and `-m claude-sonnet-4-20250514` (no `-P`) → `run_result.model.provider` **`"cline"`**, error “re-authenticate your Cline account”. Same key with `-P anthropic` → provider **`anthropic`**, error `invalid x-api-key` (key was read). Adapter forwards `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / etc. but never passes `-P` / `--provider`.
- **Fix:** In `commonArgv` / `prepare`: map model id prefix or an explicit provider field to `-P <provider>`, or document that users must put provider in `extraArgs` / model string; at minimum auto-select when only one provider key is present (e.g. only `ANTHROPIC_API_KEY` → `-P anthropic`).

### [cline] No MCP tool timeout raise above `answerTimeoutMs`

- **Severity:** major
- **Evidence:** Research §3 marks `timeoutMs` in `cline_mcp_settings.json` UNKNOWN; adapter writes MCP settings without any timeout field. Parley default/tests use long answer timeouts (e.g. 30 min / 1_800_000 ms in adapter tests). Cline defaults for MCP tool calls are unverified and not raised.
- **Fix:** Research + set per-server timeout in `mcpSettingsJson` once the settings schema accepts it; until then, document that `ask_orchestrator` may die at Cline’s default and treat as known risk in adapter header (already partially noted) — still a product gap vs codex/kilo/hermes.

### [cline] Auth-fail stderr error JSON is not always on stderr path engine sees for parseEvent

- **Severity:** minor
- **Evidence:** Live run put fatal `agent_event`/`run_result` on **stdout** (adapter handles). Research/fixture also show stderr `type:error`; engine never feeds stderr to `parseEvent` (only `stderr.log`). Adapter’s top-level `case "error"` is dead for engine unless a stdout line carries it (resume failure put error on stderr only).
- **Fix:** Prefer fatal detection from `run_result.finishReason === "error"` (already done). Optionally engine dual-feed stderr for vendors that need it; or scrape stderr.log post-exit. Doc-only if stdout coverage is sufficient for auth-fail.

---

### [kilo] Success-path event fixture is OpenCode-lineage, not live Kilo 7.4.9 output

- **Severity:** major
- **Evidence:** Unauthenticated live run only emits `type:"error"` with `sessionID` (matches fixture `v7.4.9-auth-error.jsonl`). Success fixture `v7.4.9-success.jsonl` uses OpenCode cheatsheet shapes (`step_start`/`tool_use`/`step_finish`); research and adapter both mark success path UNKNOWN/live-unverified. Tool names (`bash`, `write`, …) appear as strings in the 7.4.9 binary but live success JSONL was not re-verified.
- **Fix:** Capture a real authenticated `kilo run --format json` stream; replace/supplement fixture; adjust `parseEvent` if field names differ (especially `part.tool` / `tokens`).

### [kilo] BYOK provider API keys not forwarded in `baseEnv`

- **Severity:** minor
- **Evidence:** Adapter only passes `KILO_API_KEY` / `KILO_ORG_ID`. Research §6 documents BYOK via config `{env:ANTHROPIC_API_KEY}` etc.; binary env inventory includes many `KILO_*` keys but not automatic pass-through of `ANTHROPIC_API_KEY`. Users with only provider keys may fail unless they use `KILO_API_KEY` or put secrets in global config (isolation risk).
- **Fix:** Forward common BYOK keys when set (same pattern as hermes/openclaw `AUTH_ENV_KEYS`), or inject trusted `provider.*.options.apiKey: "{env:…}"` into `KILO_CONFIG_CONTENT`.

### [kilo] `sandbox` object often absent from resolved config when disabled

- **Severity:** minor
- **Evidence:** `KILO_CONFIG_CONTENT` with mcp/permission/`sandbox.enabled:false` → `kilo debug config` shows mcp + permission; `sandbox` key missing (defaults). Not a functional bug for disabled sandbox; documents that “resolved config always echoes sandbox” is false.
- **Fix:** None required for disable path; when testing network-deny, assert `sandbox.enabled/network` appear in `kilo debug config` after injection.

---

### [openhands] Hardcoded MCP tool timeout 300s kills long `ask_orchestrator`

- **Severity:** critical
- **Evidence:** Installed SDK `openhands/sdk/mcp/tool.py`: `MCP_TOOL_TIMEOUT_SECONDS = 300`. Research §3 confirms no CLI dial. Adapter comments document the gap but ships anyway. Parley answer timeouts in tests/default paths are often **30 minutes** (`answerTimeoutMs: 1_800_000`). Blocking hub tools >5 minutes will time out while the orchestrator answer window is still open.
- **Fix:** Raise via SDK patch/env if one exists; or lower advertised `answerTimeoutMs` for openhands to ≤300s; or poll/wrap hub differently. Do not claim full Q&A support until timeout ≥ `answerTimeoutMs + headroom`.

### [openhands] Partial `agent_settings.json` for effort is unproven / may replace full agent

- **Severity:** major
- **Evidence:** Adapter writes only `{ "llm": { "reasoning_effort": "…" } }` under `OPENHANDS_PERSISTENCE_DIR`. Research §6 and adapter mark merge behavior UNKNOWN. `AgentStore.load_or_create` path (setup.py) expects full agent specs; partial file may fail headless or wipe env-created LLM settings.
- **Fix:** Verify with a real run: materialize effort + `--override-with-envs`; if load fails, stop writing partial JSON and pass effort another way (or omit).

### [openhands] No real sandbox / network off — soft workdir only

- **Severity:** minor (documented gap; still weaker than comment tone in places)
- **Evidence:** CLI 1.16.0 help has no sandbox flags; setup uses `LocalWorkspace(working_dir=OPENHANDS_WORK_DIR|cwd)`. Adapter sets `OPENHANDS_WORK_DIR` only. Correctly documents residual gap; not a hallucinated flag, but `read-only` / `network:false` tasks are **unenforced**.
- **Fix:** Engine-level bubblewrap for openhands children, or refuse `read-only`/`network:false` postures for this vendor.

### [openhands] Token usage never in JSONL stream

- **Severity:** minor
- **Evidence:** Research §8 + live auth-fail stream: no usage events. Adapter hopes for `ConversationStateUpdateEvent` (UNKNOWN). Usage lives in on-disk `base_state.json` after exit — not scraped.
- **Fix:** Post-exit read `OPENHANDS_CONVERSATIONS_DIR/<id>/base_state.json` for `accumulated_token_usage` if product needs usage for openhands.

---

### [hermes] Session id is on stderr; engine only feeds stdout — resume never gets an id

- **Severity:** critical
- **Evidence:** Quiet success contract (research §2 + source): stderr line `session_id: <id>`. Adapter `parseEvent` matches that line, but comments: “Engine currently feeds stdout only”. Confirmed in `engine.ts`: `readline` on `child.stdout` only; stderr → `stderr.log`. Auth-fail quiet run (live): stdout error text, empty stderr (no session id). Successful quiet runs emit id only on stderr → `sessionId()` stays undefined → multi-turn resume always rejects or never starts.
- **Fix:** Engine: dual-feed stderr lines into `parseEvent` for hermes (or all vendors); **or** adapter: post-exit `hermes`/SQLite scrape of latest session under `HERMES_HOME`; **or** use `--pass-session-id` only if it appears on stdout (re-verify before relying).

### [hermes] Quiet mode has no live tool/usage stream — opaque progress + no usage

- **Severity:** major
- **Evidence:** `hermes chat --help` has no `--json` / streaming-json. Live quiet auth-fail is plain text. Research LOUD CAVEAT. Adapter synthesizes messages from every non-empty stdout line; no `command`/`file_change`. Usage only via optional JSON line parser (quiet never emits; fixture `v0.17.0-usage.json` is synthetic schema).
- **Fix:** Accept opacity, or switch integration to `hermes acp` for structured events; post-exit `state.db` / `sessions export` for usage. Document as capability limit if left as-is.

### [hermes] Pinned 0.17.0 vs upstream 0.18.x / `v2026.7.7.2`

- **Severity:** minor
- **Evidence:** Host hermes reports v0.17.0; GitHub latest release tag `v2026.7.7.2` (research also notes 0.18.2). Flag surface on 0.17.0 matches adapter (`--quiet`, `--yolo`, `--resume`, `--source tool`). Drift risk for effort CLI flags (Paperclip mentions `--reasoning-effort`; 0.17.0 help has none — adapter correctly uses config only).
- **Fix:** Pin hermes version in deploy docs; re-run validation on 0.18.x before upgrading.

---

### [openclaw] Pretty-printed `--json` stdout is line-fed — parseEvent drops entire result

- **Severity:** critical
- **Evidence:** `writeRuntimeJson` / `writeJson` in `openclaw@2026.7.1` defaults to `JSON.stringify(value, null, 2)` (multi-line). Engine reads stdout **line-by-line** and calls `parseEvent(line)`. Intermediate pretty-print lines are not valid JSON → `[]`. Final single-line fragments also fail. Adapter documents this risk (“engine feeds stdout line-by-line today”) but ships anyway. Result: **no message text, no `meta.agentMeta.sessionId`, no usage** on success path from parseEvent.
- **Fix:** Engine buffer full stdout for openclaw (or all non-JSONL vendors); **or** force compact JSON if OpenClaw gains a flag; **or** adapter `prepare` wraps binary in a small script that rewrites pretty JSON to one line. Prefer engine whole-blob parse for `openclaw`.

### [openclaw] Auth failures land only on stderr — empty stdout, no structured error event

- **Severity:** major
- **Evidence:** Live `openclaw agent --local --agent parley --message "say hi" --json --timeout 30` with isolated state: exit **1**, empty stdout, stderr `ProviderAuthError` / `FailoverError` / `missing-provider-auth`. Adapter `eventsFromDiagnosticText` never runs under engine (stderr not fed). Failure is only via process exit code (engine may still mark failed, but loses greppable `VendorEvent` error and session_meta).
- **Fix:** Dual-feed stderr into parseEvent for openclaw, or post-exit parse `stderr.log` for `ProviderAuthError` / `missing-provider-auth`.

### [openclaw] Session UUID from success envelope unreachable; resume relies on session-key only

- **Severity:** major
- **Evidence:** Related to pretty-print bug: `meta.agentMeta.sessionId` never parsed under line-mode engine. Adapter resume falls back to `--session-key agent:parley:<taskId>` which **does** work for continuity under stable `OPENCLAW_STATE_DIR` (live auth-fail still created session key `agent:parley:task-test`). Preferring UUID `--session-id` never activates. Not silent full context loss if state dir stable, but session_id field in task DB stays empty and any path requiring UUID fails.
- **Fix:** Same as pretty-print fix; after exit optionally `openclaw sessions --json` under task state dir to capture `sessionId`.

### [openclaw] `tools.exec.host: "gateway"` under pure `--local` is schema-valid but host-coupling opaque

- **Severity:** minor
- **Evidence:** Schema enum includes `gateway|sandbox|node|auto`. Research YOLO recipe sets host gateway. Live auth-fail did not exercise exec. Whether embedded `--local` runs shell on gateway host semantics without a daemon is **partially** documented product behavior, not re-proven here.
- **Fix:** Re-verify exec works with `--local` + `host: gateway` vs `host: auto`/`node` on a successful turn; switch to `auto` if gateway host requires a daemon.

---

## Per-adapter notes (sound pieces)

### cline — what is right
- Flags `--json`, `--auto-approve true`, `--data-dir`, `-c`, `-m`, `--thinking` match `cline --help` 3.0.42.
- MCP settings path `<data-dir>/settings/cline_mcp_settings.json` with `transport.type: "streamableHttp"` loads (live log: failed connect to dummy URL, server name registered).
- Auth-fail JSONL shape matches fixture envelope (`hook_event` / `agent_event` / `run_result` camelCase usage).
- Does not invent `cline models` for `listModels`.

### kilo — what is right
- `kilo run --format json --auto --dir …` and `-s` / `--session` / `--variant` match help 7.4.9.
- `KILO_CONFIG_CONTENT` injects remote MCP + headers + raised `timeout` / `experimental.mcp_timeout` (**verified** `kilo debug config`).
- `sessionID` on error events; resume `-s` reuses id (**verified**).
- Auth failure exits **0** with JSON error — adapter treats `type:error` as fatal (correct).
- `KILO_DISABLE_AUTOUPDATE`, `KILO_DISABLE_CLAUDE_CODE`, `KILO_DISABLE_PROJECT_CONFIG` exist in binary strings.

### openhands — what is right
- `--headless --json --override-with-envs -t` and `--resume` match help 1.16.0.
- Event discriminator is `kind` (not `type`) — adapter correct; docs schematic wrong.
- Conversation ID scrape regex matches live trailing line (`Conversation ID: <32 hex>` + dashed hint).
- MCP file shape `transport: "http"` + headers under `OPENHANDS_PERSISTENCE_DIR/mcp.json` matches research / CLI mcp add format.
- Auth failure emits `ConversationErrorEvent` on stdout (fixture + re-run); adapter marks fatal.

### hermes — what is right
- Argv `chat --quiet --yolo --accept-hooks --source tool -q` matches help 0.17.0.
- MCP under `HERMES_HOME/config.yaml` with `url`/`headers`/`timeout` — `hermes mcp list` shows server enabled (live).
- `HERMES_WRITE_SAFE_ROOT` multi-path via `os.pathsep` matches source docs/tests.
- MCP timeout raised: `ceil(answerTimeoutMs/1000)+60` (default tool timeout 300s in `mcp_tool.py`).
- Avoids `-z` (no session id) and `--safe-mode` / `--ignore-user-config` (would drop MCP).

### openclaw — what is right
- `agent --local --agent --message --json --timeout --session-key/--session-id` match help 2026.7.1.
- MCP `timeout` is **seconds** → ×1000 to ms in runtime (`getRequestTimeoutMs`); adapter’s second-based timeout is correct (default otherwise 60s).
- Transport `streamable-http` is schema const.
- State isolation via `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH` works (live sessions under task state).
- `models list --all --json` uses `models[].key` — matches probe shape.

---

## Claims not verified (and why)

1. **Authenticated success streams** for kilo, openhands, hermes, openclaw, cline — no live provider API keys in the validation environment; success fixtures remain synthetic/docs-lineage except auth-fail paths.
2. **Cline content/tool event field layout** (`contentType`, tool names on `content_*`) — auth-fail never emits tool content; `parseToolContent` heuristics unproven.
3. **Kilo `--auto` vs explicit `permission.deny`** — whether auto-approve overrides deny rules for read-only posture not exercised with a live tool call.
4. **Kilo OS sandbox** (`sandbox.enabled: true`) behavior for `.git` ro and MCP block under network deny — config injects; not runtime-proven on this host.
5. **OpenHands partial `agent_settings.json` merge** — not run with effort set end-to-end.
6. **OpenHands `ConversationStateUpdateEvent` / usage on success** — not observed on auth-fail; success not run.
7. **Hermes successful quiet path session_id stderr format** — auth-fail has no session id; success not run (parser unit-tested via fixture only).
8. **Hermes 0.18.x / `v2026.7.7.2` flag drift** — only 0.17.0 binary available locally.
9. **OpenClaw successful pretty JSON envelope field completeness** and exec under `tools.exec.host: gateway` with `--local` — auth-fail only.
10. **OpenHands latest PyPI beyond 1.16.0** — not installed; timeout/MCP claims checked only on 1.16.0/SDK 1.21.0.
11. **Whether engine will dual-feed stderr in future** — current `engine.ts` does not; adapters that “parse stderr shapes” are latent until engine changes.
12. **Cline `CLINE_COMMAND_PERMISSIONS` deny-all actually blocking shell** — env name present in product docs/research; not live-proven with a tool-using authenticated run.

---

## Suggested fix priority

1. **Engine stream contract** (unblocks openclaw + hermes): whole-stdout buffer for pretty JSON vendors; optional stderr lines into `parseEvent`.
2. **cline session capture + honest resume** (data-dir scrape; stop pretending `--id` works on 3.0.42).
3. **openhands MCP 300s ceiling** vs answer timeout product decision.
4. **kilo live success capture** before trusting tool/usage mapping in production.
5. **cline `-P` / provider selection** when only BYOK keys are set.

---

*Findings only — adapters intentionally unmodified per task brief.*
