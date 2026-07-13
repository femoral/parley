/**
 * `@useparley/daemon` — the parley daemon. The engine, vendor adapters, sqlite
 * storage, HTTP server, and MCP channel. The CLI spawns the daemon entry
 * (`@useparley/daemon/main`) as a detached process and talks to it over HTTP;
 * it also imports individual modules by subpath (e.g.
 * `@useparley/daemon/discovery`). This barrel re-exports the stable surface.
 */
export { createAdapterRegistry, type VendorAdapter } from "./adapters/index.js";
export { startServer, type DaemonServer } from "./server.js";
