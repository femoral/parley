/**
 * Workflow port type grammar (ADR-0016 / #231).
 *
 * Grammar:
 *   type  := atom | type "[]" | "dict<" "string" "," type ">"
 *   atom  := "text" | "url" | "file" | "dir" | <named>
 *   named := a key in the workflow's `types` block
 *
 * Comparison is structural over containers and nominal over atoms. There is no
 * `number` or `bool` atom — only types the daemon does a distinct job with.
 */

/** Builtin scalar atoms (no named-type resolution needed). */
export type BuiltinAtomKind = "text" | "url" | "file" | "dir";

/** A named type declared in the workflow `types` block. */
export type NamedTypeDecl =
  | { kind: "enum"; values: readonly string[] }
  | { kind: "schema"; path: string; schema: Record<string, unknown> | boolean };

/**
 * Parsed port type AST. Named atoms carry their declaration so equality and
 * compile need no external registry at use sites.
 */
export type PortType =
  | { kind: "text" }
  | { kind: "url" }
  | { kind: "file" }
  | { kind: "dir" }
  | { kind: "enum"; name: string; values: readonly string[] }
  | {
      kind: "schema";
      name: string;
      path: string;
      schema: Record<string, unknown> | boolean;
    }
  | { kind: "array"; element: PortType }
  | { kind: "dict"; value: PortType };

const BUILTINS = new Set<string>(["text", "url", "file", "dir"]);

/**
 * Default `max_length` applied to every `text` atom that does not declare one
 * on its producing port. 16 KiB — enough for substantial prose, still bounded
 * so the generated report schema always has a finite `maxLength` (ADR-0016).
 */
export const DEFAULT_TEXT_MAX_LENGTH = 16_384;

/** Outcome of the single compatibility comparison (ADR-0016). */
export type CompatibilityResult =
  | { outcome: "exact" }
  | { outcome: "fan-out"; container: "array" | "dict" }
  | { outcome: "error"; reason: string };

/**
 * Parse a port type string against a named-type registry.
 * Throws a descriptive Error on any grammar or resolution failure (never coerces).
 */
export function parsePortType(
  raw: string,
  named: ReadonlyMap<string, NamedTypeDecl> | Readonly<Record<string, NamedTypeDecl>>,
): PortType {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("port type must be a non-empty string");
  }
  const registry = toMap(named);
  const trimmed = raw.trim();
  const { type, rest } = parseTypeExpr(trimmed, registry);
  if (rest.trim() !== "") {
    throw new Error(`port type has trailing junk: ${JSON.stringify(rest)}`);
  }
  return type;
}

/**
 * Structural-over-containers, nominal-over-atoms equality.
 * Two named types with byte-identical schemas are *not* interchangeable.
 */
export function portTypesEqual(a: PortType, b: PortType): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "text":
    case "url":
    case "file":
    case "dir":
      return true;
    case "enum":
      return b.kind === "enum" && a.name === b.name;
    case "schema":
      return b.kind === "schema" && a.name === b.name;
    case "array":
      return b.kind === "array" && portTypesEqual(a.element, b.element);
    case "dict":
      return b.kind === "dict" && portTypesEqual(a.value, b.value);
  }
}

/**
 * One comparison, two outcomes (ADR-0016):
 * - input ≡ upstream → exact (pass whole)
 * - upstream is a container whose element type ≡ input → fan-out
 * - otherwise → error
 *
 * The two positive outcomes cannot both fire (`T ≡ T[]` has no finite solution).
 * No coercion: `dict<string,text>` feeding `text[]` is an error.
 */
export function checkCompatibility(
  input: PortType,
  upstream: PortType,
): CompatibilityResult {
  if (portTypesEqual(input, upstream)) {
    return { outcome: "exact" };
  }
  if (upstream.kind === "array" && portTypesEqual(input, upstream.element)) {
    return { outcome: "fan-out", container: "array" };
  }
  if (upstream.kind === "dict" && portTypesEqual(input, upstream.value)) {
    return { outcome: "fan-out", container: "dict" };
  }
  return {
    outcome: "error",
    reason: `incompatible types: input ${formatPortType(input)} vs upstream ${formatPortType(upstream)}`,
  };
}

/**
 * Wrap a declared output type by the step's fan-out collection container
 * (NOTES rule 4): slots or dict data fan-out → `dict<string, T>`; array data
 * fan-out → `T[]`; none → T unchanged.
 */
export function applyFanOutCollection(
  declared: PortType,
  fanOut: "none" | "array" | "dict",
): PortType {
  if (fanOut === "none") return declared;
  if (fanOut === "array") return { kind: "array", element: declared };
  return { kind: "dict", value: declared };
}

/** Human-readable form matching the source grammar. */
export function formatPortType(t: PortType): string {
  switch (t.kind) {
    case "text":
    case "url":
    case "file":
    case "dir":
      return t.kind;
    case "enum":
    case "schema":
      return t.name;
    case "array":
      return `${formatPortType(t.element)}[]`;
    case "dict":
      return `dict<string, ${formatPortType(t.value)}>`;
  }
}

/**
 * Syntactic URL check only — parley never dereferences a `url` atom (ADR-0016).
 * Accepts absolute URLs with an http(s) or other scheme; rejects empty/relative.
 */
export function isSyntacticUrl(value: string): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const u = new URL(value);
    // Require a non-empty scheme and host-or-path so bare "foo" fails.
    return u.protocol !== "" && u.protocol !== ":" && value.includes(":");
  } catch {
    return false;
  }
}

// ── parser internals ────────────────────────────────────────────────────────

function toMap(
  named: ReadonlyMap<string, NamedTypeDecl> | Readonly<Record<string, NamedTypeDecl>>,
): ReadonlyMap<string, NamedTypeDecl> {
  if (named instanceof Map) return named;
  return new Map(Object.entries(named));
}

function parseTypeExpr(
  input: string,
  named: ReadonlyMap<string, NamedTypeDecl>,
): { type: PortType; rest: string } {
  let { type, rest } = parseAtomOrDict(input, named);
  // Postfix [] as many times as present: source[][] is allowed by the grammar.
  while (rest.startsWith("[]")) {
    type = { kind: "array", element: type };
    rest = rest.slice(2);
  }
  return { type, rest };
}

function parseAtomOrDict(
  input: string,
  named: ReadonlyMap<string, NamedTypeDecl>,
): { type: PortType; rest: string } {
  const s = input.trimStart();
  if (s.startsWith("dict<")) {
    return parseDict(s, named);
  }
  return parseAtom(s, named);
}

function parseDict(
  s: string,
  named: ReadonlyMap<string, NamedTypeDecl>,
): { type: PortType; rest: string } {
  // "dict<" already matched by caller via startsWith
  let i = "dict<".length;
  // key must be the literal "string"
  const afterKey = s.slice(i).trimStart();
  if (!afterKey.startsWith("string")) {
    throw new Error(`dict key type must be "string", got: ${JSON.stringify(s)}`);
  }
  i = s.length - afterKey.length + "string".length;
  const afterComma = s.slice(i).trimStart();
  if (!afterComma.startsWith(",")) {
    throw new Error(`expected "," after dict key type in: ${JSON.stringify(s)}`);
  }
  i = s.length - afterComma.length + 1;
  const valueSrc = s.slice(i).trimStart();
  const { type: value, rest: afterValue } = parseTypeExpr(valueSrc, named);
  const closed = afterValue.trimStart();
  if (!closed.startsWith(">")) {
    throw new Error(`expected ">" to close dict in: ${JSON.stringify(s)}`);
  }
  return {
    type: { kind: "dict", value },
    rest: closed.slice(1),
  };
}

function parseAtom(
  s: string,
  named: ReadonlyMap<string, NamedTypeDecl>,
): { type: PortType; rest: string } {
  const m = /^([A-Za-z_][A-Za-z0-9_-]*)/.exec(s);
  if (!m) {
    throw new Error(`expected type atom, got: ${JSON.stringify(s)}`);
  }
  const name = m[1]!;
  const rest = s.slice(name.length);

  if (BUILTINS.has(name)) {
    return { type: { kind: name as BuiltinAtomKind }, rest };
  }

  // Reject number/bool explicitly for clearer errors (ADR-0016).
  if (name === "number" || name === "bool" || name === "boolean") {
    throw new Error(
      `port type "${name}" is not an atom — only text, url, file, dir, named enum, and named schema`,
    );
  }

  const decl = named.get(name);
  if (decl === undefined) {
    throw new Error(`unknown named type "${name}"`);
  }
  if (decl.kind === "enum") {
    return {
      type: { kind: "enum", name, values: decl.values },
      rest,
    };
  }
  return {
    type: {
      kind: "schema",
      name,
      path: decl.path,
      schema: decl.schema,
    },
    rest,
  };
}
