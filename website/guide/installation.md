# Installation

## Requirements

- **Node 24 or newer**
- **git**
- At least one vendor CLI (Codex, Grok, Claude Code, ...) installed and
  authenticated on the machine that will run the work. Parley spawns the
  vendor CLIs you already have; it does not ship or authenticate them for
  you. See [Vendors and sandboxing](/guide/vendors) for the supported list.

## Install the CLI

```bash
npm install -g @useparley/cli
```

That is the whole core install. The daemon is bundled with the CLI and
auto-spawns on first use; there is nothing to start by hand.

## Install the Console (recommended)

```bash
npm install -g @useparley/dashboard
```

`@useparley/dashboard` is **Parley Console**, the web cockpit. It is optional
but recommended: a fleet board, run detail, task inspector, and metrics
against the live daemon. Once installed, `parley ui` finds and serves it with
zero configuration. See [The Console](/guide/console).

## Verify

```bash
parley daemon status   # daemon identity: pid, port, home, version
parley --version
```

## Where Parley keeps things

| Path | Contents |
| ---- | -------- |
| `~/.parley/parley.json` | Global configuration (all optional, validated loudly) |
| `~/.parley/tasks/` | Per-task logs: `diag.log`, raw vendor stream |
| `.parley/` in your repo | Project-scope config, workflows, rubrics, context |

## Next step

Run [`parley init`](/guide/getting-started) inside the repository you want to
delegate work in.
