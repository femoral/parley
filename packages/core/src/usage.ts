/**
 * Canonical token-usage normalization (#118).
 *
 * Adapters store vendor-native keys under `session_meta.usage` (and often also
 * emit canonical `input_tokens` / `output_tokens` / `cached_tokens`). Metrics
 * fold known key families into a single {input, output, cached} shape. Unknown
 * keys are ignored; never throws.
 *
 * Key families (see docs/research/vendor-token-usage-coverage.md and adapters):
 * - Canonical: input_tokens, output_tokens, cached_tokens
 * - Codex: input_tokens, output_tokens, cached_input_tokens
 * - OpenCode / Kilo (flattened): input, output, cache_read
 * - Goose / Hermes: cache_read_input_tokens / cache_read_tokens
 * - Claude: input_tokens, cache_read_input_tokens, cache_creation_input_tokens
 * - Cline-style camelCase: inputTokens, outputTokens, cacheReadTokens, …
 * - OpenHands: prompt_tokens, completion_tokens, cache_read_tokens
 * - Gemini: cached (→ cached)
 * - Pi: input/output/cacheRead already mapped to canonical at emission time
 */

/** Normalized token counts for metrics aggregation. */
export interface NormalizedUsage {
  input: number | null;
  output: number | null;
  cached: number | null;
}

/** Prefer the first defined finite number among candidate keys. */
function pick(raw: Record<string, number>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Map a vendor (or mixed) usage object to canonical input/output/cached counts.
 * Accepts any record; non-number values are ignored. Never throws.
 */
export function normalizeUsage(raw: Record<string, number>): NormalizedUsage {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { input: null, output: null, cached: null };
  }
  // Coerce only finite numbers so a partially-typed bag still works.
  const nums: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value)) nums[key] = value;
  }

  return {
    input: pick(nums, [
      "input_tokens",
      "inputTokens",
      "totalInputTokens",
      "input",
      "prompt_tokens",
    ]),
    output: pick(nums, [
      "output_tokens",
      "outputTokens",
      "totalOutputTokens",
      "output",
      "completion_tokens",
    ]),
    cached: pick(nums, [
      "cached_tokens",
      "cached_input_tokens",
      "cacheReadTokens",
      "totalCacheReadTokens",
      "cache_read",
      "cache_read_input_tokens",
      "cache_read_tokens",
      "cacheRead",
      "cached",
      // Claude falls back to creation when no read count is present.
      "cache_creation_input_tokens",
    ]),
  };
}
