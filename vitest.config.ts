import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
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
