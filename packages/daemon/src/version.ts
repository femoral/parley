import { createRequire } from "node:module";

/**
 * The daemon package version, read from its own `package.json` at load. Surfaced
 * on `GET /health` so a UI can detect a contract mismatch against the
 * `@useparley/core` SDK it was built for (docs/spec/ui-interface-contract.md).
 *
 * `createRequire` resolves the file relative to this module — `../package.json`
 * from both `src/` (dev, run via tsx) and `dist/` (published), which sit one
 * level under the package root.
 */
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const DAEMON_VERSION: string = pkg.version;
