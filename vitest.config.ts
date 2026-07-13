import { defineConfig } from "vitest/config";

// Project definitions (include globs, pools, timeouts) live in
// vitest.workspace.ts: a parallel `unit` project and a serialized
// `integration` project. This root config only carries options that apply
// across the whole workspace run.
export default defineConfig({
  test: {},
});
