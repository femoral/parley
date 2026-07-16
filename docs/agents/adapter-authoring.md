# Authoring a vendor adapter plugin

Parley loads third-party vendor adapters from `~/.parley/parley.json` (ADR-0009).
This note is the practical guide: contract, packaging, registration, and a
smoke test.

## Module contract

Export a factory (named export preferred):

```ts
import type { VendorAdapter, TaskSpec, HubInfo, SpawnPlan, VendorEvent } from "@useparley/core";

export function createAdapter(env: NodeJS.ProcessEnv): VendorAdapter {
  return {
    id: "acme", // MUST equal the config key vendors.acme
    prepare(task: TaskSpec, hub: HubInfo): Promise<SpawnPlan> { /* ... */ },
    resume(task: TaskSpec, hub: HubInfo): Promise<SpawnPlan> { /* ... */ },
    parseEvent(line: string): VendorEvent[] { /* ... */ },
    sessionId(events: VendorEvent[]): string | undefined { /* ... */ },
    // optional: listModels(existing) for `parley models --refresh`
  };
}
```

A **default export** of the same factory (or `{ createAdapter }`) is accepted.

The daemon validates:

| Check | Failure |
| --- | --- |
| `id` equals config key | loud per-plugin error; plugin skipped |
| `prepare` / `resume` / `parseEvent` / `sessionId` are functions | same |

A failed plugin does **not** crash the daemon. Delegating to that vendor then
fails with the usual unknown-vendor error.

### `TaskSpec.extraArgs`

Always an array (default `[]`). Config may supply `vendors.<id>.args` then
`profiles.<name>.args`. **Splice them into the flags region of argv** — after
the subcommand head, **before** a positional prompt. Never append after the
prompt; many CLIs treat the first positional as the end of flags.

### Spawn plan

Return `{ argv, env, files, cwd }`. The engine may then:

- replace `argv[0]` with `vendors.<id>.bin`
- merge env: `plan.env < vendors.<id>.env < profile.env`
- materialize `files` into `cwd` before spawn

## Minimal complete example

`~/.parley/plugins/acme-adapter.mjs`:

```js
/** @typedef {import("@useparley/core").VendorAdapter} VendorAdapter */

/** @param {NodeJS.ProcessEnv} _env */
export function createAdapter(_env) {
  /** @type {VendorAdapter} */
  const adapter = {
    id: "acme",
    async prepare(task, hub) {
      return {
        argv: [
          "acme",
          "run",
          "--mcp",
          hub.url,
          ...task.extraArgs,
          task.prompt,
        ],
        env: {
          ACME_TASK: task.id,
          ...(task.model ? { ACME_MODEL: task.model } : {}),
        },
        files: [],
        cwd: task.cwd,
      };
    },
    async resume(task, hub) {
      return {
        argv: [
          "acme",
          "resume",
          task.sessionId ?? "",
          ...task.extraArgs,
          task.prompt,
        ],
        env: { ACME_TASK: task.id },
        files: [],
        cwd: task.cwd,
      };
    },
    parseEvent(line) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === "message") return [{ kind: "message", text: String(ev.text ?? "") }];
        if (ev.type === "session") return [{ kind: "session_meta", session_id: ev.id }];
      } catch {
        /* opaque */
      }
      return [];
    },
    sessionId(events) {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e?.kind === "session_meta" && e.session_id) return e.session_id;
      }
      return undefined;
    },
  };
  return adapter;
}
```

## Register

`~/.parley/parley.json`:

```json
{
  "vendors": {
    "acme": {
      "plugin": "/home/you/.parley/plugins/acme-adapter.mjs",
      "bin": "/usr/local/bin/acme",
      "args": ["--json"],
      "env": { "ACME_API_KEY": "…" }
    }
  },
  "profiles": {
    "acme-safe": {
      "vendor": "acme",
      "sandbox": "read-only",
      "network": false
    }
  }
}
```

Specifier forms for `plugin`:

1. **Absolute path** — as above.
2. **`file:` URL** — `file:///home/you/.parley/plugins/acme-adapter.mjs`.
3. **Bare package** — e.g. `@myorg/parley-acme`, resolved with `createRequire`
   from the parley home so you can `npm install` into `~/.parley`.

**Restart the daemon** after adding or changing a plugin module. Vendor
`args`/`env` and profiles hot-reload on the next `delegate` without restart.

## Smoke-test

```bash
# Ensure the daemon picks up the plugin (restart if it was already running).
parley daemon restart   # or: kill the daemon and let the next command auto-spawn

# Delegate with the new vendor (or a profile).
PARLEY_SESSION_ID=smoke parley delegate -v acme "reply with a short summary"

# Or via profile:
PARLEY_SESSION_ID=smoke parley delegate --profile acme-safe "…"

parley status
parley logs <task-id>
parley watch
```

If the plugin failed to load, the daemon log/stderr has a line starting with
`parley daemon: failed to load plugin adapter "…"`, and delegate reports
unknown vendor.

## Packaging tips

- Depend on `@useparley/core` for types only (peerDependency is fine).
- Ship ESM (`.mjs` or `"type": "module"`) — the daemon uses dynamic `import()`.
- Prefer pure spawn plans; keep auth in env passthrough, not hard-coded secrets.
- Implement thin `parseEvent` (unknown lines → `[]`); raw JSONL is the durable
  record (ADR-0004).

## Channels

Children reach the daemon three ways (ADR-0011). All three converge on the same
engine methods (`submitReport`, `askOrchestrator`), so report validation and
question stall/collapse cannot drift:

| Channel | When to use |
| --- | --- |
| **MCP** (canonical) | The harness has a configurable MCP client that can set custom headers (`x-parley-task`). Adapters inject this via `HubInfo`. |
| **HTTP** | The harness can `curl` / `fetch` but has no MCP client, or cannot set MCP headers. |
| **CLI** | Shell scripts / subprocesses: `parley child report` / `ask` / `task`. |

Every spawn gets `PARLEY_HUB_URL` (daemon base URL) and `PARLEY_TASK_ID` in env,
plus `.parley/child.json` (`{ "url", "task_id" }`) in the task cwd for children
that lose env. Prefer MCP when the vendor supports it; fall back to HTTP or the
CLI when it does not. Remote runners (ADR-0012) serve a local hub proxy that
forwards these same channels to the daemon — see `docs/agents/remote-runners.md`.

### HTTP examples

```bash
# Submit a report (default schema shape)
curl -sS -X POST "$PARLEY_HUB_URL/child/report" \
  -H "content-type: application/json" \
  -H "x-parley-task: $PARLEY_TASK_ID" \
  -d '{"summary":"done","outcome":"success","files_changed":["src/a.ts"]}'

# Ask the orchestrator (long-polls until answered or answer-timeout → 504)
curl -sS -X POST "$PARLEY_HUB_URL/child/ask" \
  -H "content-type: application/json" \
  -H "x-parley-task: $PARLEY_TASK_ID" \
  -d '{"question":"which database should I use?"}'
```

### CLI examples

```bash
parley child report --summary "done" --outcome success --file src/a.ts
parley child ask "which database should I use?"
parley child task   # self-inspection envelope
```

## Related

- ADR-0004 — spawn-per-turn adapters
- ADR-0009 — public plugin interface
- ADR-0010 — settings, profiles, remote daemon
- ADR-0011 — child HTTP and CLI channels beside MCP
- ADR-0012 — remote runners (lease-based executors)
- `docs/agents/remote-runners.md` — runner setup and branch handoff
- `packages/core/src/adapter.ts` — TypeScript contract source
