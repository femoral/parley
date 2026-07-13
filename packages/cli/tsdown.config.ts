import { defineConfig } from "tsdown";

// Unbundle mode: every source file maps 1:1 to a dist file, preserving the
// module tree and clean stack traces (see docs/research/cli-standalone-packaging.md).
// ESM-only output plus `.d.ts` declarations; workspace and runtime deps stay
// external (tsdown externalizes everything in `dependencies` by default).
export default defineConfig({
  entry: ["src/**/*.ts"],
  format: "esm",
  platform: "node",
  unbundle: true,
  dts: true,
  clean: true,
  // Emit `.js`/`.d.ts` (not `.mjs`): subpath imports and the wildcard exports
  // map reference `.js`, and the package is already `"type": "module"`.
  fixedExtension: false,
});
