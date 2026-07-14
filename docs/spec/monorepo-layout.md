# Monorepo layout spec

Decided on wayfinder map #47 (ticket #49), informed by the packaging research in
`docs/research/cli-standalone-packaging.md`. This spec is written so an execution
session can perform the migration mechanically.

## Package graph

```
@useparley/core  ←  @useparley/daemon  ←  @useparley/cli
      ↑                                        (bin, skills)
      └─────────────  @useparley/ui  (optional install)
```

Four packages under `packages/`, npm scope `@useparley`, pnpm workspaces.
Internal deps use `workspace:^` (rewritten to real semver ranges on `pnpm publish`,
per the packaging research — no bundling of workspace packages).

| Package | Contents | Depends on |
|---|---|---|
| `@useparley/core` | Domain types & task-state model (`models.ts`), data-dir resolution (`home.ts`), shared utils (`util/`), the daemon HTTP/long-poll client (`cli/client.ts` today). Doubles as the SDK custom UIs build against — no separate interfaces package. | — |
| `@useparley/daemon` | Engine, adapters, sqlite storage (`db.ts`), HTTP server, MCP channel, worktree/lock/discovery/report — everything under `src/daemon/`. Uses built-in `node:sqlite` (no native dep). | core |
| `@useparley/cli` | Commands, arg parsing, spawn/wait UX, `bin/parley.mjs`, `skills/`. Installing this package alone yields a working CLI + daemon. | core, daemon |
| `@useparley/ui` | React + Vite web UI, served by the daemon when installed (mechanics: ticket #51). Scaffolded as a placeholder now; `private: true` until the UI work lands. | core |

### File moves (current → new)

| Current | New home |
|---|---|
| `src/models.ts`, `src/home.ts`, `src/util/` | `packages/core/src/` |
| `src/cli/client.ts` | `packages/core/src/client.ts` |
| `src/daemon/**` | `packages/daemon/src/` |
| `src/cli/**` (rest: `index.ts`, `args.ts`, `commands/`, `context.ts`, `errors.ts`, `spawn.ts`, `wait.ts`) | `packages/cli/src/` |
| `bin/parley.mjs` | `packages/cli/bin/parley.mjs` |
| `skills/`, `skills-lock.json` | `packages/cli/skills/` |
| `tests/**` | Split per package: each test moves next to the package whose code it exercises (`packages/*/tests/`). |

## Build & publish

- **Build tool: tsdown** (falling back to tsup if tsdown misbehaves) per package.
  ESM-only output + `.d.ts` to `dist/`; runtime deps stay external (tsdown
  default). Daemon storage uses built-in `node:sqlite` (no native package).
- `packages/cli/bin/parley.mjs` imports the built `dist/` — **never** TS source via
  `tsx` (the current bin does; the packaging research flagged this as a
  would-not-run-as-published bug).
- Each package: `"type": "module"`, `"engines": { "node": ">=24" }`,
  `exports` map pointing at `dist/`, `files` limited to `dist` (+ `bin`, `skills`
  for cli), `publishConfig: { "access": "public" }`.

## Tooling wiring

- **pnpm**: `pnpm-workspace.yaml` with `packages: ["packages/*"]`; delete
  `package-lock.json`; root `package.json` becomes private with workspace-wide
  scripts (`-r` recursive build/test/lint).
- **TypeScript**: root `tsconfig.base.json` with shared compiler options;
  per-package `tsconfig.json` extending it, wired as project references for
  `tsc --noEmit` typecheck across the workspace.
- **Vitest**: per-package tests, single root run via vitest workspace/projects
  config.
- **ESLint**: keep the single root flat config; it already globs the tree.

## Dev-time scripts

Root scripts mirror today's UX: `pnpm parley` runs the CLI from source
(tsx watchers stay a dev-only convenience inside packages), `pnpm build`,
`pnpm test`, `pnpm typecheck`, `pnpm lint` fan out with `-r`.

## Migration order (for the execution session)

1. Introduce pnpm (workspace file, root package.json rewrite, lockfile swap).
2. Create `packages/core` and move shared code; fix imports.
3. Create `packages/daemon`; fix imports to `@useparley/core`.
4. Create `packages/cli`; move bin + skills; add tsdown build; point bin at dist.
5. Scaffold `packages/ui` placeholder (private).
6. Split tests; add vitest workspace config; wire tsconfig references.
7. Verify: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`, then
   `pnpm pack` the cli package and smoke-test a global install in a temp dir.

## Out of scope here

- UI serving/discovery mechanics — ticket #51.
- Versioning & release pipeline (changesets vs fixed version, CI publish) —
  separate map ticket.
