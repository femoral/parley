import { createRequire } from "node:module";

/**
 * Runner package version, read from its own `package.json` at load. Advertised
 * on `POST /runner/register` as `build_version` (ADR-0029 / #314).
 */
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const RUNNER_VERSION: string = pkg.version;
