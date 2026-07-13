# Research: standalone CLI packaging with native dependencies (#48)

**Question**: once parley splits into a pnpm monorepo (`@useparley/cli` / `core` /
`daemon` / `ui`), how does `npm i -g @useparley/cli` deliver a working CLI +
daemon standalone, given the daemon's `better-sqlite3` native module?

**Grounding**: `src/daemon/db.ts` is the only native-module consumer — synchronous
prepared statements, `pragma` helper (WAL, `user_version`, `foreign_keys`), the
`db.transaction()` helper, and one `RETURNING` clause. ADR-0001 already accepted
"npm distribution, no single binary". Current deps: `@modelcontextprotocol/sdk`,
`ajv`, `better-sqlite3`, `zod` — all pure JS except `better-sqlite3`.

One pre-existing gap worth fixing regardless of option: `bin/parley.mjs` registers
`tsx` and imports `src/cli/index.ts`, but `tsx` is a devDependency. The package as
published today would not run at all. Any publishing plan needs a real build step
(tsc or a bundler) emitting JS, with `bin` pointing at built output.

## Option 1 — plain npm dependencies (no bundling)

`@useparley/cli` declares `@useparley/core` and `@useparley/daemon` as regular
dependencies using `workspace:^` in the repo. **Verified**: `pnpm publish`/`pnpm
pack` rewrites `workspace:*` / `workspace:~` / `workspace:^` to the concrete
version (or semver range) of the workspace package at pack time — consumers see
ordinary semver deps and npm installs them transitively ([pnpm workspaces
docs](https://pnpm.io/workspaces)). `better-sqlite3` stays a regular dependency of
`@useparley/daemon`.

- **Buys**: zero build complexity beyond `tsc`; stack traces map to real files;
  each package is independently consumable (`@useparley/core` as a library);
  npm dedupes shared deps.
- **Costs**: multi-package publish choreography (changesets or `pnpm -r publish`
  handles it); version-skew risk between cli/daemon if ranges are loose — pin
  with `workspace:^` and release the packages in lockstep; larger `node_modules`
  than a bundle (irrelevant for a global install).
- **Gotcha**: nothing here is standalone-hostile. "Standalone" only requires that
  the dependency graph resolves from the registry, which it does.

## Option 2 — literal bundling (tsup/esbuild single artifact)

Bundle the CLI + daemon into one or two JS files at publish time; mark
`better-sqlite3` (and anything with `__dirname`-relative asset loading) as
`external` and keep it in `dependencies`. This is exactly what wrangler does
(**verified** via the npm registry): wrangler bundles its own TS with esbuild but
keeps `esbuild`, `workerd`, `miniflare` as plain runtime dependencies; native
bits are never bundled.

- **Buys**: faster cold start (one file, no module-graph walk); fewer files in
  the tarball; immunity to transitive-dep breakage at install time for the
  bundled portion; internal packages (`core`) never need publishing at all if
  everything folds into the cli tarball.
- **Costs**: build pipeline complexity (tsup config, external lists, ESM/CJS
  interop edges with `@modelcontextprotocol/sdk`); worse stack traces unless
  sourcemaps ship; `@useparley/core` stops being reusable unless it is *also*
  published unbundled — double build paths.
- **Key point**: bundling does not solve the native-module problem at all —
  `better-sqlite3` must remain a resolvable runtime dependency either way. It is
  a size/robustness optimization, not a standalone-install mechanism.

## Option 3 — the native module itself

### How better-sqlite3 installs (verified against v12.11.2 release assets)

`better-sqlite3` uses `prebuild-install`: an install script downloads a prebuilt
`better_sqlite3.node` from GitHub Releases matching `{node ABI} × {platform} ×
{arch} × {libc}`. Current coverage: darwin x64/arm64, linux x64/arm64/arm (glibc
**and** musl), win32 x64/arm64 — for Node ABIs 127 (Node 22), 137 (24), 141 (25),
147 (26), plus a wide Electron matrix. Node-gyp source compilation kicks in only
when no asset matches (odd-numbered non-LTS Node lines, exotic platforms, or no
network to GitHub) — then the user needs python3 + a C++ toolchain.

Practical implications for parley (engines `>=22`):

- Every mainstream platform on Node 22/24/26 gets a binary download, no
  toolchain. This is the same posture Cloudflare shipped to a very large user
  base with miniflare 3.
- **pnpm ≥10 blocks dependency install scripts by default.** A pnpm user gets
  the JS but no binary ("Could not locate the bindings file") until they run
  `pnpm approve-builds` / add `better-sqlite3` to `onlyBuiltDependencies`. Worth
  a line in the README; npm and npx are unaffected.
- Corporate networks that block GitHub Releases fall back to compilation.

### Alternative A: `node:sqlite` (built-in)

**Verified** against Node docs and nodejs/node#57445:

| Node line | status |
|---|---|
| 22.0–22.4 | module absent |
| 22.5–22.12 | behind `--experimental-sqlite` |
| ≥22.13 | flag-free, Stability 1.1 (experimental warning) |
| 24.x | flag-free, still experimental |
| 25.7+ | Stability 1.2 (release candidate) |
| 26.x | stable |

`db.ts` ports easily: `StatementSync` covers `prepare/run/get/all`; `RETURNING`
is plain SQL; the `pragma()` and `transaction()` helpers become small wrappers
over `exec("PRAGMA …")` and `BEGIN/COMMIT`. Cost today: engines must rise to
`>=22.13`, users on 22.13–24 see an experimental-feature warning on stderr (it
pollutes CLI output unless suppressed), and API churn is still possible until 26.

### Alternative B: WASM sqlite (`node-sqlite3-wasm`, sql.js, official sqlite-wasm)

Removes all native/install concerns, but the mature options either hold the DB
in memory with explicit persistence, or lack WAL and real concurrent-reader
semantics through a VFS shim. The daemon relies on WAL + a file the CLI plane
could inspect; WASM is the weakest fit and only worth it as a last-resort
fallback path. Not recommended.

### What comparable CLIs do (verified via npm registry)

- **wrangler** (Cloudflare): esbuild-bundles its own code; native/binary deps
  (`workerd`, `esbuild`) stay regular dependencies; `fsevents` is the lone
  optionalDependency. miniflare 3 shipped `better-sqlite3` as a plain dep to a
  huge install base; miniflare 4 dropped it (storage moved into workerd), i.e.
  they eventually engineered the native dep away rather than around it.
- **esbuild / @biomejs/biome / turbo**: per-platform binaries as
  `optionalDependencies` with cpu/os fields — the pattern to reach for only if
  parley ever ships its own native code; `better-sqlite3` already implements the
  equivalent via prebuild-install, so wrapping it again adds nothing.

## Recommendation

1. **Ship Option 1 now**: publish `@useparley/{cli,core,daemon}` as normal
   packages; `workspace:^` in-repo, rewritten by `pnpm publish`. Keep
   `better-sqlite3` a regular dependency of `@useparley/daemon`. Its prebuild
   matrix covers every platform parley plausibly targets on Node 22/24/26 with
   no toolchain. `npm i -g @useparley/cli` is standalone by construction.
2. **Add a real build step** (tsc emit, or tsup in transpile-only mode) so the
   published `bin` runs compiled JS — the current tsx-loader bin cannot ship.
   Treat single-artifact bundling as a later optimization (the wrangler
   pattern), adopted only if install size or cold start becomes a measured
   problem; it changes nothing about the native-module story.
3. **Document the pnpm ≥10 caveat** (approve `better-sqlite3` build scripts) in
   the install README.
4. **Plan a `node:sqlite` migration** as the endgame: the `db.ts` surface ports
   with a thin wrapper, and the moment parley can require Node ≥26 (or accepts
   the experimental warning at ≥22.13), the native dependency — and this entire
   problem class — disappears, following miniflare's arc. Track it as a
   follow-up issue rather than blocking the monorepo split on it.

## Sources

- pnpm workspace protocol rewriting on publish: <https://pnpm.io/workspaces>
- node:sqlite docs (Node 22.x, flag removed in v22.13.0, Stability 1.1):
  <https://nodejs.org/docs/latest-v22.x/api/sqlite.html>
- node:sqlite stabilization tracking: <https://github.com/nodejs/node/issues/57445>
- better-sqlite3 prebuild assets (v12.11.2 release):
  <https://github.com/WiseLibs/better-sqlite3/releases>
- wrangler / miniflare dependency manifests: npm registry (`wrangler`,
  `miniflare` latest); miniflare 3's better-sqlite3 dep:
  <https://github.com/cloudflare/miniflare/issues/767>
