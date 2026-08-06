/** Harness coat tokens — identity only, never status (DESIGN.md). */

const COAT_VAR: Record<string, string> = {
  codex: "var(--coat-codex)",
  grok: "var(--coat-grok)",
  claude: "var(--coat-claude)",
  gemini: "var(--coat-gemini)",
  kimi: "var(--coat-kimi)",
  opencode: "var(--coat-opencode)",
};

/** Resolve coat CSS var for a harness/vendor name; neutral border when unknown. */
export function coatVar(harness: string | null | undefined): string {
  if (!harness) return "var(--border-strong)";
  const key = harness.toLowerCase();
  return COAT_VAR[key] ?? "var(--border-strong)";
}

export function harnessModelLine(
  harness: string | null | undefined,
  model: string | null | undefined,
): string {
  const h = harness?.trim() || "—";
  const m = model?.trim() || "—";
  return `${h} · ${m}`;
}
