#!/usr/bin/env node
// Thin launcher. In a published install the built runner is present at
// `../dist/main.js`. In the dev workspace there is no `dist/`, so we register
// the `tsx` loader and run the TypeScript entry.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const distEntry = new URL("../dist/main.js", import.meta.url);

if (existsSync(fileURLToPath(distEntry))) {
  await import(distEntry.href);
} else {
  const { register } = await import("tsx/esm/api");
  register();
  await import(new URL("../src/main.ts", import.meta.url).href);
}
