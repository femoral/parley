# @useparley/cli

The parley command-line interface — delegate tasks to agent CLIs (Codex, Grok
Build) from an orchestrating agent. Installing this package alone yields a
working CLI plus the daemon it drives (`@useparley/core` and `@useparley/daemon`
come along as ordinary dependencies).

Requires Node.js ≥ 24.

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

The daemon stores task state in SQLite via Node's built-in `node:sqlite`
(`DatabaseSync`). There is no native module to compile and no install-script
approval step.
