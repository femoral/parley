#!/usr/bin/env node
// Thin launcher: register the tsx loader, then run the TypeScript CLI entry.
// Parley runs from source via tsx (see ADR-0001) — no build step required.
import { register } from "tsx/esm/api";

register();
await import(new URL("../src/cli/index.ts", import.meta.url).href);
