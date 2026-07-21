import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/hook.ts"],
  format: "esm",
  platform: "node",
  deps: { alwaysBundle: ["@useparley/core"] },
  dts: true,
  clean: true,
  fixedExtension: false,
});
