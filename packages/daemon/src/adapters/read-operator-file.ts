import fs from "node:fs";

/**
 * Guarded stat + read of a regular operator-home file for model discovery
 * (#288 / #294). Shared by codex, grok, openclaw, kimi, and hermes readers.
 *
 * Returns:
 *  - `{ text: null, error: null }` when the path is missing (ENOENT) — quiet empty
 *  - `{ text: null, error }` for non-file / oversize / unreadable
 *  - `{ text, error: null }` on success
 *
 * Never includes file body in error messages (secret hygiene). TOCTOU accepted:
 * `isFile()` stops the static-FIFO / device hang; a path swapped to FIFO between
 * the two calls can still block, and a regular file on a hung network mount
 * blocks regardless. Bound open is not portable enough for our Node target.
 */
export function readOperatorFileText(
  filePath: string,
  fileLabel: string,
  maxBytes: number,
): { text: string | null; error: string | null } {
  try {
    const stat = fs.statSync(filePath);
    // #288: refuse non-files (FIFO, dir, device). readFileSync on a FIFO
    // blocks the daemon event loop forever.
    if (!stat.isFile()) {
      return { text: null, error: `${fileLabel} is not a regular file` };
    }
    if (stat.size > maxBytes) {
      return {
        text: null,
        error: `${fileLabel} exceeds size cap (${maxBytes} bytes)`,
      };
    }
    return { text: fs.readFileSync(filePath, "utf8"), error: null };
  } catch (err) {
    if (isEnoent(err)) return { text: null, error: null };
    return {
      text: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
