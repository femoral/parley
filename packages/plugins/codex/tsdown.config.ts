import { defineConfig } from "tsdown";

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
    entry: { hook: "src/hook.ts" },
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
