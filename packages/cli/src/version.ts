import { createRequire } from "node:module";

/**
 * Read the CLI's own package version so source checkouts and packed installs
 * report the same value without depending on the daemon package.
 */
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const CLI_VERSION: string = pkg.version;
export const VERSION_LINE = `parley ${CLI_VERSION}`;
