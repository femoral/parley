import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/hook.ts"],
  format: "esm",
  platform: "node",
  dts: false,
  clean: true,
  fixedExtension: false,
});
