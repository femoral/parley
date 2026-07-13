#!/usr/bin/env node
// Thin launcher. In a published install the built CLI is present at
// `../dist/index.js`, and the bin runs that compiled entry directly — no `tsx`,
// no TypeScript at runtime (the published package ships `dist/` only).
//
// In the dev workspace there is no `dist/` (parley runs from source, no build
// step required — see ADR-0001), so we register the `tsx` loader and run the
// TypeScript entry. This branch never executes in a published install.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const distEntry = new URL("../dist/index.js", import.meta.url);

if (existsSync(fileURLToPath(distEntry))) {
  await import(distEntry.href);
} else {
  const { register } = await import("tsx/esm/api");
  register();
  await import(new URL("../src/index.ts", import.meta.url).href);
}
