/** Browser shim for `node:path` when core modules leak into the client bundle. */
export function join(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => p !== undefined && p !== null && p !== "")
    .join("/")
    .replace(/\/+/g, "/");
}

const path = { join };
export default path;
