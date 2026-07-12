// TOML basic strings forbid literal control characters (0x00-0x1f, 0x7f).
// Built via RegExp/String.fromCharCode rather than a literal escape range to
// dodge control-byte mangling in source pipelines.
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
  "g",
);

/**
 * TOML basic-string literal. Escapes backslash, quote, and control characters —
 * a raw newline/tab/quote (e.g. in a hub URL, header value, or filesystem path)
 * would otherwise emit invalid TOML, or worse, inject an extra config line.
 * Shared by every adapter that builds `-c`/config-file TOML values.
 */
export function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(CONTROL_CHARS, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"${escaped}"`;
}
