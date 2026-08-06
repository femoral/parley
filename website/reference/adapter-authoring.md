# Writing an adapter

Parley loads third-party vendor adapters from `~/.parley/parley.json`. This
is the practical guide: contract, packaging, registration, and a smoke test.
The TypeScript source of truth is `packages/core/src/adapter.ts` in the repo.

## Module contract

Export a factory (named export preferred; a default export of the same
factory, or `{ createAdapter }`, is also accepted):

```ts
import type { VendorAdapter, TaskSpec, HubInfo, SpawnPlan, VendorEvent } from "@useparley/core";

export function createAdapter(env: NodeJS.ProcessEnv): VendorAdapter {
  return {
    id: "acme", // MUST equal the config key vendors.acme
    childChannel: "mcp", // mcp | cli | http: what the preamble teaches
    // Required: what each posture request actually gets.
    // Levels: enforced | approximate | none | refused.
    enforcement: {
      "read-only": { level: "none", via: "document the gap" },
      workspace: { level: "none" },
      full: { level: "enforced", via: "unrestricted as requested" },
      "network:false": { level: "none" },
    },
    prepare(task: TaskSpec, hub: HubInfo): Promise<SpawnPlan> { /* ... */ },
    resume(task: TaskSpec, hub: HubInfo): Promise<SpawnPlan> { /* ... */ },
    parseEvent(line: string): VendorEvent[] { /* ... */ },
    sessionId(events: VendorEvent[]): string | undefined { /* ... */ },
    // optional: listModels(existing) for `parley models refresh`
    // optional: readModels(existing): on-disk catalog discovery
    // optional: readSelectedModel(): setup pre-fill + allowlist advisory
  };
}
```

The daemon validates on load: `id` must equal the config key, `childChannel`
must be one of the three channels, `enforcement` must declare all four
dimensions with a valid level, and the four methods must be functions. A
failed plugin never crashes the daemon; delegating to that vendor just fails
with the usual unknown-vendor error, and the daemon log has a line starting
with `parley daemon: failed to load plugin adapter`.

### Honest enforcement

Declare what each posture request actually gets on this vendor: `enforced`
(OS-level or equivalent), `approximate` (permission configuration that can
leak), `none` (flag accepted, nothing happens), or `refused` (refuse to spawn
rather than under-isolate). These declarations feed the
[enforcement matrix](/guide/vendors) and `parley info`. Wrap `prepare` and
`resume` with `withPostureDiagnostics` from `@useparley/core` so weak
postures emit a `PARLEY-DIAG` line into the task's `diag.log` without
failing the spawn.

### Spawn plans

`prepare` and `resume` return `{ argv, env, files, cwd }`. The engine may
then replace `argv[0]` with `vendors.<id>.bin`, merge env
(`plan.env < vendors.<id>.env < profile.env`), and materialize `files` into
`cwd` before spawning.

`TaskSpec.extraArgs` is always an array (config `vendors.<id>.args`, then
`profiles.<name>.args`). Splice it into the flags region of argv: after the
subcommand head, **before** a positional prompt. Many CLIs treat the first
positional as the end of flags.

### Events and sessions

Keep `parseEvent` thin: parse what you recognize, return `[]` for unknown
lines. The raw JSONL stream is the durable record either way. `sessionId`
extracts the vendor's session id from parsed events so `parley fix` can
resume the vendor session.

## Register it

```json
{
  "vendors": {
    "acme": {
      "plugin": "parley-adapter-acme",
      "bin": "/usr/local/bin/acme",
      "args": ["--json"],
      "env": { "ACME_API_KEY": "your-key-here" },
      "models": {
        "acme-1": { "efforts": ["low", "medium"], "default": "medium" }
      }
    }
  }
}
```

`plugin` accepts an absolute path, a `file:` URL, or a bare package name
(resolved from the parley home, so you can `npm install` into `~/.parley`).

Remember the [model allowlist](/guide/configuration#model-allowlists) is
deny-by-default: without `vendors.acme.models`, delegating to `acme` fails
and points at `/parley-wizard`.

**Restart the daemon** after adding or changing a plugin module. Vendor
`args`/`env` and profiles hot-reload on the next delegate without a restart.

## Smoke test

```bash
parley daemon restart
PARLEY_SESSION_ID=smoke parley delegate -v acme "reply with a short summary"
parley status
parley logs <task-id>
parley watch
```

## Choosing a child channel

Declare exactly one `childChannel`; the engine teaches only that channel in
the protocol preamble. Config may override with `vendors.<id>.childChannel`.

| Channel | When to use |
| ------- | ----------- |
| **MCP** | the harness has a configurable MCP client that can set custom headers (`x-parley-task`) |
| **HTTP** | the harness can `curl` or `fetch` but has no MCP client |
| **CLI** | shell scripts and subprocesses: `parley child report` / `ask` / `task` |

All channels stay functional even when untaught (every child gets
`PARLEY_HUB_URL`, `PARLEY_TASK_ID`, and `.parley/child.json`); see
[How children talk back](/explainer/children).

## Packaging tips

- Depend on `@useparley/core` for types only; a peerDependency is fine.
- Ship ESM (`.mjs` or `"type": "module"`); the daemon uses dynamic `import()`.
- Keep auth in env passthrough, never hard-coded secrets.
- For the full contract, including `readSelectedModel` semantics and a
  complete minimal example, see
  [docs/agents/adapter-authoring.md](https://github.com/femoral/parley/blob/develop/docs/agents/adapter-authoring.md)
  in the repo.
