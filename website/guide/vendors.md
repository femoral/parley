# Vendors and sandboxing

A vendor is a coding-agent CLI that Parley can put on the crew. Every vendor
sits behind the same adapter interface: same flags, same worktree semantics,
same report contract.

## Supported vendors

| Vendor | CLI | Status |
| ------ | --- | ------ |
| `codex` | OpenAI Codex CLI | ✅ tested |
| `grok` | Grok Build | ✅ tested |
| `claude` | Claude Code | 🧪 under testing |
| `cursor` | Cursor CLI (`cursor-agent`) | 🧪 under testing |
| `antigravity` | Antigravity CLI (`agy`) | 🧪 under testing |
| `opencode` | OpenCode | 🧪 under testing |
| `goose` | Goose | 🧪 under testing |
| `pi` | Pi coding agent | 🧪 under testing |
| `cline` | Cline CLI | 🧪 under testing |
| `kilo` | Kilo CLI | 🧪 under testing |
| `openhands` | OpenHands | 🧪 under testing |
| `hermes` | Hermes Agent | 🧪 under testing |
| `openclaw` | OpenClaw | 🧪 under testing |
| `kimi` | Kimi Code CLI | 🧪 under testing |

::: warning Tested vs implemented
Adapter support exists for everything listed, but only `codex` and `grok`
have been exercised in sustained real-world orchestration so far. The rest
are implemented, pass their suites, and are still being shaken out.
:::

Each vendor CLI must be installed and authenticated on the machine that runs
it (locally, or on a [remote runner](/guide/remote-runners)). Parley passes
model and reasoning effort through opaquely (`-m`, `--effort`), so any model
the vendor CLI accepts works, subject to your
[model allowlist](/guide/configuration#model-allowlists).

## Sandbox postures

Every adapter accepts the same posture flags:

- `--sandbox read-only | workspace | full`
- `--no-network`

`workspace` is the default: the child may write inside its worktree and
nothing else. `read-only` is for survey and review tasks. `full` is
unrestricted, by request.

**Enforcement is not portable.** Some vendors enforce these postures at the
OS level, some approximate them with permission configuration, and some
accept the flag and do nothing. Parley refuses to pretend otherwise: each
adapter declares what each posture actually gets, the matrix below is
contract-tested against those declarations, and `parley info` prints the same
table.

When a requested posture is only `approximate` or `none`, prepare writes a
one-line `PARLEY-DIAG` warning into the task's `diag.log` so the gap is on
the record. The `full` column is always `enforced`, since unrestricted access
is exactly what full asks for. A `refused` cell means the adapter refuses to
spawn rather than under-isolate.

@enforcement-matrix@

## Bring your own vendor

Adapters are a public contract in `@useparley/core`. Point
`vendors.<id>.plugin` at your module and the daemon loads it at startup.
Declare `enforcement` for every posture dimension so `parley info` and the
matrix stay honest. See [Writing an adapter](/reference/adapter-authoring).
