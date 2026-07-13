import { defineConfig } from "vitest/config";

export default defineConfig({
  // React component tests (.tsx) use esbuild's automatic JSX runtime so they
  // need no `import React`. Node-environment tests are unaffected.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["packages/*/tests/**/*.test.ts", "packages/*/tests/**/*.test.tsx", "scripts/tests/**/*.test.ts"],
    // Build the @useparley/ui bundle when missing so the daemon's UI-serving
    // test has a real built bundle to discover (#65).
    globalSetup: ["scripts/vitest-global-setup.ts"],
    // React component tests transform JSX via esbuild's automatic runtime.
    // (Node-environment tests are unaffected; this only changes .tsx handling.)
    // Each CLI-boundary test spawns real detached daemon processes; give them room
    // and keep them off one shared parley home by isolating per-test temp dirs.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Daemons bind ephemeral ports and write to per-test homes, but spawning many
    // node+tsx subprocesses at once is heavy; cap parallelism for stability.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
