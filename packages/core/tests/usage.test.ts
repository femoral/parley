/**
 * normalizeUsage key-family matrix (#118).
 */
import { describe, expect, it } from "vitest";
import { normalizeUsage } from "../src/usage.js";

describe("normalizeUsage (#118)", () => {
  it("maps canonical keys", () => {
    expect(
      normalizeUsage({ input_tokens: 10, output_tokens: 20, cached_tokens: 3 }),
    ).toEqual({ input: 10, output: 20, cached: 3 });
  });

  it("maps codex-style cached_input_tokens", () => {
    expect(
      normalizeUsage({
        input_tokens: 100,
        output_tokens: 50,
        cached_input_tokens: 40,
      }),
    ).toEqual({ input: 100, output: 50, cached: 40 });
  });

  it("maps opencode/kilo flat input/output/cache_read", () => {
    expect(normalizeUsage({ input: 11, output: 22, cache_read: 5 })).toEqual({
      input: 11,
      output: 22,
      cached: 5,
    });
  });

  it("maps goose/hermes cache_read_input_tokens / cache_read_tokens", () => {
    expect(
      normalizeUsage({
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 7,
      }),
    ).toEqual({ input: 1, output: 2, cached: 7 });
    expect(
      normalizeUsage({
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: 9,
      }),
    ).toEqual({ input: 1, output: 2, cached: 9 });
  });

  it("maps claude cache_creation_input_tokens as cached fallback", () => {
    expect(
      normalizeUsage({
        input_tokens: 8,
        output_tokens: 4,
        cache_creation_input_tokens: 2,
      }),
    ).toEqual({ input: 8, output: 4, cached: 2 });
  });

  it("maps cline camelCase keys", () => {
    expect(
      normalizeUsage({
        inputTokens: 30,
        outputTokens: 15,
        cacheReadTokens: 6,
      }),
    ).toEqual({ input: 30, output: 15, cached: 6 });
    expect(
      normalizeUsage({
        totalInputTokens: 31,
        totalOutputTokens: 16,
        totalCacheReadTokens: 7,
      }),
    ).toEqual({ input: 31, output: 16, cached: 7 });
  });

  it("maps openhands prompt/completion tokens", () => {
    expect(
      normalizeUsage({
        prompt_tokens: 12,
        completion_tokens: 8,
        cache_read_tokens: 1,
      }),
    ).toEqual({ input: 12, output: 8, cached: 1 });
  });

  it("maps gemini cached field", () => {
    expect(normalizeUsage({ input_tokens: 5, output_tokens: 3, cached: 2 })).toEqual({
      input: 5,
      output: 3,
      cached: 2,
    });
  });

  it("prefers canonical keys over vendor aliases when both present", () => {
    expect(
      normalizeUsage({
        input_tokens: 100,
        input: 1,
        output_tokens: 200,
        output: 2,
        cached_tokens: 50,
        cached_input_tokens: 5,
      }),
    ).toEqual({ input: 100, output: 200, cached: 50 });
  });

  it("returns nulls for empty or unknown keys and never throws", () => {
    expect(normalizeUsage({})).toEqual({ input: null, output: null, cached: null });
    expect(normalizeUsage({ cost: 1.5, total_tokens: 99 })).toEqual({
      input: null,
      output: null,
      cached: null,
    });
    // Malformed callers: still safe.
    expect(normalizeUsage(null as unknown as Record<string, number>)).toEqual({
      input: null,
      output: null,
      cached: null,
    });
  });

  it("ignores non-finite numbers", () => {
    expect(
      normalizeUsage({
        input_tokens: Number.NaN,
        output_tokens: Number.POSITIVE_INFINITY,
        cached_tokens: 3,
      }),
    ).toEqual({ input: null, output: null, cached: 3 });
  });
});
