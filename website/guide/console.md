# The Console

```bash
parley ui
```

`parley ui` prints the cockpit URL and opens it in your browser. With
`@useparley/dashboard` installed, that is **Parley Console**: the web UI for
watching your crew work.

<div class="parley-shot">
  <img src="/hero-console.png" alt="Parley Console fleet board" />
</div>

## What you get

- **Fleet board.** Every task in the current session at a glance: state,
  vendor, model, age, and what is waiting on the orchestrator.
- **Run detail.** A workflow run as a node table: one line per node and
  iteration, gates included, without dumping forty tasks on you.
- **Task inspector.** One task's full story: brief, questions and answers,
  report, branch, logs, token usage.
- **Metrics.** The same aggregates as `parley metrics`, sliceable by vendor,
  model, profile, size, difficulty, or type.

The Console is read-mostly by design. Delegation and review flow through the
orchestrator; the cockpit is where you watch and inspect.

## Zero-config discovery

The daemon discovers the UI package at startup and serves it. Discovery order,
first hit wins:

1. `config.ui.path` (explicit filesystem path)
2. `config.ui.package` (explicit package name)
3. `@useparley/dashboard` (Parley Console, the default)
4. `@useparley/ui` (Parley Cove)

So the common case is: install the dashboard globally, run `parley ui`, done.

## Parley Cove, the alternate register

`@useparley/ui` is **Parley Cove**, a different take on the same daemon: a
nautical, chart-and-sea reading of your fleet. It is fully supported. Install
it and pin it explicitly:

```bash
npm install -g @useparley/ui
```

```json
{ "ui": { "package": "@useparley/ui" } }
```

in `~/.parley/parley.json` or the project config. With both packages installed
and nothing pinned, Console wins by discovery order.
