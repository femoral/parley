# @useparley/cli

The parley command-line interface — delegate tasks to agent CLIs (Codex, Grok
Build) from an orchestrating agent. Installing this package alone yields a
working CLI plus the daemon it drives (`@useparley/core` and `@useparley/daemon`
come along as ordinary dependencies).

Requires Node.js ≥ 22.

## Install

```sh
npm install -g @useparley/cli
# or
pnpm add -g @useparley/cli
```

Then:

```sh
parley --help
```

## pnpm ≥ 10: approve the better-sqlite3 build

The daemon stores task state in SQLite via `better-sqlite3`, a native module.
Its install script downloads a prebuilt binary for your platform (no compiler
needed on mainstream Node 22/24/26 targets).

**pnpm 10 and newer block dependency install scripts by default.** Until the
build is approved, `parley` fails at startup with `Could not locate the bindings
file`. Approve it once:

```sh
pnpm approve-builds -g        # interactive: approve better-sqlite3
```

or declare it ahead of time in your `package.json` / `pnpm-workspace.yaml`:

```yaml
# pnpm-workspace.yaml
onlyBuiltDependencies:
  - better-sqlite3
```

`npm` and `npx` run install scripts by default and need no extra step.

If your environment blocks GitHub Releases (where the prebuilt binaries live),
`better-sqlite3` falls back to compiling from source, which needs `python3` and
a C/C++ toolchain.
