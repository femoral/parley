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

/**
 * Minimal TOML *reader* for the subset vendor config files actually use
 * (kimi `config.toml` model tables, etc.). Not a full TOML 1.0 parser — only
 * what discovery needs, so we never take a TOML dependency and never
 * re-serialize input (secret hygiene: credentials co-located with model data
 * must never round-trip into logs or the catalog).
 *
 * Supported:
 *  - bare keys: `key = "string" | number | true | false | ["a", "b"]`
 *  - tables: `[name]`, `[name."dotted.id"]`, `[name.plain]`
 *  - comments (`#…`) and blank lines (quote-aware — `#` inside strings is kept)
 *
 * Unsupported (ignored or skipped): inline tables, multiline strings, arrays of
 * tables, dotted bare keys outside table headers. Callers that need only
 * specific tables should filter by section name after parse.
 *
 * Prototype pollution is rejected: `__proto__` / `constructor` / `prototype`
 * are never used as table segments or keys, and every table is
 * `Object.create(null)` so a hostile header cannot walk onto
 * `Object.prototype` (#281 fix round).
 */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
/** Null-prototype table — never inherits Object.prototype keys. */
export type TomlTable = { [key: string]: TomlValue };

/** Keys / path segments that must never be materialised as own properties. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

function emptyTable(): TomlTable {
  return Object.create(null) as TomlTable;
}

function unquoteBasicString(raw: string): string {
  // raw includes surrounding quotes.
  let out = "";
  for (let i = 1; i < raw.length - 1; i++) {
    const ch = raw[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[++i];
    if (next === undefined) break;
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case '"':
        out += '"';
        break;
      case "\\":
        out += "\\";
        break;
      case "u": {
        const hex = raw.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        }
        break;
      }
      default:
        out += next;
    }
  }
  return out;
}

function parseTomlValue(raw: string): TomlValue | undefined {
  const s = raw.trim();
  if (s === "") return undefined;
  if (s === "true") return true;
  if (s === "false") return false;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return unquoteBasicString(s);
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1);
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    // Split on commas not inside quotes (simple; model effort lists are flat).
    const parts: string[] = [];
    let buf = "";
    let inQuote: '"' | "'" | null = null;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]!;
      if (inQuote) {
        buf += ch;
        if (ch === inQuote && inner[i - 1] !== "\\") inQuote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inQuote = ch;
        buf += ch;
        continue;
      }
      if (ch === ",") {
        parts.push(buf.trim());
        buf = "";
        continue;
      }
      buf += ch;
    }
    if (buf.trim() !== "") parts.push(buf.trim());
    return parts
      .map((p) => parseTomlValue(p))
      .filter((v): v is TomlValue => v !== undefined);
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return undefined;
}

/**
 * Strip a `#…` comment only when `#` is outside quotes (basic/literal).
 * A `#` inside `"…"` or `'…'` is part of the value (URLs, paths, #282).
 */
function stripTomlComment(lineRaw: string): string {
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < lineRaw.length; i++) {
    const ch = lineRaw[i]!;
    if (inQuote) {
      if (ch === "\\" && inQuote === '"') {
        i++; // skip escaped char inside basic string
        continue;
      }
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === "#") return lineRaw.slice(0, i);
  }
  return lineRaw;
}

/**
 * Parse a TOML document into nested null-prototype tables. Fail-soft on
 * individual bad lines (skip them); returns whatever tables/keys were
 * readable. Never throws on content shape — empty input returns `{}`.
 *
 * Callers that co-locate secrets with model data must project only the keys
 * they need and never log, echo, or re-serialize the returned table wholesale.
 */
export function parseToml(text: string): TomlTable {
  const root = emptyTable();
  let current: TomlTable = root;

  const lines = text.split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = stripTomlComment(lineRaw).trim();
    if (line === "") continue;

    // Table header: [foo], [foo.bar], [models."kimi-code/k3"]
    if (line.startsWith("[") && line.endsWith("]") && !line.startsWith("[[")) {
      const header = line.slice(1, -1).trim();
      const segments = splitTableHeader(header);
      if (segments === null) {
        // Rejected header (forbidden segment, empty `[]`, unterminated quote).
        // Point `current` at a throwaway so following keys do not attach to the
        // previous table or root — splitTableHeader already refused the path,
        // so a second in-loop check is unreachable and must not be relied on.
        current = emptyTable();
        continue;
      }
      let cursor: TomlTable = root;
      for (const seg of segments) {
        const existing = cursor[seg];
        if (existing !== undefined && isTomlTable(existing)) {
          cursor = existing;
        } else {
          const next = emptyTable();
          cursor[seg] = next;
          cursor = next;
        }
      }
      current = cursor;
      continue;
    }

    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const valueRaw = line.slice(eq + 1).trim();
    if (key === "" || !/^[A-Za-z0-9_-]+$/.test(key)) continue;
    if (isForbiddenKey(key)) continue;
    const value = parseTomlValue(valueRaw);
    if (value === undefined) continue;
    current[key] = value;
  }
  return root;
}

function isTomlTable(value: TomlValue): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Split a table header into path segments, honouring quoted dotted ids
 * (`models."kimi-code/k3"` → `["models", "kimi-code/k3"]`).
 * Returns null when any segment is a forbidden pollution key.
 */
function splitTableHeader(header: string): string[] | null {
  const segments: string[] = [];
  let i = 0;
  while (i < header.length) {
    while (header[i] === " " || header[i] === "\t") i++;
    if (i >= header.length) break;
    if (header[i] === '"') {
      const end = header.indexOf('"', i + 1);
      if (end < 0) return null;
      const seg = header.slice(i + 1, end);
      if (isForbiddenKey(seg)) return null;
      segments.push(seg);
      i = end + 1;
      if (header[i] === ".") i++;
      continue;
    }
    // bare segment up to next `.`
    let j = i;
    while (j < header.length && header[j] !== ".") j++;
    const seg = header.slice(i, j).trim();
    if (seg === "") return null;
    if (isForbiddenKey(seg)) return null;
    segments.push(seg);
    i = j + 1;
  }
  return segments.length > 0 ? segments : null;
}
