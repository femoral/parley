import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  unbundle: true,
  dts: true,
  clean: true,
  fixedExtension: false,
});
