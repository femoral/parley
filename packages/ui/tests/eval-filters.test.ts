/** @vitest-environment happy-dom */
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  emptyEvalFilters,
  evalFiltersToMetricsQuery,
  evalFiltersToSearchParams,
  hasActiveEvalFilters,
  parseEvalFiltersFromSearch,
  parseRubricFilter,
  patchEvalFilters,
} from "../src/app/hooks/evalFilters.js";
import { useEvalFilters } from "../src/app/hooks/useEvalFilters.js";

describe("evalFilters pure helpers (#165)", () => {
  it("starts empty with no active constraints", () => {
    const f = emptyEvalFilters();
    expect(hasActiveEvalFilters(f)).toBe(false);
    expect(evalFiltersToMetricsQuery(f)).toEqual({});
  });

  it("patches text fields with trim and composes AND query", () => {
    const f = patchEvalFilters(emptyEvalFilters(), {
      type: "  coding  ",
      vendor: "codex",
      first_attempt: true,
    });
    expect(f.type).toBe("coding");
    expect(hasActiveEvalFilters(f)).toBe(true);
    expect(evalFiltersToMetricsQuery(f)).toEqual({
      type: "coding",
      vendor: "codex",
      first_attempt: true,
    });
  });

  it("omits false toggles from the metrics query", () => {
    const f = patchEvalFilters(emptyEvalFilters(), {
      below_baseline: false,
      first_attempt: false,
      model: "m1",
    });
    expect(evalFiltersToMetricsQuery(f)).toEqual({ model: "m1" });
  });

  it("parses rubric id@version for the wire", () => {
    expect(parseRubricFilter("coding@2")).toEqual({
      rubric: "coding",
      rubric_version: 2,
    });
    expect(parseRubricFilter("coding")).toEqual({ rubric: "coding" });
    expect(parseRubricFilter("coding@x")).toEqual({ rubric: "coding" });
    expect(parseRubricFilter("")).toEqual({});

    const q = evalFiltersToMetricsQuery(
      patchEvalFilters(emptyEvalFilters(), { rubric: "docs@3" }),
    );
    expect(q).toEqual({ rubric: "docs", rubric_version: 3 });
  });

  it("round-trips through URL search params for #166 subscribers", () => {
    const f = patchEvalFilters(emptyEvalFilters(), {
      type: "coding",
      eval_harness: "claude",
      below_baseline: true,
    });
    const params = evalFiltersToSearchParams(f);
    expect(params.get("type")).toBe("coding");
    expect(params.get("eval_harness")).toBe("claude");
    expect(params.get("below_baseline")).toBe("true");
    expect(params.get("first_attempt")).toBeNull();

    const back = parseEvalFiltersFromSearch(params);
    expect(back.type).toBe("coding");
    expect(back.eval_harness).toBe("claude");
    expect(back.below_baseline).toBe(true);
    expect(back.first_attempt).toBe(false);
  });
});

describe("useEvalFilters (#165)", () => {
  it("holds filter state and exposes metricsQuery", () => {
    const { result } = renderHook(() => useEvalFilters());
    expect(result.current.active).toBe(false);
    expect(result.current.metricsQuery).toEqual({});

    act(() => {
      result.current.setFilters({ vendor: "grok", first_attempt: true });
    });
    expect(result.current.active).toBe(true);
    expect(result.current.filters.vendor).toBe("grok");
    expect(result.current.metricsQuery).toEqual({
      vendor: "grok",
      first_attempt: true,
    });

    act(() => {
      result.current.clearFilters();
    });
    expect(result.current.active).toBe(false);
    expect(result.current.metricsQuery).toEqual({});
  });
});
