/**
 * #234 — step address formatting and tmp handoff paths (ADR-0018).
 * Mode-independent: shared by repo and scratch workspaces.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatStepAddress,
  formatTmpDirRel,
  tmpHandoffPaths,
} from "../src/workflow/address.js";

describe("formatStepAddress", () => {
  it("formats node.iteration", () => {
    expect(formatStepAddress({ node: "implement", iteration: 1 })).toBe("implement.1");
  });

  it("appends slot when present", () => {
    expect(
      formatStepAddress({ node: "review", iteration: 2, slot: "correctness" }),
    ).toBe("review.2.correctness");
  });

  it("omits empty/null slot", () => {
    expect(formatStepAddress({ node: "plan", iteration: 1, slot: null })).toBe("plan.1");
    expect(formatStepAddress({ node: "plan", iteration: 1, slot: "" })).toBe("plan.1");
  });

  it("appends -r<n> for retries", () => {
    expect(
      formatStepAddress({ node: "implement", iteration: 1, retry: 1 }),
    ).toBe("implement.1-r1");
    expect(
      formatStepAddress({
        node: "review",
        iteration: 1,
        slot: "sweep",
        retry: 2,
      }),
    ).toBe("review.1.sweep-r2");
  });

  it("omits retry when 0 or null", () => {
    expect(formatStepAddress({ node: "x", iteration: 1, retry: 0 })).toBe("x.1");
    expect(formatStepAddress({ node: "x", iteration: 1, retry: null })).toBe("x.1");
  });

  it("allows iteration 0 (fork inheritance marker)", () => {
    expect(formatStepAddress({ node: "plan", iteration: 0 })).toBe("plan.0");
  });

  it("rejects empty node and bad iteration", () => {
    expect(() => formatStepAddress({ node: "", iteration: 1 })).toThrow(/node/i);
    expect(() => formatStepAddress({ node: "x", iteration: -1 })).toThrow(/iteration/i);
    expect(() => formatStepAddress({ node: "x", iteration: 1.5 })).toThrow(/iteration/i);
  });
});

describe("tmp handoff paths", () => {
  it("lays out .parley/tmp/<address>/{in,out}", () => {
    const rel = formatTmpDirRel("review.1.correctness");
    expect(rel).toBe(path.join(".parley", "tmp", "review.1.correctness"));

    const abs = tmpHandoffPaths("/ws", "implement.1-r1");
    expect(abs.root).toBe(path.join("/ws", ".parley", "tmp", "implement.1-r1"));
    expect(abs.in).toBe(path.join(abs.root, "in"));
    expect(abs.out).toBe(path.join(abs.root, "out"));
  });

  it("rejects path-like addresses", () => {
    expect(() => formatTmpDirRel("../escape")).toThrow(/invalid/i);
    expect(() => formatTmpDirRel("a/b")).toThrow(/invalid/i);
    expect(() => formatTmpDirRel("")).toThrow(/invalid/i);
  });
});
