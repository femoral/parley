import { defineWorkspace } from "vitest/config";

/**
 * Two projects with different parallelism profiles:
 *
 * - `unit`: pure in-process tests (UI components/hooks with faked fetch/SSE,
 *   projection logic, release scripts). No subprocesses, per-file isolation
 *   only — safe to run fully parallel.
 * - `integration`: CLI/daemon boundary tests that spawn real detached daemon
 *   processes (plus the packed-install smoke). Homes and ports are isolated
 *   per test, but concurrent daemon spawns are heavy and make the
 *   timing-sensitive tests flake, so they stay serialized on a single fork.
 */
export default defineWorkspace([
  {
    // React component tests (.tsx) use esbuild's automatic JSX runtime so
    // they need no `import React`. Node-environment tests are unaffected.
    esbuild: { jsx: "automatic" },
    test: {
      name: "unit",
      include: [
        "packages/ui/tests/**/*.test.ts",
        "packages/ui/tests/**/*.test.tsx",
        "packages/dashboard/tests/**/*.test.ts",
        "packages/dashboard/tests/**/*.test.tsx",
        "packages/core/tests/**/*.test.ts",
        "packages/plugins/*/tests/**/*.test.ts",
        "scripts/tests/**/*.test.ts",
      ],
      // Real-daemon dashboard tests need node:sqlite + integration pool
      // (see integration project include below).
      exclude: ["packages/dashboard/tests/integration/**"],
      testTimeout: 10_000,
    },
  },
  {
    // node:sqlite is a Node builtin; keep it external so vite does not try to
    // rewrite `node:sqlite` into a bare package id (see #54).
    ssr: { external: ["node:sqlite"] },
    esbuild: { jsx: "automatic" },
    test: {
      name: "integration",
      include: [
        "packages/cli/tests/**/*.test.ts",
        "packages/daemon/tests/**/*.test.ts",
        "packages/runner/tests/**/*.test.ts",
        // Console data layer (#352): hook/projection tests against a real
        // daemon + fake-vendor. Lives under dashboard but needs the
        // integration project's node:sqlite externalization and timeouts.
        "packages/dashboard/tests/integration/**/*.test.ts",
      ],
      // Dashboard hook tests under happy-dom must reach a real localhost
      // daemon — disable same-origin so ParleyClient fetch is not CORS-blocked.
      environmentOptions: {
        happyDOM: {
          settings: {
            fetch: {
              disableSameOriginPolicy: true,
            },
          },
        },
      },
      // Build the @useparley/ui bundle when missing so the daemon's
      // UI-serving test has a real built bundle to discover (#65).
      globalSetup: ["scripts/vitest-global-setup.ts"],
      testTimeout: 30_000,
      hookTimeout: 30_000,
      pool: "forks",
      poolOptions: {
        forks: { singleFork: true },
      },
    },
  },
]);
