import { defineConfig } from "tsdown";

// Two builds:
// 1) Library entry for tests / package exports (core stays external).
// 2) Bundled hook entry for Grok command hooks — dependency-free at runtime
//    (only needs node + dist/hook.js; core helpers are inlined).
export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: "esm",
    platform: "node",
    dts: true,
    clean: true,
    fixedExtension: false,
  },
  {
    entry: { hook: "src/hook-cli.ts" },
    format: "esm",
    platform: "node",
    dts: false,
    clean: false,
    fixedExtension: false,
    deps: {
      alwaysBundle: ["@useparley/core"],
    },
  },
]);
