/**
 * Browser entry for `@useparley/core` — node-free subset of the main barrel.
 *
 * Invariant (maintained alongside `index.ts`):
 * - browser barrel ⊂ main barrel (every export here is also on the main barrel)
 * - no Node builtins transitively (`node:fs` / `node:os` / `node:path`, and no
 *   host-only modules that import them)
 *
 * Bundlers resolve this via the package `"browser"` export condition (Vite
 * client builds). Node consumers keep the full barrel via `"default"`.
 *
 * Host-only modules intentionally omitted: `config`, `home`, `models`,
 * `vendor-home`, `session-state`, `project-lint`, and workflow discovery /
 * definition / lint / path helpers. Pure step-address formatting is re-exported
 * from `./workflow/step-address.js` so the UI can format addresses without
 * pulling `node:path`.
 */

export * from "./adapter.js";
export * from "./classification.js";
export * from "./client.js";
export * from "./contract.js";
export * from "./lease.js";
export * from "./model-allowlist.js";
export * from "./project-config.js";
export * from "./repo-key.js";
export * from "./rubric.js";
export * from "./run-query.js";
export * from "./sdk.js";
export * from "./shipped-model-catalog.js";
export * from "./states.js";
export * from "./template-expand.js";
export * from "./usage.js";
export * from "./util/time.js";
export * from "./workflow/compile.js";
export * from "./workflow/types.js";
export { formatStepAddress, type StepAddress } from "./workflow/step-address.js";
