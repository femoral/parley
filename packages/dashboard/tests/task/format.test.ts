/** @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";
import { stateLabel } from "../../src/components/index.js";
import {
  formatDuration,
  formatEvalScore,
  formatUsage,
  tailStatusLabel,
} from "../../src/screens/task/format.js";
import {
  answerScaffold,
  delegateScaffold,
  fixScaffold,
} from "../../src/screens/task/scaffolds.js";
import { formatChurn, projectReportFiles } from "../../src/data/index.js";
import { churnReport, pathOnlyReport } from "./fixtures.js";

describe("task format helpers", () => {
  it("shared stateLabel matches fleet chip labels (DONE / CANCEL)", () => {
    expect(stateLabel("awaiting_answer")).toBe("AWAITING");
    expect(stateLabel("failed")).toBe("FAILED");
    expect(stateLabel("completed")).toBe("DONE");
    expect(stateLabel("cancelled")).toBe("CANCEL");
  });

  it("formats duration and usage", () => {
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatUsage({ input_tokens: 1200, output_tokens: 400, cached_tokens: 100 })).toMatch(
      /1\.2k ▸ 400/,
    );
    expect(formatUsage(null)).toBe("—");
  });

  it("formats eval scores without inventing baselines", () => {
    expect(formatEvalScore(null, 5)).toBe("— unscored");
    expect(formatEvalScore(8, 5.2)).toBe("8.0/5.2");
    expect(formatEvalScore(8, null)).toBe("8.0");
  });

  it("tail status is honest about follow and drops", () => {
    expect(tailStatusLabel("tailing", true)).toMatch(/follow on/);
    expect(tailStatusLabel("paused-by-setting", false)).toMatch(/follow off/);
    expect(tailStatusLabel("unreachable", true)).toMatch(/stream dropped/);
  });

  it("log gutter is line numbers — never invents wall clocks", async () => {
    const { formatLogLineNo } = await import("../../src/screens/task/format.js");
    expect(formatLogLineNo(0)).toBe("01");
    expect(formatLogLineNo(9)).toBe("10");
    // formatLogClock must not exist (fabricated timestamps removed).
    const mod = await import("../../src/screens/task/format.js");
    expect("formatLogClock" in mod).toBe(false);
  });
});

describe("copy scaffolds", () => {
  it("builds ready-to-paste CLI lines", () => {
    expect(answerScaffold("abc")).toBe('parley answer abc "..."');
    expect(fixScaffold("abc")).toBe('parley fix abc "..."');
    expect(delegateScaffold("do the thing")).toBe('parley delegate "do the thing"');
  });
});

describe("report churn honesty", () => {
  it("renders +N/−N when counts exist; empty when path-only", () => {
    const view = projectReportFiles(churnReport());
    expect(view.hasChurn).toBe(true);
    expect(formatChurn(view.files[0]!)).toBe("+120 −14");
    // Path-only object form
    const pathOnly = view.files.find((f) => f.path === "README.md")!;
    expect(pathOnly.added).toBeNull();
    expect(pathOnly.removed).toBeNull();
    expect(formatChurn(pathOnly)).toBe("");
  });

  it("path-only legacy reports never invent 0/0", () => {
    const view = projectReportFiles(pathOnlyReport());
    expect(view.hasChurn).toBe(false);
    for (const f of view.files) {
      expect(formatChurn(f)).toBe("");
      expect(f.added).toBeNull();
      expect(f.removed).toBeNull();
    }
  });
});
