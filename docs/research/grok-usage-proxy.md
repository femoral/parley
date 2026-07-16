# Capturing Grok token usage via a local API proxy

Follow-up spike on [vendor token-usage event coverage](vendor-token-usage-coverage.md) (issue #38, closed):
that research confirmed grok's `streaming-json` headless format emits no usage-shaped fields at all — the
`end` event carries only `stopReason`/`sessionId`/`requestId`. This doc investigates whether parley can
recover token usage anyway by capturing grok's own calls to the xAI API, and how to attribute captured
calls back to the task that made them. Filed as issue #95.

## Summary

**Feasible, and there's a lever cleaner than a generic TLS-MITM proxy.** grok honours
`GROK_XAI_API_BASE_URL` (default `https://api.x.ai/v1`) for its own built-in-model API-key traffic — this
is a first-class base-URL override, not a BYOK-only knob. Pointing a task's child process at a local
reverse proxy via this env var sidesteps TLS-trust problems entirely (no CA to inject into a closed-source
Rust binary, no risk of misdirecting MCP-hub or `web_fetch` traffic) and gives read/write access to every
request and response body — including the ability to force `stream_options: {"include_usage": true}` on
outgoing requests so a final usage-bearing SSE chunk is guaranteed even if grok's own client omits it.

For attributing captured calls to a task, the daemon already solved the identical multiplexing problem for
the MCP hub (`packages/daemon/src/engine.ts`, `packages/daemon/src/server.ts`, `packages/daemon/src/mcp.ts`)
— one shared HTTP server, one fixed ephemeral port for the daemon's lifetime, per-task correlation
established at spawn time. The proxy should mirror that pattern rather than invent a new one.

## Why not a generic MITM proxy

- No documented cert-override env (`SSL_CERT_FILE`-equivalent) in xAI's settings reference — trusting a
  local CA inside the closed-source Rust binary is unverified and would need empirical testing per grok
  release (it auto-updates ~daily; the adapter already pins `--no-auto-update` for this class of risk).
- A generic `HTTPS_PROXY` would also intercept MCP-hub traffic and any `GROK_WEB_FETCH_PROXY`-routed
  `web_fetch` calls, widening blast radius for no benefit — the base-URL override is scoped to exactly the
  completions API.

## The base-URL lever

- `GROK_XAI_API_BASE_URL` (xAI settings reference, "Models and updates" section): `https://api.x.ai/v1` by
  default, documented as "xAI API base for API-key auth" — applies to the default built-in models under
  `XAI_API_KEY` auth, the same auth path `packages/daemon/src/adapters/grok.ts:baseEnv` already threads
  through (`result.XAI_API_KEY = env.XAI_API_KEY`).
- Plain HTTP loopback is fine for the proxy leg — grok already talks TLS to the real `api.x.ai`; the proxy
  terminates that TLS itself and re-originates the real HTTPS request upstream with the same
  `Authorization` header, so the user-visible behavior (auth, real endpoint reached) is unchanged.
- xAI's chat-completions responses only include a `usage` object (`prompt_tokens`/`completion_tokens`/
  `total_tokens`) in streaming mode when the request sets `stream_options: {"include_usage": true}` — the
  proxy can rewrite the outgoing JSON body to add this before forwarding, so usage capture doesn't depend
  on grok's client opting in on its own.

## Open risk: sandboxed network posture

`sandboxEnv` in `grok.ts` maps non-`full` sandbox postures to a bwrap-based `GROK_SANDBOX` profile, and when
`task.network` is `false` a custom `restrict_network` profile is materialized. Today grok's own model-API
calls have always gone out unsandboxed regardless of this posture (the network flag governs tool/bash
network access inside the agent's sandbox, not the CLI's own completions calls) — routing those calls
through a local proxy is new territory. Needs an empirical check: does a `restrict_network` bwrap profile
still permit loopback to the daemon's proxy port? If not, the proxy has to be reachable some other way
under that posture (e.g. exempted via the sandbox profile) before this works for network-restricted tasks.

## Task correlation: existing precedent

The daemon already multiplexes concurrent per-task HTTP traffic through one shared listener for the MCP
hub, rather than a port or process per task:

- `HubInfo` (`packages/daemon/src/adapters/types.ts`): `{ url: string; headers: Record<string, string> }`.
- Built per-task in `TaskEngine.hubFor` (`engine.ts:999-1006`): `url` is always
  `http://127.0.0.1:<hubPort>/mcp` — the **same port for every task** — and `headers` carries
  `{ [TASK_HEADER]: taskId }`, where `TASK_HEADER = "x-parley-task"` (`engine.ts:67`) and `taskId` is
  `TaskSpec.id`.
- grok's adapter (`configToml` in `grok.ts`) writes `hub.headers` into `.grok/config.toml`
  (`[mcp_servers.parley.headers]`), so every MCP request grok makes carries `x-parley-task: <taskId>`.
- Server side: one shared HTTP server bound once to `127.0.0.1:0` (`server.ts:712`), port fixed for the
  daemon's lifetime via `engine.setHubPort(port)`. `mcp.ts:110-119` reads `x-parley-task` off each request,
  rejects anything missing/unknown, and scopes the `McpServer` instance to that task.
- Each task is a genuinely separate OS process (`TaskEngine.runChild`, `engine.ts:1203`,
  `spawn(command, args, { cwd, env: { ...process.env, ...plan.env }, ... })`) — `plan.env` is per-task, so
  injecting a per-task env var at spawn time is already the established mechanism (same place
  `XAI_API_KEY`/`GROK_SANDBOX` get set today).

The one difference from the MCP case: header injection into hub-bound requests is a documented, grok-native
feature (`[mcp_servers.<name>.headers]`); there is no equivalent documented way to make grok attach a custom
header to its own xAI API calls. Correlation for the proxy has to ride something grok already varies
per-task — the base URL itself, since it's set from `plan.env` — rather than a header.

## Proposals, ranked by scalability

### 1. One shared proxy listener, task ID embedded in the per-task base-URL path (recommended)

`GROK_XAI_API_BASE_URL=http://127.0.0.1:<proxyPort>/xai/<taskId>/v1`, set in `baseEnv()` per task exactly
like `XAI_API_KEY` is today. One HTTP server, started once at daemon boot (or lazily on first grok task,
mirroring `hubPort` allocation) and reused by every concurrent task. The proxy strips the `/xai/<taskId>`
prefix, forwards the remainder to `https://api.x.ai/v1`, and tags captured usage with the `taskId` parsed
from the path — no header dependency, no per-request OS introspection.

- **Scalability**: O(1) listening sockets and O(1) server lifecycles regardless of task concurrency —
  identical footprint at 1 task or 1000. Directly reuses the MCP hub's proven pattern (shared server, fixed
  ephemeral port, teardown wired into the same `killChildren`/shutdown path), so there's no new lifecycle
  class to build or test.
- **Cost**: routing by path prefix instead of header is a minor deviation from the hub's own convention, but
  the deviation is *why* it works — the base URL is the one per-task-varying surface grok actually exposes.

### 2. One shared proxy listener + custom correlation header (fallback, unverified)

If it turns out grok's model-API client *does* support attaching custom headers (e.g. via the `[model.<id>]`
BYOK surface, if that ever extends to the default model, or an undocumented env), a design mirroring the MCP
hub exactly — fixed URL for every task, `x-parley-task` header per request — would be preferable for
consistency with the existing hub code path.

- **Scalability**: identical to #1 (still one shared server, O(1) sockets) — this and #1 are scalability-
  equivalent; the ranking gap is feasibility, not scale. Demote to a fallback only if path-based routing hits
  a concrete problem (e.g. the xAI SDK/CLI rejects a non-root base path, or double-slash/URL-join edge cases
  prove fragile) — worth a quick empirical check of `GROK_XAI_API_BASE_URL` with a path suffix before
  committing to #1's exact shape.

### 3. Per-task ephemeral proxy process/port

Spawn a dedicated proxy listener (or lightweight server instance) per task, each on its own ephemeral port;
`GROK_XAI_API_BASE_URL` points at that task's private port. Correlation is implicit — whichever listener
receives a connection owns that task's traffic — so no path/header parsing is needed at all.

- **Scalability**: linear in concurrent task count. Each task adds a listening socket and a managed
  lifecycle object (allocate on spawn, tear down on task completion/kill, handle the case where teardown
  races a still-in-flight request). None of the daemon's existing shared-server infrastructure applies, so
  this is also strictly more code to build and keep correct. Fine at the concurrency levels parley runs
  today, but it's the only proposal here whose resource cost scales with task count rather than staying flat
  — ranked below the shared-server options for that reason alone.

### 4. Port-to-PID correlation via OS introspection

Single shared proxy (as in #1), but instead of embedding the task ID anywhere in the request, correlate
each inbound connection to a task by resolving its source port to a PID (`/proc/net/tcp` on Linux, or
shelling out to `ss -tnp`) and cross-referencing the PID captured at `spawn()` time in `runChild`.

- **Scalability**: worst of the four. Adds a per-request (or per-connection) OS-introspection cost, is
  Linux-specific (no equivalent without extra tooling on macOS or inside minimal containers — a real
  constraint if the daemon ever needs to run outside Linux), and is race-prone under concurrency: ephemeral
  local ports get reused, so a port-to-PID snapshot taken slightly late can misattribute a request to the
  wrong task, silently corrupting usage data rather than failing loudly. No advantage over #1 that would
  justify the fragility — included here mainly to rule it out.

## Recommendation

Build #1. It costs nothing beyond what the MCP hub already pays (one more route, or one more small shared
server, on infrastructure that's already there), scales flat with task count, and doesn't depend on an
unverified grok capability. Resolve the sandboxed-network open risk empirically before relying on it for
`task.network: false` tasks; #2 is worth a five-minute check only if #1's path-based base URL turns out not
to work cleanly against grok's URL-joining behavior.
